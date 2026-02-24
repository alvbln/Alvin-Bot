import os from "os";
import { config } from "../config.js";
import type { ChatMessage } from "../providers/types.js";

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface UserSession {
  /** Claude SDK session ID (for resume) */
  sessionId: string | null;
  /** Working directory for tool-using providers */
  workingDir: string;
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
  /** Conversation history for non-SDK providers */
  history: ChatMessage[];
  /** Preferred language */
  language: "de" | "en";
  /** Message queue (messages received while processing) */
  messageQueue: string[];
}

/** Max history entries to keep (to avoid token overflow) */
const MAX_HISTORY = 40;

const sessions = new Map<number, UserSession>();

export function getSession(userId: number): UserSession {
  let session = sessions.get(userId);
  if (!session) {
    session = {
      sessionId: null,
      workingDir: config.defaultWorkingDir,
      isProcessing: false,
      abortController: null,
      lastActivity: Date.now(),
      startedAt: Date.now(),
      totalCost: 0,
      costByProvider: {},
      queriesByProvider: {},
      effort: "high",
      voiceReply: false,
      messageCount: 0,
      toolUseCount: 0,
      history: [],
      language: "de",
      messageQueue: [],
    };
    sessions.set(userId, session);
  }
  return session;
}

export function resetSession(userId: number): void {
  const session = getSession(userId);
  session.sessionId = null;
  session.totalCost = 0;
  session.costByProvider = {};
  session.queriesByProvider = {};
  session.messageCount = 0;
  session.toolUseCount = 0;
  session.history = [];
  session.startedAt = Date.now();
}

/** Track cost and query count for a provider. */
export function trackProviderUsage(userId: number, providerKey: string, cost: number): void {
  const session = getSession(userId);
  session.costByProvider[providerKey] = (session.costByProvider[providerKey] || 0) + cost;
  session.queriesByProvider[providerKey] = (session.queriesByProvider[providerKey] || 0) + 1;
}

/** Add a message to conversation history (for non-SDK providers). */
export function addToHistory(userId: number, message: ChatMessage): void {
  const session = getSession(userId);
  session.history.push(message);
  // Trim oldest messages if history gets too long
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY);
  }
}

/** Get all active sessions (for web UI session browser). */
export function getAllSessions(): Array<{ userId: number; session: UserSession }> {
  const result: Array<{ userId: number; session: UserSession }> = [];
  for (const [userId, session] of sessions) {
    result.push({ userId, session });
  }
  return result;
}
