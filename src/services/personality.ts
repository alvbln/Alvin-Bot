/**
 * Personality Service — Loads SOUL.md and builds system prompts.
 *
 * SOUL.md defines Alvin Bot's personality and is injected into every system prompt.
 * This ensures consistent personality across ALL providers (SDK + non-SDK).
 */

import { readFileSync } from "fs";
import { buildMemoryContext } from "./memory.js";
import { searchMemory } from "./embeddings.js";
import { getToolSummary } from "./tool-discovery.js";
import { buildSkillContext } from "./skills.js";
import { SOUL_FILE } from "../paths.js";

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
    return "AI language model";
  }
}

let soulContent = "";
try {
  soulContent = readFileSync(SOUL_FILE, "utf-8");
} catch {
  console.warn("SOUL.md not found — using default personality");
}

/** Base system prompt — adapts to user language */
function getBasePrompt(lang: "de" | "en"): string {
  return lang === "de"
    ? `You are Alvin Bot, an autonomous AI agent on Telegram.\nUse Markdown formatting compatible with Telegram (bold, italic, code blocks).`
    : `You are Alvin Bot, an autonomous AI agent on Telegram.\nUse Markdown formatting compatible with Telegram (bold, italic, code blocks).`;
}

/** Additional instructions for SDK providers (tool use) */
const SDK_ADDON = `When you run commands or edit files, briefly explain what you did.`;

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
- **Read emails?** → Use tools. But summarize content YOURSELF.
- **Generate images?** → API needed (Gemini, DALL-E).
- **Fetch a webpage?** → Use tools. But analyze content YOURSELF.
- **Create PDF?** → Use tools. But write the text YOURSELF.

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
    : "Antworte auf Deutsch. Wenn der User in einer anderen Sprache schreibt, wechsle natürlich in seine Sprache.";

  // Current date/time context
  const now = new Date();
  const locale = language === "de" ? "de-DE" : "en-US";
  const dateStr = now.toLocaleDateString(locale, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const timeContext = language === "de"
    ? `Current date: ${dateStr}, ${timeStr} (Europe/Berlin).`
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
    parts.push(`Current chat: Platform=telegram, ChatID=${chatId}. Use this ChatID when creating cron jobs that should send results to this chat.`);
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

      return base + `\n\n---\n## Relevant Memories (auto-retrieved)\n\n${memorySnippets}`;
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
    soulContent = readFileSync(SOUL_FILE, "utf-8");
    return true;
  } catch {
    return false;
  }
}
