/**
 * Gemini Memory Provider — Google's gemini-embedding-001 (3072-dim).
 *
 * Uses the public Generative Language API. Free tier limits: 100 RPM, 30k TPM,
 * 1500 RPD as of 2026-04. Batches up to 100 texts per request via
 * batchEmbedContents. RETRIEVAL_DOCUMENT for index, RETRIEVAL_QUERY for search.
 */

import { config } from "../../config.js";
import { VectorProviderBase } from "./vector-base.js";

const MODEL = "gemini-embedding-001";
const BATCH_SIZE = 100;

export class GeminiProvider extends VectorProviderBase {
  readonly name = MODEL;
  readonly dim = 3072;
  readonly tier = "vector-cloud" as const;

  async isAvailable(): Promise<boolean> {
    return Boolean(config.apiKeys.google);
  }

  protected async embed(texts: string[]): Promise<number[][]> {
    const apiKey = config.apiKeys.google;
    if (!apiKey) throw new Error("GOOGLE_API_KEY not configured");

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: batch.map(text => ({
              model: `models/${MODEL}`,
              content: { parts: [{ text }] },
              taskType: "RETRIEVAL_DOCUMENT",
            })),
          }),
        }
      );
      if (!res.ok) {
        throw new Error(`Gemini embeddings API error: ${res.status} — ${await res.text()}`);
      }
      const data = (await res.json()) as { embeddings: Array<{ values: number[] }> };
      for (const e of data.embeddings) out.push(e.values);
    }
    return out;
  }

  protected async embedQuery(text: string): Promise<number[]> {
    const apiKey = config.apiKeys.google;
    if (!apiKey) throw new Error("GOOGLE_API_KEY not configured");

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${MODEL}`,
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_QUERY",
        }),
      }
    );
    if (!res.ok) {
      throw new Error(`Gemini embeddings API error: ${res.status} — ${await res.text()}`);
    }
    const data = (await res.json()) as { embedding: { values: number[] } };
    return data.embedding.values;
  }
}
