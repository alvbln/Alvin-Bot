/**
 * Claude Agent SDK Provider
 *
 * Wraps the existing Claude Agent SDK integration as a provider.
 * This is the "premium" provider with full tool use (Read, Write, Bash, etc.)
 *
 * Requires: Claude CLI installed & logged in (Max subscription)
 */

import { query, type SDKAssistantMessage, type SDKResultMessage, type SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Provider, ProviderConfig, QueryOptions, StreamChunk, EffortLevel } from "./types.js";

const BOT_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Load CLAUDE.md once at startup
let botClaudeMd = "";
try {
  botClaudeMd = readFileSync(resolve(BOT_PROJECT_ROOT, "CLAUDE.md"), "utf-8");
  botClaudeMd = botClaudeMd.replaceAll("docs/", `${BOT_PROJECT_ROOT}/docs/`);
} catch {
  // CLAUDE.md not found — continue without
}

// Checkpoint thresholds
const CHECKPOINT_TOOL_THRESHOLD = 15;
const CHECKPOINT_MSG_THRESHOLD = 10;

export class ClaudeSDKProvider implements Provider {
  readonly config: ProviderConfig;

  constructor(config?: Partial<ProviderConfig>) {
    this.config = {
      type: "claude-sdk",
      name: "Claude (Agent SDK)",
      model: "claude-opus-4-6",
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      ...config,
    };
  }

  async *query(options: QueryOptions): AsyncGenerator<StreamChunk> {
    // Clean env to prevent nested session errors
    const cleanEnv: Record<string, string | undefined> = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    // Build prompt with optional checkpoint reminder
    let prompt = options.prompt;
    const sessionState = (options as QueryOptionsWithSessionState)._sessionState;

    if (sessionState) {
      const needsCheckpoint =
        sessionState.toolUseCount >= CHECKPOINT_TOOL_THRESHOLD ||
        sessionState.messageCount >= CHECKPOINT_MSG_THRESHOLD;

      if (needsCheckpoint) {
        prompt = `[CHECKPOINT] Du hast bereits ${sessionState.toolUseCount} Tool-Aufrufe und ${sessionState.messageCount} Nachrichten in dieser Session. Schreibe jetzt einen Checkpoint in deine Memory-Datei (docs/memory/YYYY-MM-DD.md) bevor du diese Anfrage bearbeitest.\n\n${prompt}`;
      }
    }

    // Build system prompt
    const systemPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${botClaudeMd}`
      : botClaudeMd;

    try {
      const q = query({
        prompt,
        options: {
          cwd: options.workingDir || process.cwd(),
          abortController: options.abortSignal
            ? { signal: options.abortSignal } as AbortController
            : undefined,
          resume: options.sessionId ?? undefined,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          env: cleanEnv,
          settingSources: ["user", "project"],
          allowedTools: [
            "Read", "Write", "Edit", "Bash", "Glob", "Grep",
            "WebSearch", "WebFetch", "Task",
          ],
          systemPrompt,
          effort: (options.effort || "high") as EffortLevel,
          maxTurns: 50,
        },
      });

      let accumulatedText = "";
      let capturedSessionId = options.sessionId || "";
      let localToolUseCount = 0;

      for await (const message of q) {
        // System init — capture session ID
        if (message.type === "system" && "subtype" in message && message.subtype === "init") {
          const sysMsg = message as SDKSystemMessage;
          capturedSessionId = sysMsg.session_id;
        }

        // Assistant message — text + tool use
        if (message.type === "assistant") {
          const assistantMsg = message as SDKAssistantMessage;
          capturedSessionId = assistantMsg.session_id;

          if (assistantMsg.message?.content) {
            for (const block of assistantMsg.message.content) {
              if ("text" in block && block.text) {
                accumulatedText += block.text;
                yield {
                  type: "text",
                  text: accumulatedText,
                  delta: block.text,
                  sessionId: capturedSessionId,
                };
              }
              if ("name" in block) {
                localToolUseCount++;
                yield {
                  type: "tool_use",
                  toolName: block.name,
                  sessionId: capturedSessionId,
                };
              }
            }
          }
        }

        // Result — done
        if (message.type === "result") {
          const resultMsg = message as SDKResultMessage;
          yield {
            type: "done",
            text: accumulatedText,
            sessionId: resultMsg.session_id || capturedSessionId,
            costUsd: "total_cost_usd" in resultMsg ? resultMsg.total_cost_usd : 0,
          };
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("abort")) {
        yield { type: "error", error: "Request aborted" };
      } else {
        yield {
          type: "error",
          error: `Claude SDK error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    // Claude SDK uses CLI auth — check if claude CLI is available
    try {
      const { execSync } = await import("child_process");
      execSync("claude --version", { stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  getInfo(): { name: string; model: string; status: string } {
    return {
      name: this.config.name,
      model: this.config.model,
      status: "✅ Agent SDK (CLI auth)",
    };
  }
}

// Extended query options with internal session state (for checkpoint tracking)
interface QueryOptionsWithSessionState extends QueryOptions {
  _sessionState?: {
    messageCount: number;
    toolUseCount: number;
  };
}
