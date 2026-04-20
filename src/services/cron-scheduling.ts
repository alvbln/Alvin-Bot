/**
 * Pure scheduling helpers for the cron service.
 *
 * Extracted from cron.ts so the startup-catchup and pre-execution state
 * updates can be unit-tested without booting the full scheduler loop.
 * This module is side-effect-free: it does not touch the filesystem, the
 * clock, or the sub-agent registry. Give it jobs + a `now` value and it
 * returns what the next state should look like.
 *
 * Background — see test/cron-restart-resilience.test.ts for the exact
 * contract and the regression it closes.
 */

import type { CronJob } from "./cron.js";

// ── Pure parsers ────────────────────────────────────────────
//
// These mirror parseInterval / nextCronRun from cron.ts. We duplicate them
// intentionally instead of importing — cron.ts is the scheduler-with-side-
// effects, and importing it from a "pure" helper would reintroduce the
// circular dependency we just broke. The duplication is small and well
// covered by tests; keep the two in sync when editing.

function parseInterval(input: string): number | null {
  const match = input.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)s?$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const mult: Record<string, number> = {
    s: 1000, sec: 1000, m: 60_000, min: 60_000,
    h: 3_600_000, hr: 3_600_000, d: 86_400_000, day: 86_400_000,
  };
  return value * (mult[unit] || 60_000);
}

function nextCronRun(expression: string, after: Date): Date | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minExpr, hourExpr, dayExpr, monthExpr, weekdayExpr] = parts;

  function parseField(expr: string, min: number, max: number): number[] {
    if (expr === "*") return Array.from({ length: max - min + 1 }, (_, i) => i + min);
    if (expr.includes("/")) {
      const [, step] = expr.split("/");
      const s = parseInt(step);
      return Array.from({ length: max - min + 1 }, (_, i) => i + min).filter((v) => v % s === 0);
    }
    if (expr.includes(",")) return expr.split(",").map(Number);
    if (expr.includes("-")) {
      const [a, b] = expr.split("-").map(Number);
      return Array.from({ length: b - a + 1 }, (_, i) => i + a);
    }
    return [parseInt(expr)];
  }

  const minutes = parseField(minExpr, 0, 59);
  const hours = parseField(hourExpr, 0, 23);
  const days = parseField(dayExpr, 1, 31);
  const months = parseField(monthExpr, 1, 12);
  const weekdays = parseField(weekdayExpr, 0, 6);

  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60; i++) {
    const m = candidate.getMinutes();
    const h = candidate.getHours();
    const d = candidate.getDate();
    const mo = candidate.getMonth() + 1;
    const wd = candidate.getDay();
    if (
      minutes.includes(m) &&
      hours.includes(h) &&
      days.includes(d) &&
      months.includes(mo) &&
      weekdays.includes(wd)
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

/** Compute the next run relative to an explicit base timestamp.
 *  Used by prepareForExecution to make the interval calculation stable
 *  even when `lastRunAt` is stale or null. */
export function calculateNextRunFrom(job: CronJob, base: number): number | null {
  if (!job.enabled) return null;
  const intervalMs = parseInterval(job.schedule);
  if (intervalMs) return base + intervalMs;
  const next = nextCronRun(job.schedule, new Date(base));
  return next ? next.getTime() : null;
}

// ── Pre-execution state update ─────────────────────────────

/**
 * Mark a job as "being attempted" and advance `nextRunAt` to the next
 * regular trigger, pure-functionally. Returns a NEW job object.
 *
 * Why not set `nextRunAt = null`: if the bot crashes between this call
 * and the post-execution save, we still know when the next regular run
 * is — the scheduler simply won't re-trigger. The `lastAttemptAt >
 * lastRunAt` asymmetry is then the signal for handleStartupCatchup to
 * nachholen the current attempt on the next boot.
 */
export function prepareForExecution(job: CronJob, now: number): CronJob {
  return {
    ...job,
    lastAttemptAt: now,
    nextRunAt: calculateNextRunFrom(job, now),
  };
}

// ── Startup catch-up ───────────────────────────────────────

/** Default grace window for catching up an interrupted attempt on boot. */
export const DEFAULT_CATCHUP_GRACE_MS = 6 * 60 * 60 * 1000; // 6 h

/**
 * Rewind `nextRunAt` to `now` for every enabled job whose most recent
 * attempt never completed AND is still inside the grace window. This
 * makes the very next scheduler tick pick the job up again, without
 * double-firing jobs that actually finished.
 *
 * Jobs whose crashed attempt is older than the grace window are NOT
 * caught up — the assumption is that such a run is too stale to be
 * meaningful (a "daily" run from yesterday isn't what the user wants
 * at 2pm today). Those jobs keep their scheduled future nextRunAt.
 *
 * PURE: returns a fresh array, never mutates the input.
 */
export function handleStartupCatchup(
  jobs: CronJob[],
  now: number,
  graceMs: number = DEFAULT_CATCHUP_GRACE_MS,
): CronJob[] {
  return jobs.map((job) => {
    if (!job.enabled) return job;
    if (!job.lastAttemptAt) return job;

    const completed =
      typeof job.lastRunAt === "number" &&
      job.lastRunAt >= job.lastAttemptAt;
    if (completed) return job;

    const ageMs = now - job.lastAttemptAt;
    if (ageMs <= 0) return job;                // clock weirdness — skip
    if (ageMs > graceMs) return job;           // outside grace — give up

    // Within grace, never completed → catch up on next tick.
    return { ...job, nextRunAt: now };
  });
}
