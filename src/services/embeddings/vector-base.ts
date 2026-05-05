/**
 * Shared base for vector-based providers (Gemini, OpenAI, Ollama).
 *
 * Owns the `entries` table schema, vector BLOB encoding, cosine-similarity
 * search, and transactional indexing. Subclasses implement only the embedding
 * API calls (embed for documents, embedQuery for the search query).
 *
 * Vectors are stored as Float32 BLOBs (4 bytes per dim). For a 1536-dim model
 * that's 6 KB per chunk; 3072-dim is 12 KB. Reading is mmap-cheap; cosine sim
 * runs in JS over the in-memory result set — fast enough for tens of thousands
 * of chunks.
 */

import type { Database } from "better-sqlite3";
import type { Chunk, MemoryProvider, SearchResult } from "./provider.js";

interface ChunkRow {
  source: string;
  text: string;
  vector: Buffer;
}

function vectorToBlob(v: number[]): Buffer {
  const f32 = new Float32Array(v);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function blobToVector(b: Buffer): Float32Array {
  // better-sqlite3 buffers may be unaligned; copy via DataView guarantees alignment.
  const f32 = new Float32Array(b.byteLength / 4);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < f32.length; i++) {
    f32[i] = dv.getFloat32(i * 4, true);
  }
  return f32;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export abstract class VectorProviderBase implements MemoryProvider {
  abstract readonly name: string;
  abstract readonly dim: number;
  abstract readonly tier: "vector-cloud" | "vector-local" | "keyword-local";

  abstract isAvailable(): Promise<boolean>;

  /** Embed a batch of documents (RETRIEVAL_DOCUMENT semantics where applicable). */
  protected abstract embed(texts: string[]): Promise<number[][]>;

  /** Embed a single search query (RETRIEVAL_QUERY semantics where applicable). */
  protected abstract embedQuery(text: string): Promise<number[]>;

  initSchema(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id         TEXT PRIMARY KEY,
        source     TEXT NOT NULL,
        text       TEXT NOT NULL,
        vector     BLOB NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
    `);
  }

  dropSchema(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS entries;`);
  }

  async indexChunks(db: Database, chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const vectors = await this.embed(chunks.map(c => c.text));
    if (vectors.length !== chunks.length) {
      throw new Error(
        `Embedding count mismatch: requested ${chunks.length}, got ${vectors.length}`
      );
    }

    const insertStmt = db.prepare(
      "INSERT INTO entries (id, source, text, vector, indexed_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET source=excluded.source, text=excluded.text, " +
        "vector=excluded.vector, indexed_at=excluded.indexed_at"
    );
    const now = Date.now();
    const writeAll = db.transaction(
      (rows: Array<{ id: string; source: string; text: string; vector: Buffer }>) => {
        for (const r of rows) insertStmt.run(r.id, r.source, r.text, r.vector, now);
      }
    );
    writeAll(
      chunks.map((c, i) => ({
        id: c.id,
        source: c.source,
        text: c.text,
        vector: vectorToBlob(vectors[i]),
      }))
    );
  }

  dropEntriesForSources(db: Database, sources: string[]): void {
    if (sources.length === 0) return;
    const del = db.prepare("DELETE FROM entries WHERE source = ?");
    const dropAll = db.transaction((srcs: string[]) => {
      for (const s of srcs) del.run(s);
    });
    dropAll(sources);
  }

  async search(
    db: Database,
    query: string,
    topK: number,
    minScore: number
  ): Promise<SearchResult[]> {
    const qv = Float32Array.from(await this.embedQuery(query));

    const rows = db
      .prepare("SELECT source, text, vector FROM entries")
      .all() as ChunkRow[];

    const scored: SearchResult[] = [];
    for (const row of rows) {
      const v = blobToVector(row.vector);
      const score = cosineSimilarity(qv, v);
      if (score >= minScore) {
        scored.push({ text: row.text, source: row.source, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  countEntries(db: Database): number {
    try {
      const row = db.prepare("SELECT COUNT(*) AS c FROM entries").get() as
        | { c: number }
        | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }
}
