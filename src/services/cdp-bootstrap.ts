/**
 * CDP Bootstrap — spawns Chromium with remote-debugging-port=9222 independently.
 *
 * Avoids two problems that plague naive CDP setups:
 *
 * 1. **LaunchServices hijack** — invoking /Applications/Google Chrome.app while
 *    the user's Chrome is running silently redirects the call to the existing
 *    instance without applying --remote-debugging-port. Log symptom:
 *    "Wird in einer aktuellen Browsersitzung geöffnet." We avoid it by
 *    preferring Playwright's "Google Chrome for Testing" binary, which has a
 *    distinct bundle ID.
 *
 * 2. **Stale PID files** — a crashed Chromium leaves chrome-cdp.pid pointing at
 *    a dead process; subsequent starts conclude "already running" and fail
 *    silently. We verify liveness via both `ps` and a CDP /json/version probe.
 *
 * The module is idempotent: `ensureRunning()` is safe to call repeatedly; if
 * CDP is already healthy it returns immediately.
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import {
  CDP_PROFILE_DIR,
  CDP_SCREENSHOTS_DIR,
  CDP_PID_FILE,
  CDP_LOG_FILE,
} from "../paths.js";

const CDP_PORT = 9222;
const CDP_VERSION_URL = `http://127.0.0.1:${CDP_PORT}/json/version`;
const START_TIMEOUT_MS = 15_000;

export interface CdpStatus {
  running: boolean;
  pid?: number;
  binary?: string;
  endpoint: string;
  reason?: string;
}

// ── Binary resolution ───────────────────────────────────────────────

/**
 * Find Playwright's bundled Chromium. Prefers "Google Chrome for Testing"
 * (distinct macOS bundle ID — no LaunchServices conflict with user Chrome),
 * falls back to plain Chromium for older Playwright installs.
 *
 * Returns null if no bundled Chromium is present — callers should then fall
 * back to a user-supplied binary or error out with guidance.
 */
export function findPlaywrightChromium(): string | null {
  const pwRoot = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (!fs.existsSync(pwRoot)) {
    // Linux cache path
    const linuxPwRoot = path.join(os.homedir(), ".cache", "ms-playwright");
    if (fs.existsSync(linuxPwRoot)) return resolveFromPwRoot(linuxPwRoot);
    return null;
  }
  return resolveFromPwRoot(pwRoot);
}

function resolveFromPwRoot(pwRoot: string): string | null {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(pwRoot).filter((d) => /^chromium-\d+$/.test(d));
  } catch {
    return null;
  }
  if (dirs.length === 0) return null;
  // Latest version by numeric suffix
  dirs.sort((a, b) => {
    const na = parseInt(a.replace("chromium-", ""), 10);
    const nb = parseInt(b.replace("chromium-", ""), 10);
    return nb - na;
  });

  // Platform-dependent layout; try all known variants
  const candidates: string[] = [];
  for (const dir of dirs) {
    const root = path.join(pwRoot, dir);
    for (const arch of ["chrome-mac-arm64", "chrome-mac", "chrome-linux", "chrome-win"]) {
      for (const app of [
        // macOS app bundles
        "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "Chromium.app/Contents/MacOS/Chromium",
        // Linux / Windows raw binaries
        "chrome",
        "chrome.exe",
      ]) {
        candidates.push(path.join(root, arch, app));
      }
    }
  }

  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return c;
    } catch {
      // not present, keep searching
    }
  }
  return null;
}

/**
 * Resolve the browser binary in preference order:
 *   1. Playwright's Chromium (no conflict with user Chrome, preferred)
 *   2. Existing user browser (may trigger LaunchServices hijack — last resort)
 */
export function resolveBrowserBinary(): { path: string; origin: "playwright" | "system" } | null {
  const pw = findPlaywrightChromium();
  if (pw) return { path: pw, origin: "playwright" };

  // System Chrome fallback (macOS path). On Linux/Windows we return null and
  // let callers surface a clear error.
  const sysChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(sysChrome)) return { path: sysChrome, origin: "system" };

  return null;
}

// ── Liveness probes ─────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try {
    // signal 0 tests existence without actually signaling
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(): number | null {
  try {
    const raw = fs.readFileSync(CDP_PID_FILE, "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function cdpReachable(timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(CDP_VERSION_URL, (res) => {
      res.resume(); // drain
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ── Process control ─────────────────────────────────────────────────

let bootstrapLock: Promise<void> | null = null;

/**
 * Ensure CDP is running on port 9222. Idempotent and safe to call from
 * multiple concurrent code paths — only one spawn happens at a time.
 */
export async function ensureRunning(opts: { mode?: "headless" | "headful" } = {}): Promise<CdpStatus> {
  const mode = opts.mode || "headless";

  // Already running? Verify both ends (process + endpoint).
  if (await cdpReachable()) {
    return { running: true, pid: readPidFile() || undefined, endpoint: CDP_VERSION_URL };
  }

  // Serialize concurrent bootstrap attempts
  if (bootstrapLock) {
    await bootstrapLock;
    if (await cdpReachable()) {
      return { running: true, pid: readPidFile() || undefined, endpoint: CDP_VERSION_URL };
    }
  }

  bootstrapLock = (async () => {
    // Stale PID cleanup — a PID file pointing at a dead process blocks nothing
    // but is confusing. Remove it before spawning.
    const stalePid = readPidFile();
    if (stalePid && !pidAlive(stalePid)) {
      try { fs.unlinkSync(CDP_PID_FILE); } catch {}
    }

    const binary = resolveBrowserBinary();
    if (!binary) {
      throw new Error(
        "No Chromium binary found. Install Playwright's Chromium: " +
        "cd ~/.alvin-bot && npx playwright install chromium"
      );
    }

    // Ensure data dirs exist
    for (const dir of [CDP_PROFILE_DIR, CDP_SCREENSHOTS_DIR, path.dirname(CDP_PID_FILE)]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const args = [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CDP_PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=ChromeWhatsNewUI,PrivacySandboxSettings4",
    ];
    if (mode === "headless") {
      args.push("--headless=new", "--disable-gpu");
    }
    args.push("about:blank");

    const logStream = fs.openSync(CDP_LOG_FILE, "w");
    const child = spawn(binary.path, args, {
      stdio: ["ignore", logStream, logStream],
      detached: true,
    });
    child.unref();

    if (!child.pid) {
      throw new Error("Failed to spawn Chromium (no PID)");
    }
    fs.writeFileSync(CDP_PID_FILE, String(child.pid));

    // Wait until CDP answers
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await cdpReachable()) return;
      await new Promise((r) => setTimeout(r, 300));
    }

    // Did not come up — kill and surface a useful error
    try { process.kill(child.pid); } catch {}
    try { fs.unlinkSync(CDP_PID_FILE); } catch {}
    const tail = readLogTail(20);
    throw new Error(
      `CDP did not come up within ${START_TIMEOUT_MS}ms using ${binary.path}\n` +
      `Log tail:\n${tail}`
    );
  })();

  try {
    await bootstrapLock;
  } finally {
    bootstrapLock = null;
  }

  return {
    running: true,
    pid: readPidFile() || undefined,
    binary: resolveBrowserBinary()?.path,
    endpoint: CDP_VERSION_URL,
  };
}

/**
 * Stop the bot-managed Chromium. Does NOT touch the user's own Chrome.
 */
export async function stop(): Promise<void> {
  const pid = readPidFile();
  if (pid && pidAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    // Give it a second to close gracefully, then force-kill
    await new Promise((r) => setTimeout(r, 1000));
    if (pidAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
  try { fs.unlinkSync(CDP_PID_FILE); } catch {}
}

/**
 * Report current status without starting anything.
 */
export async function status(): Promise<CdpStatus> {
  const pid = readPidFile();
  const endpoint = CDP_VERSION_URL;
  const binary = resolveBrowserBinary()?.path;

  if (pid && pidAlive(pid) && (await cdpReachable())) {
    return { running: true, pid, binary, endpoint };
  }
  if (pid && !pidAlive(pid)) {
    return { running: false, endpoint, reason: `stale PID ${pid} — process not running` };
  }
  if (pid && !(await cdpReachable())) {
    return { running: false, pid, endpoint, reason: "PID alive but CDP endpoint unreachable" };
  }
  return { running: false, endpoint, reason: "not started" };
}

function readLogTail(lines: number): string {
  try {
    const content = fs.readFileSync(CDP_LOG_FILE, "utf8");
    return content.split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log file)";
  }
}

// ── Doctor ──────────────────────────────────────────────────────────

export interface DoctorReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export async function doctor(): Promise<DoctorReport> {
  const checks: DoctorReport["checks"] = [];

  // 1. Binary
  const binary = resolveBrowserBinary();
  if (binary) {
    checks.push({
      name: "Binary",
      ok: true,
      detail:
        binary.origin === "playwright"
          ? `Playwright Chromium — ${binary.path}`
          : `System Chrome (fallback — risk of LaunchServices conflict) — ${binary.path}`,
    });
  } else {
    checks.push({
      name: "Binary",
      ok: false,
      detail: "No Chromium found. Run: npx playwright install chromium",
    });
  }

  // 2. Port / endpoint
  const reachable = await cdpReachable();
  checks.push({
    name: "CDP endpoint",
    ok: reachable,
    detail: reachable ? `${CDP_VERSION_URL} reachable` : `${CDP_VERSION_URL} not reachable`,
  });

  // 3. PID file
  const pid = readPidFile();
  if (pid === null) {
    checks.push({ name: "PID file", ok: true, detail: "none (OK if CDP not running)" });
  } else if (pidAlive(pid)) {
    checks.push({ name: "PID file", ok: true, detail: `PID ${pid} alive` });
  } else {
    checks.push({ name: "PID file", ok: false, detail: `stale PID ${pid} — delete ${CDP_PID_FILE}` });
  }

  // 4. Profile lock (only relevant on macOS / Linux)
  const lockPath = path.join(CDP_PROFILE_DIR, "SingletonLock");
  if (fs.existsSync(lockPath)) {
    // Chromium creates SingletonLock while running; only flag if there's no
    // live process associated with it.
    const livePid = pid && pidAlive(pid);
    checks.push({
      name: "Profile lock",
      ok: !!livePid,
      detail: livePid
        ? "held by live process (OK)"
        : `stale lock — delete ${lockPath}`,
    });
  } else {
    checks.push({ name: "Profile lock", ok: true, detail: "clean" });
  }

  // 5. Log tail
  if (fs.existsSync(CDP_LOG_FILE)) {
    checks.push({
      name: "Recent log",
      ok: true,
      detail: `last lines (${CDP_LOG_FILE}):\n${readLogTail(5)}`,
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
