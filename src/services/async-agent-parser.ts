/**
 * Pure helpers for the async-agent watcher (Fix #17 Stage 2).
 *
 * Two responsibilities, both pure (the file read in parseOutputFileStatus
 * is pure-by-input — same path returns the same shape at that moment in
 * time, no mutation, no side effects):
 *
 *  1. Parse the SDK's plain-text "Async agent launched successfully" tool
 *     result into a structured AsyncLaunchedInfo.
 *  2. Read the tail of an outputFile JSONL stream and decide whether the
 *     sub-agent is still running, completed, or failed.
 *
 * Format details captured live from @anthropic-ai/claude-agent-sdk@0.2.97
 * on 2026-04-13. See docs/superpowers/specs/sdk-async-agent-outputfile-format.md
 * for the full investigation notes — the SDK's .d.ts shape DOES NOT match
 * what the runtime actually emits, which is why the contract is pinned by
 * tests against real fixtures.
 */
import { promises as fs } from "fs";

export interface AsyncLaunchedInfo {
  agentId: string;
  outputFile: string;
}

export type OutputFileStatus =
  | { state: "running"; size: number }
  | {
      state: "completed";
      output: string;
      tokensUsed?: { input: number; output: number };
    }
  | { state: "failed"; error: string }
  | { state: "missing" };

// ── Tool-result text parser ──────────────────────────────────────────

/**
 * Parse the plain-text SDK tool-result content for an `Agent` call with
 * `run_in_background: true`. The format is documented in the spec doc
 * — it's NOT JSON, and the field is `output_file` (snake_case).
 *
 * Accepts:
 *   - the raw text string
 *   - an Anthropic SDK content array `[{type: "text", text: "..."}]`
 *   - null/undefined/non-string → returns null
 */
export function parseAsyncLaunchedToolResult(
  raw: unknown,
): AsyncLaunchedInfo | null {
  // Normalize to a string
  let text: string;
  if (raw == null) return null;
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    // SDK content blocks shape
    text = raw
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("");
  } else {
    return null;
  }

  if (!text || text.length === 0) return null;
  // Quick gate: avoid expensive matching on non-async tool results
  if (!text.includes("Async agent launched successfully")) return null;

  // agentId line: "agentId: <id> (...)" — capture everything up to first space/paren
  const agentMatch = text.match(/agentId:\s*(\S+)/);
  if (!agentMatch) return null;
  const agentId = agentMatch[1].trim();
  if (!agentId) return null;

  // output_file line: "output_file: <path>" — path may contain spaces, capture
  // until end of line (the path is always on its own line in real output).
  const outFileMatch = text.match(/output_file:\s*(.+?)\s*(?:\n|$)/);
  if (!outFileMatch) return null;
  const outputFile = outFileMatch[1].trim();
  if (!outputFile) return null;

  return { agentId, outputFile };
}

// ── outputFile status reader ─────────────────────────────────────────

interface JsonlLine {
  type?: string;
  agentId?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  // v4.13 — fields from `claude -p --output-format stream-json`'s
  // final result event. Structure: {"type":"result","subtype":"success",
  // "stop_reason":"end_turn","result":"FINAL TEXT","usage":{...},...}
  subtype?: string;
  result?: string;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  stop_reason?: string;
}

const DEFAULT_TAIL_BYTES = 64 * 1024;

/**
 * v4.12.4 — Default staleness window for partial-output delivery.
 *
 * If an outputFile has not been written to for at least this long AND
 * there is usable assistant text content in it, treat it as "completed
 * with partial output" rather than leaving it to time out at 12h with
 * an empty banner. 5 minutes is a balance between:
 *   - Fast enough to unblock interrupted agents (most useful work is
 *     done within a few minutes)
 *   - Slow enough to avoid false-positives on slow-but-alive agents
 *     (typical tool_use gaps are under 30s)
 *
 * Override per call via opts.stalenessMs, or globally via the
 * ALVIN_SUBAGENT_STALENESS_MS env var. `0` disables the fallback
 * entirely (strict end_turn-only completion detection).
 */
const DEFAULT_STALENESS_MS =
  Number(process.env.ALVIN_SUBAGENT_STALENESS_MS) || 5 * 60 * 1000;

/**
 * Banner prepended to partial-output deliveries so the user knows the
 * sub-agent was interrupted and this isn't a clean completion.
 */
const INTERRUPTED_BANNER =
  "⚠️ _Sub-Agent wurde unterbrochen — hier ist der partielle Output:_\n\n";

/**
 * Read the tail of an SDK background-agent outputFile and decide what
 * state the sub-agent is in. See spec doc for the JSONL format. We only
 * read the last `maxTailBytes` of the file because long-running agents
 * (SEO audits etc.) can produce hundreds of KB of intermediate JSONL.
 *
 * v4.12.4 adds staleness-based partial-output delivery. When no
 * `end_turn` marker is present, the parser checks file mtime: if the
 * file hasn't grown in `stalenessMs` AND there is text content in the
 * assistant turns, aggregate the text across all turns (not just the
 * last), prepend an "interrupted" banner, and return "completed". This
 * recovers real work from agents killed mid-execution (e.g. by the
 * v4.12.3 bypass abort propagating through the SDK subprocess).
 */
export async function parseOutputFileStatus(
  path: string,
  opts: { maxTailBytes?: number; stalenessMs?: number } = {},
): Promise<OutputFileStatus> {
  const maxTailBytes = opts.maxTailBytes ?? DEFAULT_TAIL_BYTES;
  const stalenessMs = opts.stalenessMs ?? DEFAULT_STALENESS_MS;

  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    return { state: "missing" };
  }
  if (stat.size === 0) {
    // Empty file is functionally the same as missing — we keep polling.
    return { state: "missing" };
  }

  // Tail-read the last maxTailBytes
  let buf: Buffer;
  let fh;
  try {
    fh = await fs.open(path, "r");
    const readSize = Math.min(stat.size, maxTailBytes);
    buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, stat.size - readSize);
  } catch {
    return { state: "missing" };
  } finally {
    try { await fh?.close(); } catch { /* ignore */ }
  }

  const text = buf.toString("utf-8");

  // Split into lines. If we tail-read into the middle of a line (size >
  // maxTailBytes), drop the first line because it's almost certainly
  // truncated. The trailing line is dropped if there's no newline — it's
  // the line being written right now.
  const lines = text.split("\n");
  const tailIsMidLine = stat.size > maxTailBytes;
  const headIncomplete = tailIsMidLine ? 1 : 0;
  const trailIncomplete = text.endsWith("\n") ? 0 : 1;
  const usable = lines
    .slice(headIncomplete, lines.length - (trailIncomplete > 0 ? trailIncomplete : 0))
    .filter((l) => l.length > 0);

  // v4.13 — FIRST PASS: look for a `{"type":"result"}` event anywhere in
  // the tail. This is the completion signal for `claude -p
  // --output-format stream-json` output (used by the v4.13 dispatch
  // mechanism). When present, the `result` field holds the authoritative
  // final text. If `result.result` is missing, aggregate from all
  // assistant text blocks in the tail.
  for (let i = usable.length - 1; i >= 0; i--) {
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(usable[i]) as JsonlLine;
    } catch {
      continue;
    }
    if (parsed.type === "result") {
      // Prefer the authoritative `result` field when present.
      let output = typeof parsed.result === "string" ? parsed.result : "";

      // Fallback: aggregate text from all assistant messages in the tail.
      if (!output) {
        const fragments: string[] = [];
        for (const line of usable) {
          let p: JsonlLine;
          try {
            p = JSON.parse(line) as JsonlLine;
          } catch {
            continue;
          }
          if (
            p.type === "assistant" &&
            Array.isArray(p.message?.content)
          ) {
            for (const c of p.message!.content!) {
              if (c?.type === "text" && typeof c.text === "string") {
                fragments.push(c.text);
              }
            }
          }
        }
        output = fragments.join("\n\n").trim();
      }

      // Token usage from the result event itself.
      const usage = parsed.usage;
      const tokensUsed = usage
        ? {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
          }
        : undefined;

      return { state: "completed", output, tokensUsed };
    }
  }

  // Walk backwards to find the most-recent assistant message with end_turn
  for (let i = usable.length - 1; i >= 0; i--) {
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(usable[i]) as JsonlLine;
    } catch {
      // Garbage line — skip
      continue;
    }

    if (
      parsed.type === "assistant" &&
      parsed.message?.stop_reason === "end_turn" &&
      Array.isArray(parsed.message.content)
    ) {
      const finalText = parsed.message.content
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text!)
        .join("\n\n");

      const usage = parsed.message.usage;
      return {
        state: "completed",
        output: finalText,
        tokensUsed: usage
          ? {
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
            }
          : undefined,
      };
    }
  }

  // v4.12.4 — No clean end_turn. Check for staleness + partial text.
  if (stalenessMs > 0) {
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs >= stalenessMs) {
      // Aggregate ALL assistant text blocks across the tail, in order.
      // We parse forward now (not backward like the end_turn scan) so
      // the delivered text preserves the natural reading order.
      const textFragments: string[] = [];
      let lastUsage: { input: number; output: number } | undefined;
      for (const line of usable) {
        let parsed: JsonlLine;
        try {
          parsed = JSON.parse(line) as JsonlLine;
        } catch {
          continue;
        }
        if (
          parsed.type === "assistant" &&
          Array.isArray(parsed.message?.content)
        ) {
          for (const c of parsed.message!.content!) {
            if (c?.type === "text" && typeof c.text === "string") {
              textFragments.push(c.text);
            }
          }
          if (parsed.message?.usage) {
            lastUsage = {
              input: parsed.message.usage.input_tokens ?? 0,
              output: parsed.message.usage.output_tokens ?? 0,
            };
          }
        }
      }

      if (textFragments.length > 0) {
        const aggregated = textFragments.join("\n\n").trim();
        if (aggregated.length > 0) {
          return {
            state: "completed",
            output: INTERRUPTED_BANNER + aggregated,
            tokensUsed: lastUsage,
          };
        }
      }
    }
  }

  // No completion marker found and not stale (or no text) — still running.
  return { state: "running", size: stat.size };
}
