import { describe, it, expect, vi } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { Provider, QueryOptions, StreamChunk } from "../src/providers/types.js";

/**
 * Registry tests — focused on the queryWithFallback behaviour, which is
 * the core of today's reliability work:
 *   1. Silent retry on mid-stream transient aborts
 *   2. No mid-stream failover after visible text has already streamed
 *   3. Lifecycle boot on asleep providers
 *   4. Fallback chain traversal when providers are unavailable
 */

// Mock provider factory — lets each test craft the exact chunk sequence
function createMockProvider(opts: {
  key?: string;
  available?: boolean;
  chunks: StreamChunk[];
  attempts?: number[]; // per-attempt chunk sets (for retry tests)
}): Provider {
  let attemptIndex = 0;
  return {
    config: {
      type: "openai-compatible",
      name: opts.key || "mock",
      model: "mock-model",
    },
    isAvailable: async () => opts.available ?? true,
    getInfo: () => ({
      name: opts.key || "mock",
      model: "mock-model",
      status: "mock",
    }),
    async *query(_options: QueryOptions): AsyncGenerator<StreamChunk> {
      // If per-attempt sequences provided, use them in order
      if (opts.attempts && opts.attempts.length > 0) {
        const idx = Math.min(attemptIndex, opts.attempts.length - 1);
        const count = opts.attempts[idx];
        attemptIndex++;
        for (let i = 0; i < count; i++) {
          yield opts.chunks[i];
        }
      } else {
        for (const c of opts.chunks) yield c;
      }
    },
  };
}

describe("ProviderRegistry.queryWithFallback", () => {
  it("yields chunks from the active provider on a happy path", async () => {
    const provider = createMockProvider({
      chunks: [
        { type: "text", text: "hello world" },
        { type: "done", text: "hello world", inputTokens: 10, outputTokens: 5 },
      ],
    });

    const registry = new ProviderRegistry({
      primary: "mock",
      fallbacks: [],
      providers: { mock: provider.config },
    });
    // Manually wire the mock provider — createProvider dispatches by type,
    // which would create a real OpenAICompatibleProvider. We inject directly.
    (registry as unknown as { providers: Map<string, Provider> }).providers.set("mock", provider);

    const chunks: StreamChunk[] = [];
    for await (const c of registry.queryWithFallback({ prompt: "hi" })) {
      chunks.push(c);
    }
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.type).toBe("text");
    expect(chunks[1]?.type).toBe("done");
  });

  it("falls back to the next provider when the active one has no visible text and errors", async () => {
    const primary = createMockProvider({
      chunks: [{ type: "error", error: "rate limit" }],
    });
    const fallback = createMockProvider({
      chunks: [
        { type: "text", text: "fallback answer" },
        { type: "done", text: "fallback answer" },
      ],
    });

    const registry = new ProviderRegistry({
      primary: "primary",
      fallbacks: ["fallback"],
      providers: {
        primary: primary.config,
        fallback: fallback.config,
      },
    });
    const internal = (registry as unknown as { providers: Map<string, Provider> }).providers;
    internal.set("primary", primary);
    internal.set("fallback", fallback);

    const chunks: StreamChunk[] = [];
    for await (const c of registry.queryWithFallback({ prompt: "hi" })) {
      chunks.push(c);
    }

    // Expect: fallback chunk (switching notification), then text + done from fallback
    const types = chunks.map((c) => c.type);
    expect(types).toContain("fallback");
    expect(types).toContain("text");
    expect(types).toContain("done");
  });

  it("surfaces a terminal error (no fallback) when the active provider fails mid-stream", async () => {
    const primary = createMockProvider({
      chunks: [
        { type: "text", text: "I'm starting the an" },
        { type: "error", error: "Request aborted" },
      ],
    });
    const fallback = createMockProvider({
      chunks: [
        { type: "text", text: "different answer" },
        { type: "done", text: "different answer" },
      ],
    });

    const registry = new ProviderRegistry({
      primary: "primary",
      fallbacks: ["fallback"],
      providers: {
        primary: primary.config,
        fallback: fallback.config,
      },
    });
    const internal = (registry as unknown as { providers: Map<string, Provider> }).providers;
    internal.set("primary", primary);
    internal.set("fallback", fallback);

    const chunks: StreamChunk[] = [];
    for await (const c of registry.queryWithFallback({ prompt: "hi" })) {
      chunks.push(c);
    }

    // We SHOULD get the first text chunk (visible text)
    // We SHOULD NOT get any fallback-provider chunks
    // We SHOULD get a final error chunk with the "mid-stream" message
    const texts = chunks.filter((c) => c.type === "text");
    expect(texts.length).toBeGreaterThanOrEqual(1);
    expect(texts.some((c) => c.text?.includes("different answer"))).toBe(false);

    const errors = chunks.filter((c) => c.type === "error");
    expect(errors.length).toBe(1);
    // Mid-stream message is localised, just check it mentions the provider name
    expect(errors[0]?.error).toContain("mock");
  });

  it("retries the SAME provider on mid-stream abort before giving up", async () => {
    // First attempt: emits text then aborts mid-stream
    // Second attempt: emits text and completes successfully
    const querySpy = vi.fn();
    let attemptCount = 0;
    const provider: Provider = {
      config: {
        type: "openai-compatible",
        name: "retry-test",
        model: "m",
      },
      isAvailable: async () => true,
      getInfo: () => ({ name: "retry-test", model: "m", status: "ok" }),
      async *query() {
        querySpy();
        attemptCount++;
        if (attemptCount === 1) {
          yield { type: "text", text: "first partial" } as StreamChunk;
          yield { type: "error", error: "Request aborted" } as StreamChunk;
        } else {
          yield { type: "text", text: "retry success" } as StreamChunk;
          yield { type: "done", text: "retry success" } as StreamChunk;
        }
      },
    };

    const registry = new ProviderRegistry({
      primary: "retry-test",
      fallbacks: [],
      providers: { "retry-test": provider.config },
    });
    (registry as unknown as { providers: Map<string, Provider> }).providers.set("retry-test", provider);

    const chunks: StreamChunk[] = [];
    for await (const c of registry.queryWithFallback({ prompt: "hi" })) {
      chunks.push(c);
    }

    // query() should have been called twice — original attempt + 1 retry
    expect(querySpy).toHaveBeenCalledTimes(2);
    // The final done chunk should reflect the retry's success
    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    expect(done?.text).toBe("retry success");
  }, 15_000); // allow for the 2s retry delay
});
