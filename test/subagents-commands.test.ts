import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-cmds-${process.pid}-${Date.now()}`);

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
      await new Promise((r) => setTimeout(r, 500));
      yield { type: "done", text: "ok", inputTokens: 0, outputTokens: 0 };
    },
  }),
}));

describe("cancelSubAgentByName / getSubAgentResultByName (B2 helpers)", () => {
  it("cancels an agent by its exact name", async () => {
    const mod = await import("../src/services/subagents.js");
    const id = await mod.spawnSubAgent({ name: "foo", prompt: "a" });
    const ok = mod.cancelSubAgentByName("foo");
    expect(ok).toBe(true);

    const info = mod.listSubAgents().find((a) => a.id === id);
    expect(info?.status).toBe("cancelled");
  });

  it("cancels the base-name when unambiguous", async () => {
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({ name: "bar", prompt: "a" });
    expect(mod.cancelSubAgentByName("bar")).toBe(true);
  });

  it("returns false for unknown name", async () => {
    const mod = await import("../src/services/subagents.js");
    expect(mod.cancelSubAgentByName("ghost")).toBe(false);
  });

  it("cancels the #N variant when addressed directly", async () => {
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({ name: "baz", prompt: "a" });
    await mod.spawnSubAgent({ name: "baz", prompt: "b" });
    const ok = mod.cancelSubAgentByName("baz#2");
    expect(ok).toBe(true);

    const agents = mod.listSubAgents();
    const canceledNames = agents.filter((a) => a.status === "cancelled").map((a) => a.name);
    expect(canceledNames).toEqual(["baz#2"]);
  });

  it("getSubAgentResultByName returns null when still running", async () => {
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({ name: "running", prompt: "a" });
    expect(mod.getSubAgentResultByName("running")).toBeNull();
  });
});
