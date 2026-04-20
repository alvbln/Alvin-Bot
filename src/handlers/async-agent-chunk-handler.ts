/**
 * Bridge between SDK provider stream chunks and the async-agent watcher
 * (Fix #17 Stage 2).
 *
 * When the claude-sdk-provider emits a tool_result chunk, this helper
 * inspects it for an Agent `async_launched` payload and registers the
 * pending agent with the watcher. The watcher then polls the outputFile
 * and delivers the result via subagent-delivery.ts when ready.
 *
 * Pure-over-import: the watcher is imported lazily so tests can mock it.
 *
 * See test/async-agent-chunk-flow.test.ts for the contract.
 */
import type { StreamChunk } from "../providers/types.js";
import { parseAsyncLaunchedToolResult } from "../services/async-agent-parser.js";
import { registerPendingAgent } from "../services/async-agent-watcher.js";
import { getAllSessions } from "../services/session.js";

export interface ToolUseInput {
  description?: string;
  prompt?: string;
}

export interface TurnContext {
  chatId: number;
  userId: number;
  /**
   * v4.12.3 — Session key (from buildSessionKey) so the watcher can
   * route the delivery-complete decrement back to the originating
   * session. Optional for callers that can't supply it, but strongly
   * recommended — without it the bypass-resume logic can't tell when
   * background work is done and stays in bypass mode longer than needed.
   */
  sessionKey?: string;
  /** The most recent Agent tool_use input from the same chunk pass.
   *  We pull description+prompt from here because the tool_result text
   *  itself doesn't include them. The message handler captures these
   *  during its `tool_use` chunk handling and passes the latest forward. */
  lastToolUseInput?: ToolUseInput;
}

/**
 * Inspect a stream chunk; if it's an Agent async_launched tool_result,
 * register the pending agent with the watcher.
 *
 * Safe to call on any chunk type — non-tool_result chunks are ignored.
 */
export function handleToolResultChunk(chunk: StreamChunk, ctx: TurnContext): void {
  if (chunk.type !== "tool_result") return;
  if (!chunk.toolResultContent) return;

  const info = parseAsyncLaunchedToolResult(chunk.toolResultContent);
  if (!info) return;

  // The description and prompt come from the original tool_use input,
  // not the tool_result text. If we don't have them (e.g. test setup
  // forgot to pass lastToolUseInput), fall back to a generic label so
  // the user still sees something meaningful in the delivery banner.
  const description =
    ctx.lastToolUseInput?.description?.trim() ||
    `Background agent ${info.agentId.slice(0, 8)}`;
  const prompt = ctx.lastToolUseInput?.prompt?.trim() || "";

  registerPendingAgent({
    agentId: info.agentId,
    outputFile: info.outputFile,
    description,
    prompt,
    chatId: ctx.chatId,
    userId: ctx.userId,
    toolUseId: chunk.toolUseId ?? null,
    sessionKey: ctx.sessionKey,
  });

  // v4.12.3 — Increment the session's pendingBackgroundCount so the
  // main handler knows a background task is tying up the SDK's CLI
  // subprocess. The watcher decrements this when it delivers the result.
  // Guarded: missing sessionKey or unknown session is a no-op.
  if (ctx.sessionKey) {
    try {
      const s = getAllSessions().get(ctx.sessionKey);
      if (s) {
        s.pendingBackgroundCount = (s.pendingBackgroundCount ?? 0) + 1;
      }
    } catch {
      /* never let counter updates break registration */
    }
  }
}
