import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";
import type { SubAgentInfo, SubAgentResult } from "../src/services/subagents.js";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-stats-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  vi.resetModules();
});

function makeInfo(overrides: Partial<SubAgentInfo> = {}): SubAgentInfo {
  return {
    id: "x",
    name: "test",
    status: "completed",
    startedAt: Date.now() - 1000,
    source: "user",
    depth: 0,
    ...overrides,
  };
}

function makeResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    id: "x",
    name: "test",
    status: "completed",
    output: "ok",
    tokensUsed: { input: 100, output: 50 },
    duration: 1000,
    ...overrides,
  };
}

describe("subagent-stats (H3)", () => {
  it("getSubAgentStats returns zeros on a fresh install", async () => {
    const mod = await import("../src/services/subagent-stats.js");
    const stats = mod.getSubAgentStats();
    expect(stats.total.runs).toBe(0);
    expect(stats.bySource.user.runs).toBe(0);
    expect(stats.byStatus.completed).toBe(0);
  });

  it("recordSubAgentRun appends and updates totals", async () => {
    const mod = await import("../src/services/subagent-stats.js");
    mod.recordSubAgentRun(makeInfo({ source: "user" }), makeResult({ tokensUsed: { input: 100, output: 50 } }));
    mod.recordSubAgentRun(makeInfo({ source: "cron" }), makeResult({ tokensUsed: { input: 200, output: 75 } }));
    mod.recordSubAgentRun(makeInfo({ source: "user" }), makeResult({ tokensUsed: { input: 50, output: 25 } }));

    const stats = mod.getSubAgentStats();
    expect(stats.total.runs).toBe(3);
    expect(stats.total.inputTokens).toBe(350);
    expect(stats.total.outputTokens).toBe(150);
    expect(stats.bySource.user.runs).toBe(2);
    expect(stats.bySource.user.inputTokens).toBe(150);
    expect(stats.bySource.cron.runs).toBe(1);
    expect(stats.bySource.cron.inputTokens).toBe(200);
    expect(stats.byStatus.completed).toBe(3);
  });

  it("persists to disk and round-trips through reload", async () => {
    let mod = await import("../src/services/subagent-stats.js");
    mod.recordSubAgentRun(makeInfo({ source: "cron" }), makeResult());

    // Force a reload by resetting modules
    vi.resetModules();
    mod = await import("../src/services/subagent-stats.js");

    const stats = mod.getSubAgentStats();
    expect(stats.total.runs).toBe(1);
    expect(stats.bySource.cron.runs).toBe(1);
  });

  it("prunes entries older than 24h", async () => {
    const mod = await import("../src/services/subagent-stats.js");
    // Seed the file with an entry from 25 hours ago
    const ancient = [
      {
        completedAt: Date.now() - 25 * 60 * 60 * 1000,
        name: "ancient",
        source: "user",
        status: "completed",
        durationMs: 100,
        inputTokens: 999,
        outputTokens: 999,
      },
    ];
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "subagent-stats.json"),
      JSON.stringify(ancient),
    );
    mod.__resetStatsCacheForTest();

    // Fresh read should exclude the ancient entry
    const stats = mod.getSubAgentStats();
    expect(stats.total.runs).toBe(0);
    expect(stats.total.inputTokens).toBe(0);
  });

  it("tracks byStatus separately for cancelled/error/timeout", async () => {
    const mod = await import("../src/services/subagent-stats.js");
    mod.recordSubAgentRun(makeInfo(), makeResult({ status: "completed" }));
    mod.recordSubAgentRun(makeInfo(), makeResult({ status: "cancelled" }));
    mod.recordSubAgentRun(makeInfo(), makeResult({ status: "error" }));
    mod.recordSubAgentRun(makeInfo(), makeResult({ status: "timeout" }));
    mod.recordSubAgentRun(makeInfo(), makeResult({ status: "completed" }));

    const stats = mod.getSubAgentStats();
    expect(stats.byStatus.completed).toBe(2);
    expect(stats.byStatus.cancelled).toBe(1);
    expect(stats.byStatus.error).toBe(1);
    expect(stats.byStatus.timeout).toBe(1);
  });
});
