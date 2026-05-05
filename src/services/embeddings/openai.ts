/**
 * OpenAI Memory Provider — text-embedding-3-small (1536-dim, $0.02/1M tokens).
 *
 * Most public users already have OPENAI_API_KEY set for the LLM, so this is a
 * near-zero-friction upgrade from FTS5. Reasonably priced even at heavy use.
 */

import { config } from "../../config.js";
import { VectorProviderBase } from "./vector-base.js";

const MODEL = "text-embedding-3-small";
const DIM = 1536;
const BATCH_SIZE = 100;

export class OpenAIProvider extends VectorProviderBase {
  readonly name = MODEL;
  readonly dim = DIM;
  readonly tier = "vector-cloud" as const;

  async isAvailable(): Promise<boolean> {
    return Boolean(config.apiKeys.openai);
  }

  protected async embed(texts: string[]): Promise<number[][]> {
    const apiKey = config.apiKeys.openai;
    if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: MODEL, input: batch }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI embeddings API error: ${res.status} — ${await res.text()}`);
      }
      const data = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
      // Sort by index to keep order stable across the batch.
      data.data.sort((a, b) => a.index - b.index);
      for (const e of data.data) out.push(e.embedding);
    }
    return out;
  }

  protected async embedQuery(text: string): Promise<number[]> {
    const [v] = await this.embed([text]);
    return v;
  }
}
