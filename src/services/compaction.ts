/**
 * Context Compaction Service — Auto-summarize long non-SDK sessions.
 *
 * When conversation history grows too long (by message count or token count),
 * older entries are summarized via AI, flushed to daily memory log, and replaced
 * with a compact system summary message.
 */

import type { UserSession } from "./session.js";
import type { ChatMessage } from "../providers/types.js";
import { config } from "../config.js";
import { appendDailyLog } from "./memory.js";
import { getRegistry } from "../engine.js";

/** How many recent messages to keep verbatim after compaction. */
const KEEP_LAST = 10;

/** Fallback: if AI summary fails, keep this many recent messages. */
const FALLBACK_KEEP = 5;

/** Max chars per message when building the summary input. */
const MAX_CHARS_PER_ENTRY = 500;

export interface CompactionResult {
  /** Number of history entries removed */
  removedEntries: number;
  /** Approximate token count of the summary that replaced them */
  summaryTokens: number;
  /** Whether the removed content was flushed to daily memory */
  flushedToMemory: boolean;
}

/**
 * Check whether a session needs compaction.
 * Returns true if history is long enough or token usage is high.
 */
export function shouldCompact(session: UserSession): boolean {
  if (session.history.length <= KEEP_LAST) return false;
  return (
    session.history.length >= 25 ||
    session.totalInputTokens >= config.compactionThreshold
  );
}

/**
 * Compact a session's conversation history.
 *
 * 1. Separate history into "to summarize" (older) and "to keep" (recent).
 * 2. Flush a textual summary of the older entries to daily memory log.
 * 3. Try to generate an AI summary; fall back to raw truncation on failure.
 * 4. Replace session.history with [summary system message, ...kept messages].
 */
export async function compactSession(session: UserSession): Promise<CompactionResult> {
  const history = session.history;

  // Nothing to compact if we have fewer messages than we'd keep
  if (history.length <= KEEP_LAST) {
    return { removedEntries: 0, summaryTokens: 0, flushedToMemory: false };
  }

  const toSummarize = history.slice(0, history.length - KEEP_LAST);
  const toKeep = history.slice(history.length - KEEP_LAST);

  // Build text representation of entries to summarize
  const summaryInput = toSummarize
    .map((msg) => {
      const content = msg.content.length > MAX_CHARS_PER_ENTRY
        ? msg.content.slice(0, MAX_CHARS_PER_ENTRY) + "..."
        : msg.content;
      return `${msg.role}: ${content}`;
    })
    .join("\n\n");

  // Flush to daily memory BEFORE removing entries
  let flushedToMemory = false;
  try {
    const flushText = [
      `**Context Compaction** — ${toSummarize.length} messages archived:`,
      "",
      summaryInput.length > 2000
        ? summaryInput.slice(0, 2000) + "\n[...truncated]"
        : summaryInput,
    ].join("\n");
    appendDailyLog(flushText);
    flushedToMemory = true;
  } catch (err) {
    console.error("Compaction: failed to flush to memory:", err);
  }

  // v4.11.0 P1 #5 — Auto-extract structured facts from the archived chunk
  // and persist them to MEMORY.md. Experimental feature, opt-out via
  // MEMORY_EXTRACTION_DISABLED=1. Safe wrapper — never throws.
  try {
    const { extractAndStoreFacts } = await import("./memory-extractor.js");
    const result = await extractAndStoreFacts(summaryInput);
    if (result.factsStored > 0) {
      console.log(`🧠 memory-extractor: stored ${result.factsStored} new fact(s) in MEMORY.md`);
    }
  } catch (err) {
    console.warn(
      "memory-extractor failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }

  // Try AI-powered summary
  let summaryText: string | null = null;
  try {
    summaryText = await generateAISummary(summaryInput);
  } catch (err) {
    console.warn("Compaction: AI summary failed, using fallback:", err);
  }

  let summaryMessage: ChatMessage;
  let removedEntries: number;

  if (summaryText) {
    // AI summary succeeded — replace old entries with a single system message
    summaryMessage = {
      role: "system",
      content: `[Conversation summary of ${toSummarize.length} earlier messages]\n\n${summaryText}`,
    };
    removedEntries = toSummarize.length;
    session.history = [summaryMessage, ...toKeep];
  } else {
    // Fallback — just keep the last FALLBACK_KEEP entries from the to-keep set
    // plus a minimal note that earlier context was dropped
    const fallbackKeep = history.slice(-FALLBACK_KEEP);
    summaryMessage = {
      role: "system",
      content: `[Earlier conversation context (${history.length - FALLBACK_KEEP} messages) was compacted due to length. Recent context follows.]`,
    };
    removedEntries = history.length - FALLBACK_KEEP;
    session.history = [summaryMessage, ...fallbackKeep];
  }

  const summaryTokens = Math.ceil(summaryMessage.content.length / 4); // rough estimate

  // Track how many compactions this session has seen, for /status telemetry
  session.compactionCount = (session.compactionCount || 0) + 1;

  return {
    removedEntries,
    summaryTokens,
    flushedToMemory,
  };
}

/**
 * Generate an AI-powered summary of conversation entries using the active provider.
 * Uses effort "low" to keep cost minimal.
 */
async function generateAISummary(text: string): Promise<string> {
  const registry = getRegistry();

  const opts = {
    prompt: `Summarize the following conversation in under 300 words. Focus on key topics, decisions, and any action items. Be concise.\n\n${text}`,
    systemPrompt: "You are a conversation summarizer. Output only the summary, no preamble.",
    effort: "low" as const,
  };

  let result = "";

  for await (const chunk of registry.queryWithFallback(opts)) {
    if (chunk.type === "text" && chunk.text) {
      result = chunk.text;
    }
    if (chunk.type === "error") {
      throw new Error(chunk.error || "AI summary generation failed");
    }
  }

  if (!result.trim()) {
    throw new Error("AI summary returned empty result");
  }

  return result.trim();
}
