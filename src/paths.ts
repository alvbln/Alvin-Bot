/**
 * Centralized Path Registry — Single source of truth for all file paths.
 *
 * BOT_ROOT = Code directory (where src/, dist/, plugins/, etc. live)
 * DATA_DIR = User data directory (~/.alvin-bot by default, override with ALVIN_DATA_DIR)
 *
 * All personal/runtime data lives in DATA_DIR (outside the repo).
 * All code/templates/plugins live in BOT_ROOT (inside the repo).
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import os from "os";

// ── Code Directory (repo root) ─────────────────────────────────────

export const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Data Directory (~/.alvin-bot) ──────────────────────────────────

export const DATA_DIR = resolve(
  process.env.ALVIN_DATA_DIR || resolve(os.homedir(), ".alvin-bot")
);

// ── Code paths (BOT_ROOT) ──────────────────────────────────────────

/** web/public/ — Static assets for Web UI */
export const PUBLIC_DIR = resolve(BOT_ROOT, "web", "public");

/** plugins/ — Plugin directory */
export const PLUGINS_DIR = resolve(BOT_ROOT, "plugins");

/** skills/ — Skill definitions */
export const SKILLS_DIR = resolve(BOT_ROOT, "skills");

/** .env — Environment config (stays in BOT_ROOT for dev, or DATA_DIR for packaged) */
export const ENV_FILE = resolve(BOT_ROOT, ".env");

/** Example/template files (always in repo) */
export const SOUL_EXAMPLE = resolve(BOT_ROOT, "SOUL.example.md");
export const TOOLS_EXAMPLE_MD = resolve(BOT_ROOT, "TOOLS.example.md");
export const TOOLS_EXAMPLE_JSON = resolve(BOT_ROOT, "docs", "tools.example.json");

// ── Data paths (DATA_DIR = ~/.alvin-bot) ───────────────────────────

/** memory/ — Daily logs and embeddings */
export const MEMORY_DIR = resolve(DATA_DIR, "memory");

/** memory/MEMORY.md — Long-term curated memory */
export const MEMORY_FILE = resolve(DATA_DIR, "memory", "MEMORY.md");

/** memory/.embeddings.json — Vector index */
export const EMBEDDINGS_IDX = resolve(DATA_DIR, "memory", ".embeddings.json");

/** users/ — User profiles and per-user memory */
export const USERS_DIR = resolve(DATA_DIR, "users");

/** data/ — Runtime control data */
export const RUNTIME_DIR = resolve(DATA_DIR, "data");

/** data/access.json — Group approval status */
export const ACCESS_FILE = resolve(DATA_DIR, "data", "access.json");

/** data/whatsapp-auth/ — WhatsApp session persistence */
export const WHATSAPP_AUTH = resolve(DATA_DIR, "data", "whatsapp-auth");

/** data/wa-media/ — WhatsApp temp media */
export const WA_MEDIA_DIR = resolve(DATA_DIR, "data", "wa-media");

/** data/.sudo-enc / .sudo-key — Encrypted sudo password */
export const SUDO_ENC_FILE = resolve(DATA_DIR, "data", ".sudo-enc");
export const SUDO_KEY_FILE = resolve(DATA_DIR, "data", ".sudo-key");

/** backups/ — Config snapshots */
export const BACKUP_DIR = resolve(DATA_DIR, "backups");

/** soul.md — Bot personality */
export const SOUL_FILE = resolve(DATA_DIR, "soul.md");

/** tools.md — Custom tool definitions (Markdown) */
export const TOOLS_MD = resolve(DATA_DIR, "tools.md");

/** tools.json — Custom tool definitions (legacy JSON) */
export const TOOLS_JSON = resolve(DATA_DIR, "tools.json");

/** cron-jobs.json — Scheduled tasks */
export const CRON_FILE = resolve(DATA_DIR, "cron-jobs.json");

/** mcp.json — MCP server config */
export const MCP_CONFIG = resolve(DATA_DIR, "mcp.json");

/** fallback-order.json — Provider fallback chain */
export const FALLBACK_FILE = resolve(DATA_DIR, "fallback-order.json");

/** custom-models.json — Custom LLM endpoints */
export const CUSTOM_MODELS = resolve(DATA_DIR, "custom-models.json");

/** whatsapp-groups.json — WhatsApp group tracking */
export const WA_GROUPS = resolve(DATA_DIR, "whatsapp-groups.json");
