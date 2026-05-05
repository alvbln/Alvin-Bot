/**
 * FTS5 Memory Provider — zero-config keyword search via SQLite full-text.
 *
 * No API keys, no network, no embeddings. Indexes chunk text into an FTS5
 * virtual table and ranks matches via BM25. Universal fallback when the user
 * has no Gemini / OpenAI / Ollama configured. Excellent for proper-noun and
 * exact-term lookups (project names, commands, error messages); weaker than
 * vector search for synonyms and conceptual paraphrase queries.
 *
 * Schema:
 *   entries_fts (id UNINDEXED, source UNINDEXED, text)
 *   tokenizer: unicode61 with diacritic stripping (works for de/en mixed memory).
 *
 * Score normalisation: SQLite's bm25() returns negative numbers (more negative
 * = more relevant). We map to [0, 1] via 1 / (1 + |bm25|) so callers can use
 * the same minScore semantics as vector providers.
 */

import type { Database } from "better-sqlite3";
import type { Chunk, MemoryProvider, SearchResult } from "./provider.js";

const TABLE = "entries_fts";

/** FTS5 has reserved characters/operators in MATCH queries. Sanitize to plain
 *  word-OR by extracting alphanumeric tokens and quoting each as a phrase. */
function sanitizeQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[\s\W]+/u)
    .filter(t => t.length >= 2 && t.length <= 64);
  if (tokens.length === 0) return "";
  // Each token wrapped in double quotes makes it a literal phrase, immune to
  // FTS5 operator characters (NEAR, AND, OR, NOT, *, etc.). Joined with OR.
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export class Fts5Provider implements MemoryProvider {
  readonly name = "fts5-bm25";
  readonly dim = 0;
  readonly tier = "keyword-local" as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  initSchema(db: Database): void {
    // FTS5 doesn't allow secondary indexes on the virtual table itself;
    // source filtering happens via WHERE clauses on the UNINDEXED column,
    // which is fast enough at our corpus size (<100k chunks).
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING fts5(
        id UNINDEXED,
        source UNINDEXED,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  }

  dropSchema(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS ${TABLE};`);
  }

  async indexChunks(db: Database, chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const ins = db.prepare(`INSERT INTO ${TABLE} (id, source, text) VALUES (?, ?, ?)`);
    const writeAll = db.transaction((rows: Chunk[]) => {
      for (const c of rows) ins.run(c.id, c.source, c.text);
    });
    writeAll(chunks);
  }

  dropEntriesForSources(db: Database, sources: string[]): void {
    if (sources.length === 0) return;
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE source = ?`);
    const dropAll = db.transaction((srcs: string[]) => {
      for (const s of srcs) del.run(s);
    });
    dropAll(sources);
  }

  async search(db: Database, query: string, topK: number, minScore: number): Promise<SearchResult[]> {
    const matchExpr = sanitizeQuery(query);
    if (!matchExpr) return [];

    let rows: Array<{ source: string; text: string; bm25: number }>;
    try {
      rows = db
        .prepare(
          `SELECT source, text, bm25(${TABLE}) AS bm25 FROM ${TABLE} WHERE ${TABLE} MATCH ? ORDER BY bm25(${TABLE}) LIMIT ?`
        )
        .all(matchExpr, topK * 3) as Array<{ source: string; text: string; bm25: number }>;
    } catch {
      // FTS5 MATCH parse errors (e.g. exotic Unicode) → return empty.
      return [];
    }

    const results: SearchResult[] = rows
      .map(r => ({
        text: r.text,
        source: r.source,
        score: 1 / (1 + Math.abs(r.bm25)),
      }))
      .filter(r => r.score >= minScore)
      .slice(0, topK);

    return results;
  }

  countEntries(db: Database): number {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE}`).get() as { c: number } | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }
}
