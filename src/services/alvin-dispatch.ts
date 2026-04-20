/**
 * v4.13 — alvin_dispatch custom-tool service.
 *
 * Architectural replacement for Claude Agent SDK's built-in
 * `Task(run_in_background: true)` tool. The SDK's built-in version
 * ties the background sub-agent's execution to the parent SDK
 * subprocess lifecycle — killing the parent (e.g. via v4.12.3's
 * bypass-abort) cascades into killing any in-flight background tasks.
 *
 * This module instead spawns a truly independent `claude -p` subprocess
 * via Node's `child_process.spawn({ detached: true, stdio: [...] })`.
 * The subprocess:
 *   - Has its own PID, own process group (by detached: true)
 *   - Is unreffed so the parent Node process doesn't wait for it
 *   - Writes its stream-json output to its own file
 *   - Survives any abort/crash/restart of the parent Alvin bot
 *
 * The async-agent-watcher polls the output file and delivers the
 * final result via subagent-delivery.ts when the sub-agent completes.
 *
 * See Phase A of docs/superpowers/plans/2026-04-16-v4.13-truly-async-subagents.md
 * for the empirical verification that detached `claude -p` subprocesses
 * behave as expected (they do).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import { resolve } from "node:path";
import { findClaudeBinary } from "../find-claude-binary.js";
import { registerPendingAgent } from "./async-agent-watcher.js";
import { getAllSessions } from "./session.js";
import { SUBAGENTS_DIR } from "../paths.js";

export interface DispatchInput {
  /** Full prompt for the sub-agent. Passed as -p argument. */
  prompt: string;
  /** Short human-readable description shown to the user when the
   *  sub-agent's result arrives. */
  description: string;
  /**
   * Chat id for delivery. v4.14 — string for Slack/Discord/WhatsApp
   * (channel IDs), number for Telegram. The delivery router tolerates
   * both shapes.
   */
  chatId: number | string;
  /** User id for delivery + profile attribution. Same widening. */
  userId: number | string;
  /** Session key from buildSessionKey — used by the watcher to
   *  decrement pendingBackgroundCount on delivery. */
  sessionKey: string;
  /**
   * v4.14 — Platform the parent session runs on. Routes watcher
   * delivery. Default "telegram" (unchanged behavior for callers that
   * don't pass this field).
   */
  platform?: "telegram" | "slack" | "discord" | "whatsapp";
  /** Optional working directory for the subprocess (default: user home). */
  cwd?: string;
}

export interface DispatchResult {
  /** Unique ID assigned to this dispatch. Used to correlate with
   *  the watcher's pending list and as the output file stem. */
  agentId: string;
  /** Absolute path where the subprocess writes its stream-json output. */
  outputFile: string;
  /** True if spawn succeeded and registration completed. */
  spawned: true;
}

/** Generate a 32-char hex agent id. Avoids collisions across parallel
 *  dispatches even at sub-millisecond intervals. */
function generateAgentId(): string {
  return "alvin-" + crypto.randomBytes(12).toString("hex");
}

/**
 * Dispatch a detached sub-agent. Returns synchronously — the subprocess
 * runs in the background. Throws if spawn fails. On success:
 *
 *   1. Subprocess is running, writing stream-json to outputFile
 *   2. The agent is registered with async-agent-watcher (pending list)
 *   3. session.pendingBackgroundCount is incremented
 *   4. When the subprocess completes, watcher delivers the result
 */
export function dispatchDetachedAgent(input: DispatchInput): DispatchResult {
  // Ensure subagents dir exists. Idempotent.
  try {
    fs.mkdirSync(SUBAGENTS_DIR, { recursive: true });
  } catch {
    /* race-safe — next open() will surface the real error */
  }

  const agentId = generateAgentId();
  const outputFile = resolve(SUBAGENTS_DIR, `${agentId}.jsonl`);

  // Open the output file for write. We pass the FD to child's stdout
  // so the subprocess writes directly without going through us.
  // stderr → separate .err file for diagnostics.
  const errFile = resolve(SUBAGENTS_DIR, `${agentId}.err`);
  const outFd = fs.openSync(outputFile, "w");
  const errFd = fs.openSync(errFile, "w");

  const cleanEnv: Record<string, string | undefined> = { ...process.env };
  // v4.13 — Prevent nested-session errors. The SDK refuses to run if
  // these are already set in env (they leak from parent Alvin/SDK).
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  const claudePath = findClaudeBinary();
  if (!claudePath) {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    throw new Error(
      "alvin_dispatch: claude CLI not found. Install claude-code to enable background dispatch.",
    );
  }

  const child = spawn(
    claudePath,
    [
      "-p",
      input.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    {
      cwd: input.cwd,
      detached: true,
      stdio: ["ignore", outFd, errFd],
      env: cleanEnv,
    },
  );

  // Close our copies of the FDs — the child has its own descriptors now.
  try {
    fs.closeSync(outFd);
  } catch {
    /* ignore */
  }
  try {
    fs.closeSync(errFd);
  } catch {
    /* ignore */
  }

  // Detach from parent Node's event loop so parent exit doesn't wait.
  child.unref();

  // Register with watcher so it polls the output file and delivers.
  registerPendingAgent({
    agentId,
    outputFile,
    description: input.description,
    prompt: input.prompt,
    chatId: input.chatId,
    userId: input.userId,
    toolUseId: null,
    sessionKey: input.sessionKey,
    platform: input.platform,
  });

  // Increment the session's pendingBackgroundCount so the main handler
  // knows a background task is in flight (same signal path as SDK's
  // built-in Task tool).
  try {
    const s = getAllSessions().get(input.sessionKey);
    if (s) {
      s.pendingBackgroundCount = (s.pendingBackgroundCount ?? 0) + 1;
    }
  } catch {
    /* never let counter updates break dispatch */
  }

  return { agentId, outputFile, spawned: true };
}
