import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-inherit-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  delete process.env.MAX_SUBAGENTS;
  vi.resetModules();
});

// Capture what queryWithFallback is called with, so we can inspect workingDir.
let capturedOptions: Record<string, unknown> | null = null;

vi.mock("../src/engine.js", () => ({
  getRegistry: () => ({
    queryWithFallback: async function* (options: Record<string, unknown>) {
      capturedOptions = options;
      yield { type: "text", text: "ok" };
      yield { type: "done", text: "ok", inputTokens: 0, outputTokens: 0 };
    },
  }),
}));

// Small sleep helper — spawnSubAgent is fire-and-forget, we wait for the
// background task to reach queryWithFallback.
const tick = () => new Promise((r) => setTimeout(r, 50));

describe("sub-agents inheritance (C3)", () => {
  beforeEach(() => {
    capturedOptions = null;
  });

  it("passes the provided workingDir to queryWithFallback", async () => {
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({
      name: "cwd-test",
      prompt: "hi",
      workingDir: "/tmp/inherited-project",
    });
    await tick();
    expect(capturedOptions?.workingDir).toBe("/tmp/inherited-project");
  });

  it("falls back to os.homedir() when workingDir is not provided", async () => {
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({ name: "no-cwd", prompt: "hi" });
    await tick();
    expect(capturedOptions?.workingDir).toBe(os.homedir());
  });

  it("respects inheritCwd=false by defaulting to homedir regardless of workingDir", async () => {
    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({
      name: "no-inherit",
      prompt: "hi",
      workingDir: "/tmp/should-be-ignored",
      inheritCwd: false,
    });
    await tick();
    expect(capturedOptions?.workingDir).toBe(os.homedir());
  });
});
