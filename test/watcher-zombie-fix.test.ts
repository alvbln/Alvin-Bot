/**
 * v4.14.2 — zombie-entry fix for async-agent-watcher.
 *
 * Problem: when the dispatched `claude -p` subprocess never produces
 * its outputFile (crashed before the first write, spawn failed, file
 * got deleted externally), `parseOutputFileStatus` returns "missing"
 * on every poll. The watcher keeps polling forever until `giveUpAt`
 * (12 hours) fires, then delivers a timeout banner. Meanwhile the
 * entry hangs in `/subagents list` as a permanent "running" zombie.
 *
 * Fix: when status is "missing" for longer than
 * `MISSING_FILE_FAILURE_MS` (default 10 min, env-configurable), the
 * watcher declares the agent failed with a clear "output file never
 * appeared" reason, delivers the failure banner, and removes the
 * entry. 10 minutes is well above normal startup variance (seconds)
 * and well below the 12h hard ceiling.
 *
 * Invariants preserved:
 *   - An agent whose output file DOES appear, even slowly, continues
 *     normally (missing on first poll, running on second, completed
 *     on third — same as v4.14.1).
 *   - The `completed` path (end_turn or stream-json result) is
 *     unchanged.
 *   - The `failed` path (existing "error" state from parser) is
 *     unchanged.
 *   - The 12h giveUpAt ceiling still applies — it's now just less
 *     likely to be hit because missing-file zombies resolve earlier.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(
  os.tmpdir(),
  `alvin-zombie-${process.pid}-${Date.now()}`,
);

interface Delivered {
  info: { name: string; status: string };
  result: { status: string; output: string; error?: string };
}
let delivered: Delivered[] = [];

beforeEach(async () => {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  // Reset the env override between tests
  delete process.env.ALVIN_MISSING_FILE_FAILURE_MS;
  delivered = [];
  vi.resetModules();
  vi.doMock("../src/services/subagent-delivery.js", () => ({
    deliverSubAgentResult: async (info: unknown, result: unknown) => {
      delivered.push({
        info: info as Delivered["info"],
        result: result as Delivered["result"],
      });
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
  } catch {}
  delete process.env.ALVIN_MISSING_FILE_FAILURE_MS;
});

describe("watcher zombie fix (v4.14.2)", () => {
  it("missing file younger than threshold stays pending (no premature fail)", async () => {
    // Threshold = 10 min. Backdate only 2 min. Expect: still pending.
    const mod = await import("../src/services/async-agent-watcher.js");
    mod.registerPendingAgent({
      agentId: "young-zombie",
      outputFile: `${TEST_DATA_DIR}/nonexistent.jsonl`,
      description: "young",
      prompt: "p",
      chatId: 1,
      userId: 1,
      toolUseId: null,
    });
    // Forcibly set startedAt to 2 min ago
    const pending = mod.listPendingAgents();
    expect(pending).toHaveLength(1);
    (pending[0] as { startedAt: number }).startedAt = Date.now() - 2 * 60_000;

    await mod.pollOnce();

    expect(delivered).toHaveLength(0);
    expect(mod.listPendingAgents()).toHaveLength(1);
  });

  it("missing file older than threshold delivers failed + removes from pending", async () => {
    process.env.ALVIN_MISSING_FILE_FAILURE_MS = "120000"; // 2 min for test
    const mod = await import("../src/services/async-agent-watcher.js");
    mod.registerPendingAgent({
      agentId: "old-zombie",
      outputFile: `${TEST_DATA_DIR}/never-appears.jsonl`,
      description: "stuck crash zombie",
      prompt: "p",
      chatId: 1,
      userId: 1,
      toolUseId: null,
    });
    // Backdate 5 min (> 2 min threshold)
    const pending = mod.listPendingAgents();
    (pending[0] as { startedAt: number }).startedAt = Date.now() - 5 * 60_000;

    await mod.pollOnce();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].result.status).toBe("error");
    // Error message should be explicit so user understands
    expect(delivered[0].result.error).toMatch(/output file|never appeared|never wrote/i);
    expect(mod.listPendingAgents()).toHaveLength(0);
  });

  it("default threshold is 10 min when env var is not set", async () => {
    const mod = await import("../src/services/async-agent-watcher.js");
    mod.registerPendingAgent({
      agentId: "at-default",
      outputFile: `${TEST_DATA_DIR}/z.jsonl`,
      description: "default threshold",
      prompt: "p",
      chatId: 1,
      userId: 1,
      toolUseId: null,
    });
    // Backdate 9 min — still under the 10-min default, should stay pending
    let p = mod.listPendingAgents();
    (p[0] as { startedAt: number }).startedAt = Date.now() - 9 * 60_000;
    await mod.pollOnce();
    expect(delivered).toHaveLength(0);
    expect(mod.listPendingAgents()).toHaveLength(1);

    // Backdate to 11 min — over threshold, should fire
    p = mod.listPendingAgents();
    (p[0] as { startedAt: number }).startedAt = Date.now() - 11 * 60_000;
    await mod.pollOnce();
    expect(delivered).toHaveLength(1);
  });

  it("running file (has content, no end_turn) is unaffected by zombie check", async () => {
    // A file WITH content should never trigger the missing-file path
    // regardless of age.
    const outPath = `${TEST_DATA_DIR}/running.jsonl`;
    fs.writeFileSync(
      outPath,
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        agentId: "x",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash", input: {} }],
          stop_reason: "tool_use",
        },
      }) + "\n",
      "utf-8",
    );
    const mod = await import("../src/services/async-agent-watcher.js");
    mod.registerPendingAgent({
      agentId: "active-work",
      outputFile: outPath,
      description: "legitimately running",
      prompt: "p",
      chatId: 1,
      userId: 1,
      toolUseId: null,
    });
    const p = mod.listPendingAgents();
    (p[0] as { startedAt: number }).startedAt = Date.now() - 30 * 60_000; // 30 min old

    await mod.pollOnce();

    // v4.12.4 staleness detection COULD fire here because the file has
    // text content and is stale. That's a different (benign) path — the
    // agent gets delivered as "completed with partial output". Either
    // way, the zombie-fix error path must NOT fire.
    const anyZombieError = delivered.some(
      (d) => d.result.error && /output file never/i.test(d.result.error),
    );
    expect(anyZombieError).toBe(false);
  });

  it("completed file delivers as completed (unchanged)", async () => {
    const outPath = `${TEST_DATA_DIR}/done.jsonl`;
    fs.writeFileSync(
      outPath,
      JSON.stringify({
        type: "assistant",
        agentId: "x",
        message: {
          content: [{ type: "text", text: "all good" }],
          stop_reason: "end_turn",
        },
      }) + "\n",
      "utf-8",
    );
    const mod = await import("../src/services/async-agent-watcher.js");
    mod.registerPendingAgent({
      agentId: "done-agent",
      outputFile: outPath,
      description: "clean completion",
      prompt: "p",
      chatId: 1,
      userId: 1,
      toolUseId: null,
    });
    // Backdate 1h — would trigger zombie if misapplied
    const p = mod.listPendingAgents();
    (p[0] as { startedAt: number }).startedAt = Date.now() - 60 * 60_000;

    await mod.pollOnce();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].result.status).toBe("completed");
  });

  it("decrements session counter on zombie failure delivery", async () => {
    process.env.ALVIN_MISSING_FILE_FAILURE_MS = "1000"; // 1 sec for fast test
    const sessionMod = await import("../src/services/session.js");
    const session = sessionMod.getSession("zombie-session");
    session.pendingBackgroundCount = 1;

    const mod = await import("../src/services/async-agent-watcher.js");
    mod.registerPendingAgent({
      agentId: "session-zombie",
      outputFile: `${TEST_DATA_DIR}/gone.jsonl`,
      description: "zombie for counter",
      prompt: "p",
      chatId: 1,
      userId: 1,
      toolUseId: null,
      sessionKey: "zombie-session",
    });
    const p = mod.listPendingAgents();
    (p[0] as { startedAt: number }).startedAt = Date.now() - 5000; // 5 sec ago, > 1sec threshold

    await mod.pollOnce();

    expect(delivered).toHaveLength(1);
    expect(session.pendingBackgroundCount).toBe(0);
  });
});
