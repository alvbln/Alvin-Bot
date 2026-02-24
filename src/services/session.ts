import os from "os";
import { config } from "../config.js";

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface UserSession {
  sessionId: string | null;
  workingDir: string;
  isProcessing: boolean;
  abortController: AbortController | null;
  lastActivity: number;
  totalCost: number;
  effort: EffortLevel;
  voiceReply: boolean;
  messageCount: number;       // Messages in current session (resets on /new)
  toolUseCount: number;       // Tool uses in current session (for checkpoint reminders)
}

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
      totalCost: 0,
      effort: "high",
      voiceReply: false,
      messageCount: 0,
      toolUseCount: 0,
    };
    sessions.set(userId, session);
  }
  return session;
}

export function resetSession(userId: number): void {
  const session = getSession(userId);
  session.sessionId = null;
  session.totalCost = 0;
  session.messageCount = 0;
  session.toolUseCount = 0;
}
