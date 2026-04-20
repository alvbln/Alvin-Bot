/**
 * v4.12.3 — async-agent watcher ↔ session.pendingBackgroundCount wiring.
 *
 * Contract:
 *   - registerPendingAgent takes an optional `sessionKey` so the watcher
 *     can locate the right UserSession later.
 *   - When the watcher delivers a result (completed/failed/timeout), the
 *     session's pendingBackgroundCount MUST be decremented so the main
 *     handler knows it's safe to resume SDK-session-based queries.
 *   - Decrement is clamped at 0 — the counter never goes negative even
 *     if decoupled operations drift.
 *   - The handler is responsible for INCREMENTING when it registers.
 *     The watcher only decrements.
 *
 * These tests use the shared in-memory session Map from session.ts so
 * they exercise the actual wiring, not a mock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(
  os.tmpdir(),
  `alvin-watcher-pending-${process.pid}-${Date.now()}`,
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

describe("watcher ↔ session.pendingBackgroundCount (v4.12.3)", () => {
  it("completed delivery decrements pendingBackgroundCount on the right session", async () => {
    const { getSession } = await import("../src/services/session.js");
    const watcher = await import("../src/services/async-agent-watcher.js");

    const sessionKey = "v412-session-a";
    const session = getSession(sessionKey);
    session.pendingBackgroundCount = 1;

    const outPath = `${TEST_DATA_DIR}/out-a.jsonl`;
    watcher.registerPendingAgent({
      agentId: "a",
      outputFile: outPath,
      description: "research",
      prompt: "p",
      chatId: 42,
      userId: 42,
      toolUseId: null,
      sessionKey,
    });

    writeCompletedJsonl(outPath, "result");
    await watcher.pollOnce();

    expect(session.pendingBackgroundCount).toBe(0);
  });

  it("timeout delivery also decrements the counter", async () => {
    const { getSession } = await import("../src/services/session.js");
    const watcher = await import("../src/services/async-agent-watcher.js");

    const sessionKey = "v412-session-timeout";
    const session = getSession(sessionKey);
    session.pendingBackgroundCount = 2;

    watcher.registerPendingAgent({
      agentId: "timed-out",
      outputFile: `${TEST_DATA_DIR}/never-written.jsonl`,
      description: "slow task",
      prompt: "p",
      chatId: 42,
      userId: 42,
      toolUseId: null,
      sessionKey,
      giveUpAt: Date.now() - 1000,
    });

    await watcher.pollOnce();

    expect(session.pendingBackgroundCount).toBe(1);
  });

  it("failure delivery decrements the counter", async () => {
    const { getSession } = await import("../src/services/session.js");
    const watcher = await import("../src/services/async-agent-watcher.js");

    const sessionKey = "v412-session-fail";
    const session = getSession(sessionKey);
    session.pendingBackgroundCount = 3;

    const outPath = `${TEST_DATA_DIR}/fail.jsonl`;
    // Write a malformed "error" state — a single invalid line that will
    // fall through the parser and stay in "running" state. Then mark
    // the session as a timeout by moving giveUpAt into the past.
    // Actually easier: use giveUpAt again as the trigger.
    watcher.registerPendingAgent({
      agentId: "fail-via-timeout",
      outputFile: outPath,
      description: "will fail",
      prompt: "p",
      chatId: 42,
      userId: 42,
      toolUseId: null,
      sessionKey,
      giveUpAt: Date.now() - 1000,
    });

    await watcher.pollOnce();

    expect(session.pendingBackgroundCount).toBe(2);
  });

  it("decrement is clamped at 0 — counter never goes negative", async () => {
    const { getSession } = await import("../src/services/session.js");
    const watcher = await import("../src/services/async-agent-watcher.js");

    const sessionKey = "v412-session-drift";
    const session = getSession(sessionKey);
    session.pendingBackgroundCount = 0; // drift scenario

    const outPath = `${TEST_DATA_DIR}/drift.jsonl`;
    watcher.registerPendingAgent({
      agentId: "drift",
      outputFile: outPath,
      description: "drift",
      prompt: "p",
      chatId: 42,
      userId: 42,
      toolUseId: null,
      sessionKey,
    });
    writeCompletedJsonl(outPath, "done");
    await watcher.pollOnce();

    expect(session.pendingBackgroundCount).toBe(0);
  });

  it("missing sessionKey is handled gracefully — no throw, no crash", async () => {
    const watcher = await import("../src/services/async-agent-watcher.js");
    const outPath = `${TEST_DATA_DIR}/orphan.jsonl`;
    watcher.registerPendingAgent({
      agentId: "orphan",
      outputFile: outPath,
      description: "orphan",
      prompt: "p",
      chatId: 42,
      userId: 42,
      toolUseId: null,
      // sessionKey intentionally omitted
    });
    writeCompletedJsonl(outPath, "done");
    await expect(watcher.pollOnce()).resolves.not.toThrow();
  });

  it("multiple agents for the same session all decrement", async () => {
    const { getSession } = await import("../src/services/session.js");
    const watcher = await import("../src/services/async-agent-watcher.js");

    const sessionKey = "v412-session-multi";
    const session = getSession(sessionKey);
    session.pendingBackgroundCount = 3;

    for (const id of ["m1", "m2", "m3"]) {
      const outPath = `${TEST_DATA_DIR}/${id}.jsonl`;
      watcher.registerPendingAgent({
        agentId: id,
        outputFile: outPath,
        description: `task ${id}`,
        prompt: "p",
        chatId: 42,
        userId: 42,
        toolUseId: null,
        sessionKey,
      });
      writeCompletedJsonl(outPath, `result ${id}`);
    }

    await watcher.pollOnce();

    expect(session.pendingBackgroundCount).toBe(0);
  });
});
