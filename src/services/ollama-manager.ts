/**
 * Ollama Manager — on-demand daemon lifecycle for fallback use.
 *
 * The bot uses Ollama as a local fallback when the primary provider is down.
 * Historically the user had to run `ollama serve` themselves — if they forgot,
 * the fallback silently failed. This service spawns the daemon on demand,
 * preloads the target model into VRAM, and tears it all down once the primary
 * provider is healthy again.
 *
 * Key invariants:
 *   • Only kills instances the bot started itself (tracked via PID file).
 *     An externally-managed ollama is left alone.
 *   • Preload uses Ollama's native /api/generate endpoint with an empty
 *     prompt and keep_alive=30m, so the first real query is not cold.
 *   • Unload sets keep_alive=0 to flush the model from VRAM immediately.
 *   • All spawns are detached with stdio=ignore, so the child survives the
 *     bot crashing but still gets cleaned up on graceful shutdown.
 */

import { spawn, execFile, type ChildProcess } from "child_process";
import { promisify } from "util";
import fs from "fs";
import { resolve, dirname } from "path";
import os from "os";

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.ALVIN_DATA_DIR || resolve(os.homedir(), ".alvin-bot");
const PID_FILE = resolve(DATA_DIR, "ollama.pid");
const MODEL_FILE = resolve(DATA_DIR, "ollama.model");
const OLLAMA_API_BASE = "http://localhost:11434";
const DAEMON_READY_TIMEOUT_MS = 15_000;
const PRELOAD_TIMEOUT_MS = 60_000;
const KEEP_ALIVE = "30m";

let managedProcess: ChildProcess | null = null;
let managedModel: string | null = null;

// ── PID / Process verification ─────────────────────────────────────────────

/**
 * Verify that `pid` is actually an ollama process by inspecting its command
 * via `ps`. This prevents the classic PID-reuse bug where we'd kill a
 * random process after a bot crash left a stale pid file pointing at
 * something the OS has since re-assigned.
 */
async function verifyPidIsOllama(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      timeout: 3_000,
    });
    return stdout.toLowerCase().includes("ollama");
  } catch {
    // ps exits non-zero if pid doesn't exist — treat as "not ollama"
    return false;
  }
}

function loadManagedModelFromDisk(): string | null {
  try {
    if (fs.existsSync(MODEL_FILE)) {
      return fs.readFileSync(MODEL_FILE, "utf-8").trim() || null;
    }
  } catch { /* ignore */ }
  return null;
}

function persistManagedModel(model: string | null): void {
  try {
    fs.mkdirSync(dirname(MODEL_FILE), { recursive: true });
    if (model) {
      fs.writeFileSync(MODEL_FILE, model, "utf-8");
    } else if (fs.existsSync(MODEL_FILE)) {
      fs.unlinkSync(MODEL_FILE);
    }
  } catch (err) {
    console.warn(`[ollama] failed to persist model file: ${err}`);
  }
}

/**
 * Reconcile stale state left behind from a previous bot run.
 * If the PID file points at a process that is no longer ollama (crashed,
 * PID reused, never existed), remove the file so we don't try to kill
 * the wrong process later. Called lazily from ensureRunning / ensureStopped.
 */
async function reconcileStalePidFile(): Promise<void> {
  if (!fs.existsSync(PID_FILE)) return;
  try {
    const raw = fs.readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid) || pid <= 0) {
      fs.unlinkSync(PID_FILE);
      return;
    }
    const isOllama = await verifyPidIsOllama(pid);
    if (!isOllama) {
      console.log(`[ollama] stale pid file (pid=${pid} is no longer ollama) — removing`);
      fs.unlinkSync(PID_FILE);
      persistManagedModel(null);
    }
  } catch {
    // If we can't read/parse it, drop it
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  }
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_API_BASE}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function findOllamaBinary(): Promise<string | null> {
  // Common install paths — macOS Homebrew, Linux, /usr/local
  const candidates = [
    "/opt/homebrew/bin/ollama",
    "/usr/local/bin/ollama",
    "/usr/bin/ollama",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback: `which ollama` (async, no event-loop block)
  try {
    const { stdout } = await execFileAsync("which", ["ollama"], { timeout: 3_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function waitForDaemon(timeoutMs = DAEMON_READY_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isDaemonRunning()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function preloadModel(model: string): Promise<void> {
  try {
    await fetch(`${OLLAMA_API_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "",
        keep_alive: KEEP_ALIVE,
      }),
      signal: AbortSignal.timeout(PRELOAD_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ollama] preload warning (model=${model}): ${msg}`);
  }
}

async function unloadModel(model: string): Promise<void> {
  try {
    await fetch(`${OLLAMA_API_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        keep_alive: 0, // immediate VRAM unload
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // ignore — daemon may already be stopping
  }
}

/**
 * Ensure the Ollama daemon is running and the specified model is loaded.
 * Idempotent. If an externally-managed daemon is already running, we use
 * it and just preload the model, but leave it for ensureStopped() to decide
 * whether to kill it (it won't — only bot-spawned daemons get killed).
 */
export async function ensureRunning(model: string): Promise<boolean> {
  // Drop any stale pid file from a previous run before deciding anything.
  await reconcileStalePidFile();

  if (await isDaemonRunning()) {
    // Daemon is already up — either we started it in a previous bot run
    // (pid file still valid) or user started it externally (no pid file).
    // In both cases we preload the target model so the first query is warm.
    await preloadModel(model);
    managedModel = model;
    // If a valid pid file exists, we inherit ownership of that daemon
    // (it was bot-managed before a crash/restart). Update the model file.
    if (fs.existsSync(PID_FILE)) {
      persistManagedModel(model);
    }
    return true;
  }

  const binary = await findOllamaBinary();
  if (!binary) {
    console.error("[ollama] binary not found — install ollama first (brew install ollama)");
    return false;
  }

  console.log(`[ollama] starting daemon: ${binary} serve`);
  const proc = spawn(binary, ["serve"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  proc.unref();

  if (!proc.pid) {
    console.error("[ollama] spawn failed — no pid");
    return false;
  }

  // Persist the PID + model so we can kill/unload correctly on cleanup,
  // even after a bot restart loses the in-memory references.
  try {
    fs.mkdirSync(dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(proc.pid), "utf-8");
    persistManagedModel(model);
  } catch (err) {
    console.warn(`[ollama] failed to write state files: ${err}`);
  }

  managedProcess = proc;
  managedModel = model;

  const ready = await waitForDaemon();
  if (!ready) {
    console.error("[ollama] daemon did not become ready within 15s");
    // Clean up: we spawned something that didn't come up. Best effort kill.
    try { process.kill(proc.pid, "SIGTERM"); } catch { /* ignore */ }
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    persistManagedModel(null);
    return false;
  }

  console.log(`[ollama] daemon ready — preloading model: ${model}`);
  await preloadModel(model);
  return true;
}

/**
 * Stop the daemon if we started it, unload the model from VRAM.
 * Does nothing if the daemon was started externally (no PID file).
 */
export async function ensureStopped(): Promise<void> {
  if (!fs.existsSync(PID_FILE)) {
    // No PID file = externally managed daemon. Don't touch it.
    return;
  }

  let pid: number | null = null;
  try {
    const raw = fs.readFileSync(PID_FILE, "utf-8").trim();
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) pid = parsed;
  } catch {
    // ignore
  }

  // Verify the PID actually points at an ollama process before SIGTERM.
  // Prevents the classic PID-reuse bug where we'd kill a random process
  // after a bot crash/restart left a stale pid file.
  const pidIsOllama = pid ? await verifyPidIsOllama(pid) : false;

  if (!pidIsOllama) {
    console.log(`[ollama] pid file points to pid=${pid} which is no longer ollama — cleaning up`);
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    persistManagedModel(null);
    managedProcess = null;
    managedModel = null;
    return;
  }

  // Unload the model first so VRAM is freed even if the kill races.
  // Model name might be in memory (current run) or on disk (survived a restart).
  const modelToUnload = managedModel || loadManagedModelFromDisk();
  if (modelToUnload) {
    await unloadModel(modelToUnload);
  }

  try {
    process.kill(pid!, "SIGTERM");
    console.log(`[ollama] stopped daemon pid=${pid}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ollama] failed to kill pid=${pid}: ${msg}`);
  }

  // Clean up state
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  persistManagedModel(null);
  managedProcess = null;
  managedModel = null;
}

/** Whether the current daemon was spawned by the bot (via PID file). */
export function isBotManaged(): boolean {
  return fs.existsSync(PID_FILE);
}

/** Currently loaded model name, if any. */
export function getManagedModel(): string | null {
  return managedModel || loadManagedModelFromDisk();
}

// ── Module-load side effects ──────────────────────────────────────────────
//
// On first import (bot startup), reconcile any stale pid file from a previous
// crashed run AND restore the in-memory managedModel if the daemon is still
// alive. Best-effort — failures are logged but not fatal.
//
// NOTE: SIGTERM/SIGINT handling lives in src/index.ts (the bot's shutdown()
// function). That function calls ensureStopped() directly — we deliberately
// do NOT install our own signal handler here, to avoid racing with the
// bot's own cleanup path.
void (async () => {
  try {
    await reconcileStalePidFile();
    if (fs.existsSync(PID_FILE)) {
      const diskModel = loadManagedModelFromDisk();
      if (diskModel) {
        managedModel = diskModel;
        console.log(`[ollama] restored managed state from previous run (model=${diskModel})`);
      }
    }
  } catch (err) {
    console.warn(`[ollama] startup reconciliation failed: ${err}`);
  }
})();
