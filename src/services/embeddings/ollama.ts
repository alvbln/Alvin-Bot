/**
 * Ollama Memory Provider — local, private, free embeddings via Ollama.
 *
 * Default model: nomic-embed-text (768-dim, ~270 MB pull).
 * Alternatives via OLLAMA_EMBEDDING_MODEL: mxbai-embed-large (1024-dim),
 * all-minilm (384-dim, fast), bge-large (1024-dim).
 *
 * Uses /api/embed (newer batched endpoint). Detects host via OLLAMA_HOST or
 * OLLAMA_BASE_URL env, defaults to http://localhost:11434.
 */

import { VectorProviderBase } from "./vector-base.js";

const DEFAULT_MODEL = "nomic-embed-text";
const DEFAULT_HOST = "http://localhost:11434";

// Hardcoded dims for common models — saves a probe call. Unknown models fall
// through to dynamic detection on first embed().
const KNOWN_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "bge-large": 1024,
  "bge-small-en-v1.5": 384,
  "snowflake-arctic-embed": 1024,
};

function ollamaHost(): string {
  return process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || DEFAULT_HOST;
}

function ollamaModel(): string {
  return process.env.OLLAMA_EMBEDDING_MODEL || DEFAULT_MODEL;
}

export class OllamaProvider extends VectorProviderBase {
  readonly name: string;
  readonly dim: number;
  readonly tier = "vector-local" as const;

  constructor() {
    super();
    const model = ollamaModel();
    // Strip any tag like `:latest` for the dim lookup.
    const baseModel = model.split(":")[0];
    this.name = `ollama:${model}`;
    this.dim = KNOWN_DIMS[baseModel] ?? 0; // 0 means "discover dynamically on first embed"
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${ollamaHost()}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const wanted = ollamaModel();
      const wantedBase = wanted.split(":")[0];
      // Match either the exact tag or the base name.
      return Boolean(
        data.models?.some(m => m.name === wanted || m.name.startsWith(`${wantedBase}:`))
      );
    } catch {
      return false;
    }
  }

  protected async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${ollamaHost()}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: ollamaModel(), input: texts }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embed error: ${res.status} — ${await res.text()}`);
    }
    const data = (await res.json()) as { embeddings: number[][] };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new Error(`Ollama embed returned ${data.embeddings?.length ?? 0} vectors, expected ${texts.length}`);
    }
    return data.embeddings;
  }

  protected async embedQuery(text: string): Promise<number[]> {
    const [v] = await this.embed([text]);
    return v;
  }
}
