/**
 * v4.12.3 — End-to-end integration test for the background-agent bypass
 * path. Simulates the following scenario:
 *
 *   1. User sends a message that causes Claude to launch an async Agent
 *   2. While the SDK's CLI subprocess idles waiting for the
 *      task-notification, user sends a NEW message
 *   3. The handler recognises the pending background state and:
 *      a. Aborts the blocked query
 *      b. Bypasses SDK resume for the new query (sessionId=null)
 *      c. Injects bridge preamble with history
 *   4. The watcher delivers the background result via
 *      subagent-delivery.ts as a separate message
 *   5. After delivery, pendingBackgroundCount returns to 0 and future
 *      queries use normal SDK resume again
 *
 * The full handler is too tightly coupled to grammy to unit-test end
 * to end. Instead we exercise each layer directly:
 *   - session.pendingBackgroundCount updates (counter wiring)
 *   - shouldBypassQueue / shouldBypassSdkResume decision points
 *   - watcher delivery → counter decrement
 *   - abort + wait path
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(
  os.tmpdir(),
  `alvin-bypass-int-${process.pid}-${Date.now()}`,
);

beforeEach(async () => {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  vi.resetModules();
  vi.doMock("../src/services/subagent-delivery.js", () => ({
    deliverSubAgentResult: async () => {},
    attachBotApi: () => {},
    __setBotApiForTest: () => {},
  }));
});

afterEach(async () => {
  try {
    const mod = await import("../src/services/async-agent-watcher.js");
    mod.stopWatcher();
    mod.__resetForTest();
  } catch {
    /* ignore */
  }
});

function writeCompletedJsonl(path: string, finalText: string): void {
  const lines =
    [
      JSON.stringify({
        type: "user",
        isSidechain: true,
        agentId: "x",
        message: { role: "user", content: "do it" },
      }),
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        agentId: "x",
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ].join("\n") + "\n";
  fs.mkdirSync(resolve(path, ".."), { recursive: true });
  fs.writeFileSync(path, lines, "utf-8");
}

describe("v4.12.3 background-bypass end-to-end", () => {
  it(
    "full scenario: async launch → counter incremented → new message triggers bypass → " +
      "watcher delivery → counter decremented",
    async () => {
      const { getSession } = await import("../src/services/session.js");
      const { handleToolResultChunk } = await import(
        "../src/handlers/async-agent-chunk-handler.js"
      );
      const watcher = await import("../src/services/async-agent-watcher.js");
      const {
        shouldBypassQueue,
        shouldBypassSdkResume,
      } = await import("../src/handlers/background-bypass.js");

      const sessionKey = "int-session-1";
      const session = getSession(sessionKey);
      expect(session.pendingBackgroundCount).toBe(0);

      // === Step 1: simulate the tool_result chunk for an async launch ===
      const outPath = `${TEST_DATA_DIR}/int-out.jsonl`;
      handleToolResultChunk(
        {
          type: "tool_result",
          toolUseId: "toolu_int",
          toolResultContent:
            "Async agent launched successfully.\n" +
            "agentId: int-agent\n" +
            `output_file: ${outPath}\n`,
        },
        {
          chatId: 42,
          userId: 42,
          sessionKey,
          lastToolUseInput: {
            description: "Research Higgsfield",
            prompt: "do deep research",
          },
        },
      );

      // === Step 2: counter should have been incremented ===
      expect(session.pendingBackgroundCount).toBe(1);

      // === Step 3: simulate the handler noticing isProcessing=true AND
      // background pending. shouldBypassQueue must return true so it knows
      // to abort-and-replace instead of queueing. ===
      session.isProcessing = true;
      session.abortController = new AbortController();
      expect(
        shouldBypassQueue({
          isProcessing: session.isProcessing,
          pendingBackgroundCount: session.pendingBackgroundCount,
          abortController: session.abortController,
        }),
      ).toBe(true);

      // === Step 4: shouldBypassSdkResume must return true so the fresh
      // query uses sessionId=null ===
      expect(
        shouldBypassSdkResume({
          pendingBackgroundCount: session.pendingBackgroundCount,
        }),
      ).toBe(true);

      // === Step 5: simulate the watcher delivering the background result ===
      writeCompletedJsonl(outPath, "Higgsfield research complete");
      await watcher.pollOnce();

      // === Step 6: counter should now be 0 again ===
      expect(session.pendingBackgroundCount).toBe(0);

      // === Step 7: subsequent queries should NOT bypass resume anymore ===
      expect(
        shouldBypassSdkResume({
          pendingBackgroundCount: session.pendingBackgroundCount,
        }),
      ).toBe(false);
    },
  );

  it(
    "stress: 5 parallel background agents launched in one turn, " +
      "counter reflects all of them, all decrement on delivery",
    async () => {
      const { getSession } = await import("../src/services/session.js");
      const { handleToolResultChunk } = await import(
        "../src/handlers/async-agent-chunk-handler.js"
      );
      const watcher = await import("../src/services/async-agent-watcher.js");

      const sessionKey = "stress-session-5";
      const session = getSession(sessionKey);
      session.pendingBackgroundCount = 0;

      const outPaths: string[] = [];
      for (let i = 0; i < 5; i++) {
        const outPath = `${TEST_DATA_DIR}/stress-${i}.jsonl`;
        outPaths.push(outPath);
        handleToolResultChunk(
          {
            type: "tool_result",
            toolUseId: `toolu_stress_${i}`,
            toolResultContent:
              "Async agent launched successfully.\n" +
              `agentId: stress-${i}\n` +
              `output_file: ${outPath}\n`,
          },
          {
            chatId: 42,
            userId: 42,
            sessionKey,
            lastToolUseInput: {
              description: `task ${i}`,
              prompt: "p",
            },
          },
        );
      }
      expect(session.pendingBackgroundCount).toBe(5);

      // Deliver 3 of them
      for (let i = 0; i < 3; i++) {
        writeCompletedJsonl(outPaths[i], `result ${i}`);
      }
      await watcher.pollOnce();
      expect(session.pendingBackgroundCount).toBe(2);

      // Deliver the last 2
      writeCompletedJsonl(outPaths[3], "result 3");
      writeCompletedJsonl(outPaths[4], "result 4");
      await watcher.pollOnce();
      expect(session.pendingBackgroundCount).toBe(0);
    },
  );

  it(
    "stress: agents from DIFFERENT sessions do not interfere with each other",
    async () => {
      const { getSession } = await import("../src/services/session.js");
      const { handleToolResultChunk } = await import(
        "../src/handlers/async-agent-chunk-handler.js"
      );
      const watcher = await import("../src/services/async-agent-watcher.js");

      const sessionA = getSession("stress-iso-a");
      const sessionB = getSession("stress-iso-b");
      const sessionC = getSession("stress-iso-c");
      sessionA.pendingBackgroundCount = 0;
      sessionB.pendingBackgroundCount = 0;
      sessionC.pendingBackgroundCount = 0;

      // Session A launches 2 agents
      for (const i of [0, 1]) {
        const p = `${TEST_DATA_DIR}/iso-a-${i}.jsonl`;
        handleToolResultChunk(
          {
            type: "tool_result",
            toolUseId: `a${i}`,
            toolResultContent:
              `Async agent launched successfully.\n` +
              `agentId: iso-a-${i}\n` +
              `output_file: ${p}\n`,
          },
          {
            chatId: 1,
            userId: 1,
            sessionKey: "stress-iso-a",
            lastToolUseInput: { description: "a", prompt: "p" },
          },
        );
      }
      // Session B launches 1
      handleToolResultChunk(
        {
          type: "tool_result",
          toolUseId: "b0",
          toolResultContent:
            "Async agent launched successfully.\n" +
            "agentId: iso-b-0\n" +
            `output_file: ${TEST_DATA_DIR}/iso-b-0.jsonl\n`,
        },
        {
          chatId: 2,
          userId: 2,
          sessionKey: "stress-iso-b",
          lastToolUseInput: { description: "b", prompt: "p" },
        },
      );
      // Session C launches 0

      expect(sessionA.pendingBackgroundCount).toBe(2);
      expect(sessionB.pendingBackgroundCount).toBe(1);
      expect(sessionC.pendingBackgroundCount).toBe(0);

      // Complete only A's agents
      writeCompletedJsonl(`${TEST_DATA_DIR}/iso-a-0.jsonl`, "a0 done");
      writeCompletedJsonl(`${TEST_DATA_DIR}/iso-a-1.jsonl`, "a1 done");
      await watcher.pollOnce();

      // A should be 0, B should still be 1, C unchanged
      expect(sessionA.pendingBackgroundCount).toBe(0);
      expect(sessionB.pendingBackgroundCount).toBe(1);
      expect(sessionC.pendingBackgroundCount).toBe(0);

      // Complete B's agent
      writeCompletedJsonl(`${TEST_DATA_DIR}/iso-b-0.jsonl`, "b0 done");
      await watcher.pollOnce();
      expect(sessionB.pendingBackgroundCount).toBe(0);
    },
  );

  it(
    "bypass decision is correct through a full lifecycle: " +
      "no-pending → launch → pending → deliver → no-pending",
    async () => {
      const { getSession } = await import("../src/services/session.js");
      const { handleToolResultChunk } = await import(
        "../src/handlers/async-agent-chunk-handler.js"
      );
      const watcher = await import("../src/services/async-agent-watcher.js");
      const { shouldBypassSdkResume } = await import(
        "../src/handlers/background-bypass.js"
      );

      const sessionKey = "lifecycle-session";
      const session = getSession(sessionKey);
      session.pendingBackgroundCount = 0;

      // Initially no bypass
      expect(
        shouldBypassSdkResume({
          pendingBackgroundCount: session.pendingBackgroundCount,
        }),
      ).toBe(false);

      // Launch
      const outPath = `${TEST_DATA_DIR}/lifecycle.jsonl`;
      handleToolResultChunk(
        {
          type: "tool_result",
          toolUseId: "t1",
          toolResultContent:
            "Async agent launched successfully.\n" +
            "agentId: life1\n" +
            `output_file: ${outPath}\n`,
        },
        {
          chatId: 1,
          userId: 1,
          sessionKey,
          lastToolUseInput: { description: "d", prompt: "p" },
        },
      );

      // Now bypass
      expect(
        shouldBypassSdkResume({
          pendingBackgroundCount: session.pendingBackgroundCount,
        }),
      ).toBe(true);

      // Deliver
      writeCompletedJsonl(outPath, "life done");
      await watcher.pollOnce();

      // Back to no bypass
      expect(
        shouldBypassSdkResume({
          pendingBackgroundCount: session.pendingBackgroundCount,
        }),
      ).toBe(false);
    },
  );

  it(
    "stress: rapid launch+deliver+launch cycle (10 iterations) — " +
      "counter stays consistent, no drift, no negatives",
    async () => {
      const { getSession } = await import("../src/services/session.js");
      const { handleToolResultChunk } = await import(
        "../src/handlers/async-agent-chunk-handler.js"
      );
      const watcher = await import("../src/services/async-agent-watcher.js");

      const sessionKey = "churn-session";
      const session = getSession(sessionKey);
      session.pendingBackgroundCount = 0;

      for (let i = 0; i < 10; i++) {
        const outPath = `${TEST_DATA_DIR}/churn-${i}.jsonl`;
        handleToolResultChunk(
          {
            type: "tool_result",
            toolUseId: `churn_${i}`,
            toolResultContent:
              "Async agent launched successfully.\n" +
              `agentId: churn-${i}\n` +
              `output_file: ${outPath}\n`,
          },
          {
            chatId: 1,
            userId: 1,
            sessionKey,
            lastToolUseInput: { description: `c${i}`, prompt: "p" },
          },
        );
        expect(session.pendingBackgroundCount).toBe(1);

        writeCompletedJsonl(outPath, `c${i}`);
        await watcher.pollOnce();
        expect(session.pendingBackgroundCount).toBe(0);
      }
    },
  );

  it(
    "watcher decrement is robust against session being reset mid-flight",
    async () => {
      const { getSession, resetSession } = await import(
        "../src/services/session.js"
      );
      const { handleToolResultChunk } = await import(
        "../src/handlers/async-agent-chunk-handler.js"
      );
      const watcher = await import("../src/services/async-agent-watcher.js");

      const sessionKey = "reset-session";
      const session = getSession(sessionKey);
      session.pendingBackgroundCount = 0;

      const outPath = `${TEST_DATA_DIR}/reset.jsonl`;
      handleToolResultChunk(
        {
          type: "tool_result",
          toolUseId: "t1",
          toolResultContent:
            "Async agent launched successfully.\n" +
            "agentId: reset1\n" +
            `output_file: ${outPath}\n`,
        },
        {
          chatId: 1,
          userId: 1,
          sessionKey,
          lastToolUseInput: { description: "d", prompt: "p" },
        },
      );
      expect(session.pendingBackgroundCount).toBe(1);

      // Simulate /new during background task
      resetSession(sessionKey);
      expect(session.pendingBackgroundCount).toBe(0);

      writeCompletedJsonl(outPath, "done");
      // Delivery should not crash, counter stays at 0 (Math.max clamp)
      await expect(watcher.pollOnce()).resolves.not.toThrow();
      expect(session.pendingBackgroundCount).toBe(0);
    },
  );
});
