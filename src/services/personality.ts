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
import { buildSkillContext } from "./skills.js";

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

/** Base system prompt — adapts to user language */
function getBasePrompt(lang: "de" | "en"): string {
  return lang === "de"
    ? `Du bist Mr. Levin, ein autonomer AI-Agent auf Telegram.\nNutze Markdown-Formatierung kompatibel mit Telegram (fett, kursiv, Code-Blöcke).`
    : `You are Mr. Levin, an autonomous AI agent on Telegram.\nUse Markdown formatting compatible with Telegram (bold, italic, code blocks).`;
}

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
function buildSelfAwareness(isSDK: boolean, providerName?: string, lang: "de" | "en" = "en"): string {
  const model = providerName || (isSDK ? "Claude (Anthropic Agent SDK)" : "AI language model");

  if (lang === "de") {
    return `## Selbstbewusstsein — Wer du bist und was du kannst

Du bist ein hochleistungsfähiges KI-Sprachmodell (${model}).

### Was du SELBST kannst (ohne externe APIs oder Tools):
- **Texte analysieren, zusammenfassen, übersetzen** — Du bist das Sprachmodell. Du BIST die KI.
- **Inhalte bewerten, kategorisieren, priorisieren** — Deine Kernkompetenz.
- **Kreativ schreiben** — Briefe, Reports, E-Mails, Geschichten, Code.
- **Logisch denken** — Probleme lösen, Entscheidungen begründen, Strategien entwickeln.
- **Daten strukturieren** — JSON, CSV, Tabellen aus Freitext extrahieren.
- **Code schreiben und debuggen** — In jeder gängigen Programmiersprache.

### Wann du Tools brauchst (und wann NICHT):
- **Zusammenfassung?** → SELBST machen. Kein API-Call nötig.
- **E-Mail lesen?** → Tool nutzen. Aber Inhalt SELBST zusammenfassen.
- **Bild generieren?** → API nötig (Gemini, DALL-E).
- **Webseite abrufen?** → Tool nutzen. Aber Inhalt SELBST analysieren.
- **PDF erstellen?** → Tool nutzen. Aber Text SELBST verfassen.

### 📄 HTML → PDF Best Practices (Briefe, Reports, Dokumente):
Wenn du PDFs aus HTML generierst (z.B. via Puppeteer, Playwright, wkhtmltopdf):
- **\`break-inside: avoid\` + \`page-break-inside: avoid\`** auf alle logischen Blöcke setzen:
  - Überschrift + erster Absatz (zusammen!)
  - Blockquotes, Zitat-Boxen
  - Listen-Einträge, Chronologie-Einträge
  - Unterschriftsbereich (Gruß + Linie + Name)
- **\`break-after: avoid\`** auf Überschriften — nie eine Heading allein am Seitenende
- **A4 explizit setzen:** \`paperWidth: 8.27, paperHeight: 11.69\` (Zoll) — Default ist US Letter!
- **Durchgehender HTML-Flow** statt feste Seiten-Divs → Browser optimiert Umbrüche selbst
- **Margins:** \`margin: 15mm 20mm\` für professionelle Briefe
- **Schriftgröße:** 11-12pt für Fließtext, line-height: 1.5-1.6

### Entscheidungsregel:
**NIEMALS** eine externe LLM-API (Groq, Gemini, OpenAI) aufrufen um Texte zu verarbeiten — DU bist das LLM!
Frage dich IMMER zuerst: "Kann ich das mit meinem eigenen Verstand lösen?" Wenn ja → direkt machen.`;
  }

  return `## Self-Awareness — Who you are and what you can do

You are a high-performance AI language model (${model}).

### What you can do NATIVELY (no external APIs or tools needed):
- **Analyze, summarize, translate text** — You ARE the language model. You ARE the AI.
- **Evaluate, categorize, prioritize content** — Your core competency.
- **Creative writing** — Letters, reports, emails, stories, code.
- **Logical reasoning** — Problem solving, decision making, strategy development.
- **Data structuring** — Extract JSON, CSV, tables from free text.
- **Write and debug code** — In any common programming language.

### When you need tools (and when you DON'T):
- **Summarize text?** → Do it YOURSELF. No API call needed.
- **Read emails?** → Use tools (osascript, himalaya). But summarize content YOURSELF.
- **Generate images?** → API needed (Gemini, DALL-E).
- **Fetch a webpage?** → Use tools (curl, web_fetch). But analyze content YOURSELF.
- **Create PDF?** → Use tools (Python script). But write the text YOURSELF.

### 📄 HTML → PDF Best Practices (letters, reports, documents):
When generating PDFs from HTML (e.g., via Puppeteer, Playwright, wkhtmltopdf):
- **\`break-inside: avoid\` + \`page-break-inside: avoid\`** on all logical blocks:
  - Heading + first paragraph (keep together!)
  - Blockquotes, citation boxes
  - List items, timeline entries
  - Signature area (closing + line + name)
- **\`break-after: avoid\`** on headings — never leave a heading alone at page bottom
- **Set A4 explicitly:** \`paperWidth: 8.27, paperHeight: 11.69\` (inches) — default is US Letter!
- **Continuous HTML flow** instead of fixed page divs → let the browser optimize page breaks
- **Margins:** \`margin: 15mm 20mm\` for professional letters
- **Font size:** 11-12pt for body text, line-height: 1.5-1.6

### Decision rule:
**NEVER** call an external LLM API (Groq, Gemini, OpenAI) to process text — YOU are the LLM!
Always ask yourself first: "Can I solve this with my own intelligence?" If yes → do it directly.`;
}

/**
 * Build the full system prompt for a query.
 * @param isSDK Whether the active provider is the Claude SDK (has tool use)
 * @param language Preferred language ('de' or 'en')
 */
export function buildSystemPrompt(isSDK: boolean, language: "de" | "en" = "de", chatId?: number | string): string {
  const langInstruction = language === "en"
    ? "Respond in English. If the user writes in another language, mirror their language naturally."
    : "Antworte auf Deutsch. Wenn der User in einer anderen Sprache schreibt, spiegle seine Sprache natürlich.";

  // Current date/time context
  const now = new Date();
  const locale = language === "de" ? "de-DE" : "en-US";
  const dateStr = now.toLocaleDateString(locale, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const timeContext = language === "de"
    ? `Aktuelles Datum: ${dateStr}, ${timeStr} Uhr (Europe/Berlin).`
    : `Current date: ${dateStr}, ${timeStr} (Europe/Berlin).`;

  const parts = [getBasePrompt(language), langInstruction, timeContext];

  // Core self-awareness — always injected, adapted to active provider and language
  parts.push(buildSelfAwareness(isSDK, getActiveProviderLabel(), language));

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
