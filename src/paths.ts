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

/** User skills directory (custom, outside repo) */
export const USER_SKILLS_DIR = resolve(DATA_DIR, "skills");

/** Example/template files (always in repo) */
export const SOUL_EXAMPLE = resolve(BOT_ROOT, "SOUL.example.md");
export const TOOLS_EXAMPLE_MD = resolve(BOT_ROOT, "TOOLS.example.md");
export const TOOLS_EXAMPLE_JSON = resolve(BOT_ROOT, "docs", "tools.example.json");

// ── Data paths (DATA_DIR = ~/.alvin-bot) ───────────────────────────

/**
 * .env — Environment config with secrets (BOT_TOKEN, API keys, etc.)
 *
 * Lives in DATA_DIR (outside the code repo) for three reasons:
 *   1. Defense in depth against accidental commits — secrets never touch BOT_ROOT
 *   2. Survives `npm update -g` (BOT_ROOT in global installs = node_modules, gets wiped)
 *   3. Consistent with the loader priority in src/config.ts (DATA_DIR is Priority 1)
 *
 * Legacy installs with BOT_ROOT/.env are auto-migrated on first run (see src/migrate.ts).
 */
export const ENV_FILE = resolve(DATA_DIR, ".env");

/** memory/ — Daily logs and embeddings */
export const MEMORY_DIR = resolve(DATA_DIR, "memory");

/** memory/MEMORY.md — Long-term curated memory (legacy monolithic, still loaded) */
export const MEMORY_FILE = resolve(DATA_DIR, "memory", "MEMORY.md");

/** memory/identity.md — L0 layer (v4.11.0): core user facts, always loaded.
 *  Optional. If missing, MEMORY.md acts as the L0+L1 fallback. */
export const IDENTITY_FILE = resolve(DATA_DIR, "memory", "identity.md");

/** memory/preferences.md — L1 layer (v4.11.0): communication style + don'ts. */
export const PREFERENCES_FILE = resolve(DATA_DIR, "memory", "preferences.md");

/** memory/projects/ — L2 layer (v4.11.0): per-project context loaded on topic match. */
export const PROJECTS_MEMORY_DIR = resolve(DATA_DIR, "memory", "projects");

/** workspaces/ — Per-workspace configuration (v4.12.0).
 *  Each file is a markdown doc with YAML frontmatter defining the workspace's
 *  name, purpose, cwd, color, emoji, and an optional system prompt body.
 *  See src/services/workspaces.ts for the loader and matcher. */
export const WORKSPACES_DIR = resolve(DATA_DIR, "workspaces");

/** memory/.embeddings.json — Vector index */
export const EMBEDDINGS_IDX = resolve(DATA_DIR, "memory", ".embeddings.json");

/** users/ — User profiles and per-user memory */
export const USERS_DIR = resolve(DATA_DIR, "users");

/** data/ — Runtime control data */
export const RUNTIME_DIR = resolve(DATA_DIR, "data");

/** data/access.json — Group approval status */
export const ACCESS_FILE = resolve(DATA_DIR, "data", "access.json");

/** data/approved-users.json — DM-pairing approved user IDs */
export const APPROVED_USERS_FILE = resolve(DATA_DIR, "data", "approved-users.json");

/** data/whatsapp-auth/ — WhatsApp session persistence */
export const WHATSAPP_AUTH = resolve(DATA_DIR, "data", "whatsapp-auth");

/** data/wa-media/ — WhatsApp temp media */
export const WA_MEDIA_DIR = resolve(DATA_DIR, "data", "wa-media");

/** data/.sudo-enc / .sudo-key — Encrypted sudo password */
export const SUDO_ENC_FILE = resolve(DATA_DIR, "data", ".sudo-enc");
export const SUDO_KEY_FILE = resolve(DATA_DIR, "data", ".sudo-key");

/** backups/ — Config snapshots */
export const BACKUP_DIR = resolve(DATA_DIR, "backups");

/** state/async-agents.json — Pending background SDK agents (Fix #17 Stage 2).
 *  See src/services/async-agent-watcher.ts for the watcher that polls and
 *  delivers these. Survives bot restarts. */
export const ASYNC_AGENTS_STATE_FILE = resolve(DATA_DIR, "state", "async-agents.json");

/** state/sessions.json — Persisted user sessions across bot restarts (v4.11.0).
 *  Includes: sessionId (Claude SDK resume token), language, effort, voiceReply,
 *  workingDir, lastActivity, lastSdkHistoryIndex, history (capped). Atomic write
 *  via tmp+rename. Loaded on startup, debounce-flushed on mutations.
 *  See src/services/session-persistence.ts for the loader/flusher. */
export const SESSIONS_STATE_FILE = resolve(DATA_DIR, "state", "sessions.json");

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

/** delivery-queue.json — Reliable message delivery queue */
export const DELIVERY_QUEUE_FILE = resolve(DATA_DIR, "delivery-queue.json");

/** AGENTS.md — Standing orders (permanent instructions for every session) */
export const AGENTS_FILE = resolve(DATA_DIR, "AGENTS.md");

/** hooks/ — User-defined lifecycle event handlers */
export const HOOKS_DIR = resolve(DATA_DIR, "hooks");

/** scripts/browse-server.cjs — HTTP gateway for persistent browser sessions */
export const BROWSE_SERVER_SCRIPT = resolve(BOT_ROOT, "scripts", "browse-server.cjs");

/** ~/.claude/hub/SCRIPTS/browser.sh — Optional dev-only 3-tier browser router.
 *  Used ONLY if present (maintainer dev environment). Not required for normal operation —
 *  the bot has its own CDP bootstrap (see src/services/cdp-bootstrap.ts). */
export const HUB_BROWSER_SH = resolve(os.homedir(), ".claude", "hub", "SCRIPTS", "browser.sh");

/** browser/profile/ — Persistent Chromium profile for CDP (cookies, login state) */
export const CDP_PROFILE_DIR = resolve(DATA_DIR, "browser", "profile");

/** browser/screenshots/ — CDP screenshot output directory */
export const CDP_SCREENSHOTS_DIR = resolve(DATA_DIR, "browser", "screenshots");

/** browser/chrome-cdp.pid — PID of Chromium started by cdp-bootstrap */
export const CDP_PID_FILE = resolve(DATA_DIR, "browser", "chrome-cdp.pid");

/** browser/chrome-cdp.log — Chromium stderr/stdout when started by cdp-bootstrap */
export const CDP_LOG_FILE = resolve(DATA_DIR, "browser", "chrome-cdp.log");

/** data/exec-allowlist.json — User-defined exec allowlist */
export const EXEC_ALLOWLIST_FILE = resolve(DATA_DIR, "exec-allowlist.json");

/** assets/ — User-supplied files organized in category subdirectories */
export const ASSETS_DIR = resolve(DATA_DIR, "assets");

/** assets/INDEX.json — Machine-readable asset registry */
export const ASSETS_INDEX_JSON = resolve(DATA_DIR, "assets", "INDEX.json");

/** assets/INDEX.md — Human-readable asset summary (injected into prompts) */
export const ASSETS_INDEX_MD = resolve(DATA_DIR, "assets", "INDEX.md");

/** subagents/ — Detached `claude -p` subprocess output files (v4.13).
 *  Each dispatched agent writes its full stream-json output to
 *  subagents/<agentId>.jsonl. The async-agent-watcher polls these files
 *  and delivers the final result as a separate message when ready.
 *  These live outside BOT_ROOT/DATA_DIR's state/ so that the watcher's
 *  giveUpAt-survive-restart logic doesn't leak into the subprocess
 *  lifecycle. */
export const SUBAGENTS_DIR = resolve(DATA_DIR, "subagents");
