/**
 * Disk Cleanup Service — periodic cleanup of transient bot files.
 *
 * Targets files that are SAFE to delete (logs, temp screenshots, browser
 * artifacts, old subagent streams) and leaves critical data alone
 * (memory, assets, workspaces, cron-jobs, .env, session-store).
 *
 * Strategy:
 *   - Each path has a max age (days) OR a max size (MB, with rotation)
 *   - Defaults are conservative: keep 30 days of artifacts, rotate logs >100MB
 *   - All knobs overridable via env (CLEANUP_* vars) and via /cleanup set <key>
 *   - Runs once at boot + every 24h thereafter, unref'd so it doesn't
 *     prevent shutdown
 *
 * NEVER cleaned:
 *   ~/.alvin-bot/memory/         (daily logs, long-term memory)
 *   ~/.alvin-bot/assets/         (user-supplied files)
 *   ~/.alvin-bot/workspaces/     (user configuration)
 *   ~/.alvin-bot/cron-jobs.json  (scheduled tasks)
 *   ~/.alvin-bot/.env            (secrets)
 *   ~/.alvin-bot/session-store.json (resume tokens)
 *   ~/.alvin-bot/delivery-queue.json
 *   ~/.alvin-bot/standing-orders
 *   ~/.alvin-bot/auto-update.flag
 */

import fs from "fs";
import path from "path";
import os from "os";
import { DATA_DIR } from "../paths.js";

export interface CleanupPolicy {
  /** Rotate bot log files when they exceed this size (MB). 0 disables. */
  logMaxSizeMb: number;
  /** Browser screenshots older than this (days) get deleted. 0 disables. */
  screenshotsMaxAgeDays: number;
  /** Finished subagent output files older than this (days). 0 disables. */
  subagentsMaxAgeDays: number;
  /** Files under /tmp/alvin-bot/ older than this (days). 0 disables. */
  tmpMaxAgeDays: number;
  /** WhatsApp media cache older than this (days). 0 disables. */
  waMediaMaxAgeDays: number;
}

const DEFAULT_POLICY: CleanupPolicy = {
  logMaxSizeMb: parseInt(process.env.CLEANUP_LOG_MAX_MB || "100", 10),
  screenshotsMaxAgeDays: parseInt(process.env.CLEANUP_SCREENSHOTS_DAYS || "30", 10),
  subagentsMaxAgeDays: parseInt(process.env.CLEANUP_SUBAGENTS_DAYS || "30", 10),
  tmpMaxAgeDays: parseInt(process.env.CLEANUP_TMP_DAYS || "7", 10),
  waMediaMaxAgeDays: parseInt(process.env.CLEANUP_WA_MEDIA_DAYS || "30", 10),
};

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export interface CleanupResult {
  filesDeleted: number;
  bytesReclaimed: number;
  logsRotated: number;
  errors: string[];
  details: Array<{ path: string; action: string; size?: number }>;
}

/**
 * Return the current effective policy (env-overridden defaults).
 */
export function getCleanupPolicy(): CleanupPolicy {
  return { ...DEFAULT_POLICY };
}

/**
 * Run a cleanup pass once. Safe to call manually (e.g. /cleanup command).
 */
export async function runCleanup(policyOverride?: Partial<CleanupPolicy>): Promise<CleanupResult> {
  const policy = { ...DEFAULT_POLICY, ...policyOverride };
  const result: CleanupResult = {
    filesDeleted: 0,
    bytesReclaimed: 0,
    logsRotated: 0,
    errors: [],
    details: [],
  };

  // 1. Rotate large log files (launchd stdout/stderr)
  if (policy.logMaxSizeMb > 0) {
    const logsDir = path.join(DATA_DIR, "logs");
    try {
      if (fs.existsSync(logsDir)) {
        for (const name of fs.readdirSync(logsDir)) {
          if (!name.endsWith(".log")) continue;
          const full = path.join(logsDir, name);
          try {
            const st = fs.statSync(full);
            if (st.size > policy.logMaxSizeMb * 1024 * 1024) {
              // Rotate: keep a .old, overwrite current. Launchd will reopen on next write.
              const oldPath = full + ".old";
              try { fs.rmSync(oldPath, { force: true }); } catch {}
              fs.renameSync(full, oldPath);
              fs.writeFileSync(full, "");
              result.logsRotated++;
              result.bytesReclaimed += st.size;
              result.details.push({ path: full, action: "rotated", size: st.size });
            }
          } catch (err) {
            result.errors.push(`log-rotate ${full}: ${(err as Error).message}`);
          }
        }
      }
    } catch (err) {
      result.errors.push(`logs scan: ${(err as Error).message}`);
    }
  }

  // 2. Browser screenshots (bot-owned CDP)
  if (policy.screenshotsMaxAgeDays > 0) {
    const dir = path.join(DATA_DIR, "browser", "screenshots");
    cleanupOldFiles(dir, policy.screenshotsMaxAgeDays, result);
  }

  // 3. Subagent streaming outputs — only delete FINISHED ones (older than N days).
  // We trust that the async-agent-watcher has already marked them done — files
  // older than a few days are either delivered or definitively abandoned.
  if (policy.subagentsMaxAgeDays > 0) {
    const dir = path.join(DATA_DIR, "subagents");
    cleanupOldFiles(dir, policy.subagentsMaxAgeDays, result, [".jsonl", ".err"]);
  }

  // 4. /tmp/alvin-bot/*  (media, temp scrapes)
  if (policy.tmpMaxAgeDays > 0) {
    cleanupOldFiles("/tmp/alvin-bot", policy.tmpMaxAgeDays, result);
  }

  // 5. WhatsApp media cache
  if (policy.waMediaMaxAgeDays > 0) {
    const dir = path.join(DATA_DIR, "data", "wa-media");
    cleanupOldFiles(dir, policy.waMediaMaxAgeDays, result);
  }

  // 6. CDP log (/tmp/chrome-cdp.log) — always keep just the latest boot
  const cdpLog = path.join(os.tmpdir(), "chrome-cdp.log");
  try {
    if (fs.existsSync(cdpLog)) {
      const st = fs.statSync(cdpLog);
      const ageDays = (Date.now() - st.mtimeMs) / (24 * 60 * 60 * 1000);
      if (ageDays > 7) {
        fs.unlinkSync(cdpLog);
        result.filesDeleted++;
        result.bytesReclaimed += st.size;
        result.details.push({ path: cdpLog, action: "deleted", size: st.size });
      }
    }
  } catch {
    // Not critical
  }

  return result;
}

/**
 * Delete files in `dir` older than `maxAgeDays`. Safe if `dir` doesn't exist.
 * Optional extension filter — e.g. [".jsonl", ".err"] restricts to those types.
 */
function cleanupOldFiles(
  dir: string,
  maxAgeDays: number,
  result: CleanupResult,
  extensions?: string[],
): void {
  if (!fs.existsSync(dir)) return;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!entry.isFile()) continue;
      if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoffMs) {
          fs.unlinkSync(full);
          result.filesDeleted++;
          result.bytesReclaimed += st.size;
          result.details.push({ path: full, action: "deleted", size: st.size });
        }
      } catch (err) {
        result.errors.push(`${full}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    result.errors.push(`scan ${dir}: ${(err as Error).message}`);
  }
}

/**
 * Start the periodic cleanup loop. Runs first pass after 5 minutes (let the
 * bot fully boot and avoid competing with startup I/O), then every 24h.
 */
export function startCleanupLoop(): void {
  if (cleanupTimer) return;

  // First run delayed so we don't step on a restart that's still writing logs
  setTimeout(() => {
    void runCleanup().then((r) => {
      if (r.filesDeleted > 0 || r.logsRotated > 0) {
        console.log(
          `[cleanup] ${r.filesDeleted} files deleted, ${r.logsRotated} logs rotated, ${formatBytes(r.bytesReclaimed)} reclaimed`,
        );
      }
    });
  }, 5 * 60 * 1000);

  cleanupTimer = setInterval(
    () => {
      void runCleanup().then((r) => {
        if (r.filesDeleted > 0 || r.logsRotated > 0) {
          console.log(
            `[cleanup] ${r.filesDeleted} files deleted, ${r.logsRotated} logs rotated, ${formatBytes(r.bytesReclaimed)} reclaimed`,
          );
        }
      });
    },
    CLEANUP_INTERVAL_MS,
  );
  cleanupTimer.unref?.();
}

export function stopCleanupLoop(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
