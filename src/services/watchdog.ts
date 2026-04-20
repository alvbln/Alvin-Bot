/**
 * Internal Watchdog — Self-monitoring for crash-loop detection.
 *
 * Writes a liveness beacon file every 30 s with the current pid + boot
 * time + crash counter. On startup, reads the beacon to detect whether
 * the previous process exited cleanly or crashed. If too many crashes
 * happen in a short window, refuses to keep restarting and writes an
 * alert file so the user can investigate.
 *
 * Persistence layers this complements:
 *   - launchd KeepAlive: true → restarts on any exit (good)
 *   - ThrottleInterval: 5     → minimum 5 s between restarts (good)
 *   - This watchdog            → caps the total restart count so we
 *                                don't burn CPU on a truly broken state
 *
 * What this CAN catch:
 *   - Process crash → exit non-zero → launchd restarts → next boot reads
 *     beacon, sees a recent exit, increments crash counter
 *   - Tight crash loop → counter accumulates → hits brake at 10
 *
 * What this CANNOT catch (yet):
 *   - True event-loop deadlocks (process alive but frozen). That requires
 *     an external watchdog process — tracked as a follow-up.
 */

import fs from "fs";
import { resolve, dirname } from "path";
import os from "os";
import { execSync } from "child_process";
import { BOT_VERSION } from "../version.js";
import {
  decideBrakeAction,
  shouldResetCrashCounter,
  DEFAULTS,
  type BeaconData,
} from "./watchdog-brake.js";

const DATA_DIR = process.env.ALVIN_DATA_DIR || resolve(os.homedir(), ".alvin-bot");
const STATE_DIR = resolve(DATA_DIR, "state");
const BEACON_FILE = resolve(STATE_DIR, "watchdog.json");
const ALERT_FILE = resolve(STATE_DIR, "crash-loop.alert");

const BEACON_INTERVAL_MS = 30_000; // write a beacon every 30 s
// Thresholds and windows live in watchdog-brake.ts DEFAULTS.

let beaconTimer: ReturnType<typeof setInterval> | null = null;
let resetTimer: ReturnType<typeof setTimeout> | null = null;
let bootTime = 0;

function ensureStateDir(): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch (err) {
    console.error("[watchdog] failed to create state dir:", err);
  }
}

function readBeacon(): BeaconData | null {
  try {
    const raw = fs.readFileSync(BEACON_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BeaconData>;
    if (
      typeof parsed.lastBeat === "number" &&
      typeof parsed.pid === "number" &&
      typeof parsed.bootTime === "number" &&
      typeof parsed.crashCount === "number" &&
      typeof parsed.crashWindowStart === "number" &&
      typeof parsed.version === "string"
    ) {
      // Older beacons don't have daily-counter fields — default them to
      // 0/now so the brake logic treats this run as the start of the
      // first daily window.
      return {
        lastBeat: parsed.lastBeat,
        pid: parsed.pid,
        bootTime: parsed.bootTime,
        crashCount: parsed.crashCount,
        crashWindowStart: parsed.crashWindowStart,
        version: parsed.version,
        dailyCrashCount:
          typeof parsed.dailyCrashCount === "number" ? parsed.dailyCrashCount : 0,
        dailyCrashWindowStart:
          typeof parsed.dailyCrashWindowStart === "number"
            ? parsed.dailyCrashWindowStart
            : Date.now(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writeBeacon(data: BeaconData): void {
  try {
    fs.writeFileSync(BEACON_FILE, JSON.stringify(data, null, 0), "utf-8");
  } catch (err) {
    console.error("[watchdog] failed to write beacon:", err);
  }
}

function writeAlert(reason: string, crashCount: number): void {
  try {
    const content = [
      `Alvin Bot crash-loop brake hit at ${new Date().toISOString()}`,
      `Version: ${BOT_VERSION}`,
      `Crashes in the last ${DEFAULTS.SHORT_WINDOW_MS / 60_000} minutes: ${crashCount}`,
      `Short-window threshold: ${DEFAULTS.SHORT_BRAKE_THRESHOLD}`,
      `Daily threshold: ${DEFAULTS.DAILY_BRAKE_THRESHOLD}`,
      ``,
      `Reason: ${reason}`,
      ``,
      `The bot will refuse to start until this file is removed AND the`,
      `LaunchAgent is reloaded. Investigate the recent error log:`,
      `  ${resolve(DATA_DIR, "logs", "alvin-bot.err.log")}`,
      ``,
      `Recovery steps once you've fixed the underlying issue:`,
      `  rm "${ALERT_FILE}"`,
      `  alvin-bot launchd install   # or just kickstart the service`,
      ``,
    ].join("\n");
    fs.writeFileSync(ALERT_FILE, content, "utf-8");
  } catch (err) {
    console.error("[watchdog] failed to write alert:", err);
  }
}

/**
 * Check whether the watchdog has hit the crash-loop brake. Called once
 * at startup, BEFORE most of the bot initializes. If the brake is set
 * (alert file exists), the bot exits cleanly with code 3 — and because
 * launchd's KeepAlive will keep retrying, we also try to unload our
 * own LaunchAgent so the retries stop.
 */
export function checkCrashLoopBrake(): void {
  if (!fs.existsSync(ALERT_FILE)) return;

  console.error("");
  console.error("==================================================");
  console.error("⛔ alvin-bot crash-loop brake is engaged");
  console.error("==================================================");
  try {
    const content = fs.readFileSync(ALERT_FILE, "utf-8");
    console.error(content);
  } catch { /* ignore */ }

  // Attempt to unload our own LaunchAgent so launchd stops retrying.
  // If we don't do this, launchd just KeepAlive's us forever and we
  // burn CPU writing the same alert.
  if (process.platform === "darwin") {
    try {
      const home = os.homedir();
      const plistPath = resolve(home, "Library", "LaunchAgents", "com.alvinbot.app.plist");
      if (fs.existsSync(plistPath)) {
        execSync(`launchctl unload -w "${plistPath}"`, { stdio: "pipe" });
        console.error("[watchdog] LaunchAgent unloaded — bot will not auto-restart.");
      }
    } catch (err) {
      console.error("[watchdog] failed to unload LaunchAgent:", err);
    }
  }

  // Exit with a distinct code so logs make the cause obvious
  process.exit(3);
}

/**
 * Start the watchdog. Called from src/index.ts after all services are
 * initialized. Reads the previous beacon, increments crash counter if
 * the previous run exited recently, schedules the periodic beacon
 * writer, and schedules a recovery-mark reset after RECOVERY_UPTIME_MS
 * of clean uptime.
 */
export function startWatchdog(): void {
  ensureStateDir();
  bootTime = Date.now();

  const previous = readBeacon();
  const decision = decideBrakeAction(previous, bootTime);

  if (decision.action === "brake") {
    console.error(`[watchdog] crash-loop brake triggered: ${decision.reason}`);
    writeAlert(decision.reason, previous?.crashCount ?? 0);
    // checkCrashLoopBrake tries to unload the LaunchAgent so launchd stops
    // retrying. It only runs the exit path if ALERT_FILE exists, which is
    // normally true after writeAlert — but if writeAlert failed silently
    // (disk full, permissions), we MUST still halt this boot. The trailing
    // process.exit(3) below is the mandatory guarantee.
    checkCrashLoopBrake();
    process.exit(3);
  }

  let crashCount = decision.crashCount;
  let crashWindowStart = decision.crashWindowStart;
  let dailyCrashCount = decision.dailyCrashCount;
  let dailyCrashWindowStart = decision.dailyCrashWindowStart;

  if (previous) {
    const timeSinceLastBeat = bootTime - previous.lastBeat;
    if (timeSinceLastBeat < DEFAULTS.STALE_BEACON_MS) {
      console.log(
        `[watchdog] detected restart after ${Math.round(timeSinceLastBeat / 1000)}s — ` +
        `crash ${crashCount}/${DEFAULTS.SHORT_BRAKE_THRESHOLD} in current ` +
        `${DEFAULTS.SHORT_WINDOW_MS / 60_000}min window, ` +
        `${dailyCrashCount}/${DEFAULTS.DAILY_BRAKE_THRESHOLD} in current 24h window`,
      );
    }
  }

  // Write the first beacon immediately so a fresh restart updates the file
  writeBeacon({
    lastBeat: bootTime,
    pid: process.pid,
    bootTime,
    crashCount,
    crashWindowStart,
    dailyCrashCount,
    dailyCrashWindowStart,
    version: BOT_VERSION,
  });

  // Periodic beacon writer
  beaconTimer = setInterval(() => {
    writeBeacon({
      lastBeat: Date.now(),
      pid: process.pid,
      bootTime,
      crashCount,
      crashWindowStart,
      dailyCrashCount,
      dailyCrashWindowStart,
      version: BOT_VERSION,
    });
  }, BEACON_INTERVAL_MS);

  // Schedule a recovery counter reset after RESET_AFTER_MS (1 h by default)
  // of clean uptime. The old policy was 5 min — too short because chronic
  // crashes often had 5-10 min gaps and never tripped the brake.
  resetTimer = setTimeout(() => {
    const uptime = Date.now() - bootTime;
    if (shouldResetCrashCounter(uptime) && crashCount > 0) {
      console.log(
        `[watchdog] ${Math.round(uptime / 60_000)}min clean uptime — ` +
        `resetting short-window crash counter from ${crashCount} to 0 ` +
        `(daily counter ${dailyCrashCount} stays)`,
      );
      crashCount = 0;
      crashWindowStart = Date.now();
      writeBeacon({
        lastBeat: Date.now(),
        pid: process.pid,
        bootTime,
        crashCount,
        crashWindowStart,
        dailyCrashCount,
        dailyCrashWindowStart,
        version: BOT_VERSION,
      });
    }
  }, DEFAULTS.RESET_AFTER_MS);

  console.log(
    `[watchdog] started — beacon every ${BEACON_INTERVAL_MS / 1000}s, ` +
    `brake at ${DEFAULTS.SHORT_BRAKE_THRESHOLD} crashes / ${DEFAULTS.SHORT_WINDOW_MS / 60_000}min ` +
    `or ${DEFAULTS.DAILY_BRAKE_THRESHOLD} / 24h, ` +
    `recovery after ${DEFAULTS.RESET_AFTER_MS / 60_000}min uptime`,
  );
}

/**
 * Stop the watchdog cleanly. Called from the shutdown handler in
 * index.ts so beacon timers don't keep the process alive after the
 * grammy bot has stopped.
 */
export function stopWatchdog(): void {
  if (beaconTimer) {
    clearInterval(beaconTimer);
    beaconTimer = null;
  }
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
}
