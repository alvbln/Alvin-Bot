import type { Context } from "grammy";
import { InputFile } from "grammy";
import fs from "fs";
import { getSession, addToHistory, trackProviderUsage, buildSessionKey, getTelegramWorkspace, markSessionDirty } from "../services/session.js";
import { resolveWorkspaceOrDefault, getWorkspace } from "../services/workspaces.js";
import { TelegramStreamer } from "../services/telegram.js";
import { getRegistry } from "../engine.js";
import { textToSpeech } from "../services/voice.js";
import type { QueryOptions } from "../providers/types.js";
import { buildSystemPrompt, buildSmartSystemPrompt } from "../services/personality.js";
import { buildSkillContext } from "../services/skills.js";
import { isForwardingAllowed } from "../services/access.js";
import { touchProfile } from "../services/users.js";
import { trackAndAdapt } from "../services/language-detect.js";
import { shouldCompact, compactSession } from "../services/compaction.js";
import { emit } from "../services/hooks.js";
import { trackUsage } from "../services/usage-tracker.js";
import {
  emitUserMessage as broadcastUserMessage,
  emitResponseStart as broadcastResponseStart,
  emitResponseDelta as broadcastResponseDelta,
  emitResponseDone as broadcastResponseDone,
} from "../services/broadcast.js";
import { t } from "../i18n.js";
import { isHarmlessTelegramError } from "../util/telegram-error-filter.js";
import { handleToolResultChunk, type ToolUseInput } from "./async-agent-chunk-handler.js";
import { createStuckTimer } from "./stuck-timer.js";
import {
  shouldBypassQueue,
  shouldBypassSdkResume,
  waitUntilProcessingFalse,
} from "./background-bypass.js";

/**
 * Stuck-only timeout — NO absolute cap.
 *
 * Alvin is designed to work as long as it needs to, including overnight
 * on multi-hour tasks. The ONLY condition under which we abort a running
 * query is when Claude produces no chunks at all for STUCK_TIMEOUT_MINUTES
 * — that's a genuine hang, not legitimate work. Every text chunk and
 * tool_use chunk resets this timer, so an actively-progressing task will
 * never be cut off regardless of total duration.
 *
 * Previous design had an additional 30-minute absolute cap that violated
 * this "work as long as needed" character. Removed entirely — only the
 * stuck detector remains.
 *
 * Configurable via ALVIN_STUCK_TIMEOUT_MINUTES env var. Default 10 minutes,
 * which is generous for normal work (Claude typically streams chunks every
 * few seconds) but still catches real deadlocks quickly.
 */
const STUCK_TIMEOUT_MINUTES = Number(process.env.ALVIN_STUCK_TIMEOUT_MINUTES) || 10;
const STUCK_TIMEOUT_MS = STUCK_TIMEOUT_MINUTES * 60 * 1000;

/**
 * v4.12.1 — Task-aware stuck timeout for sync Task/Agent tool calls.
 *
 * When Claude calls the Task/Agent tool WITHOUT run_in_background: true,
 * the Claude Agent SDK runs the sub-agent synchronously inside the tool
 * call. The parent stream emits NO intermediate chunks during that time
 * — it's silent until the sub-agent finishes and the final tool_result
 * arrives. With the normal STUCK_TIMEOUT_MS (10 min), this triggered a
 * false abort on legitimate long-running sub-agents.
 *
 * The new approach: track pending sync Task/Agent tool calls by their
 * toolUseId, and while any are active, escalate the idle timeout to
 * SYNC_AGENT_IDLE_TIMEOUT_MS (default 120 min, env-configurable). After
 * the matching tool_result arrives, revert to the normal timeout.
 *
 * The normal 10-min timeout still applies for genuine SDK hangs (no
 * sync tool call active, no chunks arriving).
 */
const SYNC_AGENT_IDLE_TIMEOUT_MINUTES =
  Number(process.env.ALVIN_SYNC_AGENT_IDLE_TIMEOUT_MINUTES) || 120;
const SYNC_AGENT_IDLE_TIMEOUT_MS = SYNC_AGENT_IDLE_TIMEOUT_MINUTES * 60 * 1000;

/** Checkpoint reminder thresholds — kept in sync with
 *  src/providers/claude-sdk-provider.ts (where the actual hint injection
 *  happens). We mirror the check here so the session telemetry knows
 *  when the SDK provider would have injected a reminder. */
const CHECKPOINT_TOOL_THRESHOLD = 15;
const CHECKPOINT_MSG_THRESHOLD = 10;

/** Maximum characters in the bridge-message preamble that gets prepended
 * to the first post-recovery SDK query. Oldest gap-turns get truncated. */
const BRIDGE_MAX_CHARS = 2500;
/** Maximum characters per individual message in the bridge preamble. */
const BRIDGE_MSG_MAX_CHARS = 500;

/**
 * Build a "catch-up" preamble summarising turns that happened while the
 * SDK was not the active provider (i.e., during a failover to Ollama or
 * a manual /model switch). This gets prepended to the first post-recovery
 * prompt so the SDK sees what its alter-ego did.
 */
function buildBridgeMessage(fallbackTurns: Array<{ role: string; content: string }>): string {
  if (fallbackTurns.length === 0) return "";

  const renderTurn = (m: { role: string; content: string }) => {
    const label = m.role === "user" ? "User" : "Assistant (Fallback)";
    const content = m.content.length > BRIDGE_MSG_MAX_CHARS
      ? m.content.slice(0, BRIDGE_MSG_MAX_CHARS) + "…"
      : m.content;
    return `${label}: ${content}`;
  };

  // Start with all turns rendered, then trim from the oldest if we exceed budget.
  let lines = fallbackTurns.map(renderTurn);
  let body = lines.join("\n\n");
  let truncatedOldest = 0;
  while (body.length > BRIDGE_MAX_CHARS && lines.length > 2) {
    lines.shift();
    truncatedOldest++;
    body = lines.join("\n\n");
  }
  const omittedNote = truncatedOldest > 0
    ? `[…${truncatedOldest} older turn(s) omitted…]\n\n`
    : "";

  const count = fallbackTurns.length;
  return (
    `[Context: While you (Claude) were briefly not the active provider, ` +
    `the following ${count} message(s) were exchanged with a fallback model. ` +
    `Catching you up:\n\n` +
    omittedNote +
    body +
    `\n\n--- New message from user: ---]\n\n`
  );
}

/** Tool name → emoji. Used to render a status line while Alvin is running
 * tools, so users see real progress instead of an endless typing indicator. */
const TOOL_ICONS: Record<string, string> = {
  Read: "📖",
  Write: "📝",
  Edit: "✏️",
  Bash: "⚡",
  Glob: "🔍",
  Grep: "🔎",
  WebSearch: "🌐",
  WebFetch: "📡",
  Task: "🤖",
};

/** React to a message with an emoji. Silently fails if reactions aren't supported. */
async function react(ctx: Context, emoji: string): Promise<void> {
  try {
    await ctx.react(emoji as Parameters<typeof ctx.react>[0]);
  } catch {
    // Reactions not supported in this chat — silently ignore
  }
}

export async function handleMessage(ctx: Context): Promise<void> {
  const rawText = ctx.message?.text;
  if (!rawText || rawText.startsWith("/")) return;

  let text = rawText;

  // Forwarded message — add forward context (if allowed)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgAny = ctx.message as any;
  if (msgAny?.forward_origin || msgAny?.forward_date) {
    if (!isForwardingAllowed()) {
      await ctx.reply("⚠️ Weitergeleitete Nachrichten sind deaktiviert. Aktiviere mit `/security forwards on`", { parse_mode: "Markdown" });
      return;
    }
    const forwardFrom = msgAny.forward_sender_name || "unbekannt";
    text = `[Weitergeleitete Nachricht von ${forwardFrom}]\n\n${rawText}`;
  }

  // Reply context — include quoted message
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo?.text) {
    const quotedText = replyTo.text.length > 500
      ? replyTo.text.slice(0, 500) + "..."
      : replyTo.text;
    text = `[Replying to previous message: "${quotedText}"]\n\n${text}`;
  }

  const userId = ctx.from!.id;
  const sessionKey = buildSessionKey("telegram", ctx.chat!.id, userId);
  const session = getSession(sessionKey);

  // Track user profile
  touchProfile(userId, ctx.from?.first_name, ctx.from?.username, "telegram", text);

  // Sync session language from persistent profile (on first message)
  if (session.messageCount === 0) {
    const { loadProfile } = await import("../services/users.js");
    const profile = loadProfile(userId);
    if (profile?.language) session.language = profile.language;
  }

  if (session.isProcessing) {
    // v4.12.3 — If a background agent is pending, the running query is
    // almost certainly just the SDK's CLI subprocess sitting idle waiting
    // for the task-notification to be ready (can take 5+ minutes for long
    // audits). Don't queue — abort the blocked query and fall through so
    // the new message gets processed immediately. The background task
    // itself continues in its detached subprocess; the async-agent watcher
    // delivers the result via subagent-delivery.ts when ready.
    if (
      shouldBypassQueue({
        isProcessing: session.isProcessing,
        pendingBackgroundCount: session.pendingBackgroundCount,
        abortController: session.abortController,
      })
    ) {
      console.log(
        `[v4.12.3 bypass] aborting blocked query for ${sessionKey} — ` +
          `${session.pendingBackgroundCount} background agent(s) pending`,
      );
      // Mark the abort as a bypass so the old handler's error branch
      // doesn't surface a "request cancelled" reply to the user.
      session._bypassAbortFired = true;
      try {
        session.abortController!.abort();
      } catch {
        /* ignore */
      }
      // Wait briefly for the old handler's finally to run. If it hangs
      // (>5s, shouldn't happen), we fall through anyway — worst case is
      // a brief overlap where both handlers run.
      await waitUntilProcessingFalse(session, 5000);
      // Fall through to start a fresh query below.
    } else {
      // Normal queue behavior. v4.12.3 — emit a text reply in addition
      // to the reaction so the user actually sees that their message
      // was received and is waiting. Reactions alone are too subtle.
      if (session.messageQueue.length < 3) {
        session.messageQueue.push(text);
        await react(ctx, "📝");
        try {
          await ctx.reply(
            "⏳ Eine Anfrage läuft gerade. Deine Nachricht ist in der Warteschlange und wird als Nächstes bearbeitet.",
          );
        } catch {
          /* harmless grammy race */
        }
      } else {
        await ctx.reply("⏳ Warteschlange voll (3 Nachrichten). Bitte warten oder /cancel.");
      }
      return;
    }
  }

  // Consume queued messages (sent while previous query was processing)
  if (session.messageQueue.length > 0) {
    const queued = session.messageQueue.splice(0);
    text = [...queued, text].join("\n\n");
  }

  session.isProcessing = true;
  session.abortController = new AbortController();
  // v4.12.3 — Clear any stale bypass flag from a previous aborted turn.
  // The flag is set by the bypass path right before it calls abort(),
  // read by the OLD handler's error path, and cleared here by the NEW
  // handler so it doesn't misclassify future non-bypass aborts. Use
  // `delete` so TypeScript doesn't narrow the flag to literal `false`
  // for the rest of this function (it's mutated from the bypass path in
  // another handler invocation, so the type stays `boolean | undefined`).
  delete session._bypassAbortFired;

  const streamer = new TelegramStreamer(ctx.chat!.id, ctx.api, ctx.message?.message_id);
  let finalText = "";
  let timedOut = false;
  // v4.12.3 — Tracks whether the current turn ended because the bypass
  // path aborted us. When true, skip the finalize/broadcast/👍 reaction
  // flow at the bottom of the handler since the user isn't waiting on
  // this turn anymore. Explicit `boolean` type so TS doesn't narrow to
  // the literal `false` and reject the later comparison.
  let bypassAborted: boolean = false;

  const typingInterval = setInterval(() => {
    ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => {});
  }, 4000);

  // v4.12.1 — Task-aware stuck timer. Normal mode (STUCK_TIMEOUT_MS)
  // fires after 10 min of silence. When a sync Task/Agent tool call is
  // active (tracked by toolUseId in the for-await loop below), the
  // timeout escalates to SYNC_AGENT_IDLE_TIMEOUT_MS (120 min) so
  // legitimate long-running sub-agents that emit no intermediate chunks
  // don't get falsely aborted. See src/handlers/stuck-timer.ts.
  const stuckTimer = createStuckTimer({
    normalMs: STUCK_TIMEOUT_MS,
    extendedMs: SYNC_AGENT_IDLE_TIMEOUT_MS,
    onTimeout: () => {
      if (session.abortController && !session.abortController.signal.aborted) {
        timedOut = true;
        session.abortController.abort();
      }
    },
  });
  stuckTimer.reset();

  try {
    // React with 🤔 to show we're thinking
    await react(ctx, "🤔");
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");
    session.messageCount++;
    emit("message:received", { userId, text, platform: "telegram" });

    // v4.5.0: broadcast the user message so TUI/WebUI observers can mirror it.
    // The broadcast bus is fire-and-forget — never affects the Telegram flow.
    broadcastUserMessage({
      platform: "telegram",
      userId,
      userName: ctx.from?.first_name || ctx.from?.username,
      chatId: ctx.chat!.id,
      text,
      ts: Date.now(),
    });
    broadcastResponseStart({
      platform: "telegram",
      userId,
      chatId: ctx.chat!.id,
      ts: Date.now(),
    });

    // Determine provider type early for compaction check
    const registry = getRegistry();
    const activeProvider = registry.getActive();
    const isSDK = activeProvider.config.type === "claude-sdk";

    // Auto-compact if needed (non-SDK only)
    if (!isSDK) {
      if (shouldCompact(session)) {
        const result = await compactSession(session);
        if (result.removedEntries > 0) {
          console.log(`Compacted session: removed ${result.removedEntries} entries, flushed=${result.flushedToMemory}`);
        }
      }
    }

    // Auto-detect and adapt language from user's message
    const adaptedLang = trackAndAdapt(userId, text, session.language);
    if (adaptedLang !== session.language) {
      session.language = adaptedLang;
    }

    // Build query options (with semantic memory search for non-SDK + skill injection).
    // v4.11.0 P0 #3: SDK now also gets semantic recall on first-turn. The signal
    // is `session.sessionId === null` — meaning Claude SDK hasn't given us a
    // resume token yet for this session. True for: brand-new users, post-/new,
    // and rehydrated sessions where the persisted snapshot lacked a sessionId.
    // After the first SDK turn, Claude resumes via SDK session_id and already
    // carries the recalled context — no need for another search per turn.
    //
    // v4.12.0 — Resolve the user's active Telegram workspace (if any) and
    // forward the persona to buildSmartSystemPrompt. If the workspace
    // changed since last turn, update session's workingDir + workspaceName.
    const activeWsName = getTelegramWorkspace(userId);
    const workspace = activeWsName
      ? (getWorkspace(activeWsName) ?? resolveWorkspaceOrDefault("telegram", String(userId), undefined))
      : resolveWorkspaceOrDefault("telegram", String(userId), undefined);
    // v4.19.1 — Workspace switch detection. Claude Agent SDK's `resume` is
    // bound to the cwd (session files live under
    // ~/.claude/projects/<cwd-hash>/<session-id>.jsonl). If cwd changes as
    // part of this switch, the stored sessionId points at a file the CLI
    // cannot find in the new project folder → silent empty stream. Guard
    // with a workspaceName change (not cwd comparison) so /dir-initiated
    // custom cwds are preserved across turns where no workspace actually
    // switched.
    if (session.workspaceName !== workspace.name) {
      const cwdChanged = session.workingDir !== workspace.cwd;
      session.workspaceName = workspace.name;
      session.workingDir = workspace.cwd;
      if (cwdChanged) {
        console.log(
          `[session] workspace switch changed cwd (→ ${workspace.cwd}) — ` +
          `invalidating SDK resume anchor to prevent empty-stream loop`,
        );
        session.sessionId = null;
        session.lastSdkHistoryIndex = -1;
        markSessionDirty(userId);
      }
    }

    const chatIdStr = String(ctx.chat!.id);
    const skillContext = buildSkillContext(text);
    const isFirstSDKTurn = isSDK && session.sessionId === null;
    const systemPrompt = (
      await buildSmartSystemPrompt(
        isSDK,
        session.language,
        text,
        chatIdStr,
        isFirstSDKTurn,
        workspace.systemPromptOverride,
      )
    ) + skillContext;

    // Track the user turn in history regardless of provider type. This keeps
    // the fallback path (Ollama etc.) aware of what was said on SDK turns.
    addToHistory(userId, { role: "user", content: text });

    // Checkpoint telemetry: mirror the SDK provider's threshold check here
    // so session.checkpointHintsInjected reflects reality. The provider
    // evaluates the exact same condition at query time — if it's true,
    // it prepends a [CHECKPOINT] reminder to the prompt.
    if (isSDK) {
      const wouldInjectCheckpoint =
        session.toolUseCount >= CHECKPOINT_TOOL_THRESHOLD ||
        session.messageCount >= CHECKPOINT_MSG_THRESHOLD;
      if (wouldInjectCheckpoint) {
        session.checkpointHintsInjected++;
      }
    }

    // v4.12.3 — If a background agent is still pending, skip SDK resume.
    // The OLD SDK session is blocked waiting to deliver the
    // task-notification inline; resuming it would inherit that block.
    // Start a fresh SDK session and rely on the bridge preamble below
    // to carry recent history so Claude has context.
    const bypassResume = isSDK && shouldBypassSdkResume({
      pendingBackgroundCount: session.pendingBackgroundCount,
    });
    if (bypassResume) {
      console.log(
        `[v4.12.3 bypass] starting fresh SDK session for ${sessionKey} — ` +
          `${session.pendingBackgroundCount} background agent(s) still pending`,
      );
    }

    // B2 Bridge-Message: if SDK is active but there are non-SDK turns since
    // the last SDK turn, prepend a catch-up preamble so the SDK sees what
    // happened during the failover. We defensively clamp the index against
    // history bounds in case compaction shrank the array under our feet.
    //
    // v4.12.3 — Bypass-resume path also gets a bridge: since we're starting
    // a fresh SDK session, Claude has no prior context from this chat.
    // Bridge the last BYPASS_BRIDGE_TURNS entries so it knows what we were
    // just talking about.
    const BYPASS_BRIDGE_TURNS = 10;
    let bridgedPrompt = text;
    if (isSDK) {
      let gapStart: number;
      let gapEnd: number;
      if (bypassResume) {
        gapEnd = session.history.length - 1;
        gapStart = Math.max(0, gapEnd - BYPASS_BRIDGE_TURNS);
      } else {
        const anchor = Math.min(session.lastSdkHistoryIndex, session.history.length - 1);
        gapStart = Math.max(0, anchor + 1);
        // gapEnd excludes the user message we just added (history.length - 1).
        gapEnd = session.history.length - 1;
      }
      if (gapEnd > gapStart) {
        const gapTurns = session.history.slice(gapStart, gapEnd);
        const bridge = buildBridgeMessage(gapTurns);
        if (bridge) {
          bridgedPrompt = bridge + text;
          console.log(
            `[bridge] ${bypassResume ? "bypass" : "SDK recovery"}: ` +
              `injecting ${gapTurns.length} turn(s) into prompt`,
          );
        }
      }
    }

    // v4.19.0 — Per-workspace runtime overrides. Each is only applied when
    // the workspace explicitly set it; otherwise the session/provider default
    // wins. Toolset is mapped to a concrete allowedTools list via
    // toolsetToAllowedTools(); providers that ignore allowedTools (Ollama etc.)
    // just drop it.
    const { toolsetToAllowedTools } = await import("../services/workspaces.js");
    const wsAllowed = toolsetToAllowedTools(workspace.toolset);

    const queryOpts: QueryOptions & { _sessionState?: { messageCount: number; toolUseCount: number } } = {
      prompt: bridgedPrompt,
      systemPrompt,
      workingDir: session.workingDir,
      effort: workspace.effort ?? session.effort,
      // v4.15 — Per-workspace model override (optional YAML `model:` field).
      // v4.19 — ditto for temperature and toolset-derived allowedTools.
      ...(workspace.model ? { model: workspace.model } : {}),
      ...(workspace.temperature !== undefined ? { temperature: workspace.temperature } : {}),
      ...(wsAllowed ? { allowedTools: wsAllowed } : {}),
      abortSignal: session.abortController.signal,
      // User's UI locale — registry uses it to localize failure messages.
      locale: session.language,
      // SDK-specific. v4.12.3 — bypass resume when background pending.
      sessionId: isSDK && !bypassResume ? session.sessionId : null,
      // Unified history: SDK ignores it (uses filesystem-resume instead),
      // non-SDK providers use it for context. Keeping it populated for both
      // means a failover from SDK → Ollama keeps the conversation context.
      history: session.history,
      // SDK checkpoint tracking
      _sessionState: isSDK ? {
        messageCount: session.messageCount,
        toolUseCount: session.toolUseCount,
      } : undefined,
      // v4.13 — Expose alvin_dispatch_agent MCP tool so Claude can spawn
      // truly detached background sub-agents (independent of this SDK
      // subprocess's lifecycle). Only for SDK provider + Telegram here —
      // non-SDK providers ignore this field.
      alvinDispatchContext: isSDK ? {
        chatId: ctx.chat!.id,
        userId,
        sessionKey,
      } : undefined,
    };

    // Stream response from provider (with fallback)
    let lastBroadcastLen = 0;
    // Captured during tool_use chunks; consumed by tool_result chunks so
    // the async-agent watcher can label pending agents with their human-
    // readable description (which only appears in the tool_use input,
    // not in the tool_result text). See Fix #17 Stage 2.
    let lastAgentToolUseInput: ToolUseInput | undefined;
    // v4.19.1 — Track whether the provider requested a session reset during
    // this stream. If it did, the trailing `done` chunk's sessionId MUST be
    // ignored — otherwise it restores the exact sessionId we just cleared
    // (the empty-stream capturedSessionId) and the next turn loops again.
    // This is the second half of the empty-stream-loop fix.
    let sessionResetInStream = false;
    for await (const chunk of registry.queryWithFallback(queryOpts, workspace.provider)) {
      // v4.12.1 — Update pending-sync-task state FIRST so the timer's
      // next reset picks up the new state. This ordering is load-bearing:
      // reversing it means the timer rearms with stale state. A sync
      // Task/Agent tool call switches the stuck timer to extended mode
      // (120 min) to tolerate the silent gap until tool_result arrives.
      if (
        chunk.type === "tool_use" &&
        (chunk.toolName === "Task" || chunk.toolName === "Agent") &&
        chunk.toolUseId &&
        chunk.runInBackground !== true
      ) {
        stuckTimer.enterSync(chunk.toolUseId);
      } else if (chunk.type === "tool_result" && chunk.toolUseId) {
        // Any tool_result may match a pending sync entry. Set.delete is
        // a no-op if the id isn't in the set — safe for async results.
        stuckTimer.exitSync(chunk.toolUseId);
      }

      // Any chunk is progress — reset the stuck timer (now with
      // updated pending-sync state so the correct timeout is armed).
      stuckTimer.reset();
      switch (chunk.type) {
        case "text":
          finalText = chunk.text || "";
          // Clear any tool-use status line — real content is flowing now.
          streamer.setStatus(null);
          await streamer.update(finalText);
          // v4.18.5 — Provider requested a session reset (empty-stream / stale
          // sessionId recovery). Clear the session's sessionId + SDK anchor so
          // the next query starts a fresh Claude session instead of resuming
          // the broken one. Without this, the bot would loop empty-stream
          // replies and burn credits until the user manually runs /new.
          if (chunk.sessionResetRequested) {
            console.warn(`[session] provider requested reset for ${sessionKey} — clearing sessionId + SDK anchor`);
            session.sessionId = null;
            session.lastSdkHistoryIndex = -1;
            sessionResetInStream = true;
            markSessionDirty(userId);
          }
          // Emit the new delta for observers — accumulated text minus what
          // we already broadcast.
          if (finalText.length > lastBroadcastLen) {
            const delta = finalText.slice(lastBroadcastLen);
            broadcastResponseDelta({
              platform: "telegram",
              userId,
              chatId: ctx.chat!.id,
              delta,
              ts: Date.now(),
            });
            lastBroadcastLen = finalText.length;
          }
          break;

        case "tool_use":
          // Surface the active tool so users see real progress instead of
          // an endless typing indicator. The streamer renders this as a
          // dim italic footer under any accumulated text.
          if (chunk.toolName) {
            session.toolUseCount++;
            const icon = TOOL_ICONS[chunk.toolName] || "🔧";

            // Special treatment for Claude's SDK-internal Task/Agent tool:
            // track how many sub-tasks Claude delegated and surface the
            // task description in the status line so the user sees WHAT
            // is being delegated, not just "Task…". The tool was renamed
            // from "Task" to "Agent" in Claude Code v2.1.63 — match both.
            if (chunk.toolName === "Task" || chunk.toolName === "Agent") {
              session.sdkSubTaskCount++;
              let label = chunk.toolName;
              if (chunk.toolInput) {
                try {
                  const parsed = JSON.parse(chunk.toolInput) as {
                    description?: string;
                    subagent_type?: string;
                    prompt?: string;
                  };
                  if (parsed.description) {
                    // Trim long descriptions so the status line stays readable
                    const desc = parsed.description.length > 80
                      ? parsed.description.slice(0, 80) + "…"
                      : parsed.description;
                    label = `${chunk.toolName}: ${desc}`;
                  } else if (parsed.subagent_type) {
                    label = `${chunk.toolName} (${parsed.subagent_type})`;
                  }
                  // Capture the description+prompt for the upcoming
                  // tool_result. Used by Fix #17 Stage 2 to label
                  // background agents in the watcher's delivery banner.
                  lastAgentToolUseInput = {
                    description: parsed.description,
                    prompt: parsed.prompt,
                  };
                } catch {
                  // not JSON — keep generic label
                }
              }
              streamer.setStatus(`${icon} ${label}…`);
            } else {
              streamer.setStatus(`${icon} ${chunk.toolName}…`);
            }
          }
          break;

        case "tool_result":
          // Fix #17 Stage 2: detect Agent async_launched payloads and
          // hand them off to the async-agent watcher. The watcher will
          // poll the outputFile and deliver the result as a separate
          // Telegram message when the background agent finishes.
          // v4.12.3 — Forward sessionKey so the watcher can route the
          // delivery-complete decrement back to the right session.
          handleToolResultChunk(chunk, {
            chatId: ctx.chat!.id,
            userId,
            sessionKey,
            lastToolUseInput: lastAgentToolUseInput,
          });
          // Reset the captured input — only the immediately following
          // tool_result should consume it.
          lastAgentToolUseInput = undefined;
          break;

        case "done":
          // v4.19.1 — Respect the in-stream session reset. If the provider
          // already signalled `sessionResetRequested` on the preceding text
          // chunk (empty-stream detection), do NOT let the trailing done
          // chunk restore the sessionId we just nulled — that was the
          // silent bug behind the empty-stream loop across workspace
          // switches. The `done` chunk's sessionId on an empty stream is
          // either the stale resume token we tried to use or a brand-new
          // session file the CLI created in the wrong project folder;
          // neither is safe to resume from.
          if (chunk.sessionId && !sessionResetInStream) session.sessionId = chunk.sessionId;
          if (chunk.costUsd) session.totalCost += chunk.costUsd;
          // Track the input tokens this turn used — this approximates the
          // current context window usage since the model receives the full
          // conversation context on every turn. Used for the Context:X/Y
          // progress meter in /status.
          if (typeof chunk.inputTokens === "number" && chunk.inputTokens > 0) {
            session.lastTurnInputTokens = chunk.inputTokens;
          }
          trackProviderUsage(userId, registry.getActiveKey(), chunk.costUsd || 0, chunk.inputTokens, chunk.outputTokens);
          trackUsage(registry.getActiveKey(), chunk.inputTokens || 0, chunk.outputTokens || 0, chunk.costUsd || 0);
          session.lastActivity = Date.now();
          break;

        case "fallback":
          await ctx.reply(
            `⚡ _${chunk.failedProvider} unavailable — switching to ${chunk.providerName}_`,
            { parse_mode: "Markdown" }
          );
          break;

        case "error":
          // v4.12.3 — If the bypass path aborted us, swallow the error
          // silently. The new handler is already preparing to process
          // the user's next message; showing a cancellation notice here
          // would be misleading.
          if (
            session._bypassAbortFired === true &&
            chunk.error?.toLowerCase().includes("abort")
          ) {
            bypassAborted = true;
            break;
          }
          // If our stuck-timer fired, the abort travels up as a registry
          // mid-stream error chunk. Prefer the explicit stuck message over
          // the generic one so the user understands this was a real hang,
          // not a random error.
          if (timedOut) {
            await ctx.reply(t("bot.error.timeoutStuck", session.language, { min: STUCK_TIMEOUT_MINUTES }));
          } else if (!isHarmlessTelegramError(chunk.error)) {
            await ctx.reply(`${t("bot.error.prefix", session.language)} ${chunk.error}`);
          }
          break;
      }
    }

    if (bypassAborted) {
      // v4.12.3 — Bypass path took over; don't finalize, don't react 👍.
      // Just clean up and return. The finally block still fires.
      return;
    }

    await streamer.finalize(finalText);
    emit("message:sent", { userId, text: finalText, platform: "telegram" });

    // v4.5.0: tell observers the response is complete.
    broadcastResponseDone({
      platform: "telegram",
      userId,
      chatId: ctx.chat!.id,
      finalText,
      cost: session.costByProvider[registry.getActiveKey()],
      ts: Date.now(),
    });

    // Clear thinking reaction (replace with nothing — message was answered)
    await react(ctx, "👍");

    // Track the assistant turn in history regardless of provider type
    // (unified history for seamless failover between SDK and Ollama).
    if (finalText) {
      addToHistory(userId, { role: "assistant", content: finalText });
      // Advance the B2 bridge anchor to the assistant turn we just added,
      // so the next SDK turn only bridges turns that happened AFTER this one.
      if (isSDK) {
        session.lastSdkHistoryIndex = session.history.length - 1;
      }
    }

    // Voice reply if enabled
    if (session.voiceReply && finalText.trim()) {
      try {
        await ctx.api.sendChatAction(ctx.chat!.id, "upload_voice");
        const audioPath = await textToSpeech(finalText, workspace.voice);
        await ctx.replyWithVoice(new InputFile(fs.readFileSync(audioPath), "response.mp3"));
        fs.unlink(audioPath, () => {});
      } catch (err) {
        console.error("TTS error:", err);
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const lang = session.language;
    // v4.12.3 — If this handler was interrupted by the bypass path
    // (another handler aborted us to process a new message while a
    // background agent is pending), silently absorb the abort error.
    // Showing "request cancelled" would be misleading — from the
    // user's point of view, nothing was cancelled, their new message
    // is just being processed.
    const absorbBypassAbort =
      errorMsg.includes("abort") && session._bypassAbortFired === true;
    if (absorbBypassAbort) {
      // Do NOT react 👎 or reply — just clean up silently.
    } else if (timedOut) {
      await react(ctx, "👎");
      await ctx.reply(t("bot.error.timeoutStuck", lang, { min: STUCK_TIMEOUT_MINUTES }));
    } else if (errorMsg.includes("abort")) {
      await react(ctx, "👎");
      await ctx.reply(t("bot.error.requestCancelled", lang));
    } else if (!isHarmlessTelegramError(err)) {
      await react(ctx, "👎");
      // Drop benign grammy races ("message is not modified", etc.)
      // instead of surfacing them as "Fehler: ..." replies.
      await ctx.reply(`${t("bot.error.prefix", lang)} ${errorMsg}`);
    }
  } finally {
    stuckTimer.cancel();
    clearInterval(typingInterval);
    session.isProcessing = false;
    session.abortController = null;

    // Check for queued messages — they'll be prepended to the next real message
    // Queue stays in session and gets consumed on next handleMessage call
  }
}
