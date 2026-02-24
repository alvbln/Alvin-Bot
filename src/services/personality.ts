/**
 * Personality Service — Loads SOUL.md and builds system prompts.
 *
 * SOUL.md defines Mr. Levin's personality and is injected into every system prompt.
 * This ensures consistent personality across ALL providers (SDK + non-SDK).
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { buildMemoryContext } from "./memory.js";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let soulContent = "";
try {
  soulContent = readFileSync(resolve(BOT_ROOT, "SOUL.md"), "utf-8");
} catch {
  console.warn("SOUL.md not found — using default personality");
}

/** Base system prompt for all providers */
const BASE_PROMPT = `Du bist Mr. Levin, ein autonomer AI-Agent auf Telegram.
Nutze Markdown-Formatierung kompatibel mit Telegram (fett, kursiv, Code-Blöcke).`;

/** Additional instructions for SDK providers (tool use) */
const SDK_ADDON = `Wenn du Commands ausführst oder Dateien bearbeitest, erkläre kurz was du getan hast.`;

/**
 * Build the full system prompt for a query.
 * @param isSDK Whether the active provider is the Claude SDK (has tool use)
 */
export function buildSystemPrompt(isSDK: boolean): string {
  const parts = [BASE_PROMPT];

  if (soulContent) {
    parts.push(soulContent);
  }

  if (isSDK) {
    parts.push(SDK_ADDON);
  }

  // Non-SDK providers get memory injected into system prompt
  // (SDK provider reads memory files directly via tools)
  if (!isSDK) {
    const memoryCtx = buildMemoryContext();
    if (memoryCtx) {
      parts.push(memoryCtx);
    }
  }

  return parts.join("\n\n");
}

/**
 * Get just the SOUL.md content (for /status or debugging).
 */
export function getSoulContent(): string {
  return soulContent || "(no SOUL.md loaded)";
}

/**
 * Reload SOUL.md from disk (e.g., after editing).
 */
export function reloadSoul(): boolean {
  try {
    soulContent = readFileSync(resolve(BOT_ROOT, "SOUL.md"), "utf-8");
    return true;
  } catch {
    return false;
  }
}
