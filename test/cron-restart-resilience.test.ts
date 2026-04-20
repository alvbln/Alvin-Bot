/**
 * Fix #3 — Cron scheduler must survive a bot restart during job execution.
 *
 * Background: the old scheduler set `nextRunAt = null` immediately before
 * `await executeJob(job)` and only re-calculated it after completion. A
 * crash mid-execution (EADDRINUSE, unhandled rejection, launchd restart)
 * left `nextRunAt = null`, so the next boot called `calculateNextRun()`
 * from the current time — which for a cron expression always yields a
 * FUTURE trigger (e.g. tomorrow 08:00). Today's run was lost forever.
 *
 * New contract (pure-function pair):
 *
 *   prepareForExecution(job, now)
 *     - updates lastAttemptAt = now
 *     - updates nextRunAt = <next regular trigger from `now`>
 *     - returns the mutated job
 *
 *   handleStartupCatchup(jobs, now, graceMs)
 *     - for every enabled job where `lastAttemptAt > lastRunAt`
 *       (i.e. the last attempt never completed) AND the attempt is
 *       within `graceMs`, rewinds `nextRunAt` to `now` so the next
 *       scheduler tick picks it up immediately
 *     - for every enabled job where `lastAttemptAt > lastRunAt` but
 *       the attempt is older than `graceMs`, gives up and recalculates
 *       `nextRunAt` normally
 *     - never touches disabled jobs
 *     - returns a NEW array of jobs (pure, no mutation of input)
 */
import { describe, it, expect } from "vitest";
import {
  prepareForExecution,
  handleStartupCatchup,
} from "../src/services/cron-scheduling.js";
import type { CronJob } from "../src/services/cron.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "Daily Job Alert",
    type: "ai-query",
    schedule: "00 08 * * *",
    oneShot: false,
    payload: { prompt: "x" },
    target: { platform: "telegram", chatId: "1" },
    enabled: true,
    createdAt: 1_700_000_000_000,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    nextRunAt: null,
    runCount: 0,
    createdBy: "test",
    ...overrides,
  };
}

describe("prepareForExecution (Fix #3)", () => {
  it("sets lastAttemptAt to now", () => {
    const job = makeJob();
    const now = 1_775_887_200_000; // 2026-04-11 08:00 Berlin
    const updated = prepareForExecution(job, now);
    expect(updated.lastAttemptAt).toBe(now);
  });

  it("advances nextRunAt to the NEXT regular trigger, not null", () => {
    const job = makeJob({ schedule: "00 08 * * *" });
    const now = 1_775_887_200_000; // today 08:00
    const updated = prepareForExecution(job, now);
    // nextRunAt must be a future timestamp, not null, not zero
    expect(updated.nextRunAt).not.toBeNull();
    expect(updated.nextRunAt!).toBeGreaterThan(now);
  });

  it("works with interval schedules — base = now, not lastRunAt", () => {
    const job = makeJob({ schedule: "5m", lastRunAt: 1_000_000_000_000 });
    const now = 1_775_887_200_000;
    const updated = prepareForExecution(job, now);
    expect(updated.nextRunAt).toBe(now + 5 * 60_000);
  });

  it("does not touch lastRunAt", () => {
    const job = makeJob({ lastRunAt: 123 });
    const updated = prepareForExecution(job, 9999);
    expect(updated.lastRunAt).toBe(123);
  });

  it("is pure — returns a new object, leaves the input alone", () => {
    const job = makeJob();
    const before = JSON.stringify(job);
    prepareForExecution(job, 42);
    expect(JSON.stringify(job)).toBe(before);
  });
});

describe("handleStartupCatchup (Fix #3)", () => {
  const GRACE = 6 * 60 * 60 * 1000; // 6 h

  it("rewinds nextRunAt to now when a recent attempt never completed", () => {
    // Scenario: 08:00 triggered, 08:05 bot crashed, 10:30 bot restarts.
    const job = makeJob({
      lastRunAt: null,                              // never completed
      lastAttemptAt: 1_775_887_200_000,             // 08:00
      nextRunAt: 1_775_973_600_000,                 // tomorrow 08:00 (set pre-execution)
    });
    const now = 1_775_896_200_000;                  // 10:30
    const [out] = handleStartupCatchup([job], now, GRACE);
    expect(out.nextRunAt).toBe(now); // rewind → picked up on next tick
  });

  it("does not rewind when attempt completed (lastRunAt >= lastAttemptAt)", () => {
    const tomorrow8am = 1_775_973_600_000;
    const job = makeJob({
      lastRunAt: 1_775_896_200_000,                 // completed at 10:30
      lastAttemptAt: 1_775_887_200_000,             // started at 08:00
      nextRunAt: tomorrow8am,
    });
    const now = 1_775_900_000_000;
    const [out] = handleStartupCatchup([job], now, GRACE);
    expect(out.nextRunAt).toBe(tomorrow8am); // unchanged
  });

  it("gives up when the attempt is older than the grace window", () => {
    // Scenario: attempt was 7h ago, never completed, bot only now back up.
    const sevenHoursAgo = 1_775_887_200_000 - 60_000;
    const now = sevenHoursAgo + 7 * 60 * 60 * 1000 + 60_000;
    const job = makeJob({
      lastRunAt: null,
      lastAttemptAt: sevenHoursAgo,
      nextRunAt: now + 86_400_000, // whatever — scheduler will replace
    });
    const [out] = handleStartupCatchup([job], now, GRACE);
    // Must NOT rewind to `now`. Must either keep the future value or
    // recompute — either way it has to stay strictly greater than now.
    expect(out.nextRunAt).not.toBe(now);
    expect(out.nextRunAt!).toBeGreaterThan(now);
  });

  it("ignores disabled jobs", () => {
    const job = makeJob({
      enabled: false,
      lastRunAt: null,
      lastAttemptAt: 1_775_887_200_000,
      nextRunAt: 1_775_973_600_000,
    });
    const now = 1_775_896_200_000;
    const [out] = handleStartupCatchup([job], now, GRACE);
    expect(out).toEqual(job); // untouched
  });

  it("handles jobs without any attempt history (no-op)", () => {
    const job = makeJob({
      lastRunAt: null,
      lastAttemptAt: null,
      nextRunAt: 1_775_973_600_000,
    });
    const now = 1_775_896_200_000;
    const [out] = handleStartupCatchup([job], now, GRACE);
    expect(out).toEqual(job);
  });

  it("is pure — does not mutate the input array", () => {
    const job = makeJob({
      lastRunAt: null,
      lastAttemptAt: 1_775_887_200_000,
      nextRunAt: 1_775_973_600_000,
    });
    const input = [job];
    const snapshot = JSON.stringify(input);
    handleStartupCatchup(input, 1_775_896_200_000, GRACE);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("processes multiple jobs independently", () => {
    const now = 1_775_896_200_000;
    const recent = makeJob({
      id: "a",
      lastRunAt: null,
      lastAttemptAt: 1_775_887_200_000, // within grace
      nextRunAt: 1_775_973_600_000,
    });
    const completed = makeJob({
      id: "b",
      lastRunAt: 1_775_887_500_000,
      lastAttemptAt: 1_775_887_200_000,
      nextRunAt: 1_775_973_600_000,
    });
    const out = handleStartupCatchup([recent, completed], now, GRACE);
    expect(out[0].nextRunAt).toBe(now);            // caught up
    expect(out[1].nextRunAt).toBe(1_775_973_600_000); // untouched
  });
});
