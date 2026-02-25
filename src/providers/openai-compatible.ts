/**
 * OpenAI-Compatible Provider
 *
 * Works with: OpenAI, Groq, Gemini, NVIDIA NIM, Ollama, OpenRouter, LM Studio,
 * and any other endpoint that implements the OpenAI Chat Completions API.
 *
 * Supports function calling (tool use) for providers that support it,
 * giving non-Claude models full agent capabilities (shell, files, web).
 */

import type { Provider, ProviderConfig, QueryOptions, StreamChunk, ChatMessage } from "./types.js";
import { AGENT_TOOLS, executeTool, type ToolResult } from "./tool-executor.js";

// Max tool call rounds to prevent infinite loops
const MAX_TOOL_ROUNDS = 10;

// Providers known to support function calling
const TOOL_CAPABLE_PROVIDERS = [
  "api.openai.com",
  "api.groq.com",
  "generativelanguage.googleapis.com",
  "openrouter.ai",
  "integrate.api.nvidia.com",
  "api.mistral.ai",
  "api.together.xyz",
  "api.fireworks.ai",
];

export class OpenAICompatibleProvider implements Provider {
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = {
      maxTokens: 4096,
      temperature: 0.7,
      supportsStreaming: true,
      supportsVision: false,
      supportsTools: false,
      ...config,
    };
  }

  /** Check if this provider's endpoint likely supports function calling */
  private supportsToolUse(): boolean {
    if (this.config.supportsTools) return true;
    const url = this.config.baseUrl || "";
    return TOOL_CAPABLE_PROVIDERS.some(p => url.includes(p));
  }

  async *query(options: QueryOptions): AsyncGenerator<StreamChunk> {
    const useTools = this.supportsToolUse();

    if (useTools) {
      // Tool-use loop: send messages, get response, execute tools, repeat
      yield* this.queryWithTools(options);
    } else {
      // Simple text-only query
      yield* this.querySimple(options);
    }
  }

  // ── Tool-Use Query Loop ─────────────────────────────────────────────────

  private async *queryWithTools(options: QueryOptions): AsyncGenerator<StreamChunk> {
    const messages = this.buildMessages(options);
    let accumulatedText = "";
    let totalCost = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Non-streaming request for tool use (streaming + tools is complex)
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
        tools: AGENT_TOOLS,
        tool_choice: "auto",
      };

      const headers = this.buildHeaders();
      const url = `${this.config.baseUrl}/chat/completions`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options.abortSignal,
        });
      } catch (err) {
        // If tool call fails, retry without tools
        if (round === 0) {
          yield* this.querySimple(options);
          return;
        }
        yield { type: "error", error: `Network error: ${err instanceof Error ? err.message : err}` };
        return;
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        // If 400/422 (tools not supported), fall back to simple
        if ((response.status === 400 || response.status === 422) && round === 0) {
          yield* this.querySimple(options);
          return;
        }
        yield { type: "error", error: `${this.config.name} error (${response.status}): ${errorBody}` };
        return;
      }

      const data = await response.json() as any;
      const choice = data.choices?.[0];
      if (!choice) {
        yield { type: "error", error: "No response from provider" };
        return;
      }

      const msg = choice.message;
      totalCost += this.estimateCostFromUsage(data.usage);

      // Check for tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Add assistant message with tool calls to history
        messages.push(msg);

        // Execute each tool call
        for (const toolCall of msg.tool_calls) {
          const fn = toolCall.function;
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(fn.arguments || "{}");
          } catch {
            args = {};
          }

          // Notify about tool use
          yield {
            type: "tool_use",
            toolName: fn.name,
            toolInput: JSON.stringify(args).substring(0, 200),
          };

          // Execute the tool
          const result = executeTool(fn.name, args, options.workingDir);

          // Notify about result
          yield {
            type: "tool_result",
            toolName: fn.name,
            text: result.result.substring(0, 200),
          };

          // Add tool result to conversation
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result.result,
          });
        }

        // Continue loop — let the model process tool results
        continue;
      }

      // No tool calls — this is the final text response
      if (msg.content) {
        accumulatedText += msg.content;
        yield { type: "text", text: accumulatedText };
      }

      yield { type: "done", text: accumulatedText, costUsd: totalCost };
      return;
    }

    // Max rounds reached
    if (accumulatedText) {
      yield { type: "done", text: accumulatedText, costUsd: totalCost };
    } else {
      yield { type: "error", error: "Max tool call rounds reached" };
    }
  }

  // ── Simple Text-Only Query ──────────────────────────────────────────────

  private async *querySimple(options: QueryOptions): AsyncGenerator<StreamChunk> {
    const messages = this.buildMessages(options);

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
    };

    const headers = this.buildHeaders();
    const url = `${this.config.baseUrl}/chat/completions`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "Unknown error");
        yield {
          type: "error",
          error: `${this.config.name} API error (${response.status}): ${errorBody}`,
        };
        return;
      }

      if (!response.body) {
        yield { type: "error", error: "No response body (streaming not supported?)" };
        return;
      }

      let accumulatedText = "";
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            yield { type: "done", text: accumulatedText };
            return;
          }

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;

            if (delta?.content) {
              accumulatedText += delta.content;
              yield { type: "text", text: accumulatedText, delta: delta.content };
            }

            if (json.choices?.[0]?.finish_reason) {
              yield {
                type: "done",
                text: accumulatedText,
                costUsd: this.estimateCost(accumulatedText),
              };
              return;
            }
          } catch {
            // Skip unparseable chunks
          }
        }
      }

      if (accumulatedText) {
        yield { type: "done", text: accumulatedText, costUsd: this.estimateCost(accumulatedText) };
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        yield { type: "error", error: "Request aborted" };
      } else {
        yield {
          type: "error",
          error: `${this.config.name} error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  // ── Provider Interface ──────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    if (this.config.baseUrl?.includes("localhost") || this.config.baseUrl?.includes("127.0.0.1")) {
      try {
        const res = await fetch(`${this.config.baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
      } catch {
        return false;
      }
    }
    return !!this.config.apiKey;
  }

  getInfo(): { name: string; model: string; status: string } {
    const tools = this.supportsToolUse() ? " 🔧" : "";
    return {
      name: this.config.name + tools,
      model: this.config.model,
      status: this.config.apiKey ? "✅ configured" : "❌ no API key",
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    if (this.config.baseUrl?.includes("openrouter.ai")) {
      headers["HTTP-Referer"] = "https://github.com/alevbln/mr-levin";
      headers["X-Title"] = "Mr. Levin";
    }
    return headers;
  }

  private buildMessages(options: QueryOptions): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];

    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }

    if (options.history && options.history.length > 0) {
      for (const msg of options.history) {
        if (this.config.supportsVision && msg.images && msg.images.length > 0) {
          const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
            { type: "text", text: msg.content },
          ];
          for (const img of msg.images) {
            content.push({
              type: "image_url",
              image_url: { url: img.startsWith("http") ? img : `data:image/jpeg;base64,${img}` },
            });
          }
          messages.push({ role: msg.role, content });
        } else {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    messages.push({ role: "user", content: options.prompt });
    return messages;
  }

  private estimateCost(text: string): number {
    const tokens = text.length / 4;
    const costs: Record<string, number> = {
      "gpt-4o": 0.01, "gpt-4o-mini": 0.0003,
      "gemini-2.5-pro": 0.005, "gemini-2.5-flash": 0.0005,
    };
    return (tokens / 1000) * (costs[this.config.model] || 0.001);
  }

  private estimateCostFromUsage(usage?: { prompt_tokens?: number; completion_tokens?: number }): number {
    if (!usage) return 0;
    const total = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    return (total / 1000) * 0.001; // rough estimate
  }
}
