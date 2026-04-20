import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-reject-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  process.env.MAX_SUBAGENTS = "2";
  vi.resetModules();
});

// Long-running engine stub — holds agents in 'running' state
vi.mock("../src/engine.js", () => ({
  getRegistry: () => ({
    queryWithFallback: async function* () {
      await new Promise((r) => setTimeout(r, 5000));
      yield { type: "done", text: "ok", inputTokens: 0, outputTokens: 0 };
    },
  }),
}));

describe("priority-aware reject (D4) — queue disabled", () => {
  // With queueCap=0 the bounded queue is disabled, so hitting the max
  // parallel limit triggers immediate rejection — the D4 messages.
  it("user-spawn message points out cron/implicit jobs hold the slots", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setMaxParallelAgents(2);
    mod.setQueueCap(0);

    await mod.spawnSubAgent({ name: "bg-1", prompt: "x", source: "cron" });
    await mod.spawnSubAgent({ name: "bg-2", prompt: "y", source: "implicit" });

    await expect(
      mod.spawnSubAgent({ name: "user-new", prompt: "z", source: "user" }),
    ).rejects.toThrow(/cron\/implicit|Hintergrund/i);
  });

  it("user-spawn message blames user agents when they hold all slots", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setMaxParallelAgents(2);
    mod.setQueueCap(0);

    await mod.spawnSubAgent({ name: "u1", prompt: "x", source: "user" });
    await mod.spawnSubAgent({ name: "u2", prompt: "y", source: "user" });

    await expect(
      mod.spawnSubAgent({ name: "u3", prompt: "z", source: "user" }),
    ).rejects.toThrow(/user-spawns|cancel/i);
  });

  it("cron and implicit rejects use the generic message", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setMaxParallelAgents(1);
    mod.setQueueCap(0);

    await mod.spawnSubAgent({ name: "first", prompt: "x", source: "user" });
    await expect(
      mod.spawnSubAgent({ name: "cron-new", prompt: "y", source: "cron" }),
    ).rejects.toThrow(/limit reached/i);
  });
});

describe("priority-aware reject (D4) — queue enabled", () => {
  // With a queue, reject only fires when BOTH the running pool and the
  // queue are full. Queue-enabled rejections still carry the priority-
  // aware messages because the code path is shared.
  it("user-spawn rejects with cron-in-queue message when pool + queue are full", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setMaxParallelAgents(2);
    mod.setQueueCap(2);

    // Fill the running pool with cron agents
    await mod.spawnSubAgent({ name: "bg-1", prompt: "x", source: "cron" });
    await mod.spawnSubAgent({ name: "bg-2", prompt: "y", source: "implicit" });
    // Fill the queue with 2 more
    await mod.spawnSubAgent({ name: "q-1", prompt: "z", source: "cron" });
    await mod.spawnSubAgent({ name: "q-2", prompt: "z", source: "cron" });

    // Now a user spawn has nowhere to go → reject
    await expect(
      mod.spawnSubAgent({ name: "user-new", prompt: "w", source: "user" }),
    ).rejects.toThrow(/Queue voll|Hintergrund/i);
  });
});
