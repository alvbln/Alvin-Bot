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
import { execFile } from "child_process";
import { promisify } from "util";
import type { Provider, ProviderConfig, QueryOptions, StreamChunk, EffortLevel } from "./types.js";
import { findClaudeBinary } from "../find-claude-binary.js";
import { buildAlvinMcpServer } from "../services/alvin-mcp-tools.js";

const execFileAsync = promisify(execFile);

/**
 * Detects the Claude CLI "Not logged in" error message. The CLI emits this
 * as normal assistant text when no valid OAuth token is present, so we have
 * to treat that output as an error in the SDK path too.
 */
export function isAuthErrorOutput(text: string): boolean {
  if (!text) return false;
  return /^\s*not logged in\b/i.test(text);
}

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

  // Cache the availability check: execFile on every user message would block
  // the bot for ~0-5s each time. A 60s cache is safe — the CLI binary does
  // not disappear mid-session.
  private availabilityCache: { result: boolean; expiresAt: number } | null = null;
  private static readonly AVAILABILITY_CACHE_MS = 60_000;

  constructor(config?: Partial<ProviderConfig>) {
    this.config = {
      type: "claude-sdk",
      name: "Claude (Agent SDK)",
      // "inherit" = don't pass model: to the SDK → Claude CLI default wins
      // (currently Opus 4.7 on Max subscription). Override with an alias
      // ("opus" | "sonnet" | "haiku") or a full ID ("claude-opus-4-7").
      model: "inherit",
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
      // Checkpoint reminder injection with COOLDOWN.
      //
      // Old behaviour: once either threshold was crossed, the hint got
      // prepended to EVERY subsequent turn's prompt. That forced Claude
      // to detour through memory-file reads/writes on every single turn,
      // which bloated turn latency in long sessions and was a major
      // contributor to the 5-minute hard timeout firing.
      //
      // New behaviour: inject only every CHECKPOINT_REMINDER_EVERY turns
      // after the threshold is reached. At messageCount 10 → injected,
      // 11/12/13/14 → skipped, 15 → injected again, etc. 80% reduction
      // in per-turn overhead while still giving Claude periodic reminders.
      const CHECKPOINT_REMINDER_EVERY = 5;
      const overThreshold =
        sessionState.toolUseCount >= CHECKPOINT_TOOL_THRESHOLD ||
        sessionState.messageCount >= CHECKPOINT_MSG_THRESHOLD;
      const onCooldownBeat =
        sessionState.messageCount % CHECKPOINT_REMINDER_EVERY === 0;

      if (overThreshold && onCooldownBeat) {
        prompt = `[CHECKPOINT] Du hast bereits ${sessionState.toolUseCount} Tool-Aufrufe und ${sessionState.messageCount} Nachrichten in dieser Session. Schreibe jetzt einen Checkpoint in deine Memory-Datei (docs/memory/YYYY-MM-DD.md) bevor du diese Anfrage bearbeitest.\n\n${prompt}`;
      }
    }

    // Build system prompt
    const systemPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${botClaudeMd}`
      : botClaudeMd;

    // Build a real AbortController the SDK can call .abort() on.
    // The previous implementation cast a plain {signal} object to AbortController,
    // which broke SDK-internal cancellation and left orphan subprocesses.
    let internalAbortController: AbortController | undefined;
    if (options.abortSignal) {
      internalAbortController = new AbortController();
      if (options.abortSignal.aborted) {
        internalAbortController.abort();
      } else {
        options.abortSignal.addEventListener(
          "abort",
          () => internalAbortController?.abort(),
          { once: true }
        );
      }
    }

    try {
      const claudePath = findClaudeBinary();

      // v4.13 — Register Alvin's custom MCP server if the caller provided
      // dispatch context. The server exposes `alvin_dispatch_agent` which
      // spawns truly detached `claude -p` subprocesses (independent of the
      // main SDK subprocess's lifecycle). When Claude calls it, the bot
      // can abort this query without killing the dispatched sub-agent.
      const mcpServers: Record<string, ReturnType<typeof buildAlvinMcpServer>> = {};
      if (options.alvinDispatchContext) {
        mcpServers.alvin = buildAlvinMcpServer(options.alvinDispatchContext);
      }

      // v4.13 — MCP tool names must be explicitly whitelisted via allowedTools
      // in the form `mcp__<server>__<tool>`. Without this, Claude can see the
      // tool in the catalog but cannot actually invoke it.
      const defaultAllowed = [
        "Read", "Write", "Edit", "Bash", "Glob", "Grep",
        "WebSearch", "WebFetch", "Task",
      ];
      if (options.alvinDispatchContext) {
        defaultAllowed.push("mcp__alvin__dispatch_agent");
      }

      // v4.15 — Forward model selection to the Agent SDK. Resolution order:
      //   1. options.model (per-query override — e.g. workspace `model:` field)
      //   2. this.config.model (provider-level default — e.g. claude-sonnet)
      //   3. "inherit" → don't pass model: → Claude CLI default (Opus 4.7 on Max)
      // Aliases "opus" | "sonnet" | "haiku" auto-resolve to the latest tier.
      const rawModel = options.model ?? this.config.model;
      const modelOverride =
        rawModel && rawModel !== "inherit" ? rawModel : undefined;

      // v4.15.1 — Suppress fallbackModel when the primary model is already
      // Haiku. The Agent SDK rejects identical model/fallbackModel pairs with
      // "Fallback model cannot be the same as the main model", which then
      // cascades all the way down the provider fallback chain (→ Ollama
      // on-demand boot → noticeable latency spike). For opus/sonnet/inherit,
      // keep Haiku as the rate-limit fallback.
      const primaryIsHaiku = (modelOverride ?? "").toLowerCase().includes("haiku");
      const fallbackModel = primaryIsHaiku ? undefined : "haiku";

      const q = query({
        prompt,
        options: {
          cwd: options.workingDir || process.cwd(),
          abortController: internalAbortController,
          resume: options.sessionId ?? undefined,
          pathToClaudeCodeExecutable: claudePath,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          env: cleanEnv,
          settingSources: ["user", "project"],
          // v4.12.2 — options.allowedTools can override the default full set.
          // Used by sub-agents with toolset="readonly"/"research" to restrict
          // what Claude can do. Default = full access + alvin MCP tools.
          allowedTools: options.allowedTools ?? defaultAllowed,
          // v4.13 — Conditionally pass the MCP server config so the inline
          // dispatch tool is visible. Empty object = no custom tools.
          mcpServers:
            Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
          systemPrompt,
          effort: (options.effort || "medium") as EffortLevel,
          maxTurns: 50,
          betas: ["context-1m-2025-08-07"],
          ...(modelOverride ? { model: modelOverride } : {}),
          // Prefer Haiku as fallback on rate-limit/overload — cheap and
          // fast, keeps the bot responsive when the primary tier is
          // throttled. Omitted when the primary IS Haiku (SDK requires
          // distinct model/fallbackModel values — see v4.15.1 fix above).
          ...(fallbackModel ? { fallbackModel } : {}),
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
                // Guard against "Not logged in" leaking as assistant text.
                // If the very first text chunk matches the CLI auth-error
                // pattern, surface it as an error chunk instead of rendering
                // it as a normal response.
                if (!accumulatedText && isAuthErrorOutput(block.text)) {
                  yield {
                    type: "error",
                    error: "Claude CLI is not logged in. Run `claude login` on this machine.",
                  };
                  return;
                }
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

                // v4.12.1 — Extract run_in_background from the raw input
                // object BEFORE the 500-char JSON truncation below. This is
                // load-bearing: for long prompts the serialized input can
                // exceed 500 chars, and naive post-truncation parsing would
                // lose the flag and misclassify sync tasks as async (→ false
                // 10-min abort on legitimate long-running sub-agents).
                // See src/handlers/stuck-timer.ts and message.ts for the
                // consumer side.
                let runInBackground: boolean | undefined;
                if (
                  "input" in block &&
                  block.input &&
                  typeof block.input === "object"
                ) {
                  const input = block.input as { run_in_background?: unknown };
                  if (input.run_in_background === true) runInBackground = true;
                  else if (input.run_in_background === false) runInBackground = false;
                }

                // Serialise the tool input (parameters) so the message
                // handler can surface detail for specific tools — most
                // importantly the "Task" tool where `input.description`
                // describes what sub-task Claude is delegating.
                let toolInputStr: string | undefined;
                if ("input" in block && block.input !== undefined) {
                  try {
                    const raw = JSON.stringify(block.input);
                    // cap at 500 chars to keep status lines manageable
                    toolInputStr = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
                  } catch {
                    // unserializable — skip
                  }
                }

                // Tool-use blocks in the Anthropic API always have an `id`
                // at runtime, but the SDK's .d.ts shape doesn't guarantee it
                // — defensive cast. Used by the task-aware stuck timer to
                // correlate tool_use → tool_result for sync tracking.
                const toolUseId = (block as { id?: string }).id;

                yield {
                  type: "tool_use",
                  toolName: block.name,
                  toolInput: toolInputStr,
                  toolUseId,
                  runInBackground,
                  sessionId: capturedSessionId,
                };
              }
            }
          }
        }

        // User message — tool_results from the Claude API arrive as user
        // messages in the SDK protocol. We surface tool_result blocks as
        // chunks so the message handler can detect Agent async_launched
        // payloads and register them with the watcher (Fix #17 Stage 2).
        if (message.type === "user") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const userMsg = message as any;
          const content = userMsg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block &&
                typeof block === "object" &&
                block.type === "tool_result" &&
                typeof block.tool_use_id === "string"
              ) {
                // The `content` field on a tool_result block can be a
                // plain string OR an array of content blocks. Normalize
                // to a single string so the chunk consumer doesn't need
                // to know about the SDK shape.
                let contentText = "";
                if (typeof block.content === "string") {
                  contentText = block.content;
                } else if (Array.isArray(block.content)) {
                  contentText = block.content
                    .map((c: unknown) => {
                      if (c && typeof c === "object" && "text" in c) {
                        const t = (c as { text: unknown }).text;
                        return typeof t === "string" ? t : "";
                      }
                      return "";
                    })
                    .join("");
                }
                yield {
                  type: "tool_result",
                  toolUseId: block.tool_use_id,
                  toolResultContent: contentText,
                  sessionId: capturedSessionId,
                };
              }
            }
          }
        }

        // Result — done (extract full usage including cache tokens)
        if (message.type === "result") {
          const resultMsg = message as SDKResultMessage;
          const usage = "usage" in resultMsg ? (resultMsg as any).usage : null;
          const inputTok = usage
            ? (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
            : 0;
          const outputTok = usage?.output_tokens || 0;
          yield {
            type: "done",
            text: accumulatedText,
            sessionId: resultMsg.session_id || capturedSessionId,
            costUsd: "total_cost_usd" in resultMsg ? resultMsg.total_cost_usd : 0,
            inputTokens: inputTok,
            outputTokens: outputTok,
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
    // Cached availability check. The previous implementation called execSync
    // on every user message, blocking the Node event loop for up to 5s per
    // query. We now use async execFile and cache the result for 60s.
    const now = Date.now();
    if (this.availabilityCache && this.availabilityCache.expiresAt > now) {
      return this.availabilityCache.result;
    }

    const cache = (result: boolean): boolean => {
      this.availabilityCache = {
        result,
        expiresAt: now + ClaudeSDKProvider.AVAILABILITY_CACHE_MS,
      };
      return result;
    };

    try {
      const claudePath = findClaudeBinary();
      if (!claudePath) return cache(false);

      // Step 1: binary exists?
      await execFileAsync(claudePath, ["--version"], { timeout: 5000 });

      // Step 2: actually authenticated?
      //
      // We used to use `claude -p "ping" --output-format text` and sniff
      // the stdout for "Not logged in". That spawned a full SDK query,
      // consumed tokens, and took 5-10 seconds warm — occasionally
      // crossing our timeout on cold starts or under load, leading to
      // false-positive "unavailable" reports that cascaded into heartbeat
      // failures and unnecessary fallback to Ollama.
      //
      // `claude auth status` is the purpose-built command: fast (~150ms),
      // no token cost, no SDK init, returns structured JSON with an
      // explicit `loggedIn` boolean. Much cleaner.
      try {
        const { stdout } = await execFileAsync(
          claudePath,
          ["auth", "status"],
          { timeout: 5000 },
        );
        const parsed = JSON.parse(stdout) as { loggedIn?: unknown };
        if (parsed.loggedIn === true) {
          return cache(true);
        }
        // loggedIn === false (or missing) — not authenticated
        return cache(false);
      } catch (authErr) {
        // Older claude CLI versions may not expose `auth status` as JSON,
        // or may exit non-zero when not logged in. Fall back to the
        // sniff-stdout approach for backward compat.
        try {
          const { stdout: probeOut } = await execFileAsync(
            claudePath,
            ["-p", "ping", "--output-format", "text"],
            { timeout: 15000 },
          );
          return cache(!isAuthErrorOutput(probeOut));
        } catch {
          // Both checks failed — treat as unavailable
          void authErr;
          return cache(false);
        }
      }
    } catch {
      return cache(false);
    }
  }

  /** v4.15.2 — Clear the cached isAvailable() result. Called by the
   *  heartbeat service after detecting macOS sleep/wake so the first
   *  post-wake probe doesn't serve a stale "unavailable" from hours ago. */
  invalidateAvailabilityCache(): void {
    this.availabilityCache = null;
  }

  getInfo(): { name: string; model: string; status: string } {
    const model =
      this.config.model === "inherit"
        ? "CLI default (latest)"
        : this.config.model;
    return {
      name: this.config.name,
      model,
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
