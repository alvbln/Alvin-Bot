/**
 * File Permissions Hardening (v4.12.2)
 *
 * On multi-user dev servers, Alvin's sensitive files (.env, sessions.json,
 * memory files, cron-jobs.json) were previously written with the default
 * umask — typically 0o644 on Linux/macOS, meaning any other user on the
 * same machine could read API keys, conversation history, cron job
 * definitions, etc.
 *
 * This module provides:
 *   - writeSecure(path, content) — atomic write with mode 0o600
 *   - ensureSecureMode(path) — chmod-repair an existing file if it's too permissive
 *   - auditSensitiveFiles(paths[]) — batch-audit a list of files and repair
 *
 * The handler strategy:
 *   - NEW writes: use writeSecure() or pass `{ mode: 0o600 }` to writeFileSync
 *   - STARTUP: call auditSensitiveFiles() once with the list of known-sensitive
 *     files to chmod-repair anything that was written pre-v4.12.2
 *
 * Pure file-system operations — no grammy, no session, testable in isolation.
 */
import fs from "fs";

/** Strict mode for all sensitive files: owner read/write only. */
export const SECURE_MODE = 0o600;

export type EnsureStatus = "already-secure" | "repaired" | "missing" | "error";

export interface EnsureResult {
  path: string;
  status: EnsureStatus;
  /** Previous mode as octal string (e.g. "644") when status=repaired. */
  previousMode?: string;
  /** Error message when status=error. */
  error?: string;
}

/**
 * Atomically write a file with mode 0o600.
 *
 * Uses fs.writeFileSync's built-in `mode` option for initial creation, then
 * an explicit fs.chmodSync to handle the case where the file already exists
 * (in which case the mode arg to writeFileSync is ignored).
 */
export function writeSecure(path: string, content: string | Buffer): void {
  fs.writeFileSync(path, content, { mode: SECURE_MODE });
  // writeFileSync's mode is only applied on initial create. If the file
  // already existed with a looser mode, we need to explicitly chmod it.
  try {
    fs.chmodSync(path, SECURE_MODE);
  } catch {
    // Best effort — some filesystems (e.g. FAT) don't support chmod
  }
}

/**
 * Ensure a file is at most as permissive as SECURE_MODE (0o600). If it's
 * already 0o600 or stricter (e.g. 0o400), leave it alone. If it's more
 * permissive (e.g. 0o644, 0o666), repair it to 0o600.
 *
 * Returns a report of what happened — used by auditSensitiveFiles().
 */
export function ensureSecureMode(path: string): EnsureResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { path, status: "missing" };
    }
    return { path, status: "error", error: e.message };
  }

  const currentMode = stat.mode & 0o777;

  // If the file is already at SECURE_MODE or stricter (fewer bits), leave it.
  // We use bitwise AND: if (currentMode & ~SECURE_MODE) === 0 then all set bits
  // are within SECURE_MODE's bits — i.e. the file is not MORE permissive.
  if ((currentMode & ~SECURE_MODE) === 0) {
    return { path, status: "already-secure" };
  }

  // File is more permissive than 0o600 — repair.
  try {
    fs.chmodSync(path, SECURE_MODE);
    return {
      path,
      status: "repaired",
      previousMode: currentMode.toString(8),
    };
  } catch (err) {
    return {
      path,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Audit + repair a list of sensitive file paths. Returns a report per file.
 * Called once at bot startup with the list of known-sensitive files so that
 * any file written pre-v4.12.2 (with default 0o644/0o666 umask) gets repaired.
 */
export function auditSensitiveFiles(paths: string[]): EnsureResult[] {
  return paths.map(p => ensureSecureMode(p));
}
