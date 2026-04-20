/**
 * v4.13 — alvin_dispatch custom-tool service.
 *
 * `dispatchDetachedAgent(input)` spawns a truly independent `claude -p`
 * subprocess that survives the parent handler's abort. This is the
 * architectural replacement for SDK's built-in Task(run_in_background)
 * tool, which was tied to the parent SDK subprocess lifecycle.
 *
 * Contract:
 *   - Input: { prompt, description, chatId, userId, sessionKey }
 *   - Output (synchronous): { agentId, outputFile, spawned: true }
 *   - Side effect: spawns detached subprocess writing stream-json
 *     output to outputFile, registers with async-agent-watcher.
 *
 * These tests stub child_process.spawn so they run fast and deterministic.
 * The "real subprocess survives parent" property was verified empirically
 * in Phase A (see plan doc).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import fs from "fs";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(
  os.tmpdir(),
  `alvin-dispatch-${process.pid}-${Date.now()}`,
);

interface SpawnRecord {
  cmd: string;
  args: string[];
  opts: {
    detached?: boolean;
    stdio?: unknown;
    cwd?: string;
    env?: Record<string, string | undefined>;
  };
  unreffed: boolean;
}

let spawned: SpawnRecord[] = [];

beforeEach(async () => {
  if (fs.existsSync(TEST_DATA_DIR))
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  spawned = [];
  vi.resetModules();

  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
    return {
      ...actual,
      spawn: (cmd: string, args: string[], opts: SpawnRecord["opts"]) => {
        const record: SpawnRecord = {
          cmd,
          args,
          opts,
          unreffed: false,
        };
        spawned.push(record);
        return {
          pid: 12345,
          unref() {
            record.unreffed = true;
          },
          on() {},
          kill() {},
        };
      },
    };
  });

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

describe("dispatchDetachedAgent (v4.13)", () => {
  it("spawns claude -p with detached: true and unrefs", async () => {
    const mod = await import("../src/services/alvin-dispatch.js");
    const result = mod.dispatchDetachedAgent({
      prompt: "research X",
      description: "X research",
      chatId: 42,
      userId: 42,
      sessionKey: "s1",
    });
    expect(result.agentId).toMatch(/^alvin-[a-f0-9]{16,}$/);
    expect(result.outputFile).toContain(TEST_DATA_DIR);
    expect(result.spawned).toBe(true);

    expect(spawned).toHaveLength(1);
    const [s] = spawned;
    expect(s.cmd).toMatch(/claude/);
    expect(s.args).toContain("-p");
    expect(s.args).toContain("research X");
    expect(s.args).toContain("--output-format");
    expect(s.args).toContain("stream-json");
    expect(s.opts.detached).toBe(true);
    expect(s.unreffed).toBe(true);
  });

  it("returns unique agentIds for concurrent dispatches", async () => {
    const mod = await import("../src/services/alvin-dispatch.js");
    const r1 = mod.dispatchDetachedAgent({
      prompt: "a",
      description: "a",
      chatId: 1,
      userId: 1,
      sessionKey: "s1",
    });
    const r2 = mod.dispatchDetachedAgent({
      prompt: "b",
      description: "b",
      chatId: 1,
      userId: 1,
      sessionKey: "s1",
    });
    expect(r1.agentId).not.toBe(r2.agentId);
    expect(r1.outputFile).not.toBe(r2.outputFile);
  });

  it("registers the pending agent with the watcher", async () => {
    const mod = await import("../src/services/alvin-dispatch.js");
    const watcher = await import("../src/services/async-agent-watcher.js");

    mod.dispatchDetachedAgent({
      prompt: "x",
      description: "X audit",
      chatId: 42,
      userId: 42,
      sessionKey: "s1",
    });

    const pending = watcher.listPendingAgents();
    expect(pending).toHaveLength(1);
    expect(pending[0].description).toBe("X audit");
    expect(pending[0].sessionKey).toBe("s1");
  });

  it("increments session.pendingBackgroundCount on dispatch", async () => {
    const mod = await import("../src/services/alvin-dispatch.js");
    const { getSession } = await import("../src/services/session.js");

    const session = getSession("s-count");
    session.pendingBackgroundCount = 0;

    mod.dispatchDetachedAgent({
      prompt: "p",
      description: "d",
      chatId: 1,
      userId: 1,
      sessionKey: "s-count",
    });
    expect(session.pendingBackgroundCount).toBe(1);

    mod.dispatchDetachedAgent({
      prompt: "p2",
      description: "d2",
      chatId: 1,
      userId: 1,
      sessionKey: "s-count",
    });
    expect(session.pendingBackgroundCount).toBe(2);
  });

  it("uses stdio redirect so child's stdout goes to outputFile", async () => {
    const mod = await import("../src/services/alvin-dispatch.js");
    mod.dispatchDetachedAgent({
      prompt: "p",
      description: "d",
      chatId: 1,
      userId: 1,
      sessionKey: "s1",
    });
    const [s] = spawned;
    // stdio should be an array with FD redirects (ignore, pipe-to-file, ignore)
    // or similar. We verify it's NOT "inherit" (which would attach to parent).
    expect(s.opts.stdio).not.toBe("inherit");
    expect(s.opts.stdio).not.toBe(undefined);
  });

  it("cleans env of CLAUDECODE/CLAUDE_CODE_ENTRYPOINT to prevent nested session errors", async () => {
    const mod = await import("../src/services/alvin-dispatch.js");
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    try {
      mod.dispatchDetachedAgent({
        prompt: "p",
        description: "d",
        chatId: 1,
        userId: 1,
        sessionKey: "s1",
      });
      const [s] = spawned;
      expect(s.opts.env).toBeDefined();
      expect(s.opts.env?.CLAUDECODE).toBeUndefined();
      expect(s.opts.env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    } finally {
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    }
  });
});
