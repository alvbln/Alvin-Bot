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
import { searchMemory } from "./embeddings.js";

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
 * @param language Preferred language ('de' or 'en')
 */
export function buildSystemPrompt(isSDK: boolean, language: "de" | "en" = "de"): string {
  const langInstruction = language === "en"
    ? "Respond in English unless the user writes in another language."
    : "Antworte auf Deutsch, es sei denn der User schreibt auf Englisch.";

  // Current date/time context
  const now = new Date();
  const dateStr = now.toLocaleDateString("de-DE", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const timeContext = `Aktuelles Datum: ${dateStr}, ${timeStr} Uhr (Europe/Berlin).`;

  const parts = [BASE_PROMPT, langInstruction, timeContext];

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
 * Build a system prompt enhanced with semantically relevant memories.
 * Searches the vector index for context related to the user's message.
 */
export async function buildSmartSystemPrompt(
  isSDK: boolean,
  language: "de" | "en" = "de",
  userMessage?: string
): Promise<string> {
  const base = buildSystemPrompt(isSDK, language);

  // SDK providers read memory directly via tools — skip
  if (isSDK || !userMessage) return base;

  // Search for relevant memories
  try {
    const results = await searchMemory(userMessage, 3, 0.35);
    if (results.length > 0) {
      const memorySnippets = results.map(r => {
        const preview = r.text.length > 400 ? r.text.slice(0, 400) + "..." : r.text;
        return `[${r.source}] ${preview}`;
      }).join("\n\n");

      return base + `\n\n---\n## Relevante Erinnerungen (automatisch abgerufen)\n\n${memorySnippets}`;
    }
  } catch {
    // Embedding search failed — fall back to basic context
  }

  return base;
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
