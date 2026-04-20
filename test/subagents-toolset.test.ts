import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-toolset-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  delete process.env.MAX_SUBAGENTS;
  vi.resetModules();
});

vi.mock("../src/engine.js", () => ({
  getRegistry: () => ({
    queryWithFallback: async function* () {
      yield { type: "done", text: "ok", inputTokens: 0, outputTokens: 0 };
    },
  }),
}));

describe("sub-agents toolset (G1, extended v4.12.2)", () => {
  it("accepts toolset='full'", async () => {
    const mod = await import("../src/services/subagents.js");
    const id = await mod.spawnSubAgent({
      name: "tool-full",
      prompt: "hi",
      toolset: "full",
    });
    expect(typeof id).toBe("string");
  });

  it("defaults to 'full' when omitted", async () => {
    const mod = await import("../src/services/subagents.js");
    const id = await mod.spawnSubAgent({ name: "tool-default", prompt: "hi" });
    expect(typeof id).toBe("string");
  });

  it("accepts toolset='readonly' (v4.12.2 — read-only sub-agents)", async () => {
    const mod = await import("../src/services/subagents.js");
    const id = await mod.spawnSubAgent({
      name: "tool-readonly",
      prompt: "hi",
      toolset: "readonly",
    });
    expect(typeof id).toBe("string");
  });

  it("accepts toolset='research' (v4.12.2 — readonly + web)", async () => {
    const mod = await import("../src/services/subagents.js");
    const id = await mod.spawnSubAgent({
      name: "tool-research",
      prompt: "hi",
      toolset: "research",
    });
    expect(typeof id).toBe("string");
  });

  it("rejects unknown toolset values at runtime", async () => {
    const mod = await import("../src/services/subagents.js");
    await expect(
      mod.spawnSubAgent({
        name: "tool-bogus",
        prompt: "hi",
        toolset: "nonsense-preset" as unknown as "full",
      }),
    ).rejects.toThrow(/toolset/i);
  });
});
