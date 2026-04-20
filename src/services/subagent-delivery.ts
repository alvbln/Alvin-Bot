/**
 * Sub-Agent Delivery Router (I3) — context-aware rendering of sub-agent
 * results into Telegram. Source decides the delivery path:
 *   - implicit → no-op (main stream already shows the Task-tool result)
 *   - user     → banner+final as a new message in parentChatId
 *   - cron     → banner+final in chatId from the CronJob target
 *
 * The caller is responsible for passing a correct `parentChatId` on the
 * SubAgentInfo. Lookup of the bot API is lazy so we can unit-test the
 * module with a fake bot via __setBotApiForTest.
 */

import type { SubAgentInfo, SubAgentResult, VisibilityMode } from "./subagents.js";
import { getVisibility } from "./subagents.js";

/**
 * Telegram's Markdown parser rejects unbalanced or unexpected entities
 * (stray `*`, `_`, un-escaped `|` in tables, etc.). Sub-agent outputs
 * mix all of these. When we hit one of these errors, retry the same
 * content as plain text so the user still sees the result instead of
 * a silent drop.
 */
function isTelegramParseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: string; description?: string };
  const haystack = `${e.message ?? ""} ${e.description ?? ""}`;
  return /can't parse entities|can't find end of the entity/i.test(haystack);
}

/**
 * Send a Markdown message with an automatic plain-text retry on parse
 * errors. Any other error propagates to the caller's outer catch.
 */
async function sendWithMarkdownFallback(
  api: MinimalBotApi,
  chatId: number,
  text: string,
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (err) {
    if (!isTelegramParseError(err)) throw err;
    console.warn(`[subagent-delivery] Markdown parse failed, retrying as plain text`);
    await api.sendMessage(chatId, text);
  }
}

const MAX_TG_CHUNK = 3800; // below Telegram's 4096 limit with headroom
const FILE_UPLOAD_THRESHOLD = 20_000; // switch to .md file upload above this

interface MinimalBotApi {
  sendMessage: (chatId: number, text: string, opts?: Record<string, unknown>) => Promise<unknown>;
  sendDocument: (chatId: number, doc: unknown, opts?: Record<string, unknown>) => Promise<unknown>;
  /** Optional — required for A4 live-stream mode. */
  editMessageText?: (
    chatId: number,
    messageId: number,
    text: string,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
}

let injectedApi: MinimalBotApi | null = null;
let runtimeApi: MinimalBotApi | null = null;

/** Test-only hook for injecting a fake bot API. Production code must NEVER call this. */
export function __setBotApiForTest(api: MinimalBotApi | null): void {
  injectedApi = api;
}

/** Wire the grammy bot API once at startup (called from src/index.ts). */
export function attachBotApi(api: MinimalBotApi): void {
  runtimeApi = api;
}

function getBotApi(): MinimalBotApi | null {
  return injectedApi ?? runtimeApi;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem}s`;
}

function statusIcon(status: SubAgentResult["status"]): string {
  switch (status) {
    case "completed": return "✅";
    case "timeout":   return "⏱️";
    case "cancelled": return "⚠️";
    case "error":     return "❌";
  }
}

function buildBanner(info: SubAgentInfo, result: SubAgentResult): string {
  // A "completed" run that produced zero output is almost always a
  // silent failure — a truncated stream, a tool-only final turn, a
  // provider that swallowed its response. Call that out explicitly so
  // the user sees a clear signal instead of a green tick on nothing.
  const truncated =
    result.status === "completed" && (!result.output || result.output.trim().length === 0);
  const icon = truncated ? "⚠️" : statusIcon(result.status);
  const statusLabel = truncated ? "completed · empty output" : result.status;
  const dur = formatDuration(result.duration);
  const ti = formatTokens(result.tokensUsed.input);
  const to = formatTokens(result.tokensUsed.output);
  return `${icon} *${info.name}* ${statusLabel} · ${dur} · ${ti} in / ${to} out`;
}

// ── A4 Live-Stream ──────────────────────────────────────────

/**
 * Per-spawn live-stream state. Edits a single Telegram message as the
 * sub-agent produces text, throttled to ~800ms between edits. Posts a
 * separate banner message at finalize so the user gets a completion
 * notification (edits don't trigger Telegram notifications).
 *
 * The live message uses plain text (no parse_mode) so half-formed
 * markdown during streaming can never crash the edit. The final banner
 * does use markdown.
 */
const LIVE_EDIT_THROTTLE_MS = 800;
const LIVE_INITIAL_TEXT = (name: string) => `⏳ ${name} thinking…`;

export class LiveStream {
  private messageId: number | null = null;
  private lastEditAt = 0;
  private pendingText: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  public failed = false;

  constructor(
    private api: MinimalBotApi,
    private chatId: number,
    private agentName: string,
  ) {}

  /** Post the initial placeholder message. Called before the first chunk. */
  async start(): Promise<void> {
    if (!this.api.editMessageText) {
      this.failed = true;
      console.warn(`[subagent-live] bot api has no editMessageText — falling back`);
      return;
    }
    try {
      const initial = LIVE_INITIAL_TEXT(this.agentName);
      const msg = await this.api.sendMessage(this.chatId, initial);
      const msgId = (msg as { message_id?: number }).message_id;
      if (typeof msgId === "number") {
        this.messageId = msgId;
        this.lastEditAt = Date.now();
        this.started = true;
      } else {
        console.warn(`[subagent-live] sendMessage returned no message_id`);
        this.failed = true;
      }
    } catch (err) {
      console.error(`[subagent-live] start failed:`, err);
      this.failed = true;
    }
  }

  /**
   * Record a new accumulated text state. Will schedule a throttled edit
   * ~800ms after the previous edit. Later updates that arrive before
   * the throttled flush coalesce — only the latest text is used.
   */
  update(text: string): void {
    if (!this.started || this.failed || this.messageId === null) return;
    this.pendingText = text;
    if (this.pendingTimer) return;
    const elapsed = Date.now() - this.lastEditAt;
    const delay = Math.max(0, LIVE_EDIT_THROTTLE_MS - elapsed);
    this.pendingTimer = setTimeout(() => {
      this.flush().catch((err) => {
        console.warn(`[subagent-live] scheduled flush failed:`, err);
      });
    }, delay);
  }

  private async flush(): Promise<void> {
    this.pendingTimer = null;
    if (!this.pendingText || this.messageId === null || this.failed) return;
    if (!this.api.editMessageText) {
      this.failed = true;
      return;
    }
    // Cap edit length — Telegram rejects >4096 chars
    const body = this.pendingText.slice(0, MAX_TG_CHUNK);
    const display = `⏳ ${this.agentName}\n\n${body}`;
    try {
      await this.api.editMessageText(this.chatId, this.messageId, display);
      this.lastEditAt = Date.now();
    } catch (err) {
      // "message is not modified" is harmless (same content as before)
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not modified/i.test(msg)) {
        console.warn(`[subagent-live] edit failed:`, msg);
      }
    }
    this.pendingText = null;
  }

  /**
   * Flush any pending edit, then post the final banner as a new message
   * so the user gets a notification. The live-stream message stays in
   * place as the body; the banner is a separate message above/below it.
   */
  async finalize(info: SubAgentInfo, result: SubAgentResult): Promise<void> {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.pendingText) {
      await this.flush();
    }
    this.started = false;
    if (this.failed) return;

    // One last edit to remove the "thinking…" header (replace with final text)
    if (this.messageId !== null && this.api.editMessageText) {
      const finalBody = (result.output?.trim() || "(empty output)").slice(0, MAX_TG_CHUNK);
      const finalDisplay = `${info.name}\n\n${finalBody}`;
      try {
        await this.api.editMessageText(this.chatId, this.messageId, finalDisplay);
      } catch {
        // If the final edit fails, the "thinking…" header stays —
        // the banner below will still communicate completion.
      }
    }

    // Post the banner as a new message (notification-triggering)
    const banner = buildBanner(info, result);
    try {
      await this.api.sendMessage(this.chatId, banner, { parse_mode: "Markdown" });
    } catch (err) {
      console.error(`[subagent-live] finalize banner failed:`, err);
      this.failed = true;
      throw err;
    }
  }
}

/**
 * Factory for LiveStream — returns null if the bot api isn't attached
 * yet, or if the api doesn't support editMessageText. Callers check
 * the return value and fall back to normal delivery if null.
 */
export function createLiveStream(chatId: number, agentName: string): LiveStream | null {
  const api = getBotApi();
  if (!api || !api.editMessageText) {
    console.warn(`[subagent-live] no compatible bot api — live mode unavailable`);
    return null;
  }
  return new LiveStream(api, chatId, agentName);
}

// ── Main delivery entry point ───────────────────────────────

/**
 * Main delivery entry point. Resolves the effective visibility (override →
 * config default), then dispatches to the source-specific renderer.
 *
 * Errors are logged but never thrown — delivery must not break the sub-agent
 * lifecycle. A failed send falls through silently.
 *
 * v4.14 — routes by `info.platform`:
 *   - "telegram" (default) → existing grammy pipeline (unchanged)
 *   - "slack" / "discord" / "whatsapp" → delivery-registry lookup
 */
export async function deliverSubAgentResult(
  info: SubAgentInfo,
  result: SubAgentResult,
  opts: { visibility?: VisibilityMode } = {},
): Promise<void> {
  // Implicit spawns: the Task-tool bridge in the main stream has already
  // surfaced the output; extra delivery would be duplication.
  if (info.source === "implicit") return;

  const effective: VisibilityMode = opts.visibility ?? getVisibility();
  if (effective === "silent") return;

  if (!info.parentChatId) {
    console.warn(`[subagent-delivery] missing parentChatId for ${info.name} (source=${info.source})`);
    return;
  }

  // v4.14 — Platform routing. Telegram is the default path (unchanged).
  const platform = info.platform ?? "telegram";
  if (platform !== "telegram") {
    await deliverViaRegistry(platform, info, result);
    return;
  }

  // ── Telegram path (v4.12.x behavior, unchanged) ──────────────────
  const api = getBotApi();
  if (!api) {
    console.warn(`[subagent-delivery] no bot api available for ${info.name}`);
    return;
  }

  // Telegram's chatId is always a number at runtime; defensive cast.
  const tgChatId =
    typeof info.parentChatId === "number"
      ? info.parentChatId
      : Number(info.parentChatId);
  if (!Number.isFinite(tgChatId)) {
    console.warn(`[subagent-delivery] invalid telegram chatId for ${info.name}`);
    return;
  }

  const banner = buildBanner(info, result);
  const body = result.output?.trim() || `(empty output)`;

  try {
    // Case 1: very long output → file upload with a short banner
    if (body.length > FILE_UPLOAD_THRESHOLD) {
      await sendWithMarkdownFallback(api, tgChatId, banner);
      try {
        const { InputFile } = await import("grammy");
        const buf = Buffer.from(body, "utf-8");
        await api.sendDocument(
          tgChatId,
          new InputFile(buf, `${info.name}.md`),
        );
      } catch (err) {
        console.error(`[subagent-delivery] file upload failed:`, err);
        await api.sendMessage(tgChatId, body.slice(0, MAX_TG_CHUNK));
      }
      return;
    }

    // Case 2: fits in a single message → banner + body joined
    if (body.length + banner.length + 2 <= MAX_TG_CHUNK) {
      await sendWithMarkdownFallback(api, tgChatId, `${banner}\n\n${body}`);
      return;
    }

    // Case 3: medium output → banner as its own message, body chunked
    await sendWithMarkdownFallback(api, tgChatId, banner);
    for (let i = 0; i < body.length; i += MAX_TG_CHUNK) {
      // Body chunks are always sent as plain text — markdown across
      // arbitrary chunk boundaries would be inconsistent anyway.
      await api.sendMessage(tgChatId, body.slice(i, i + MAX_TG_CHUNK));
    }
  } catch (err) {
    console.error(`[subagent-delivery] send failed for ${info.name}:`, err);
  }
}

/**
 * v4.14 — Delivery path for non-Telegram platforms. Uses the adapter
 * registered in delivery-registry (populated by each platform module
 * at startup). Simpler than the Telegram path: no Markdown parsing,
 * no live-stream mode, plain text only, chunked to a conservative
 * 3800-char cap that all three platforms handle.
 */
async function deliverViaRegistry(
  platform: "slack" | "discord" | "whatsapp",
  info: SubAgentInfo,
  result: SubAgentResult,
): Promise<void> {
  const { getDeliveryAdapter } = await import("./delivery-registry.js");
  const adapter = getDeliveryAdapter(platform);
  if (!adapter) {
    console.warn(
      `[subagent-delivery] no ${platform} adapter registered for ${info.name} — skipping delivery`,
    );
    return;
  }

  if (info.parentChatId === undefined) return;
  // Registry adapters accept string | number chatId directly.
  const chatId = info.parentChatId;

  const banner = buildBannerPlain(info, result);
  const body = result.output?.trim() || `(empty output)`;
  const NON_TG_CHUNK = 3800;
  const FILE_THRESHOLD = 20_000;

  try {
    // Very long output → file upload if supported, else truncated text
    if (body.length > FILE_THRESHOLD) {
      await adapter.sendText(chatId, banner);
      if (adapter.sendDocument) {
        try {
          await adapter.sendDocument(
            chatId,
            Buffer.from(body, "utf-8"),
            `${info.name}.md`,
          );
          return;
        } catch (err) {
          console.error(`[subagent-delivery] ${platform} file upload failed:`, err);
        }
      }
      // Fallback: chunked text if no file upload or upload failed
      for (let i = 0; i < body.length; i += NON_TG_CHUNK) {
        await adapter.sendText(chatId, body.slice(i, i + NON_TG_CHUNK));
      }
      return;
    }

    // Fits in one message → combined
    if (body.length + banner.length + 2 <= NON_TG_CHUNK) {
      await adapter.sendText(chatId, `${banner}\n\n${body}`);
      return;
    }

    // Medium — banner first, then chunked body
    await adapter.sendText(chatId, banner);
    for (let i = 0; i < body.length; i += NON_TG_CHUNK) {
      await adapter.sendText(chatId, body.slice(i, i + NON_TG_CHUNK));
    }
  } catch (err) {
    console.error(
      `[subagent-delivery] ${platform} send failed for ${info.name}:`,
      err,
    );
  }
}

/**
 * v4.14 — Plain-text banner variant for non-Telegram platforms.
 * No Markdown (some platforms render it inconsistently), just emoji +
 * clean labels. Matches the info layout of buildBanner.
 */
function buildBannerPlain(
  info: SubAgentInfo,
  result: SubAgentResult,
): string {
  const truncated =
    result.status === "completed" &&
    (!result.output || result.output.trim().length === 0);
  const icon = truncated ? "⚠️" : statusIcon(result.status);
  const statusLabel = truncated ? "completed · empty output" : result.status;
  const dur = formatDuration(result.duration);
  const ti = formatTokens(result.tokensUsed.input);
  const to = formatTokens(result.tokensUsed.output);
  return `${icon} ${info.name} — ${statusLabel} · ${dur} · ${ti} in / ${to} out`;
}
