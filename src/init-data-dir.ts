/**
 * Data Directory Bootstrap — Ensures ~/.alvin-bot/ exists with all required structure.
 *
 * Called as the very first thing at bot startup, before any service imports.
 * Idempotent — safe to call multiple times.
 */

import fs from "fs";
import { DATA_DIR, MEMORY_DIR, USERS_DIR, RUNTIME_DIR, WHATSAPP_AUTH, BACKUP_DIR, SOUL_FILE, TOOLS_MD, TOOLS_JSON, CRON_FILE, MCP_CONFIG, FALLBACK_FILE, CUSTOM_MODELS, WA_GROUPS, SOUL_EXAMPLE, TOOLS_EXAMPLE_MD, TOOLS_EXAMPLE_JSON, WA_MEDIA_DIR, DELIVERY_QUEUE_FILE, AGENTS_FILE, HOOKS_DIR, USER_SKILLS_DIR, APPROVED_USERS_FILE } from "./paths.js";

/**
 * Create the directory structure only (no file seeding).
 * Must run BEFORE migration so directories exist for copying.
 */
export function ensureDataDirs(): void {
  const dirs = [
    DATA_DIR,
    MEMORY_DIR,
    USERS_DIR,
    RUNTIME_DIR,
    WHATSAPP_AUTH,
    WA_MEDIA_DIR,
    BACKUP_DIR,
    HOOKS_DIR,
    USER_SKILLS_DIR,
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Seed default files for a fresh install (only if they don't exist yet).
 * Must run AFTER migration so legacy data takes priority over templates.
 */
export function seedDefaults(): void {
  // SOUL.md — copy from example template if available
  if (!fs.existsSync(SOUL_FILE)) {
    if (fs.existsSync(SOUL_EXAMPLE)) {
      fs.copyFileSync(SOUL_EXAMPLE, SOUL_FILE);
    } else {
      fs.writeFileSync(SOUL_FILE, "# Bot Personality\n\nYou are a direct, lightly sarcastic, and genuinely helpful AI assistant.\nYou have opinions, you verify your work, and you don't pad answers with filler.\nMirror the user's language naturally.\n");
    }
  }

  // TOOLS.md — copy from example template if available
  if (!fs.existsSync(TOOLS_MD)) {
    if (fs.existsSync(TOOLS_EXAMPLE_MD)) {
      fs.copyFileSync(TOOLS_EXAMPLE_MD, TOOLS_MD);
    }
  }

  // tools.json (legacy) — copy from example if available
  if (!fs.existsSync(TOOLS_JSON)) {
    if (fs.existsSync(TOOLS_EXAMPLE_JSON)) {
      fs.copyFileSync(TOOLS_EXAMPLE_JSON, TOOLS_JSON);
    }
  }

  // Empty JSON defaults
  const jsonDefaults: Array<[string, string]> = [
    [CRON_FILE, "[]"],
    [DELIVERY_QUEUE_FILE, "[]"],
    [CUSTOM_MODELS, "[]"],
    [APPROVED_USERS_FILE, "[]"],
    [WA_GROUPS, '{"groups":[]}'],
    [FALLBACK_FILE, ""],  // Empty = use env defaults
    [MCP_CONFIG, ""],     // Empty = no MCP servers
  ];

  for (const [file, defaultContent] of jsonDefaults) {
    if (!fs.existsSync(file) && defaultContent) {
      fs.writeFileSync(file, defaultContent);
    }
  }

  // MEMORY.md — seed with empty template
  const memoryFile = `${MEMORY_DIR}/MEMORY.md`;
  if (!fs.existsSync(memoryFile)) {
    fs.writeFileSync(memoryFile, "# Long-term Memory\n\n> This file is your agent's long-term memory. Add important context here.\n");
  }

  // AGENTS.md — seed with default standing orders template
  if (!fs.existsSync(AGENTS_FILE)) {
    fs.writeFileSync(AGENTS_FILE, "# Standing Orders\n\n> Permanent instructions that apply to every session.\n> Edit this file to add rules, workflows, or recurring tasks.\n");
  }
}
