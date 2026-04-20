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
import { loadStandingOrders, getStandingOrders } from "./standing-orders.js";
import { getAssetIndexMd } from "./asset-index.js";

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

loadStandingOrders();

/** Base system prompt — adapts to user language */
function getBasePrompt(lang: "de" | "en"): string {
  return lang === "de"
    ? `You are Alvin Bot, an autonomous AI agent on Telegram.\nUse Markdown formatting compatible with Telegram (bold, italic, code blocks).`
    : `You are Alvin Bot, an autonomous AI agent on Telegram.\nUse Markdown formatting compatible with Telegram (bold, italic, code blocks).`;
}

/** Additional instructions for SDK providers (tool use) */
const SDK_ADDON = `When you run commands or edit files, briefly explain what you did.`;

/**
 * Stage 1 of Fix #17 — async sub-agents.
 *
 * Tells Claude to use the SDK's `run_in_background` flag for long-running
 * Agent tool calls so the main Telegram session doesn't stay locked for
 * 10+ minutes while sub-agents crawl the web, run audits, or build reports.
 *
 * Only injected into the prompt when isSDK === true (non-SDK providers
 * have no Agent tool). The bot's async-agent-watcher (Stage 2) picks up
 * the resulting outputFile, polls for completion, and delivers the
 * result as a separate Telegram message via subagent-delivery.ts.
 *
 * See test/system-prompt-background-hint.test.ts and
 * docs/superpowers/plans/2026-04-13-async-subagents.md
 */
const BACKGROUND_SUBAGENT_HINT = `## ⚠️ CRITICAL: Background Sub-Agents on Telegram/WhatsApp/Slack

**THE RULE (v4.13 update)**: For ANY long-running work (research,
audits, multi-step analysis, >30 seconds), you MUST prefer the
\`mcp__alvin__dispatch_agent\` tool over the built-in \`Task\` tool.

**Why alvin_dispatch over Task(run_in_background: true)?**

The built-in Task tool (even with \`run_in_background: true\`) keeps
the sub-agent tied to THIS session's CLI subprocess. If the user sends
me a new message mid-work, aborting this session would kill the
sub-agent half-way through and leave garbage partial output. Alvin
learned this the hard way (v4.12.1–v4.12.3 all got this wrong).

\`mcp__alvin__dispatch_agent\` spawns a COMPLETELY INDEPENDENT
\`claude -p\` subprocess with its own PID, own process group. It
survives ANY abort of this session. The user can interrupt me freely
and keep chatting while the sub-agent finishes cleanly. The bot
delivers the result as a separate message when ready.

**THIS IS THE SINGLE MOST IMPORTANT RULE FOR USER RESPONSIVENESS.**

**Why it matters**: During a synchronous Agent tool call the parent
session has no way to know the sub-agent is still working. It appears
hung. After a long silence the session can be aborted, destroying the
work. Using \`run_in_background: true\` solves this: the tool returns
an \`agentId\` + \`outputFile\` path IMMEDIATELY, your turn ends in
seconds, the user can keep chatting with me, and the bot automatically
delivers the sub-agent's final result as a separate message when ready.

**Decision tree** (apply every time you consider any sub-agent tool):

  Does the task involve ANY of the following?
    • Visiting more than 2 URLs
    • Reading/analyzing more than 5 files
    • A full-repo scan, audit, or refactor proposal
    • A multi-section report or structured document
    • Tasks you'd describe as "thorough", "comprehensive", or "deep"
    • Shell commands that may take >30s (builds, installs, tests)
    • Crawling, scraping, or fetching multiple resources
    • Research across multiple sources or domains

  YES → use \`mcp__alvin__dispatch_agent\` (truly detached, preferred)
  NO  → foreground is fine (single quick sub-query under 30s, answer
        yourself if possible)

NOTE: The built-in Task tool with run_in_background: true still works
but is now deprecated on Telegram/Slack/Discord/WhatsApp because it
ties sub-agent lifetime to this session. Only use Task directly when
you explicitly need the sub-agent's result IN THIS SAME TURN (rare).

**Examples where you MUST use \`run_in_background: true\`:**
- ANY audit (SEO, security, code quality, performance, accessibility, GEO)
- Research visiting more than 1-2 web pages
- Code reviews on more than a single file
- Full-repo analyses, dependency scans, architecture proposals
- Report generation with multiple sub-steps
- Build / install / test runs
- Long data-processing jobs
- Anything involving the word "analyze", "audit", "review", "scan", "research"

**Examples where foreground is fine:**
- "Read this file and summarize it" (single file, <10s)
- "What's 2+2?" (no sub-agent needed — answer yourself)
- "Check if package.json has foo" (one quick tool call)

**After launching a background agent (either tool), you MUST:**
1. Tell the user in ONE short sentence what you kicked off.
   Example: "Starting SEO audit for example.com in the background —
   I'll send the report when it's done."
2. End your turn IMMEDIATELY. Do not continue working. Do not wait.
3. The bot will deliver the result as a separate message when ready.
   You don't need to poll the outputFile proactively.

**For PARALLEL dispatch** (e.g. user says "research X and Y in parallel"):
Call \`mcp__alvin__dispatch_agent\` multiple times in the SAME assistant
turn, once per sub-task. Each returns its own agentId immediately. Your
turn ends as soon as all dispatches have returned — no sequential
waiting. The bot delivers each sub-agent's result separately when ready.

If the user asks "is it done yet?" before the bot delivers the result,
you MAY read the agent's \`outputFile\` (from the original tool result)
using the Read tool to peek at progress — but don't block on it.

**Never** call the Agent/Task tool without \`run_in_background: true\`
for anything you're not 100% sure completes in under 30 seconds. The
cost of unnecessary background mode is zero. The cost of blocking the
Telegram user for 20 minutes on a synchronous call is very high.`;

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
export function buildSystemPrompt(
  isSDK: boolean,
  language: import("../i18n.js").Locale = "en",
  chatId?: number | string,
  query?: string,
  workspacePersona?: string,
): string {
  // The deep base prompt has only de/en variants (writing four full
  // personality templates is out of scope). For es/fr we fall back to
  // the English base — the LLM mirrors the user's conversational language
  // anyway via langInstruction below, so the base-prompt language is
  // really just the "hint" for the system-prompt wrapper.
  const deepLang: "de" | "en" = language === "de" ? "de" : "en";

  const langInstruction = "Reply in the language the user writes in. Match their language naturally.";

  // Current date/time context — locale formatting uses the user's picked
  // locale for familiarity (German date formatting for de, etc.).
  const now = new Date();
  const tzLocale =
    language === "de" ? "de-DE" :
    language === "es" ? "es-ES" :
    language === "fr" ? "fr-FR" :
                        "en-US";
  const dateStr = now.toLocaleDateString(tzLocale, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString(tzLocale, { hour: "2-digit", minute: "2-digit" });
  const timeContext = `Current date: ${dateStr}, ${timeStr} (Europe/Berlin).`;

  const parts = [getBasePrompt(deepLang), langInstruction, timeContext];

  // Core self-awareness — always injected, adapted to active provider and language
  parts.push(buildSelfAwareness(isSDK, getActiveProviderLabel(), deepLang));

  if (soulContent) {
    parts.push(soulContent);
  }

  const standingOrders = getStandingOrders();
  if (standingOrders) {
    parts.push("## Standing Orders\n\n" + standingOrders);
  }

  // v4.12.0 — Workspace persona: per-channel system prompt override from
  // ~/.alvin-bot/workspaces/<name>.md body. Only injected when a workspace
  // is resolved for the channel; default workspace passes empty string.
  if (workspacePersona && workspacePersona.trim().length > 0) {
    parts.push("## Workspace Persona\n\n" + workspacePersona.trim());
  }

  if (isSDK) {
    parts.push(SDK_ADDON);
    // Stage 1 — teach Claude to use run_in_background for long-running
    // Agent tool calls so the main session unlocks fast.
    parts.push(BACKGROUND_SUBAGENT_HINT);
    // SDK providers have bash access — inject discovered tools so they know what's available
    parts.push(getToolSummary());
  }

  // Inject chat context for cron job creation
  if (chatId) {
    parts.push(`Current chat: Platform=telegram, ChatID=${chatId}. Use this ChatID when creating cron jobs that should send results to this chat.`);
  }

  // Memory context: ALL providers (SDK + non-SDK) get long-term memory
  // injected (v4.11.0 P0 #2). Before v4.11.0 this was non-SDK only; the SDK
  // was expected to read memory via tools but in practice rarely did, leading
  // to "frickelig" UX after session restarts. The injected MEMORY.md gives
  // Claude immediate context without spending a tool-call round-trip on Read.
  //
  // The optional `query` argument enables L2 project loading (v4.11.0 P1 #4):
  // memory-layers.ts matches the user's question against project filenames
  // in ~/.alvin-bot/memory/projects/ and only loads matching ones — keeping
  // the system prompt small while still surfacing relevant per-project facts.
  // See docs/superpowers/plans/2026-04-13-memory-persistence.md
  const memoryCtx = buildMemoryContext(query);
  if (memoryCtx) {
    parts.push(memoryCtx);
  }

  // Asset awareness: also extended to SDK in v4.11.0 — same rationale as
  // memory above. Cheap injection beats hoping Claude uses Glob/Read on
  // ~/.alvin-bot/assets/ proactively.
  const assetMd = getAssetIndexMd();
  if (assetMd) {
    parts.push(assetMd);
  }

  return parts.join("\n\n");
}

/**
 * Build a system prompt enhanced with semantically relevant memories.
 * Searches the vector index for context related to the user's message.
 *
 * @param isSDK         true → Claude SDK provider (has tool use)
 * @param language      preferred UI language
 * @param userMessage   the user's incoming message (used as the search query)
 * @param chatId        Telegram chat id (for cron job context)
 * @param isFirstTurn   v4.11.0 P0 #3 — whether this is the very first turn of
 *                      a (rehydrated or fresh) session. SDK only runs the
 *                      semantic search on first-turn to avoid spamming the
 *                      embeddings API on every subsequent turn — once the
 *                      session has resumed, Claude already has the recalled
 *                      context in its conversation history. Non-SDK providers
 *                      run the search on every turn (cheap, no resume).
 */
export async function buildSmartSystemPrompt(
  isSDK: boolean,
  language: import("../i18n.js").Locale = "en",
  userMessage?: string,
  chatId?: number | string,
  isFirstTurn = false,
  workspacePersona?: string,
): Promise<string> {
  // Pass userMessage as query so L2 project memories matching the topic
  // get loaded into the base prompt automatically. Workspace persona (v4.12.0)
  // is also threaded through so per-channel personas land in the system prompt.
  const base = buildSystemPrompt(isSDK, language, chatId, userMessage, workspacePersona);

  if (!userMessage) return base;

  // Decide whether to run the semantic search:
  //   non-SDK → always (cheap, no session resume to lean on)
  //   SDK     → only on the first turn of a session (Claude carries context
  //             across turns within the same session via SDK resume)
  const shouldSearch = !isSDK || isFirstTurn;
  if (!shouldSearch) return base;

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
