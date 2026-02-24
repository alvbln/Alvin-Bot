import { query, type SDKMessage, type SDKAssistantMessage, type SDKResultMessage, type SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import type { EffortLevel } from "./services/session.js";

// Bot project root (one level up from src/)
const BOT_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Load bot's CLAUDE.md at startup — personality, rules, memory instructions
let botClaudeMd = "";
try {
  botClaudeMd = readFileSync(resolve(BOT_PROJECT_ROOT, "CLAUDE.md"), "utf-8");
  // Replace relative docs/ paths with absolute paths so memory works from any CWD
  botClaudeMd = botClaudeMd.replaceAll("docs/", `${BOT_PROJECT_ROOT}/docs/`);
} catch {
  // CLAUDE.md not found — continue without bot-specific instructions
}

// Checkpoint reminder thresholds
const CHECKPOINT_TOOL_THRESHOLD = 15;   // After N tool uses → inject checkpoint reminder
const CHECKPOINT_MSG_THRESHOLD = 10;    // After N messages → inject checkpoint reminder

export interface ClaudeQueryOptions {
  prompt: string;
  sessionId: string | null;
  workingDir: string;
  effort: EffortLevel;
  abortController: AbortController;
  messageCount: number;
  toolUseCount: number;
  onText: (fullText: string) => Promise<void>;
  onToolUse?: (toolName: string) => Promise<void>;
  onToolUseCount?: (count: number) => void;
  onComplete: (result: { sessionId: string; cost: number }) => void;
}

export async function runClaudeAgent(opts: ClaudeQueryOptions): Promise<void> {
  // Remove env vars that prevent nested Claude Code sessions
  const cleanEnv: Record<string, string | undefined> = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  // Build prompt — inject checkpoint reminder if thresholds exceeded
  let prompt = opts.prompt;
  const needsCheckpoint =
    opts.toolUseCount >= CHECKPOINT_TOOL_THRESHOLD ||
    opts.messageCount >= CHECKPOINT_MSG_THRESHOLD;

  if (needsCheckpoint) {
    prompt = `[CHECKPOINT] Du hast bereits ${opts.toolUseCount} Tool-Aufrufe und ${opts.messageCount} Nachrichten in dieser Session. Schreibe jetzt einen Checkpoint in deine Memory-Datei (docs/memory/YYYY-MM-DD.md) bevor du diese Anfrage bearbeitest — fasse den bisherigen Kontext kurz zusammen.\n\n${prompt}`;
  }

  const q = query({
    prompt,
    options: {
      cwd: opts.workingDir,
      abortController: opts.abortController,
      resume: opts.sessionId ?? undefined,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      env: cleanEnv,
      settingSources: ["user", "project"],
      allowedTools: [
        "Read", "Write", "Edit", "Bash", "Glob", "Grep",
        "WebSearch", "WebFetch", "Task",
      ],
      systemPrompt: `Du bist ein autonomer AI-Agent, gesteuert über Telegram.
Halte Antworten kurz und prägnant, aber gründlich.
Nutze Markdown-Formatierung kompatibel mit Telegram (fett, kursiv, Code-Blöcke).
Wenn du Commands ausführst oder Dateien bearbeitest, erkläre kurz was du getan hast.
Antworte auf Deutsch, es sei denn der User schreibt auf Englisch.

${botClaudeMd}`,
      effort: opts.effort,
      maxTurns: 50,
    },
  });

  let accumulatedText = "";
  let capturedSessionId = opts.sessionId || "";
  let localToolUseCount = 0;

  for await (const message of q) {
    // System init message — capture session ID
    if (message.type === "system" && "subtype" in message && message.subtype === "init") {
      const sysMsg = message as SDKSystemMessage;
      capturedSessionId = sysMsg.session_id;
    }

    // Assistant message — extract text and tool use
    if (message.type === "assistant") {
      const assistantMsg = message as SDKAssistantMessage;
      capturedSessionId = assistantMsg.session_id;

      if (assistantMsg.message?.content) {
        for (const block of assistantMsg.message.content) {
          if ("text" in block && block.text) {
            accumulatedText += block.text;
            await opts.onText(accumulatedText);
          }
          if ("name" in block) {
            localToolUseCount++;
            if (opts.onToolUse) {
              await opts.onToolUse(block.name);
            }
          }
        }
      }
    }

    // Result message — complete
    if (message.type === "result") {
      const resultMsg = message as SDKResultMessage;
      // Report tool use count back to caller for session tracking
      if (opts.onToolUseCount) {
        opts.onToolUseCount(localToolUseCount);
      }
      opts.onComplete({
        sessionId: resultMsg.session_id || capturedSessionId,
        cost: "total_cost_usd" in resultMsg ? resultMsg.total_cost_usd : 0,
      });
    }
  }
}
