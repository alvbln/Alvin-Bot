/**
 * Session Persistence Service (v4.11.0)
 *
 * The sessions Map in src/services/session.ts is in-memory only. When the bot
 * restarts (launchctl, watchdog brake, npm install, crash), every user's
 * Claude SDK session_id, conversation history, language preference, and
 * tracking counters are wiped. Claude SDK then starts a fresh conversation
 * on the next user message, behaving like a goldfish.
 *
 * This service:
 * 1. Flushes a sanitized snapshot of getAllSessions() to disk (atomic write).
 * 2. Loads that snapshot at bot startup and rehydrates the Map.
 * 3. Coalesces rapid mutations via a debounced timer.
 *
 * Persisted fields are intentionally a SUBSET of UserSession — runtime-only
 * fields like abortController, isProcessing, and messageQueue are excluded.
 *
 * History is capped at MAX_PERSISTED_HISTORY (50 entries) per session so the
 * state file stays small even after months of conversation.
 */
import fs from "fs";
import { dirname } from "path";
import { SESSIONS_STATE_FILE } from "../paths.js";
import { SECURE_MODE } from "./file-permissions.js";
import {
  getAllSessions,
  getTelegramWorkspacesMap,
  type UserSession,
  type EffortLevel,
} from "./session.js";
import type { ChatMessage } from "../providers/types.js";
import type { Locale } from "../i18n.js";

/** History entries to keep in the persisted snapshot (per session). */
const MAX_PERSISTED_HISTORY = 50;

/** Debounce window for grouped mutations. */
const DEBOUNCE_MS = 1500;

interface PersistedSession {
  sessionId: string | null;
  workingDir: string;
  workspaceName: string | null;
  language: Locale;
  effort: EffortLevel;
  voiceReply: boolean;
  lastActivity: number;
  startedAt: number;
  totalCost: number;
  messageCount: number;
  toolUseCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastSdkHistoryIndex: number;
  history: ChatMessage[];
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Strip runtime-only fields and clip history. */
function snapshot(session: UserSession): PersistedSession {
  return {
    sessionId: session.sessionId,
    workingDir: session.workingDir,
    workspaceName: session.workspaceName,
    language: session.language,
    effort: session.effort,
    voiceReply: session.voiceReply,
    lastActivity: session.lastActivity,
    startedAt: session.startedAt,
    totalCost: session.totalCost,
    messageCount: session.messageCount,
    toolUseCount: session.toolUseCount,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    lastSdkHistoryIndex: session.lastSdkHistoryIndex,
    history: session.history.slice(-MAX_PERSISTED_HISTORY),
  };
}

/** Skip sessions that have never accumulated meaningful state. */
function isWorthPersisting(session: UserSession): boolean {
  return !!(
    session.sessionId ||
    session.history.length > 0 ||
    session.messageCount > 0 ||
    session.totalCost > 0
  );
}

/**
 * Atomic flush of all worth-persisting sessions to SESSIONS_STATE_FILE.
 * Cancels any pending debounced flush — this is the immediate path.
 */
export async function flushSessions(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  try {
    const all = getAllSessions();
    const out: Record<string, PersistedSession> = {};
    for (const [key, session] of all) {
      if (isWorthPersisting(session)) {
        out[key] = snapshot(session);
      }
    }

    // Ensure the state directory exists
    fs.mkdirSync(dirname(SESSIONS_STATE_FILE), { recursive: true });

    // v4.12.0 — Persist Telegram active-workspace map alongside sessions.
    // Wrapped in a versioned envelope so we can add more state later without
    // breaking loadPersistedSessions' backwards-compat path for older files.
    const tgWorkspaces: Record<string, string> = {};
    for (const [userId, ws] of getTelegramWorkspacesMap()) {
      tgWorkspaces[userId] = ws;
    }
    const envelope = {
      version: 2,
      sessions: out,
      telegramWorkspaces: tgWorkspaces,
    };

    // Atomic write: tmp + rename. v4.12.2 — mode 0o600 enforced so other
    // users on the same machine can't read conversation history or tokens.
    const tmpFile = `${SESSIONS_STATE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(envelope, null, 2), {
      encoding: "utf-8",
      mode: SECURE_MODE,
    });
    // Belt-and-suspenders: chmod in case the tmp file already existed with
    // looser permissions (writeFileSync's mode option is only applied on
    // initial create).
    try { fs.chmodSync(tmpFile, SECURE_MODE); } catch { /* fs may not support */ }
    fs.renameSync(tmpFile, SESSIONS_STATE_FILE);
  } catch (err) {
    console.warn(
      "⚠️ session-persistence: flush failed —",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Schedule a debounced flush. Multiple rapid calls collapse into one.
 * Use this from any session-mutating code path; the immediate flushSessions()
 * is reserved for graceful shutdown.
 */
export function schedulePersist(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void flushSessions();
  }, DEBOUNCE_MS);
}

/**
 * Load the persisted sessions snapshot from disk and rehydrate the Map.
 * Called once at bot startup. Returns the number of sessions restored.
 */
export function loadPersistedSessions(): number {
  let raw: string;
  try {
    raw = fs.readFileSync(SESSIONS_STATE_FILE, "utf-8");
  } catch {
    return 0; // no file = nothing to do
  }

  let raw_parsed: unknown;
  try {
    raw_parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      "⚠️ session-persistence: corrupt sessions.json, starting fresh —",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }

  if (!raw_parsed || typeof raw_parsed !== "object") return 0;

  // v4.12.0 — Detect envelope format vs legacy v4.11.0 flat format
  let parsed: Record<string, PersistedSession>;
  let tgWorkspaces: Record<string, string> = {};
  if (
    raw_parsed &&
    typeof raw_parsed === "object" &&
    "version" in (raw_parsed as Record<string, unknown>) &&
    "sessions" in (raw_parsed as Record<string, unknown>)
  ) {
    const env = raw_parsed as {
      version: number;
      sessions: Record<string, PersistedSession>;
      telegramWorkspaces?: Record<string, string>;
    };
    parsed = env.sessions ?? {};
    tgWorkspaces = env.telegramWorkspaces ?? {};
  } else {
    // Legacy flat format (v4.11.0)
    parsed = raw_parsed as Record<string, PersistedSession>;
  }

  // Rehydrate Telegram workspace map
  const tgMap = getTelegramWorkspacesMap();
  for (const [userId, name] of Object.entries(tgWorkspaces)) {
    if (typeof name === "string") tgMap.set(userId, name);
  }

  // Use the same getAllSessions Map that session.ts exports
  const all = getAllSessions();
  let count = 0;

  for (const [key, persisted] of Object.entries(parsed)) {
    if (!persisted || typeof persisted !== "object") continue;

    // Build a UserSession from the persisted shape, filling defaults for any
    // fields added in newer schema versions.
    const restored: UserSession = {
      sessionId: persisted.sessionId ?? null,
      workingDir: persisted.workingDir ?? process.cwd(),
      workspaceName: persisted.workspaceName ?? null,
      isProcessing: false,
      abortController: null,
      lastActivity: persisted.lastActivity ?? Date.now(),
      startedAt: persisted.startedAt ?? Date.now(),
      totalCost: persisted.totalCost ?? 0,
      costByProvider: {},
      queriesByProvider: {},
      effort: persisted.effort ?? "medium",
      voiceReply: persisted.voiceReply ?? false,
      messageCount: persisted.messageCount ?? 0,
      toolUseCount: persisted.toolUseCount ?? 0,
      totalInputTokens: persisted.totalInputTokens ?? 0,
      totalOutputTokens: persisted.totalOutputTokens ?? 0,
      lastTurnInputTokens: 0,
      compactionCount: 0,
      checkpointHintsInjected: 0,
      sdkSubTaskCount: 0,
      // v4.12.3 — Don't persist pendingBackgroundCount. On restart, the
      // async-agent-watcher re-hydrates its own state file and polls each
      // pending agent's outputFile, which handles delivery independently.
      // Starting at 0 avoids stale counters surviving a crash.
      pendingBackgroundCount: 0,
      history: Array.isArray(persisted.history) ? persisted.history : [],
      language: persisted.language ?? "en",
      messageQueue: [],
      lastSdkHistoryIndex: persisted.lastSdkHistoryIndex ?? -1,
    };
    all.set(key, restored);
    count++;
  }

  if (count > 0) {
    console.log(`🧠 session-persistence: restored ${count} session(s) from disk`);
  }
  return count;
}
