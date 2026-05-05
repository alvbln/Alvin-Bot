/**
 * Memory Provider interface — abstracts vector + keyword backends.
 *
 * The embeddings service supports four providers (Gemini, OpenAI, Ollama, FTS5)
 * behind a single facade. Vector providers (Gemini/OpenAI/Ollama) share an
 * `entries` table with a Float32 BLOB column. The FTS5 provider uses an
 * `entries_fts` virtual table for BM25 keyword ranking — no embeddings, no
 * keys, no API calls. Universal zero-config fallback.
 *
 * Common to all providers:
 *   meta(key, value)              — model name, dim, lastReindex, pending_reindex
 *   file_mtimes(source, mtime_ms) — staleness tracking
 *
 * Provider-owned tables:
 *   Vector providers → entries(id, source, text, vector BLOB, indexed_at)
 *   FTS5 provider    → entries_fts(text, source UNINDEXED, id UNINDEXED) VIRTUAL
 *
 * When the active provider changes (e.g. user adds GOOGLE_API_KEY), the facade
 * detects the schema mismatch via meta.embedding_model and triggers a clean
 * reindex against the new provider's schema.
 */

import type { Database } from "better-sqlite3";

export interface Chunk {
  /** Stable identifier — typically `${source}:${section}:${chunkIdx}` */
  id: string;
  /** Source file relative path (e.g. "MEMORY.md", "memory/2026-05-05.md") */
  source: string;
  /** The chunk's text content */
  text: string;
}

export interface SearchResult {
  text: string;
  source: string;
  /** Normalised relevance score in [0, 1]. Higher = more relevant. */
  score: number;
}

export interface MemoryProvider {
  /**
   * Stable identifier stored in meta.embedding_model.
   * Examples: "gemini-embedding-001", "openai-text-embedding-3-small",
   *           "ollama-nomic-embed-text", "fts5-bm25"
   */
  readonly name: string;

  /**
   * Vector dimension — 0 for keyword-only providers (FTS5).
   * Stored in meta.embedding_dim. Used for schema-mismatch detection.
   */
  readonly dim: number;

  /** Human-friendly tier label for logs / doctor output. */
  readonly tier: "vector-cloud" | "vector-local" | "keyword-local";

  /**
   * Pre-flight check: is this provider usable right now?
   * - Vector cloud providers: API key set (no actual network call).
   * - Ollama: HEAD localhost:11434/api/tags + check model is pulled.
   * - FTS5: always true (only depends on better-sqlite3 being loaded).
   */
  isAvailable(): Promise<boolean>;

  /**
   * Initialise this provider's tables in the DB. Idempotent.
   * Called once when this provider becomes active.
   */
  initSchema(db: Database): void;

  /**
   * Drop this provider's tables. Called when switching to a different provider.
   * Must NOT drop shared tables (meta, file_mtimes).
   */
  dropSchema(db: Database): void;

  /**
   * Index a batch of chunks. May call out to embedding APIs (vector providers)
   * or just write text rows (FTS5). Implementations should be transactional.
   */
  indexChunks(db: Database, chunks: Chunk[]): Promise<void>;

  /**
   * Delete all entries for the given source paths. Used before re-indexing
   * stale files.
   */
  dropEntriesForSources(db: Database, sources: string[]): void;

  /**
   * Search for chunks relevant to the query. Returns top-K with score >= minScore.
   *
   * minScore semantics:
   * - Vector providers: cosine similarity in [-1, 1], typically [0, 1] for
   *   normalised embeddings. Default minScore around 0.3-0.35.
   * - FTS5: BM25 distance is unbounded, lower = better in raw form. The
   *   provider normalises into [0, 1] before applying minScore. Default
   *   minScore should still be ~0.3 for parity.
   */
  search(db: Database, query: string, topK: number, minScore: number): Promise<SearchResult[]>;

  /** Count entries currently indexed by this provider. */
  countEntries(db: Database): number;
}
