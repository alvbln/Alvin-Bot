import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-depth-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  delete process.env.MAX_SUBAGENTS;
  vi.resetModules();
});

// Stub the engine so spawnSubAgent doesn't actually invoke any LLM.
vi.mock("../src/engine.js", () => ({
  getRegistry: () => ({
    queryWithFallback: async function* () {
      yield { type: "text", text: "ok" };
      yield { type: "done", text: "ok", inputTokens: 1, outputTokens: 1 };
    },
  }),
}));

describe("sub-agents depth-cap (F2)", () => {
  it("accepts depth 0 (root)", async () => {
    const mod = await import("../src/services/subagents.js");
    const id = await mod.spawnSubAgent({ name: "d0", prompt: "hi", depth: 0 });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("accepts depth 1", async () => {
    const mod = await import("../src/services/subagents.js");
    const id = await mod.spawnSubAgent({ name: "d1", prompt: "hi", depth: 1 });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("accepts depth 2 (the cap)", async () => {
    const mod = await import("../src/services/subagents.js");
    const id = await mod.spawnSubAgent({ name: "d2", prompt: "hi", depth: 2 });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects depth 3 with a clear error", async () => {
    const mod = await import("../src/services/subagents.js");
    await expect(
      mod.spawnSubAgent({ name: "d3", prompt: "hi", depth: 3 }),
    ).rejects.toThrow(/depth limit/i);
  });

  it("defaults depth to 0 when omitted", async () => {
    const mod = await import("../src/services/subagents.js");
    const id = await mod.spawnSubAgent({ name: "nodepth", prompt: "hi" });
    const info = mod.listSubAgents().find((a) => a.id === id);
    expect(info?.depth).toBe(0);
  });
});
