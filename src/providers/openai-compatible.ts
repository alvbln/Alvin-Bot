/**
 * OpenAI-Compatible Provider
 *
 * Works with: OpenAI, Gemini, NVIDIA NIM, Ollama, OpenRouter, LM Studio,
 * and any other endpoint that implements the OpenAI Chat Completions API.
 *
 * This single provider covers ~90% of all available models.
 */

import type { Provider, ProviderConfig, QueryOptions, StreamChunk, ChatMessage } from "./types.js";

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

  async *query(options: QueryOptions): AsyncGenerator<StreamChunk> {
    const messages = this.buildMessages(options);

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    // OpenRouter-specific headers
    if (this.config.baseUrl?.includes("openrouter.ai")) {
      headers["HTTP-Referer"] = "https://github.com/alevbln/mr-levin";
      headers["X-Title"] = "Mr. Levin";
    }

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
            yield {
              type: "done",
              text: accumulatedText,
            };
            return;
          }

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;

            if (delta?.content) {
              accumulatedText += delta.content;
              yield {
                type: "text",
                text: accumulatedText,
                delta: delta.content,
              };
            }

            // Check for finish reason
            if (json.choices?.[0]?.finish_reason) {
              yield {
                type: "done",
                text: accumulatedText,
                costUsd: this.estimateCost(accumulatedText),
              };
              return;
            }
          } catch {
            // Skip unparseable chunks (common with some providers)
          }
        }
      }

      // If we get here without a [DONE], still emit done
      if (accumulatedText) {
        yield {
          type: "done",
          text: accumulatedText,
          costUsd: this.estimateCost(accumulatedText),
        };
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

  async isAvailable(): Promise<boolean> {
    // Ollama/local: check if endpoint is reachable
    if (this.config.baseUrl?.includes("localhost") || this.config.baseUrl?.includes("127.0.0.1")) {
      try {
        const res = await fetch(`${this.config.baseUrl}/models`, {
          signal: AbortSignal.timeout(3000),
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    // Remote APIs: check if API key is set
    return !!this.config.apiKey;
  }

  getInfo(): { name: string; model: string; status: string } {
    return {
      name: this.config.name,
      model: this.config.model,
      status: this.config.apiKey ? "✅ configured" : "❌ no API key",
    };
  }

  // ── Private helpers ─────────────────────────────────

  private buildMessages(options: QueryOptions): Array<{ role: string; content: unknown }> {
    const messages: Array<{ role: string; content: unknown }> = [];

    // System prompt
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }

    // Conversation history
    if (options.history && options.history.length > 0) {
      for (const msg of options.history) {
        if (this.config.supportsVision && msg.images && msg.images.length > 0) {
          // Vision message with images
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

    // Current user message
    messages.push({ role: "user", content: options.prompt });

    return messages;
  }

  private estimateCost(text: string): number {
    // Very rough estimate — tokens ≈ chars / 4
    const estimatedTokens = text.length / 4;

    // Rough per-1K-token costs
    const costs: Record<string, number> = {
      "gpt-4o": 0.01,
      "gpt-4o-mini": 0.0003,
      "gemini-2.5-pro": 0.005,
      "gemini-2.5-flash": 0.0005,
    };

    const costPerK = costs[this.config.model] || 0.001;
    return (estimatedTokens / 1000) * costPerK;
  }
}
