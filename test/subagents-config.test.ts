import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import { resolve } from "path";
import os from "os";

/**
 * Tests for the file-backed sub-agents config.
 *
 * We isolate via ALVIN_DATA_DIR pointing at a temp directory, so the test
 * never touches the real ~/.alvin-bot/sub-agents.json. vi.resetModules()
 * clears Vitest's module cache between tests so each import() gets a
 * fresh module with a fresh configCache.
 */

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-test-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  delete process.env.MAX_SUBAGENTS;
  vi.resetModules(); // force re-import of subagents.ts next time
});

afterEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

describe("sub-agents config", () => {
  it("returns 0 as the configured value on a fresh install", async () => {
    const mod = await import("../src/services/subagents.js");
    expect(mod.getConfiguredMaxParallel()).toBe(0);
  });

  it("resolves 0 to min(cpuCount, 16) in getMaxParallelAgents", async () => {
    const mod = await import("../src/services/subagents.js");
    const effective = mod.getMaxParallelAgents();
    const cpuCount = os.cpus().length;
    expect(effective).toBe(Math.min(cpuCount, 16));
  });

  it("setMaxParallelAgents persists the value to disk", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setMaxParallelAgents(5);
    expect(mod.getConfiguredMaxParallel()).toBe(5);
    expect(mod.getMaxParallelAgents()).toBe(5);

    // Verify file on disk
    const configPath = resolve(TEST_DATA_DIR, "sub-agents.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(persisted.maxParallel).toBe(5);
  });

  it("clamps values above ABSOLUTE_MAX (16) down to 16", async () => {
    const mod = await import("../src/services/subagents.js");
    const effective = mod.setMaxParallelAgents(500);
    expect(effective).toBe(16);
    expect(mod.getConfiguredMaxParallel()).toBe(16);
  });

  it("clamps negative values to 0 (which then resolves to auto)", async () => {
    const mod = await import("../src/services/subagents.js");
    const effective = mod.setMaxParallelAgents(-5);
    expect(mod.getConfiguredMaxParallel()).toBe(0);
    expect(effective).toBe(Math.min(os.cpus().length, 16));
  });

  it("floors fractional values", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setMaxParallelAgents(7.8);
    expect(mod.getConfiguredMaxParallel()).toBe(7);
  });
});

describe("sub-agents visibility config (A4)", () => {
  it("defaults visibility to 'auto' on a fresh install", async () => {
    const mod = await import("../src/services/subagents.js");
    expect(mod.getVisibility()).toBe("auto");
  });

  it("setVisibility persists the value to disk", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setVisibility("banner");
    expect(mod.getVisibility()).toBe("banner");

    const configPath = resolve(TEST_DATA_DIR, "sub-agents.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(persisted.visibility).toBe("banner");
  });

  it("rejects invalid visibility values", async () => {
    const mod = await import("../src/services/subagents.js");
    expect(() => mod.setVisibility("bogus" as "auto")).toThrow(/invalid/i);
  });

  it("accepts 'live' as a valid visibility mode (A4 Stufe 2)", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setVisibility("live");
    expect(mod.getVisibility()).toBe("live");
  });

  it("setVisibility('auto') round-trips through disk", async () => {
    const mod = await import("../src/services/subagents.js");
    mod.setVisibility("banner");
    mod.setVisibility("auto");
    expect(mod.getVisibility()).toBe("auto");
  });
});
