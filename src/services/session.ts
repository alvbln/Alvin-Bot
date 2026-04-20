import os from "os";
import { config } from "../config.js";
import type { ChatMessage } from "../providers/types.js";
import type { Locale } from "../i18n.js";

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface UserSession {
  /** Claude SDK session ID (for resume) */
  sessionId: string | null;
  /** Working directory for tool-using providers */
  workingDir: string;
  /** Name of the workspace this session belongs to (v4.12.0).
   *  null = default workspace (pre-v4.12 behavior preserved). */
  workspaceName: string | null;
  /** Whether a query is currently running */
  isProcessing: boolean;
  /** Abort controller for cancelling running queries */
  abortController: AbortController | null;
  /** Last activity timestamp */
  lastActivity: number;
  /** Session start time */
  startedAt: number;
  /** Total cost in USD for this session */
  totalCost: number;
  /** Cost breakdown per provider */
  costByProvider: Record<string, number>;
  /** Queries per provider */
  queriesByProvider: Record<string, number>;
  /** Thinking effort level */
  effort: EffortLevel;
  /** Whether to send voice replies */
  voiceReply: boolean;
  /** Message count in current session (for checkpoint reminders) */
  messageCount: number;
  /** Tool use count in current session (for checkpoint reminders) */
  toolUseCount: number;
  /** Total input tokens in current session (cumulative over all turns) */
  totalInputTokens: number;
  /** Total output tokens in current session (cumulative over all turns) */
  totalOutputTokens: number;
  /** Input tokens the model saw on the LAST turn — a good proxy for
   *  "current context window usage", since the LLM always receives the
   *  full context on each turn. Used for the Context: X/Y progress meter
   *  in /status. Differs from totalInputTokens which is a billing counter. */
  lastTurnInputTokens: number;
  /** Number of times the compaction service successfully ran on this
   *  session. Only non-SDK providers (compaction.ts is skipped for SDK). */
  compactionCount: number;
  /** Number of times we injected a checkpoint reminder into the SDK's
   *  prompt because toolUseCount/messageCount crossed the threshold.
   *  Proxy for "how many chances did Claude have to persist its memory".
   *  SDK sessions only. */
  checkpointHintsInjected: number;
  /** Count of SDK-internal sub-tasks Claude delegated via its own Task
   *  tool in this session. Not to be confused with bot-level sub-agents
   *  (/agent spawn) or cron-spawned sub-agents — this is Claude's
   *  built-in parallel decomposition inside a single user turn. */
  sdkSubTaskCount: number;
  /**
   * v4.12.3 — Number of background agents currently pending for this
   * session. Incremented by the message handler when an `Agent` tool
   * call with `run_in_background: true` is registered with the
   * async-agent watcher. Decremented by the watcher when it delivers
   * the result (success, failure, or timeout).
   *
   * When this is > 0, the SDK's CLI subprocess for the ORIGINAL query
   * is almost certainly blocked waiting for the task-notification to
   * deliver (which happens when the background task finishes — can be
   * 5+ minutes). During that time `isProcessing` stays true, which
   * would queue any new user message behind the blocked query.
   *
   * The handler uses this counter to:
   *   1. Abort the blocked query on new-message arrival (instead of
   *      queueing) and proceed with the new message immediately.
   *   2. Bypass SDK resume (sessionId=null) for the next query so the
   *      new query doesn't inherit the block. History is still carried
   *      via the bridge preamble so Claude has full context.
   *
   * The background task's subprocess itself continues independently —
   * it's detached from the query's abortController and writes to its
   * own outputFile. The async-agent watcher polls that file and
   * delivers the result as a separate Telegram message.
   */
  pendingBackgroundCount: number;
  /** Conversation history for non-SDK providers */
  history: ChatMessage[];
  /** Preferred UI language (for bot-facing messages only — the LLM mirrors
   *  the conversational language regardless). */
  language: Locale;
  /** Message queue (messages received while processing) */
  messageQueue: string[];
  /**
   * Index in `history` of the last entry produced by a Claude-SDK turn
   * (i.e. the assistant response on the most recent SDK run). -1 if
   * there has never been an SDK turn in this session.
   *
   * Used for the B2 bridge-message: when the active provider switches
   * away from SDK and back again, the turns between lastSdkHistoryIndex
   * and the next SDK turn are the "gap" that the SDK never saw. On the
   * next SDK turn, those turns get summarized into the prompt so the
   * SDK catches up on what happened during the failover.
   */
  lastSdkHistoryIndex: number;
  /** Internal: has the 80% budget warning been emitted for this session? */
  _budgetWarned80?: boolean;
  /** Internal: has the 100% budget warning been emitted for this session? */
  _budgetWarned100?: boolean;
  /**
   * v4.12.3 — Set by the message handler when it aborts a running query
   * via the bypass-queue path (background agent pending). The old
   * handler's catch branch checks this flag and silently swallows the
   * resulting abort error instead of surfacing it as a user-visible
   * "request cancelled" reply. Cleared when the new query starts.
   */
  _bypassAbortFired?: boolean;
}

/** Max history entries to keep (to avoid token overflow) */
const MAX_HISTORY = 100;

const sessions = new Map<string, UserSession>();

// v4.12.0 P1 #3 — Telegram active-workspace map: userId → workspaceName.
// Separate from the sessions Map because a user's ACTIVE workspace is an
// index, not a session itself. Persisted via session-persistence snapshots.
const telegramWorkspaces = new Map<string, string>();

/** Get the user's currently active Telegram workspace. null = default. */
export function getTelegramWorkspace(userId: string | number): string | null {
  return telegramWorkspaces.get(String(userId)) ?? null;
}

/** Set the user's currently active Telegram workspace. */
export function setTelegramWorkspace(userId: string | number, name: string | null): void {
  const key = String(userId);
  if (name === null) {
    telegramWorkspaces.delete(key);
  } else {
    telegramWorkspaces.set(key, name);
  }
  // Defer persist() until after it's defined below
  if (_persistHook) {
    try { _persistHook(); } catch { /* ignore */ }
  }
}

/** For session-persistence.ts — expose the raw map for snapshotting. */
export function getTelegramWorkspacesMap(): Map<string, string> {
  return telegramWorkspaces;
}

// ── Persistence Hook (v4.11.0) ─────────────────────────────────────
//
// session-persistence.ts is wired in via attachPersistHook() at bot startup.
// We use a callback indirection rather than a direct import to avoid a
// circular dependency (session-persistence imports getAllSessions from here).
let _persistHook: (() => void) | null = null;

/** Wire a callback that gets invoked on every session mutation. */
export function attachPersistHook(fn: () => void): void {
  _persistHook = fn;
}

/** Internal: invoke the persist hook if attached. Never throws. */
function persist(): void {
  if (!_persistHook) return;
  try {
    _persistHook();
  } catch {
    // never let persistence break session writes
  }
}

/** Public marker for handlers that mutate session fields directly (sessionId,
 *  language, effort, voiceReply, workingDir) outside of addToHistory/trackProviderUsage.
 *  Triggers a debounced persist. Safe to call from any code path. */
export function markSessionDirty(_key?: number | string): void {
  persist();
}

export function buildSessionKey(
  platform: string,
  channelId: string | number,
  userId: string | number,
): string {
  switch (config.sessionMode) {
    case "per-channel":
      return `${platform}:${channelId}`;
    case "per-channel-peer":
      return `${platform}:${channelId}:${userId}`;
    case "per-user":
    default:
      return String(userId);
  }
}

export function getSession(key: number | string): UserSession {
  const k = String(key);
  let session = sessions.get(k);
  if (!session) {
    session = {
      sessionId: null,
      workingDir: config.defaultWorkingDir,
      workspaceName: null,
      isProcessing: false,
      abortController: null,
      lastActivity: Date.now(),
      startedAt: Date.now(),
      totalCost: 0,
      costByProvider: {},
      queriesByProvider: {},
      effort: "medium",
      voiceReply: false,
      messageCount: 0,
      toolUseCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      lastTurnInputTokens: 0,
      compactionCount: 0,
      checkpointHintsInjected: 0,
      sdkSubTaskCount: 0,
      pendingBackgroundCount: 0,
      history: [],
      language: "en",
      messageQueue: [],
      lastSdkHistoryIndex: -1,
    };
    sessions.set(k, session);
  } else {
    // Touch lastActivity on every access so the cleanup interval
    // never kills a session that's still being interacted with.
    session.lastActivity = Date.now();
  }
  return session;
}

export function resetSession(key: number | string): void {
  const session = getSession(key);
  session.sessionId = null;
  session.totalCost = 0;
  session.costByProvider = {};
  session.queriesByProvider = {};
  session.messageCount = 0;
  session.toolUseCount = 0;
  session.totalInputTokens = 0;
  session.totalOutputTokens = 0;
  session.lastTurnInputTokens = 0;
  session.compactionCount = 0;
  session.checkpointHintsInjected = 0;
  session.sdkSubTaskCount = 0;
  session.pendingBackgroundCount = 0;
  session.history = [];
  session.lastSdkHistoryIndex = -1;
  session.startedAt = Date.now();
  // Reset budget warning flags so the user gets fresh warnings in the new session.
  session._budgetWarned80 = false;
  session._budgetWarned100 = false;
  persist();
}

/** Track cost, query count, and tokens for a provider. */
export function trackProviderUsage(key: number | string, providerKey: string, cost: number, inputTokens?: number, outputTokens?: number): void {
  const session = getSession(key);
  session.costByProvider[providerKey] = (session.costByProvider[providerKey] || 0) + cost;
  session.queriesByProvider[providerKey] = (session.queriesByProvider[providerKey] || 0) + 1;
  session.totalCost += cost;
  if (inputTokens) session.totalInputTokens += inputTokens;
  if (outputTokens) session.totalOutputTokens += outputTokens;
  persist();

  // Soft budget warnings — these NEVER block the bot. They exist purely
  // as log signals so the operator can notice unusually expensive
  // sessions. Each threshold fires at most once per session (reset on /new).
  const budget = config.maxBudgetUsd;
  if (budget > 0) {
    const pct = (session.totalCost / budget) * 100;
    if (pct >= 100 && !session._budgetWarned100) {
      console.warn(
        `💸 Session budget exceeded: $${session.totalCost.toFixed(4)} / $${budget.toFixed(2)} (${pct.toFixed(0)}%) — bot continues (no hard limit enforced)`
      );
      session._budgetWarned100 = true;
    } else if (pct >= 80 && !session._budgetWarned80) {
      console.warn(
        `⚠️  Session budget 80% consumed: $${session.totalCost.toFixed(4)} / $${budget.toFixed(2)}`
      );
      session._budgetWarned80 = true;
    }
  }
}

// ── Session Cleanup ────────────────────────────────────────────────────────
//
// Memory hygiene for long-running deployments. The sessions Map would
// otherwise grow unbounded as new users arrive. The cleanup is deliberately
// *conservative*:
//   • Default TTL: 7 days of complete inactivity (not 24h)
//   • Never touches sessions where isProcessing === true
//   • Touches lastActivity on every getSession() call, so any interaction
//     in the last 7 days keeps the session alive indefinitely
//   • Aborts orphaned abort controllers defensively before removal
//
// Override via ALVIN_SESSION_TTL_DAYS env var if you want different behavior.
const SESSION_TTL_DAYS = Number(process.env.ALVIN_SESSION_TTL_DAYS) || 7;
const SESSION_INACTIVE_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // check hourly

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic session cleanup. Safe to call multiple times. */
export function startSessionCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    let purged = 0;
    for (const [key, s] of sessions) {
      // NEVER kill a session that's actively processing a query.
      if (s.isProcessing) continue;
      if (now - s.lastActivity > SESSION_INACTIVE_TTL_MS) {
        if (s.abortController) {
          try { s.abortController.abort(); } catch { /* ignore */ }
        }
        sessions.delete(key);
        purged++;
      }
    }
    if (purged > 0) {
      console.log(`🧹 Session cleanup: purged ${purged} inactive session(s) (TTL: ${SESSION_TTL_DAYS} days)`);
    }
  }, CLEANUP_INTERVAL_MS);
}

/** Stop the cleanup timer (for graceful shutdown). */
export function stopSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/** Add a message to conversation history. Unified across all provider types
 * — SDK providers resume from their filesystem session but we still track the
 * transcript here so failovers (and the B2 bridge-message) have context. */
export function addToHistory(key: number | string, message: ChatMessage): void {
  const session = getSession(key);
  session.history.push(message);
  // Trim oldest messages if history gets too long. Adjust lastSdkHistoryIndex
  // by the number of dropped entries so it keeps pointing at the correct
  // (now shifted) assistant turn — or collapses to -1 if it falls off the front.
  if (session.history.length > MAX_HISTORY) {
    const dropped = session.history.length - MAX_HISTORY;
    session.history = session.history.slice(-MAX_HISTORY);
    if (session.lastSdkHistoryIndex >= 0) {
      session.lastSdkHistoryIndex = Math.max(-1, session.lastSdkHistoryIndex - dropped);
    }
  }
  persist();
}

/** Get all active sessions (for web UI session browser). */
export function getAllSessions(): Map<string, UserSession> {
  return sessions;
}

/** v4.12.0 — Aggregate session.totalCost by workspaceName across all
 *  active sessions. Returns an object keyed by workspace name (null →
 *  "default") with cumulative cost, session count, message count, and
 *  tool use count. Used by the Web UI's workspace overview. */
export function getCostByWorkspace(): Record<string, {
  totalCost: number;
  sessionCount: number;
  messageCount: number;
  toolUseCount: number;
}> {
  const out: Record<string, {
    totalCost: number;
    sessionCount: number;
    messageCount: number;
    toolUseCount: number;
  }> = {};
  for (const s of sessions.values()) {
    const name = s.workspaceName ?? "default";
    if (!out[name]) {
      out[name] = { totalCost: 0, sessionCount: 0, messageCount: 0, toolUseCount: 0 };
    }
    out[name].totalCost += s.totalCost;
    out[name].sessionCount += 1;
    out[name].messageCount += s.messageCount;
    out[name].toolUseCount += s.toolUseCount;
  }
  return out;
}

/** Kill a user session completely — abort running query, clear history, remove from map. */
export function killSession(key: number | string): { aborted: boolean; hadSession: boolean } {
  const k = String(key);
  const session = sessions.get(k);
  if (!session) return { aborted: false, hadSession: false };

  let aborted = false;
  if (session.abortController) {
    session.abortController.abort();
    aborted = true;
  }

  sessions.delete(k);
  return { aborted, hadSession: true };
}
