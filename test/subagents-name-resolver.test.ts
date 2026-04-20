import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-name-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  delete process.env.MAX_SUBAGENTS;
  vi.resetModules();
});

// Long-running engine stub: holds for 500ms so entries stay "running"
// while we interrogate the resolver.
vi.mock("../src/engine.js", () => ({
  getRegistry: () => ({
    queryWithFallback: async function* () {
      await new Promise((r) => setTimeout(r, 500));
      yield { type: "done", text: "ok", inputTokens: 0, outputTokens: 0 };
    },
  }),
}));

describe("sub-agents name resolver (B2)", () => {
  it("spawning a second agent with the same name adds #2 suffix", async () => {
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({ name: "review", prompt: "a" });
    await mod.spawnSubAgent({ name: "review", prompt: "b" });

    const agents = mod.listSubAgents();
    const names = agents.map((a) => a.name).sort();
    expect(names).toEqual(["review", "review#2"]);
  });

  it("spawning a third adds #3 when #2 is also running", async () => {
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({ name: "review", prompt: "a" });
    await mod.spawnSubAgent({ name: "review", prompt: "b" });
    await mod.spawnSubAgent({ name: "review", prompt: "c" });

    const names = mod.listSubAgents().map((a) => a.name).sort();
    expect(names).toEqual(["review", "review#2", "review#3"]);
  });

  it("different base names do not interfere", async () => {
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({ name: "review", prompt: "a" });
    await mod.spawnSubAgent({ name: "scan", prompt: "b" });

    const names = mod.listSubAgents().map((a) => a.name).sort();
    expect(names).toEqual(["review", "scan"]);
  });

  it("findSubAgentByName returns exact match when unambiguous", async () => {
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({ name: "review", prompt: "a" });
    const match = mod.findSubAgentByName("review");
    expect(match).not.toBeNull();
    if (match && !("ambiguous" in match)) {
      expect(match.name).toBe("review");
    }
  });

  it("findSubAgentByName returns null for unknown name", async () => {
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({ name: "review", prompt: "a" });
    expect(mod.findSubAgentByName("ghost")).toBeNull();
  });

  it("findSubAgentByName returns the #N variant when addressed directly", async () => {
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({ name: "review", prompt: "a" });
    await mod.spawnSubAgent({ name: "review", prompt: "b" });
    const match = mod.findSubAgentByName("review#2");
    expect(match).not.toBeNull();
    if (match && !("ambiguous" in match)) {
      expect(match.name).toBe("review#2");
    }
  });

  it("findSubAgentByName with ambiguousAsList still honours exact #N match", async () => {
    // Regression test: the previous implementation checked base-name
    // siblings BEFORE the exact match when ambiguousAsList was set, so
    // queries like findSubAgentByName("review#2", { ambiguousAsList: true })
    // incorrectly returned an ambiguity marker instead of the specific
    // #2 entry. Explicit disambiguation via #N must always win.
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({ name: "review", prompt: "a" });
    await mod.spawnSubAgent({ name: "review", prompt: "b" });

    const match = mod.findSubAgentByName("review#2", { ambiguousAsList: true });
    expect(match).not.toBeNull();
    if (match && "ambiguous" in match) {
      throw new Error(`Expected exact match for 'review#2', got ambiguous marker: ${JSON.stringify(match)}`);
    }
    expect(match?.name).toBe("review#2");
  });

  it("findSubAgentByName returns an ambiguity marker when a basename has >1 variant", async () => {
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({ name: "review", prompt: "a" });
    await mod.spawnSubAgent({ name: "review", prompt: "b" });
    // Query the bare basename that also exists as exact → exact match wins.
    // So we use a non-matching basename form to trigger ambiguity: the
    // basename "review" matches exactly, so we need to query something
    // that is neither exact nor unique — we use the exact query but with
    // an ambiguousAsList opt-in, which should now return the marker
    // because there are two siblings under the "review" base name.
    const result = mod.findSubAgentByName("review", { ambiguousAsList: true });
    // In ambiguous mode, return an object with { ambiguous: true, candidates: [...] }
    expect(result).toMatchObject({
      ambiguous: true,
    });
    if (result && "ambiguous" in result) {
      const names = result.candidates.map((c) => c.name).sort();
      expect(names).toEqual(["review", "review#2"]);
    }
  });
});
