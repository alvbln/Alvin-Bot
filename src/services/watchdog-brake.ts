/**
 * Pure crash-loop brake logic, extracted from watchdog.ts so it can be
 * unit-tested without touching the filesystem or launchctl.
 *
 * See test/watchdog-brake.test.ts for the regression this closes:
 * chronic crashes with >5 min of uptime between them used to reset
 * the counter before it could trip the brake, so the bot cycled
 * indefinitely. The new policy enforces TWO thresholds — a fast
 * short-window brake and a hard 24h daily cap — and only resets the
 * counter after a real 1 h of clean uptime.
 */

export const DEFAULTS = {
  /** Beacon older than this → previous process exited cleanly (or the
   *  machine was rebooted); do not count as a crash. */
  STALE_BEACON_MS: 90_000,

  /** Short-window crash tracking — N crashes in SHORT_WINDOW_MS. */
  SHORT_WINDOW_MS: 10 * 60_000,
  SHORT_BRAKE_THRESHOLD: 10,

  /** Daily crash cap — hard ceiling regardless of gaps. Tripping this
   *  means the bot has been restarting >20 times per day, which is
   *  almost certainly a chronic issue worth freezing and alerting. */
  DAILY_WINDOW_MS: 24 * 60 * 60 * 1000,
  DAILY_BRAKE_THRESHOLD: 20,

  /** Uptime required before the short-window counter resets. Was 5 min
   *  in the buggy version — but 5 min is shorter than the typical
   *  sub-agent lifetime (the daily job-alert takes 10+ min), so chronic
   *  crashes with ≥5 min gaps sailed right past the brake. 1 h is safer. */
  RESET_AFTER_MS: 60 * 60_000,
} as const;

export interface BeaconData {
  lastBeat: number;
  pid: number;
  bootTime: number;
  crashCount: number;
  crashWindowStart: number;
  /** 24h rolling crash counter, independent of the short window. */
  dailyCrashCount: number;
  dailyCrashWindowStart: number;
  version: string;
}

export type BrakeAction =
  | {
      action: "proceed";
      crashCount: number;
      crashWindowStart: number;
      dailyCrashCount: number;
      dailyCrashWindowStart: number;
    }
  | { action: "brake"; reason: string };

export interface DecideBrakeOpts {
  staleBeaconMs?: number;
  shortWindowMs?: number;
  shortBrakeThreshold?: number;
  dailyWindowMs?: number;
  dailyBrakeThreshold?: number;
}

/**
 * Given the previous beacon (or null on first boot) and the current time,
 * decide whether the bot should proceed with boot or engage the crash-loop
 * brake.
 *
 * PURE: no fs, no launchctl, no clock — `now` is an explicit parameter.
 */
export function decideBrakeAction(
  previous: BeaconData | null,
  now: number,
  opts: DecideBrakeOpts = {},
): BrakeAction {
  const staleMs = opts.staleBeaconMs ?? DEFAULTS.STALE_BEACON_MS;
  const shortWindow = opts.shortWindowMs ?? DEFAULTS.SHORT_WINDOW_MS;
  const shortBrake = opts.shortBrakeThreshold ?? DEFAULTS.SHORT_BRAKE_THRESHOLD;
  const dailyWindow = opts.dailyWindowMs ?? DEFAULTS.DAILY_WINDOW_MS;
  const dailyBrake = opts.dailyBrakeThreshold ?? DEFAULTS.DAILY_BRAKE_THRESHOLD;

  // First boot or no beacon file → clean start
  if (!previous) {
    return {
      action: "proceed",
      crashCount: 0,
      crashWindowStart: now,
      dailyCrashCount: 0,
      dailyCrashWindowStart: now,
    };
  }

  // Daily window roll-over first — it's independent of short window.
  let dailyCount = previous.dailyCrashCount;
  let dailyStart = previous.dailyCrashWindowStart;
  if (now - dailyStart >= dailyWindow) {
    dailyCount = 0;
    dailyStart = now;
  }

  const timeSinceLastBeat = now - previous.lastBeat;
  const previousExitedRecently = timeSinceLastBeat < staleMs;

  if (!previousExitedRecently) {
    // Clean exit (or machine reboot between runs) → short-window counter
    // resets, but the daily counter keeps going unless its own window
    // already expired above.
    return {
      action: "proceed",
      crashCount: 0,
      crashWindowStart: now,
      dailyCrashCount: dailyCount,
      dailyCrashWindowStart: dailyStart,
    };
  }

  // Short-window logic
  const shortWindowExpired = now - previous.crashWindowStart >= shortWindow;
  let crashCount: number;
  let crashWindowStart: number;
  if (shortWindowExpired) {
    crashCount = 1;
    crashWindowStart = now;
  } else {
    crashCount = previous.crashCount + 1;
    crashWindowStart = previous.crashWindowStart;
  }

  // Increment daily count since we treat this as a crash
  dailyCount += 1;

  if (crashCount >= shortBrake) {
    return {
      action: "brake",
      reason: `${crashCount} crashes within short window (${Math.round(shortWindow / 60_000)}min) — threshold is ${shortBrake}`,
    };
  }
  if (dailyCount >= dailyBrake) {
    return {
      action: "brake",
      reason: `${dailyCount} crashes within daily window (${Math.round(dailyWindow / 3_600_000)}h) — threshold is ${dailyBrake}`,
    };
  }

  return {
    action: "proceed",
    crashCount,
    crashWindowStart,
    dailyCrashCount: dailyCount,
    dailyCrashWindowStart: dailyStart,
  };
}

/** Whether the short-window crash counter should be reset after this
 *  much clean uptime. Default: 1 h. */
export function shouldResetCrashCounter(
  uptimeMs: number,
  opts: { resetAfterMs?: number } = {},
): boolean {
  const threshold = opts.resetAfterMs ?? DEFAULTS.RESET_AFTER_MS;
  return uptimeMs >= threshold;
}
