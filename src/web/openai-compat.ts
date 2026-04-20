/**
 * OpenAI-Compatible API — /v1/chat/completions + /v1/models
 *
 * Allows external tools (e.g., OpenClaw) to use Claude via Alvin-Bot's
 * Agent SDK. Routes through Claude Code CLI OAuth (Max subscription).
 *
 * Auth: Bearer token (WEBHOOK_TOKEN from .env)
 */

import http from "http";
import crypto from "crypto";
import { ClaudeSDKProvider } from "../providers/claude-sdk-provider.js";
import { config } from "../config.js";

// Lazy-initialized provider (shares nothing with Telegram sessions)
let provider: ClaudeSDKProvider | null = null;

function getProvider(): ClaudeSDKProvider {
  if (!provider) {
    provider = new ClaudeSDKProvider();
  }
  return provider;
}

// ── Auth ────────────────────────────────────────────────

function checkBearer(req: http.IncomingMessage): boolean {
  if (!config.webhookToken) return false; // No token = disabled
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${config.webhookToken}`;
}

// ── Models Endpoint ─────────────────────────────────────

function handleModels(res: http.ServerResponse): void {
  const now = Math.floor(Date.now() / 1000);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    object: "list",
    data: [
      { id: "alvin-opus-4", object: "model", created: now, owned_by: "alvin-bot" },
      { id: "alvin-sonnet-4", object: "model", created: now, owned_by: "alvin-bot" },
      { id: "alvin-haiku-4", object: "model", created: now, owned_by: "alvin-bot" },
    ],
  }));
}

// ── Chat Completions ────────────────────────────────────

interface OAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OAIRequest {
  model?: string;
  messages: OAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

function buildPromptFromMessages(messages: OAIMessage[]): { prompt: string; systemPrompt: string } {
  let systemPrompt = "";
  const conversationParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt += (systemPrompt ? "\n\n" : "") + msg.content;
    } else if (msg.role === "user") {
      conversationParts.push(`User: ${msg.content}`);
    } else if (msg.role === "assistant") {
      conversationParts.push(`Assistant: ${msg.content}`);
    }
  }

  // Single message: extract raw content without "User:" prefix
  if (conversationParts.length <= 1) {
    const lastUser = messages.filter(m => m.role === "user").pop();
    return { prompt: lastUser?.content || "", systemPrompt };
  }

  // Multi-turn: format as conversation context
  return { prompt: conversationParts.join("\n\n"), systemPrompt };
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
): Promise<void> {
  // Parse request
  let oaiReq: OAIRequest;
  try {
    oaiReq = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }));
    return;
  }

  if (!oaiReq.messages || !Array.isArray(oaiReq.messages) || oaiReq.messages.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "messages array is required", type: "invalid_request_error" } }));
    return;
  }

  const { prompt, systemPrompt } = buildPromptFromMessages(oaiReq.messages);
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const model = oaiReq.model || "claude-opus-4-6";

  // Optional session resumption via header
  const sessionId = (req.headers["x-session-id"] as string) || null;

  const p = getProvider();

  if (oaiReq.stream !== false) {
    // ── Streaming Response (SSE) ──────────────────────
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Initial role chunk
    const roleChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" as const, content: "" }, finish_reason: null as string | null }],
    };
    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

    let outputSessionId = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for await (const chunk of p.query({ prompt, systemPrompt, sessionId })) {
        if (chunk.type === "text" && chunk.delta) {
          const sseChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null as string | null }],
          };
          res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
        }

        if (chunk.type === "done") {
          outputSessionId = chunk.sessionId || "";
          inputTokens = chunk.inputTokens || 0;
          outputTokens = chunk.outputTokens || 0;

          // Final chunk with finish_reason
          const doneChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" as string | null }],
            ...(inputTokens || outputTokens ? {
              usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
            } : {}),
          };
          res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        }

        if (chunk.type === "error") {
          const errChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content: `\n\n[Error: ${chunk.error}]` }, finish_reason: "stop" as string | null }],
          };
          res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errChunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: `\n\n[Error: ${errMsg}]` }, finish_reason: "stop" as string | null }],
      };
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
    }

    // Emit session ID for multi-turn support
    if (outputSessionId) {
      res.write(`data: ${JSON.stringify({ session_id: outputSessionId })}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    // ── Non-Streaming Response ────────────────────────
    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let outputSessionId = "";

    try {
      for await (const chunk of p.query({ prompt, systemPrompt, sessionId })) {
        if (chunk.type === "text" && chunk.delta) {
          fullText += chunk.delta;
        }
        if (chunk.type === "done") {
          outputSessionId = chunk.sessionId || "";
          inputTokens = chunk.inputTokens || 0;
          outputTokens = chunk.outputTokens || 0;
        }
        if (chunk.type === "error") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: { message: chunk.error || "Provider error", type: "server_error" },
          }));
          return;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: { message: errMsg, type: "server_error" },
      }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/json",
      ...(outputSessionId ? { "x-session-id": outputSessionId } : {}),
    });
    res.end(JSON.stringify({
      id: completionId,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: fullText },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    }));
  }
}

// ── Exported Handler ────────────────────────────────────

/**
 * Handle OpenAI-compatible API requests (/v1/...).
 * Returns true if the request was handled, false if not an /v1/ route.
 */
export function handleOpenAICompat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string,
  body: string,
): boolean {
  // Only handle /v1/ routes
  if (!urlPath.startsWith("/v1/")) return false;

  // Auth check (Bearer token required)
  if (!checkBearer(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: { message: "Invalid API key", type: "authentication_error" },
    }));
    return true;
  }

  // GET /v1/models
  if (urlPath === "/v1/models" && req.method === "GET") {
    handleModels(res);
    return true;
  }

  // POST /v1/chat/completions
  if (urlPath === "/v1/chat/completions" && req.method === "POST") {
    handleChatCompletions(req, res, body);
    return true;
  }

  // Unknown /v1/ route
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: { message: `Unknown endpoint: ${urlPath}`, type: "invalid_request_error" },
  }));
  return true;
}
