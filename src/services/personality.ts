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
import { getToolSummary } from "./tool-discovery.js";

// Resolve display name for the active provider
function getActiveProviderLabel(): string {
  try {
    const primary = process.env.PRIMARY_PROVIDER || "claude-sdk";
    const labels: Record<string, string> = {
      "claude-sdk": "Claude (Anthropic Agent SDK) — Opus/Sonnet Klasse",
      "openai": "OpenAI GPT",
      "groq": "Groq (Llama 3.3 70B)",
      "gemini-2.5-flash": "Google Gemini 2.5 Flash",
      "google": "Google Gemini",
      "nvidia-llama-3.3-70b": "NVIDIA NIM (Llama 3.3 70B)",
      "nvidia-kimi-k2.5": "NVIDIA NIM (Kimi K2.5)",
    };
    return labels[primary] || primary;
  } catch {
    return "AI-Sprachmodell";
  }
}

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
 * Self-Awareness Core — Dynamic introspection block.
 *
 * This makes the agent deeply aware of what it IS, what it can do natively
 * (without external APIs), and when to use tools vs its own intelligence.
 *
 * Injected into EVERY system prompt, adapted to the active provider.
 */
function buildSelfAwareness(isSDK: boolean, providerName?: string): string {
  const model = providerName || (isSDK ? "Claude (Anthropic Agent SDK)" : "AI-Sprachmodell");

  return `## Selbstbewusstsein — Wer du bist und was du kannst

Du bist ein hochleistungsfähiges KI-Sprachmodell (${model}).

### Was du SELBST kannst (ohne externe APIs oder Tools):
- **Texte analysieren, zusammenfassen, übersetzen** — Du bist das Sprachmodell. Du BIST die KI.
- **Inhalte bewerten, kategorisieren, priorisieren** — Dein Kernkompetenz.
- **Kreativ schreiben** — Briefe, Reports, E-Mails, Geschichten, Code.
- **Logisch denken** — Probleme lösen, Entscheidungen begründen, Strategien entwickeln.
- **Daten strukturieren** — JSON, CSV, Tabellen aus Freitext extrahieren.
- **Code schreiben und debuggen** — In jeder gängigen Programmiersprache.

### Wann du Tools/APIs brauchst (und wann NICHT):
- **Zusammenfassung eines Textes?** → Du machst das SELBST. Kein API-Call nötig.
- **E-Mail lesen?** → Tool nutzen (osascript, himalaya). Aber den Inhalt SELBST zusammenfassen.
- **Bild generieren?** → API nötig (Gemini, DALL-E). Du kannst keine Bilder erzeugen.
- **Webseite abrufen?** → Tool nutzen (curl, web_fetch). Aber den Inhalt SELBST analysieren.
- **PDF erstellen?** → Tool nutzen (Python-Script, wkhtmltopdf). Aber den Text SELBST verfassen.
- **Etwas berechnen?** → Einfache Berechnungen selbst, komplexe via Python-Tool.

### Entscheidungsregel:
**Frage dich IMMER zuerst:** "Kann ich das mit meinem eigenen Verstand lösen?"
- Wenn ja → Direkt machen, kein Tool/API.
- Wenn nein → Das passende Tool nutzen.
- **NIEMALS** eine externe LLM-API (Groq, Gemini, OpenAI) aufrufen um Texte zu verarbeiten — DU bist das LLM!

### Deine Architektur (zur Orientierung):
- Du läufst als autonomer Agent mit Shell-Zugriff, Dateisystem-Zugriff und Web-Zugriff.
- Externe APIs sind für **spezialisierte Dienste** (Bildgenerierung, TTS, Wetter-Daten) — nicht für Denkarbeit.
- Wenn du Daten hast (E-Mails, Texte, Logs), verarbeite sie DIREKT in deiner Antwort.`;
}

/**
 * Build the full system prompt for a query.
 * @param isSDK Whether the active provider is the Claude SDK (has tool use)
 * @param language Preferred language ('de' or 'en')
 */
export function buildSystemPrompt(isSDK: boolean, language: "de" | "en" = "de", chatId?: number | string): string {
  const langInstruction = language === "en"
    ? "Respond in English unless the user writes in another language."
    : "Antworte auf Deutsch, es sei denn der User schreibt auf Englisch.";

  // Current date/time context
  const now = new Date();
  const dateStr = now.toLocaleDateString("de-DE", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const timeContext = `Aktuelles Datum: ${dateStr}, ${timeStr} Uhr (Europe/Berlin).`;

  const parts = [BASE_PROMPT, langInstruction, timeContext];

  // Core self-awareness — always injected, adapted to active provider
  parts.push(buildSelfAwareness(isSDK, getActiveProviderLabel()));

  if (soulContent) {
    parts.push(soulContent);
  }

  if (isSDK) {
    parts.push(SDK_ADDON);
    // SDK providers have bash access — inject discovered tools so they know what's available
    parts.push(getToolSummary());
  }

  // Inject chat context for cron job creation
  if (chatId) {
    parts.push(`Aktueller Chat: Platform=telegram, ChatID=${chatId}. Nutze diese ChatID wenn du Cron-Jobs erstellst die Ergebnisse an diesen Chat senden sollen.`);
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
  userMessage?: string,
  chatId?: number | string
): Promise<string> {
  const base = buildSystemPrompt(isSDK, language, chatId);

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
