/**
 * v4.12.3 — Stress + edge-case tests for the bypass path.
 *
 * These tests exercise scenarios that aren't part of the happy path
 * but should hold up in real-world use:
 *   - Many parallel sessions
 *   - Rapid churn (launch/deliver cycles)
 *   - Memory hygiene (no residual in-memory state after delivery)
 *   - Race conditions: delivery fires while counter is mid-update
 *   - Extreme counter drift (more deliveries than launches)
 *   - waitUntilProcessingFalse timeout paths
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(
  os.tmpdir(),
  `alvin-bypass-stress-${process.pid}-${Date.now()}`,
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

function writeCompletedJsonl(path: string, text: string): void {
  const lines =
    [
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        agentId: "x",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    ].join("\n") + "\n";
  fs.mkdirSync(resolve(path, ".."), { recursive: true });
  fs.writeFileSync(path, lines, "utf-8");
}

describe("v4.12.3 bypass — stress + edge cases", () => {
  it("100 parallel sessions each launch and deliver one agent — counters isolated", async () => {
    const { getSession } = await import("../src/services/session.js");
    const { handleToolResultChunk } = await import(
      "../src/handlers/async-agent-chunk-handler.js"
    );
    const watcher = await import("../src/services/async-agent-watcher.js");

    const N = 100;
    const sessionKeys: string[] = [];

    // Launch phase
    for (let i = 0; i < N; i++) {
      const sk = `stress-parallel-${i}`;
      sessionKeys.push(sk);
      const s = getSession(sk);
      s.pendingBackgroundCount = 0;

      const outPath = `${TEST_DATA_DIR}/p-${i}.jsonl`;
      handleToolResultChunk(
        {
          type: "tool_result",
          toolUseId: `p_${i}`,
          toolResultContent:
            "Async agent launched successfully.\n" +
            `agentId: p-${i}\n` +
            `output_file: ${outPath}\n`,
        },
        {
          chatId: i,
          userId: i,
          sessionKey: sk,
          lastToolUseInput: { description: `task ${i}`, prompt: "p" },
        },
      );
    }

    // Verify all have count=1
    for (const sk of sessionKeys) {
      expect(getSession(sk).pendingBackgroundCount).toBe(1);
    }

    // Complete phase
    for (let i = 0; i < N; i++) {
      writeCompletedJsonl(`${TEST_DATA_DIR}/p-${i}.jsonl`, `done ${i}`);
    }
    await watcher.pollOnce();

    // Verify all back to 0
    for (const sk of sessionKeys) {
      expect(getSession(sk).pendingBackgroundCount).toBe(0);
    }

    // Verify watcher in-memory state is empty
    expect(watcher.listPendingAgents()).toHaveLength(0);
  });

  it("churn: 200 rapid launch/deliver cycles on one session — counter stays [0,1]", async () => {
    const { getSession } = await import("../src/services/session.js");
    const { handleToolResultChunk } = await import(
      "../src/handlers/async-agent-chunk-handler.js"
    );
    const watcher = await import("../src/services/async-agent-watcher.js");

    const sk = "churn-hot";
    const s = getSession(sk);
    s.pendingBackgroundCount = 0;

    for (let i = 0; i < 200; i++) {
      const outPath = `${TEST_DATA_DIR}/churn-${i}.jsonl`;
      handleToolResultChunk(
        {
          type: "tool_result",
          toolUseId: `c_${i}`,
          toolResultContent:
            "Async agent launched successfully.\n" +
            `agentId: c-${i}\n` +
            `output_file: ${outPath}\n`,
        },
        {
          chatId: 1,
          userId: 1,
          sessionKey: sk,
          lastToolUseInput: { description: `task ${i}`, prompt: "p" },
        },
      );
      expect(s.pendingBackgroundCount).toBe(1);

      writeCompletedJsonl(outPath, `done ${i}`);
      await watcher.pollOnce();
      expect(s.pendingBackgroundCount).toBe(0);
    }

    // Final sanity
    expect(watcher.listPendingAgents()).toHaveLength(0);
  });

  it("extreme drift: 10 deliveries but only 1 launch — counter clamps at 0", async () => {
    const { getSession } = await import("../src/services/session.js");
    const watcher = await import("../src/services/async-agent-watcher.js");

    const sk = "drift-extreme";
    const s = getSession(sk);
    s.pendingBackgroundCount = 1;

    // Register 10 agents to the same session, but keep the counter at 1
    // (simulating a scenario where the handler increment got lost on 9 of them)
    for (let i = 0; i < 10; i++) {
      const outPath = `${TEST_DATA_DIR}/drift-${i}.jsonl`;
      watcher.registerPendingAgent({
        agentId: `drift-${i}`,
        outputFile: outPath,
        description: `drift ${i}`,
        prompt: "p",
        chatId: 1,
        userId: 1,
        toolUseId: null,
        sessionKey: sk,
      });
      writeCompletedJsonl(outPath, `done ${i}`);
    }

    await watcher.pollOnce();

    // First delivery takes counter from 1 → 0.
    // The next 9 deliveries try to decrement from 0 and clamp.
    expect(s.pendingBackgroundCount).toBe(0);
  });

  it("user /new during pending — counter reset is safe", async () => {
    const { getSession, resetSession } = await import("../src/services/session.js");
    const { handleToolResultChunk } = await import(
      "../src/handlers/async-agent-chunk-handler.js"
    );
    const watcher = await import("../src/services/async-agent-watcher.js");

    const sk = "reset-during-pending";
    const s = getSession(sk);
    s.pendingBackgroundCount = 0;

    // Launch 3 agents
    for (let i = 0; i < 3; i++) {
      const outPath = `${TEST_DATA_DIR}/reset-${i}.jsonl`;
      handleToolResultChunk(
        {
          type: "tool_result",
          toolUseId: `r_${i}`,
          toolResultContent:
            "Async agent launched successfully.\n" +
            `agentId: reset-${i}\n` +
            `output_file: ${outPath}\n`,
        },
        {
          chatId: 1,
          userId: 1,
          sessionKey: sk,
          lastToolUseInput: { description: `task ${i}`, prompt: "p" },
        },
      );
    }
    expect(s.pendingBackgroundCount).toBe(3);

    // User issues /new while all 3 are running
    resetSession(sk);
    expect(s.pendingBackgroundCount).toBe(0);

    // Watcher delivers all 3 afterwards
    for (let i = 0; i < 3; i++) {
      writeCompletedJsonl(`${TEST_DATA_DIR}/reset-${i}.jsonl`, `done ${i}`);
    }
    await watcher.pollOnce();

    // Counter should remain 0 (clamped)
    expect(s.pendingBackgroundCount).toBe(0);
  });

  it("session removed from Map before delivery — decrement is no-op, no crash", async () => {
    const { getAllSessions } = await import("../src/services/session.js");
    const { handleToolResultChunk } = await import(
      "../src/handlers/async-agent-chunk-handler.js"
    );
    const watcher = await import("../src/services/async-agent-watcher.js");

    const sk = "ephemeral-session";
    const s = getAllSessions();
    // Use the standard path to ensure getSession works first
    const { getSession } = await import("../src/services/session.js");
    const session = getSession(sk);
    session.pendingBackgroundCount = 0;

    const outPath = `${TEST_DATA_DIR}/eph.jsonl`;
    handleToolResultChunk(
      {
        type: "tool_result",
        toolUseId: "eph_1",
        toolResultContent:
          "Async agent launched successfully.\n" +
          "agentId: eph-1\n" +
          `output_file: ${outPath}\n`,
      },
      {
        chatId: 1,
        userId: 1,
        sessionKey: sk,
        lastToolUseInput: { description: "d", prompt: "p" },
      },
    );
    expect(session.pendingBackgroundCount).toBe(1);

    // Nuke the session from the map (simulates TTL cleanup)
    s.delete(sk);

    writeCompletedJsonl(outPath, "done");
    await expect(watcher.pollOnce()).resolves.not.toThrow();
  });

  it("mixed rollout: pre-v4.12.3 persisted entries (no sessionKey) mixed with new entries", async () => {
    const { getSession } = await import("../src/services/session.js");
    const watcher = await import("../src/services/async-agent-watcher.js");

    // v4.12.3 session with counter
    const sk = "mixed-v412";
    const s = getSession(sk);
    s.pendingBackgroundCount = 1;

    // New-style entry with sessionKey
    const newPath = `${TEST_DATA_DIR}/new.jsonl`;
    watcher.registerPendingAgent({
      agentId: "new-agent",
      outputFile: newPath,
      description: "new",
      prompt: "p",
      chatId: 1,
      userId: 1,
      toolUseId: null,
      sessionKey: sk,
    });

    // Old-style entry without sessionKey (pre-v4.12.3)
    const oldPath = `${TEST_DATA_DIR}/old.jsonl`;
    watcher.registerPendingAgent({
      agentId: "old-agent",
      outputFile: oldPath,
      description: "old",
      prompt: "p",
      chatId: 2,
      userId: 2,
      toolUseId: null,
      // sessionKey intentionally omitted
    });

    writeCompletedJsonl(newPath, "new done");
    writeCompletedJsonl(oldPath, "old done");
    await watcher.pollOnce();

    // New agent decrements our counter; old agent is a no-op
    expect(s.pendingBackgroundCount).toBe(0);
    expect(watcher.listPendingAgents()).toHaveLength(0);
  });

  it("waitUntilProcessingFalse: flag flips right at the tick boundary", async () => {
    const { waitUntilProcessingFalse } = await import(
      "../src/handlers/background-bypass.js"
    );
    const session = { isProcessing: true };
    // Start waiting, then flip asynchronously
    const waitPromise = waitUntilProcessingFalse(session, 2000, 10);
    setTimeout(() => { session.isProcessing = false; }, 15);
    const result = await waitPromise;
    expect(result).toBe(true);
  });

  it("waitUntilProcessingFalse: timeout respected", async () => {
    const { waitUntilProcessingFalse } = await import(
      "../src/handlers/background-bypass.js"
    );
    const session = { isProcessing: true };
    const start = Date.now();
    const result = await waitUntilProcessingFalse(session, 200, 25);
    const elapsed = Date.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(180); // allow small jitter
    expect(elapsed).toBeLessThan(400);
  });

  it(
    "high load: 50 sessions, each with 4 parallel agents (200 total) — " +
      "all deliver, all counters return to 0",
    async () => {
      const { getSession } = await import("../src/services/session.js");
      const { handleToolResultChunk } = await import(
        "../src/handlers/async-agent-chunk-handler.js"
      );
      const watcher = await import("../src/services/async-agent-watcher.js");

      const S = 50;
      const A = 4;
      const sessionKeys: string[] = [];
      const allPaths: string[] = [];

      for (let i = 0; i < S; i++) {
        const sk = `load-s-${i}`;
        sessionKeys.push(sk);
        const s = getSession(sk);
        s.pendingBackgroundCount = 0;

        for (let j = 0; j < A; j++) {
          const outPath = `${TEST_DATA_DIR}/load-${i}-${j}.jsonl`;
          allPaths.push(outPath);
          handleToolResultChunk(
            {
              type: "tool_result",
              toolUseId: `load_${i}_${j}`,
              toolResultContent:
                "Async agent launched successfully.\n" +
                `agentId: load-${i}-${j}\n` +
                `output_file: ${outPath}\n`,
            },
            {
              chatId: i,
              userId: i,
              sessionKey: sk,
              lastToolUseInput: {
                description: `task ${i}-${j}`,
                prompt: "p",
              },
            },
          );
        }
      }

      // Every session has A agents pending
      for (const sk of sessionKeys) {
        expect(getSession(sk).pendingBackgroundCount).toBe(A);
      }

      // Deliver all
      for (const p of allPaths) {
        writeCompletedJsonl(p, "done");
      }
      await watcher.pollOnce();

      // All counters back to 0
      for (const sk of sessionKeys) {
        expect(getSession(sk).pendingBackgroundCount).toBe(0);
      }

      // No residual state
      expect(watcher.listPendingAgents()).toHaveLength(0);
    },
  );
});
