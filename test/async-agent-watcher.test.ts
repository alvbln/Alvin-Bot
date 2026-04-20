/**
 * Fix #17 (Stage 2) — async-agent-watcher integration tests.
 *
 * The watcher polls outputFiles of pending agents, detects completion,
 * delivers via subagent-delivery.ts, and persists state to disk so the
 * pending list survives bot restarts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-async-watcher-${process.pid}-${Date.now()}`);

interface DeliveredCall {
  info: { name: string; source?: string; parentChatId?: number; status?: string };
  result: { status: string; output: string; duration: number; error?: string };
}

let delivered: DeliveredCall[] = [];

beforeEach(async () => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  delivered = [];
  vi.resetModules();
  vi.doMock("../src/services/subagent-delivery.js", () => ({
    deliverSubAgentResult: async (info: unknown, result: unknown) => {
      delivered.push({ info: info as DeliveredCall["info"], result: result as DeliveredCall["result"] });
    },
    attachBotApi: () => {},
    __setBotApiForTest: () => {},
  }));
});

afterEach(async () => {
  try {
    const mod = await import("../src/services/async-agent-watcher.js");
    mod.stopWatcher();
    mod.__resetForTest();
  } catch { /* ignore */ }
});

function writeCompletedJsonl(path: string, finalText: string): void {
  const lines = [
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
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }),
  ].join("\n") + "\n";
  fs.mkdirSync(resolve(path, ".."), { recursive: true });
  fs.writeFileSync(path, lines, "utf-8");
}

describe("async-agent-watcher (Stage 2)", () => {
  it("registers a pending agent and persists it to disk", async () => {
    const mod = await import("../src/services/async-agent-watcher.js");
    mod.registerPendingAgent({
      agentId: "abc-1",
      outputFile: `${TEST_DATA_DIR}/out-abc-1.jsonl`,
      description: "Test SEO audit",
      prompt: "do a test",
      chatId: 42,
      userId: 42,
      toolUseId: "toolu_1",
    });
    const stateFile = `${TEST_DATA_DIR}/state/async-agents.json`;
    expect(fs.existsSync(stateFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].agentId).toBe("abc-1");
    expect(parsed[0].description).toBe("Test SEO audit");
  });

  it("delivers a pending agent when its outputFile completes", async () => {
    const mod = await import("../src/services/async-agent-watcher.js");
    const outPath = `${TEST_DATA_DIR}/out-abc-2.jsonl`;
    mod.registerPendingAgent({
      agentId: "abc-2",
      outputFile: outPath,
      description: "quick task",
      prompt: "p",
      chatId: 42,
      userId: 42,
      toolUseId: null,
    });
    writeCompletedJsonl(outPath, "Here is the report");

    await mod.pollOnce();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].info.name).toBe("quick task");
    expect(delivered[0].result.output).toContain("Here is the report");
    expect(delivered[0].result.status).toBe("completed");
  });

  it("removes a pending agent from persistence after delivery", async () => {
    const mod = await import("../src/services/async-agent-watcher.js");
    const outPath = `${TEST_DATA_DIR}/out-abc-3.jsonl`;
    mod.registerPendingAgent({
      agentId: "abc-3",
      outputFile: outPath,
      description: "cleanup test",
      prompt: "p",
      chatId: 42,
      userId: 42,
      toolUseId: null,
    });
    writeCompletedJsonl(outPath, "done");
    await mod.pollOnce();

    const stateFile = `${TEST_DATA_DIR}/state/async-agents.json`;
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(state).toHaveLength(0);
  });

  it("loads pending agents from disk at startup (bot restart catchup)", async () => {
    fs.mkdirSync(`${TEST_DATA_DIR}/state`, { recursive: true });
    const outPath = `${TEST_DATA_DIR}/out-preexisting.jsonl`;
    fs.writeFileSync(
      `${TEST_DATA_DIR}/state/async-agents.json`,
      JSON.stringify([
        {
          agentId: "preexisting",
          outputFile: outPath,
          description: "Survived restart",
          prompt: "p",
          chatId: 42,
          userId: 42,
          startedAt: Date.now() - 5000,
          lastCheckedAt: Date.now() - 1000,
          giveUpAt: Date.now() + 86_400_000,
          toolUseId: null,
        },
      ]),
    );
    writeCompletedJsonl(outPath, "result from earlier session");

    const mod = await import("../src/services/async-agent-watcher.js");
    mod.startWatcher();
    await mod.pollOnce();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].info.name).toBe("Survived restart");
    expect(delivered[0].result.output).toContain("result from earlier session");
  });

  it("gives up on agents older than giveUpAt and delivers a timeout banner", async () => {
    const mod = await import("../src/services/async-agent-watcher.js");
    const outPath = `${TEST_DATA_DIR}/out-timeout.jsonl`;
    mod.registerPendingAgent({
      agentId: "abc-4",
      outputFile: outPath,
      description: "forever task",
      prompt: "p",
      chatId: 42,
      userId: 42,
      toolUseId: null,
      giveUpAt: Date.now() - 1000,
    });
    // File never exists
    await mod.pollOnce();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].result.status).toBe("timeout");
    expect(delivered[0].info.status).toBe("timeout");
  });

  it("multiple concurrent pending agents all get delivered as they complete", async () => {
    const mod = await import("../src/services/async-agent-watcher.js");
    const outA = `${TEST_DATA_DIR}/out-a.jsonl`;
    const outB = `${TEST_DATA_DIR}/out-b.jsonl`;
    const outC = `${TEST_DATA_DIR}/out-c.jsonl`;
    mod.registerPendingAgent({
      agentId: "a", outputFile: outA, description: "A",
      prompt: "p", chatId: 1, userId: 1, toolUseId: null,
    });
    mod.registerPendingAgent({
      agentId: "b", outputFile: outB, description: "B",
      prompt: "p", chatId: 2, userId: 2, toolUseId: null,
    });
    mod.registerPendingAgent({
      agentId: "c", outputFile: outC, description: "C",
      prompt: "p", chatId: 3, userId: 3, toolUseId: null,
    });

    writeCompletedJsonl(outA, "A done");
    writeCompletedJsonl(outB, "B done");
    // C still pending

    await mod.pollOnce();
    expect(delivered).toHaveLength(2);
    expect(delivered.map((d) => d.info.name).sort()).toEqual(["A", "B"]);

    writeCompletedJsonl(outC, "C done");
    await mod.pollOnce();
    expect(delivered).toHaveLength(3);
  });

  it("listPendingAgents reflects in-memory state", async () => {
    const mod = await import("../src/services/async-agent-watcher.js");
    expect(mod.listPendingAgents()).toEqual([]);
    mod.registerPendingAgent({
      agentId: "x",
      outputFile: `${TEST_DATA_DIR}/out-x.jsonl`,
      description: "test",
      prompt: "p",
      chatId: 1,
      userId: 1,
      toolUseId: null,
    });
    expect(mod.listPendingAgents()).toHaveLength(1);
    expect(mod.listPendingAgents()[0].agentId).toBe("x");
  });
});
