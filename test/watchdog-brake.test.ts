/**
 * Fix #4 — Watchdog brake must actually engage on chronic crashes.
 *
 * Regression: the previous logic reset crashCount after 5 min of clean
 * uptime. Production logs showed the bot crashing ~5 times per hour, but
 * each boot lived just long enough (>5 min, <10 min) to reset the counter.
 * Result: `crashCount` never reached the brake threshold, the bot cycled
 * for hours, and the daily job-alert silently lost its scheduled runs.
 *
 * New contract (pure function pair extracted to watchdog-brake.ts):
 *
 *   decideBrakeAction(prevBeacon, now, opts)
 *     - returns `{ action: "proceed", crashCount, crashWindowStart }`
 *       on clean start or old previous beacon
 *     - returns `{ action: "proceed", crashCount: N }` when the last run
 *       exited recently but we're still under the brake threshold
 *     - returns `{ action: "brake", reason }` when either
 *         (a) N+1 crashes in a short window, or
 *         (b) the daily crash cap (default 20) is exceeded
 *
 *   shouldResetCrashCounter(uptimeMs, opts) → boolean
 *     - default policy: only reset after 1 h of clean uptime (NOT 5 min)
 */
import { describe, it, expect } from "vitest";
import {
  decideBrakeAction,
  shouldResetCrashCounter,
  DEFAULTS,
  type BeaconData,
} from "../src/services/watchdog-brake.js";

const ONE_MIN = 60_000;
const ONE_HOUR = 60 * ONE_MIN;

function beacon(partial: Partial<BeaconData> = {}): BeaconData {
  return {
    lastBeat: 0,
    pid: 1,
    bootTime: 0,
    crashCount: 0,
    crashWindowStart: 0,
    dailyCrashCount: 0,
    dailyCrashWindowStart: 0,
    version: "test",
    ...partial,
  };
}

describe("decideBrakeAction (Fix #4)", () => {
  it("proceeds on first boot (no previous beacon)", () => {
    const now = 1_000_000;
    const result = decideBrakeAction(null, now);
    expect(result.action).toBe("proceed");
    if (result.action === "proceed") {
      expect(result.crashCount).toBe(0);
      expect(result.crashWindowStart).toBe(now);
      expect(result.dailyCrashCount).toBe(0);
    }
  });

  it("proceeds when previous beacon is old (>STALE_MS) — clean exit", () => {
    const now = 1_000_000_000;
    const prev = beacon({ lastBeat: now - 10 * ONE_MIN, crashCount: 3 });
    const result = decideBrakeAction(prev, now);
    expect(result.action).toBe("proceed");
    if (result.action === "proceed") {
      // Old beacon → treat as clean, reset window counter (but keep daily)
      expect(result.crashCount).toBe(0);
    }
  });

  it("counts a restart after a fresh beacon as a crash", () => {
    const now = 1_000_000_000;
    const prev = beacon({
      lastBeat: now - 15_000, // 15 s ago
      crashCount: 2,
      crashWindowStart: now - 5 * ONE_MIN,
      dailyCrashCount: 2,
      dailyCrashWindowStart: now - 2 * ONE_HOUR,
    });
    const result = decideBrakeAction(prev, now);
    expect(result.action).toBe("proceed");
    if (result.action === "proceed") {
      expect(result.crashCount).toBe(3);
      expect(result.dailyCrashCount).toBe(3);
    }
  });

  it("engages brake when short-window threshold is crossed", () => {
    const now = 1_000_000_000;
    const prev = beacon({
      lastBeat: now - 10_000,
      crashCount: DEFAULTS.SHORT_BRAKE_THRESHOLD - 1, // one more = brake
      crashWindowStart: now - 2 * ONE_MIN,
      dailyCrashCount: 5,
      dailyCrashWindowStart: now - ONE_HOUR,
    });
    const result = decideBrakeAction(prev, now);
    expect(result.action).toBe("brake");
    if (result.action === "brake") {
      expect(result.reason).toMatch(/short.*window|threshold|crashes/i);
    }
  });

  it("engages brake when daily cap is exceeded", () => {
    const now = 1_000_000_000;
    const prev = beacon({
      lastBeat: now - 10_000,
      crashCount: 1, // short window fine
      crashWindowStart: now - 30 * ONE_MIN,
      dailyCrashCount: DEFAULTS.DAILY_BRAKE_THRESHOLD - 1,
      dailyCrashWindowStart: now - 12 * ONE_HOUR,
    });
    const result = decideBrakeAction(prev, now);
    expect(result.action).toBe("brake");
    if (result.action === "brake") {
      expect(result.reason).toMatch(/daily|day/i);
    }
  });

  it("rolls over daily counter when 24h window expires", () => {
    const now = 1_000_000_000;
    const prev = beacon({
      lastBeat: now - 10_000,
      crashCount: 1,
      crashWindowStart: now - 30 * ONE_MIN,
      dailyCrashCount: 18,                  // high
      dailyCrashWindowStart: now - 25 * ONE_HOUR, // but window rolled over
    });
    const result = decideBrakeAction(prev, now);
    expect(result.action).toBe("proceed");
    if (result.action === "proceed") {
      expect(result.dailyCrashCount).toBe(1); // fresh window
      expect(result.dailyCrashWindowStart).toBe(now);
    }
  });
});

describe("shouldResetCrashCounter (Fix #4)", () => {
  it("does NOT reset after 5 min of uptime (old buggy behaviour)", () => {
    expect(shouldResetCrashCounter(5 * ONE_MIN)).toBe(false);
  });

  it("does NOT reset after 30 min of uptime", () => {
    expect(shouldResetCrashCounter(30 * ONE_MIN)).toBe(false);
  });

  it("resets after 1 h of clean uptime", () => {
    expect(shouldResetCrashCounter(ONE_HOUR)).toBe(true);
    expect(shouldResetCrashCounter(ONE_HOUR + 1)).toBe(true);
  });

  it("can be overridden via opts.resetAfterMs", () => {
    expect(shouldResetCrashCounter(10 * ONE_MIN, { resetAfterMs: 10 * ONE_MIN })).toBe(true);
    expect(shouldResetCrashCounter(10 * ONE_MIN - 1, { resetAfterMs: 10 * ONE_MIN })).toBe(false);
  });
});
