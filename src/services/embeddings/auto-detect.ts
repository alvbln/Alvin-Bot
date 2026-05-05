/**
 * Provider auto-detection for the memory backend.
 *
 * Probes available providers in priority order and returns the first one that
 * is usable right now. The order is:
 *
 *   1. EMBEDDINGS_PROVIDER env override (gemini|openai|ollama|fts5) — explicit wins.
 *   2. Gemini  (free tier, 3072-dim) — when GOOGLE_API_KEY is set.
 *   3. OpenAI  (cheap, 1536-dim)     — when OPENAI_API_KEY is set.
 *   4. Ollama  (local, free, 768-dim default) — when /api/tags responds AND
 *               an embedding model is pulled. Many Ollama users only have chat
 *               models, so we don't auto-pull; we return false from isAvailable.
 *   5. FTS5    (always available)   — universal zero-config fallback.
 *
 * The facade calls this once per startup and caches the chosen provider for
 * the lifetime of the process. If the user changes EMBEDDINGS_PROVIDER or
 * adds a key, a restart picks up the new choice (and triggers a reindex via
 * schema-mismatch detection in the facade).
 */

import { GeminiProvider } from "./gemini.js";
import { OpenAIProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";
import { Fts5Provider } from "./fts5.js";
import type { MemoryProvider } from "./provider.js";

export type ProviderKey = "gemini" | "openai" | "ollama" | "fts5" | "auto";

export function parseProviderKey(raw: string | undefined | null): ProviderKey {
  const v = (raw ?? "").trim().toLowerCase();
  switch (v) {
    case "gemini":
    case "openai":
    case "ollama":
    case "fts5":
    case "auto":
      return v;
    default:
      return "auto";
  }
}

function instantiate(key: Exclude<ProviderKey, "auto">): MemoryProvider {
  switch (key) {
    case "gemini":
      return new GeminiProvider();
    case "openai":
      return new OpenAIProvider();
    case "ollama":
      return new OllamaProvider();
    case "fts5":
      return new Fts5Provider();
  }
}

/**
 * Pick the active provider. If override is given (and not "auto"), force it
 * regardless of availability — the facade still runs isAvailable() and
 * surfaces a clear error if the forced provider can't actually run.
 *
 * Otherwise probe in priority order until one succeeds. FTS5 is the universal
 * tail and always succeeds (assuming better-sqlite3 loaded).
 */
export async function detectProvider(override?: ProviderKey): Promise<MemoryProvider> {
  if (override && override !== "auto") {
    return instantiate(override);
  }

  const tryOrder: Array<Exclude<ProviderKey, "auto">> = ["gemini", "openai", "ollama", "fts5"];
  for (const key of tryOrder) {
    const p = instantiate(key);
    try {
      if (await p.isAvailable()) return p;
    } catch {
      // probe failure is non-fatal — try next
    }
  }
  // unreachable: fts5.isAvailable always returns true
  return new Fts5Provider();
}
