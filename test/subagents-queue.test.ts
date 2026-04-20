import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

/**
 * Tests for the D3 bounded priority queue.
 */

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-queue-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  delete process.env.MAX_SUBAGENTS;
  vi.resetModules();
});

// Slow generator so the first 2 agents stay "running" while we test
// queueing of subsequent spawns.
vi.mock("../src/engine.js", () => ({
  getRegistry: () => ({
    queryWithFallback: async function* () {
      await new Promise((r) => setTimeout(r, 1000));
      yield { type: "done", text: "ok", inputTokens: 0, outputTokens: 0 };
    },
  }),
}));

describe("sub-agents bounded queue (D3)", () => {
  it("getQueueCap defaults to 20", async () => {
    const mod = await import("../src/services/subagents.js");
    expect(mod.getQueueCap()).toBe(20);
  });

  it("setQueueCap persists to disk and round-trips through reload", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setQueueCap(5);
    expect(mod.getQueueCap()).toBe(5);

    const configPath = resolve(TEST_DATA_DIR, "sub-agents.json");
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(persisted.queueCap).toBe(5);
  });

  it("clamps setQueueCap to [0, ABSOLUTE_MAX_QUEUE]", async () => {
    const mod = await import("../src/services/subagents.js");
    expect(mod.setQueueCap(-5)).toBe(0);
    expect(mod.setQueueCap(500)).toBe(200); // ABSOLUTE_MAX_QUEUE
    expect(mod.setQueueCap(7.9)).toBe(7);
  });

  it("third spawn at full pool lands in the queue as status=queued", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setMaxParallelAgents(2);
    mod.setQueueCap(20);

    await mod.spawnSubAgent({ name: "a", prompt: "x", source: "user" });
    await mod.spawnSubAgent({ name: "b", prompt: "y", source: "user" });
    const id = await mod.spawnSubAgent({ name: "c", prompt: "z", source: "user" });

    const info = mod.listSubAgents().find((a) => a.id === id);
    expect(info?.status).toBe("queued");
    expect(info?.queuePosition).toBe(1);
  });

  it("queue drains automatically when a running agent finishes", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setMaxParallelAgents(2);
    mod.setQueueCap(20);

    await mod.spawnSubAgent({ name: "a", prompt: "x", source: "user" });
    await mod.spawnSubAgent({ name: "b", prompt: "y", source: "user" });
    const cId = await mod.spawnSubAgent({ name: "c", prompt: "z", source: "user" });

    // c is queued
    expect(mod.listSubAgents().find((a) => a.id === cId)?.status).toBe("queued");

    // Wait for the first two to finish (1s each) + drain cycle
    await new Promise((r) => setTimeout(r, 1400));

    // c should now be running or completed
    const cInfo = mod.listSubAgents().find((a) => a.id === cId);
    expect(["running", "completed"]).toContain(cInfo?.status);
  });

  it("priority order: user spawns drain before cron at the same moment", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setMaxParallelAgents(1);
    mod.setQueueCap(20);

    // One running blocker
    await mod.spawnSubAgent({ name: "blocker", prompt: "x", source: "user" });
    // Queue order: cron first, then user — BUT the drain should pick user first
    const cronId = await mod.spawnSubAgent({ name: "cron-q", prompt: "y", source: "cron" });
    const userId = await mod.spawnSubAgent({ name: "user-q", prompt: "z", source: "user" });

    // Wait for blocker to finish and drain
    await new Promise((r) => setTimeout(r, 1200));

    const cronInfo = mod.listSubAgents().find((a) => a.id === cronId);
    const userInfo = mod.listSubAgents().find((a) => a.id === userId);

    // user agent should be running or done; cron should still be queued
    // (because user has higher priority when draining)
    expect(["running", "completed"]).toContain(userInfo?.status);
    expect(cronInfo?.status).toBe("queued");
  });

  it("cancelSubAgent removes a queued entry from the queue", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setMaxParallelAgents(1);
    mod.setQueueCap(20);

    await mod.spawnSubAgent({ name: "blocker", prompt: "x", source: "user" });
    const qId = await mod.spawnSubAgent({ name: "victim", prompt: "y", source: "user" });

    expect(mod.listSubAgents().find((a) => a.id === qId)?.status).toBe("queued");

    const ok = mod.cancelSubAgent(qId);
    expect(ok).toBe(true);

    const info = mod.listSubAgents().find((a) => a.id === qId);
    expect(info?.status).toBe("cancelled");
  });
});
