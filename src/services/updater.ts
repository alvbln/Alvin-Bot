/**
 * Updater Service — git-based self-update for alvin-bot.
 *
 * Provides:
 *   - runUpdate(): manual update (git pull + install + build)
 *   - getAutoUpdate() / setAutoUpdate(): persistent on/off toggle
 *   - startAutoUpdateLoop(): periodic check every 6h if enabled
 *
 * After a successful update that produces new artifacts, the bot calls
 * process.exit(0) and PM2 auto-restarts it with fresh code. This is the
 * only safe self-restart path — we never re-exec the Node process directly.
 *
 * The auto-update flag is persisted to ~/.alvin-bot/auto-update.flag
 * (a plain text file containing "on" or "off"), so it survives restarts.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
import { BOT_VERSION } from "../version.js";

const execAsync = promisify(exec);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const DATA_DIR = process.env.ALVIN_DATA_DIR || resolve(os.homedir(), ".alvin-bot");
const FLAG_FILE = resolve(DATA_DIR, "auto-update.flag");
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let autoTimer: ReturnType<typeof setInterval> | null = null;

export interface UpdateResult {
  ok: boolean;
  message: string;
  requiresRestart: boolean;
}

/**
 * Is PROJECT_ROOT itself a git repository? We deliberately do NOT use
 * `git rev-parse --is-inside-work-tree` because that walks UP the
 * directory tree and would return true for any ancestor that happens
 * to be a git repo — e.g. Homebrew stores its formula tree in a git
 * repo at /opt/homebrew/, so a npm-global install of alvin-bot under
 * /opt/homebrew/lib/node_modules/alvin-bot would be reported as a git
 * repo even though it's just plain files shipped via npm.
 *
 * The strict check: does PROJECT_ROOT/.git exist?
 */
function isOwnGitRepo(): boolean {
  return fs.existsSync(resolve(PROJECT_ROOT, ".git"));
}

/**
 * Heuristic for "this is an npm-global install": PROJECT_ROOT sits
 * inside a node_modules/alvin-bot directory. Covers:
 *   - /opt/homebrew/lib/node_modules/alvin-bot (Homebrew node)
 *   - /usr/local/lib/node_modules/alvin-bot (plain npm)
 *   - ~/.nvm/versions/node/...alvin-bot (nvm)
 *   - ~/.volta/tools/image/packages/...alvin-bot (volta)
 */
function isNpmGlobalInstall(): boolean {
  return /node_modules[/\\]alvin-bot$/.test(PROJECT_ROOT) || PROJECT_ROOT.includes("node_modules/alvin-bot/");
}

function readLocalVersion(): string | null {
  try {
    const pkgPath = resolve(PROJECT_ROOT, "package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

async function fetchRemoteVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("npm view alvin-bot version", {
      timeout: 15_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Semver-compare A vs B. Returns negative if A < B, 0 if equal, positive if A > B. */
function compareSemver(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/, "").split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  const av = norm(a);
  const bv = norm(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Is the running bot's in-memory version older than what's already built
 * on disk? This happens when the dev/CI rebuilt the bot mid-session and
 * the process hasn't restarted yet. A manual /update without a git/npm
 * fetch should still trigger a restart in this case so the fresh code
 * takes effect.
 */
function isRuntimeStale(): boolean {
  const onDisk = readLocalVersion();
  if (!onDisk || !BOT_VERSION || BOT_VERSION === "unknown") return false;
  return compareSemver(BOT_VERSION, onDisk) < 0;
}

/** Pull latest changes, install deps, rebuild. Returns a structured result
 *  instead of throwing so the /update command can report cleanly to Telegram.
 *  Dispatches to the git path for source installs and the npm path for
 *  npm-global installs.
 *
 *  Before doing any fetch, checks whether the disk is already newer than
 *  the running process (i.e. someone rebuilt between the process start
 *  and this call). If so, returns success with requiresRestart=true so
 *  the command handler can trigger a graceful restart.
 */
export async function runUpdate(): Promise<UpdateResult> {
  try {
    // Stale-runtime check: disk is already newer than the running code.
    if (isRuntimeStale()) {
      const onDisk = readLocalVersion();
      return {
        ok: true,
        message: `Disk is already built at v${onDisk}, running v${BOT_VERSION}. Restarting to pick up the new code...`,
        requiresRestart: true,
      };
    }

    if (isOwnGitRepo()) {
      return await runGitUpdate();
    }
    if (isNpmGlobalInstall()) {
      return await runNpmUpdate();
    }
    return {
      ok: false,
      message:
        "Update not supported for this install type. Clone the git repo or use npm install -g alvin-bot.",
      requiresRestart: false,
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.length > 300 ? raw.slice(0, 300) + "…" : raw;
    return { ok: false, message, requiresRestart: false };
  }
}

async function runGitUpdate(): Promise<UpdateResult> {
  // Fetch latest without merging
  await execAsync("git fetch --quiet", {
    cwd: PROJECT_ROOT,
    timeout: 30_000,
  });

  // Count commits we're behind the upstream
  let behindCount = 0;
  try {
    const { stdout } = await execAsync("git rev-list --count HEAD..@{upstream}", {
      cwd: PROJECT_ROOT,
      timeout: 10_000,
    });
    behindCount = parseInt(stdout.trim() || "0", 10);
  } catch {
    behindCount = 0;
  }

  if (behindCount === 0) {
    return {
      ok: true,
      message: "Already up to date — no new commits.",
      requiresRestart: false,
    };
  }

  // Fast-forward pull
  await execAsync("git pull --ff-only", {
    cwd: PROJECT_ROOT,
    timeout: 60_000,
  });

  // Prefer pnpm if the lockfile exists, otherwise fall back to npm
  const hasPnpmLock = fs.existsSync(resolve(PROJECT_ROOT, "pnpm-lock.yaml"));
  const installCmd = hasPnpmLock ? "pnpm install --frozen-lockfile" : "npm install --no-audit --no-fund";
  const buildCmd = hasPnpmLock ? "pnpm run build" : "npm run build";

  await execAsync(installCmd, { cwd: PROJECT_ROOT, timeout: 180_000 });
  await execAsync(buildCmd, { cwd: PROJECT_ROOT, timeout: 180_000 });

  return {
    ok: true,
    message: `Installed ${behindCount} commit(s), build successful.`,
    requiresRestart: true,
  };
}

async function runNpmUpdate(): Promise<UpdateResult> {
  const current = readLocalVersion();
  const latest = await fetchRemoteVersion();

  if (!latest) {
    return {
      ok: false,
      message: "Could not reach npm registry — check your internet connection.",
      requiresRestart: false,
    };
  }

  if (current && compareSemver(current, latest) >= 0) {
    return {
      ok: true,
      message: `Already up to date — v${current} is the latest published version.`,
      requiresRestart: false,
    };
  }

  // Newer version exists — install it globally. npm install -g writes to
  // the globally-scoped node_modules directory (/opt/homebrew/lib/… on
  // Homebrew, /usr/local/lib/… on plain npm). The running process still
  // has the old code loaded in memory, so after install we signal the
  // caller to restart.
  try {
    await execAsync("npm install -g alvin-bot@latest --no-audit --no-fund", {
      timeout: 300_000, // 5 minutes for large installs
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Permission errors are the most common npm -g failure mode
    if (/EACCES|permission denied/i.test(raw)) {
      return {
        ok: false,
        message: `npm install -g failed with permissions. Try: sudo npm install -g alvin-bot@latest`,
        requiresRestart: false,
      };
    }
    return {
      ok: false,
      message: `npm install failed: ${raw.slice(0, 200)}`,
      requiresRestart: false,
    };
  }

  return {
    ok: true,
    message: `Installed v${latest} (was v${current ?? "?"}). Restarting...`,
    requiresRestart: true,
  };
}

export function getAutoUpdate(): boolean {
  try {
    if (!fs.existsSync(FLAG_FILE)) return false;
    return fs.readFileSync(FLAG_FILE, "utf-8").trim() === "on";
  } catch {
    return false;
  }
}

export function setAutoUpdate(enabled: boolean): void {
  try {
    fs.mkdirSync(dirname(FLAG_FILE), { recursive: true });
    fs.writeFileSync(FLAG_FILE, enabled ? "on" : "off", "utf-8");
    if (enabled) {
      startAutoUpdateLoop();
    } else {
      stopAutoUpdateLoop();
    }
  } catch (err) {
    console.error("[auto-update] setAutoUpdate failed:", err);
  }
}

export function startAutoUpdateLoop(): void {
  if (autoTimer) return;
  if (!getAutoUpdate()) return;

  autoTimer = setInterval(async () => {
    const result = await runUpdate();
    if (result.ok && result.requiresRestart) {
      console.log(`[auto-update] ${result.message} — exiting for PM2 restart`);
      // Small delay so any in-flight log write completes
      setTimeout(() => process.exit(0), 1_000);
    } else if (result.ok) {
      // up-to-date, no-op
    } else {
      console.log(`[auto-update] check failed: ${result.message}`);
    }
  }, AUTO_CHECK_INTERVAL_MS);
  autoTimer.unref?.();

  console.log(`[auto-update] loop started (interval: 6h)`);
}

export function stopAutoUpdateLoop(): void {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
    console.log(`[auto-update] loop stopped`);
  }
}
