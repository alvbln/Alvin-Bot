/**
 * Legacy Data Migration — Copies data from old in-repo locations to ~/.alvin-bot/.
 *
 * Old layout (in BOT_ROOT):
 *   docs/MEMORY.md, docs/memory/, docs/users/, docs/tools.json, docs/cron-jobs.json,
 *   docs/mcp.json, docs/fallback-order.json, docs/custom-models.json, docs/whatsapp-groups.json
 *   data/access.json, data/whatsapp-auth/, data/wa-media/, data/.sudo-*
 *   SOUL.md, TOOLS.md
 *   backups/
 *
 * New layout (in DATA_DIR = ~/.alvin-bot/):
 *   memory/MEMORY.md, memory/*.md, memory/.embeddings.json
 *   users/
 *   data/access.json, data/whatsapp-auth/, data/wa-media/, data/.sudo-*
 *   soul.md, tools.md, tools.json
 *   cron-jobs.json, mcp.json, fallback-order.json, custom-models.json, whatsapp-groups.json
 *   backups/
 *
 * Does NOT delete source files — the user can clean up manually.
 */

import fs from "fs";
import { resolve } from "path";
import { BOT_ROOT, DATA_DIR, MEMORY_DIR, USERS_DIR, RUNTIME_DIR, BACKUP_DIR, SOUL_FILE, TOOLS_MD, TOOLS_JSON, CRON_FILE, MCP_CONFIG, FALLBACK_FILE, CUSTOM_MODELS, WA_GROUPS, WHATSAPP_AUTH, WA_MEDIA_DIR, ACCESS_FILE, SUDO_ENC_FILE, SUDO_KEY_FILE, MEMORY_FILE, EMBEDDINGS_IDX, ENV_FILE } from "./paths.js";

/**
 * Check if legacy data exists in the old locations.
 */
export function hasLegacyData(): boolean {
  const legacyIndicators = [
    resolve(BOT_ROOT, "docs", "MEMORY.md"),
    resolve(BOT_ROOT, "docs", "memory"),
    resolve(BOT_ROOT, "docs", "users"),
    resolve(BOT_ROOT, "data", "access.json"),
    resolve(BOT_ROOT, "SOUL.md"),
    // A BOT_ROOT/.env without a corresponding DATA_DIR/.env is a legacy layout
    // — the loader prefers DATA_DIR, so keeping .env in BOT_ROOT silently
    // breaks Settings/Setup/Doctor/fallback-order sync.
    (fs.existsSync(resolve(BOT_ROOT, ".env")) && !fs.existsSync(ENV_FILE))
      ? resolve(BOT_ROOT, ".env")
      : "",
  ].filter(Boolean);
  return legacyIndicators.some(p => fs.existsSync(p));
}

/**
 * Copy a file if source exists and destination doesn't.
 */
function copyIfNew(src: string, dest: string): boolean {
  if (fs.existsSync(src) && !fs.existsSync(dest)) {
    const destDir = resolve(dest, "..");
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  }
  return false;
}

/**
 * Copy a file if source exists and destination doesn't, then enforce a specific file mode.
 * Used for files containing secrets (e.g. .env) where 0600 must be guaranteed
 * regardless of the source file's permissions or the process umask.
 */
function copyIfNewWithMode(src: string, dest: string, mode: number): boolean {
  const copied = copyIfNew(src, dest);
  if (copied) {
    try { fs.chmodSync(dest, mode); } catch { /* best effort */ }
  }
  return copied;
}

/**
 * Recursively copy a directory if source exists and destination doesn't have the files.
 */
function copyDirIfNew(src: string, dest: string): number {
  if (!fs.existsSync(src)) return 0;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  let count = 0;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDirIfNew(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      try {
        fs.copyFileSync(srcPath, destPath);
        count++;
      } catch {
        // Source may have vanished between readdir and copy (e.g. WhatsApp session files)
      }
    }
  }
  return count;
}

/**
 * Migrate all legacy data to the new DATA_DIR.
 * Returns a summary of what was copied.
 */
export function migrateFromLegacy(): { copied: string[]; skipped: string[] } {
  const copied: string[] = [];
  const skipped: string[] = [];

  function track(label: string, result: boolean) {
    if (result) copied.push(label);
    else skipped.push(label);
  }

  // ── Single files ─────────────────────────────────────────

  // .env → .env  (secrets — enforce 0600 mode regardless of source perms)
  track(".env → .env", copyIfNewWithMode(resolve(BOT_ROOT, ".env"), ENV_FILE, 0o600));

  // SOUL.md → soul.md
  track("SOUL.md → soul.md", copyIfNew(resolve(BOT_ROOT, "SOUL.md"), SOUL_FILE));

  // TOOLS.md → tools.md
  track("TOOLS.md → tools.md", copyIfNew(resolve(BOT_ROOT, "TOOLS.md"), TOOLS_MD));

  // docs/tools.json → tools.json
  track("docs/tools.json", copyIfNew(resolve(BOT_ROOT, "docs", "tools.json"), TOOLS_JSON));

  // docs/MEMORY.md → memory/MEMORY.md
  track("docs/MEMORY.md", copyIfNew(resolve(BOT_ROOT, "docs", "MEMORY.md"), MEMORY_FILE));

  // docs/memory/.embeddings.json → memory/.embeddings.json
  track(".embeddings.json", copyIfNew(resolve(BOT_ROOT, "docs", "memory", ".embeddings.json"), EMBEDDINGS_IDX));

  // docs/cron-jobs.json → cron-jobs.json
  track("cron-jobs.json", copyIfNew(resolve(BOT_ROOT, "docs", "cron-jobs.json"), CRON_FILE));

  // docs/mcp.json → mcp.json
  track("mcp.json", copyIfNew(resolve(BOT_ROOT, "docs", "mcp.json"), MCP_CONFIG));

  // docs/fallback-order.json → fallback-order.json
  track("fallback-order.json", copyIfNew(resolve(BOT_ROOT, "docs", "fallback-order.json"), FALLBACK_FILE));

  // docs/custom-models.json → custom-models.json
  track("custom-models.json", copyIfNew(resolve(BOT_ROOT, "docs", "custom-models.json"), CUSTOM_MODELS));

  // docs/whatsapp-groups.json → whatsapp-groups.json
  track("whatsapp-groups.json", copyIfNew(resolve(BOT_ROOT, "docs", "whatsapp-groups.json"), WA_GROUPS));

  // data/access.json → data/access.json
  track("data/access.json", copyIfNew(resolve(BOT_ROOT, "data", "access.json"), ACCESS_FILE));

  // data/.sudo-enc → data/.sudo-enc
  track("data/.sudo-enc", copyIfNew(resolve(BOT_ROOT, "data", ".sudo-enc"), SUDO_ENC_FILE));
  track("data/.sudo-key", copyIfNew(resolve(BOT_ROOT, "data", ".sudo-key"), SUDO_KEY_FILE));

  // ── Directories ──────────────────────────────────────────

  // docs/memory/*.md → memory/*.md
  const memCount = copyDirIfNew(resolve(BOT_ROOT, "docs", "memory"), MEMORY_DIR);
  if (memCount > 0) copied.push(`memory/ (${memCount} files)`);

  // docs/users/ → users/
  const usersCount = copyDirIfNew(resolve(BOT_ROOT, "docs", "users"), USERS_DIR);
  if (usersCount > 0) copied.push(`users/ (${usersCount} files)`);

  // data/whatsapp-auth/ → data/whatsapp-auth/
  const waAuthCount = copyDirIfNew(resolve(BOT_ROOT, "data", "whatsapp-auth"), WHATSAPP_AUTH);
  if (waAuthCount > 0) copied.push(`whatsapp-auth/ (${waAuthCount} files)`);

  // data/wa-media/ → data/wa-media/
  const waMediaCount = copyDirIfNew(resolve(BOT_ROOT, "data", "wa-media"), WA_MEDIA_DIR);
  if (waMediaCount > 0) copied.push(`wa-media/ (${waMediaCount} files)`);

  // backups/ → backups/
  const backupCount = copyDirIfNew(resolve(BOT_ROOT, "backups"), BACKUP_DIR);
  if (backupCount > 0) copied.push(`backups/ (${backupCount} files)`);

  return { copied: copied.filter(c => !c.includes("false")), skipped };
}
