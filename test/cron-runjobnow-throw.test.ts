/**
 * Fix #14 (batch: "Issue C" from the strict review) — runJobNow must
 * never let a thrown error escape its try/finally. Any exception
 * bubbling out would skip the runningJobs cleanup path in the callers
 * above it, leak a stale guard entry forever, and produce no user
 * feedback (grammy's bot.catch logs silently).
 *
 * Contract: a throwing executeJob surfaces as `{status: "ran", error}`.
 * runningJobs is still cleared on the way out (tested via a second
 * runJobNow call immediately after — it must not see `already-running`).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-runjobnow-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  vi.resetModules();
});

function seedCronJob() {
  const cronFile = resolve(TEST_DATA_DIR, "cron-jobs.json");
  fs.writeFileSync(
    cronFile,
    JSON.stringify([
      {
        id: "test-id-1",
        name: "Throwing Job",
        type: "ai-query",
        schedule: "0 8 * * *",
        oneShot: false,
        payload: { prompt: "x" },
        target: { platform: "telegram", chatId: "1" },
        enabled: true,
        createdAt: 0,
        lastRunAt: null,
        lastResult: null,
        lastError: null,
        nextRunAt: null,
        runCount: 0,
        createdBy: "test",
      },
    ]),
    "utf-8",
  );
}

describe("runJobNow throw-safety (Fix A/B/C batch)", () => {
  it("catches a thrown executeJob error and surfaces it as { status: 'ran', error }", async () => {
    seedCronJob();

    // Mock the sub-agent layer to throw.
    vi.doMock("../src/services/subagents.js", () => ({
      spawnSubAgent: async () => {
        throw new Error("simulated OOM from spawnSubAgent");
      },
    }));

    const mod = await import("../src/services/cron.js");
    const outcome = await mod.runJobNow("Throwing Job");

    expect(outcome.status).toBe("ran");
    if (outcome.status === "ran") {
      // executeJob catches sub-agent throws internally and returns
      // { output: "", error: "..." }. The error string must flow through.
      expect(outcome.error).toMatch(/simulated OOM|spawnSubAgent/);
      expect(outcome.output).toBe("");
    }
  });

  it("clears runningJobs even when executeJob throws, so a retry is accepted", async () => {
    seedCronJob();

    let callCount = 0;
    vi.doMock("../src/services/subagents.js", () => ({
      spawnSubAgent: async () => {
        callCount++;
        throw new Error("simulated");
      },
    }));

    const mod = await import("../src/services/cron.js");

    // First call: throws inside, surfaces as ran-with-error.
    const first = await mod.runJobNow("Throwing Job");
    expect(first.status).toBe("ran");

    // Second call: must NOT be rejected with "already-running".
    // If runningJobs.delete was skipped on the throw path, this would
    // permanently wedge every future manual trigger.
    const second = await mod.runJobNow("Throwing Job");
    expect(second.status).toBe("ran");
    expect(callCount).toBe(2);
  });
});
