/**
 * Embeddings Service — Vector-based semantic memory search.
 *
 * Uses Google's gemini-embedding-001 model for generating embeddings.
 * Stores embeddings in a SQLite database (.embeddings.db) — replaces the
 * older .embeddings.json index since v4.20. The migration runs once
 * automatically on startup (see src/migrate.ts).
 *
 * Architecture:
 * - Each memory entry (paragraph/section) gets a 3072-dim Float32 vector.
 * - Vectors are stored as raw BLOB (4 bytes × 3072 = 12 KB each) instead of
 *   JSON-encoded Float64 arrays (~24 KB each) — halves disk footprint.
 * - Cosine similarity runs in-memory: SQLite has no native vector ops, but
 *   reading the BLOBs is mmap-cheap and JS does the dot product fast enough
 *   for the current corpus (a few thousand entries).
 * - Reindexing is per-chunk INSERT/UPDATE — no full-file rewrite.
 */

import fs from "fs";
import path from "path";
import { resolve } from "path";
import os from "os";
import Database, { type Database as Db } from "better-sqlite3";
import { config } from "../config.js";
import { MEMORY_DIR, MEMORY_FILE, EMBEDDINGS_DB } from "../paths.js";
import { ASSETS_DIR, ASSETS_INDEX_MD } from "../paths.js";

// Hub memory directory (Claude Hub — read-only, additional context)
const HUB_MEMORY_DIR = resolve(os.homedir(), ".claude", "hub", "MEMORY");

// ── Types ───────────────────────────────────────────────

export interface SearchResult {
  /** The matched text */
  text: string;
  /** Source file */
  source: string;
  /** Cosine similarity score (0-1) */
  score: number;
}

interface ChunkRow {
  id: string;
  source: string;
  text: string;
  vector: Buffer;
}

// ── Constants ───────────────────────────────────────────

const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSION = 3072;
const SCHEMA_VERSION = "1";

// ── Vector encoding (Float32Array ↔ Buffer) ─────────────

function vectorToBlob(v: number[]): Buffer {
  const f32 = new Float32Array(v);
  // Buffer.from(arrayBuffer, byteOffset, length) preserves the underlying memory.
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function blobToVector(b: Buffer): Float32Array {
  // Buffers from better-sqlite3 own their memory and may not be aligned to 4 bytes.
  // Copying into a fresh Float32Array guarantees alignment.
  const f32 = new Float32Array(b.byteLength / 4);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < f32.length; i++) {
    f32[i] = dv.getFloat32(i * 4, true /* little-endian */);
  }
  return f32;
}

// ── DB lifecycle ────────────────────────────────────────

let dbInstance: Db | null = null;

function db(): Db {
  if (dbInstance) return dbInstance;

  // Ensure directory exists (handles fresh installs).
  fs.mkdirSync(path.dirname(EMBEDDINGS_DB), { recursive: true });

  dbInstance = new Database(EMBEDDINGS_DB);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("synchronous = NORMAL");
  dbInstance.pragma("temp_store = MEMORY");
  dbInstance.pragma("mmap_size = 268435456"); // 256 MB

  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_mtimes (
      source   TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entries (
      id         TEXT PRIMARY KEY,
      source     TEXT NOT NULL,
      text       TEXT NOT NULL,
      vector     BLOB NOT NULL,
      indexed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
  `);

  // Initialise meta if absent.
  const set = dbInstance.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING"
  );
  set.run("model", EMBEDDING_MODEL);
  set.run("schemaVersion", SCHEMA_VERSION);

  return dbInstance;
}

/** Close handle (used by tests / shutdown). */
export function closeEmbeddingsDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// ── Meta helpers ────────────────────────────────────────

function getMeta(key: string): string | null {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setMeta(key: string, value: string): void {
  db()
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}

function getFileMtimes(): Record<string, number> {
  const rows = db().prepare("SELECT source, mtime_ms FROM file_mtimes").all() as Array<{
    source: string;
    mtime_ms: number;
  }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.source] = r.mtime_ms;
  return out;
}

function setFileMtime(source: string, mtimeMs: number): void {
  db()
    .prepare(
      "INSERT INTO file_mtimes (source, mtime_ms) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET mtime_ms = excluded.mtime_ms"
    )
    .run(source, mtimeMs);
}

// ── Google Embeddings API ───────────────────────────────

async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = config.apiKeys.google;
  if (!apiKey) {
    throw new Error("Google API key not configured. Set GOOGLE_API_KEY in .env");
  }

  const results: number[][] = [];
  const batchSize = 100;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: batch.map(text => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
            taskType: "RETRIEVAL_DOCUMENT",
          })),
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Embedding API error: ${response.status} — ${err}`);
    }

    const data = (await response.json()) as { embeddings: Array<{ values: number[] }> };
    for (const emb of data.embeddings) {
      results.push(emb.values);
    }
  }

  return results;
}

async function getQueryEmbedding(text: string): Promise<number[]> {
  const apiKey = config.apiKeys.google;
  if (!apiKey) {
    throw new Error("Google API key not configured");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_QUERY",
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Embedding API error: ${response.status} — ${err}`);
  }

  const data = (await response.json()) as { embedding: { values: number[] } };
  return data.embedding.values;
}

// ── Vector Math ─────────────────────────────────────────

function cosineSimilarityF32(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// ── Text Chunking ───────────────────────────────────────

function chunkMarkdown(content: string, source: string): Array<{ id: string; text: string }> {
  const chunks: Array<{ id: string; text: string }> = [];
  const sections = content.split(/^(?=## )/gm);

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i].trim();
    if (!section || section.length < 20) continue;

    if (section.length > 1000) {
      const paragraphs = section.split(/\n\n+/);
      let currentChunk = "";
      let chunkIdx = 0;

      for (const para of paragraphs) {
        if (currentChunk.length + para.length > 800 && currentChunk.length > 100) {
          chunks.push({
            id: `${source}:${i}:${chunkIdx}`,
            text: currentChunk.trim(),
          });
          currentChunk = "";
          chunkIdx++;
        }
        currentChunk += para + "\n\n";
      }
      if (currentChunk.trim().length > 20) {
        chunks.push({
          id: `${source}:${i}:${chunkIdx}`,
          text: currentChunk.trim(),
        });
      }
    } else {
      chunks.push({
        id: `${source}:${i}`,
        text: section,
      });
    }
  }

  return chunks;
}

// ── Indexable file discovery ────────────────────────────

function walkAssetDir(dir: string): Array<{ name: string; path: string }> {
  const results: Array<{ name: string; path: string }> = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (currentDir === dir && (entry.name === "INDEX.json" || entry.name === "INDEX.md")) continue;
        results.push({ name: entry.name, path: fullPath });
      }
    }
  }

  walk(dir);
  return results;
}

const TEXT_EXTENSIONS = new Set([".md", ".html", ".txt", ".css", ".ts"]);

function getIndexableFiles(): Array<{ path: string; relativePath: string }> {
  const files: Array<{ path: string; relativePath: string }> = [];

  if (fs.existsSync(MEMORY_FILE)) {
    files.push({ path: MEMORY_FILE, relativePath: "MEMORY.md" });
  }

  if (fs.existsSync(MEMORY_DIR)) {
    const entries = fs.readdirSync(MEMORY_DIR);
    for (const entry of entries) {
      if (entry.endsWith(".md") && !entry.startsWith(".")) {
        files.push({
          path: resolve(MEMORY_DIR, entry),
          relativePath: `memory/${entry}`,
        });
      }
    }
  }

  if (fs.existsSync(HUB_MEMORY_DIR)) {
    try {
      const entries = fs.readdirSync(HUB_MEMORY_DIR);
      for (const entry of entries) {
        if (entry.endsWith(".md") && !entry.startsWith(".")) {
          files.push({
            path: resolve(HUB_MEMORY_DIR, entry),
            relativePath: `hub/${entry}`,
          });
        }
      }
    } catch {
      /* Hub not available — skip */
    }
  }

  if (fs.existsSync(ASSETS_INDEX_MD)) {
    files.push({ path: ASSETS_INDEX_MD, relativePath: "assets/INDEX.md" });
  }

  if (fs.existsSync(ASSETS_DIR)) {
    for (const entry of walkAssetDir(ASSETS_DIR)) {
      if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
        files.push({
          path: entry.path,
          relativePath: `assets/${path.relative(ASSETS_DIR, entry.path)}`,
        });
      }
    }
  }

  return files;
}

function getStaleFiles(): Array<{ path: string; relativePath: string }> {
  const allFiles = getIndexableFiles();
  const known = getFileMtimes();
  const stale: typeof allFiles = [];

  for (const file of allFiles) {
    try {
      const mtime = fs.statSync(file.path).mtimeMs;
      if (!known[file.relativePath] || known[file.relativePath] < mtime) {
        stale.push(file);
      }
    } catch {
      /* file disappeared */
    }
  }
  return stale;
}

// ── Public API ──────────────────────────────────────────

export async function reindexMemory(force = false): Promise<{ indexed: number; total: number }> {
  const filesToIndex = force ? getIndexableFiles() : getStaleFiles();

  if (filesToIndex.length === 0) {
    const total = (db().prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number }).c;
    return { indexed: 0, total };
  }

  // Drop existing entries for files being reindexed (per-source DELETE is O(log n) thanks to idx).
  const delStmt = db().prepare("DELETE FROM entries WHERE source = ?");
  const dropOld = db().transaction((sources: string[]) => {
    for (const s of sources) delStmt.run(s);
  });
  dropOld(filesToIndex.map(f => f.relativePath));

  // Chunk all files.
  const allChunks: Array<{ id: string; text: string; source: string; mtime: number }> = [];
  for (const file of filesToIndex) {
    try {
      const content = fs.readFileSync(file.path, "utf-8");
      const chunks = chunkMarkdown(content, file.relativePath);
      const mtime = fs.statSync(file.path).mtimeMs;
      for (const chunk of chunks) {
        allChunks.push({ ...chunk, source: file.relativePath, mtime });
      }
    } catch (err) {
      console.error(`Failed to chunk ${file.relativePath}:`, err);
    }
  }

  if (allChunks.length === 0) {
    // Even with zero chunks, keep mtimes in sync so we don't re-walk on next run.
    const updMtime = db().transaction((files: Array<{ relativePath: string; path: string }>) => {
      for (const f of files) {
        try {
          setFileMtime(f.relativePath, fs.statSync(f.path).mtimeMs);
        } catch {
          /* file disappeared */
        }
      }
    });
    updMtime(filesToIndex);
    const total = (db().prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number }).c;
    return { indexed: 0, total };
  }

  // Get embeddings for all chunks (network).
  const texts = allChunks.map(c => c.text);
  const vectors = await getEmbeddings(texts);

  // Single transaction for all writes.
  const insertStmt = db().prepare(
    "INSERT INTO entries (id, source, text, vector, indexed_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET source=excluded.source, text=excluded.text, vector=excluded.vector, indexed_at=excluded.indexed_at"
  );
  const writeAll = db().transaction((rows: Array<{ id: string; source: string; text: string; vector: Buffer; indexedAt: number }>) => {
    for (const r of rows) {
      insertStmt.run(r.id, r.source, r.text, r.vector, r.indexedAt);
    }
  });
  const now = Date.now();
  writeAll(
    allChunks.map((c, i) => ({
      id: c.id,
      source: c.source,
      text: c.text,
      vector: vectorToBlob(vectors[i]),
      indexedAt: now,
    }))
  );

  // Update mtimes for the files we just (re-)indexed.
  const updMtime = db().transaction((files: typeof filesToIndex) => {
    for (const f of files) {
      try {
        setFileMtime(f.relativePath, fs.statSync(f.path).mtimeMs);
      } catch {
        /* file disappeared */
      }
    }
  });
  updMtime(filesToIndex);

  setMeta("lastReindex", String(now));

  const total = (db().prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number }).c;
  return { indexed: allChunks.length, total };
}

export async function searchMemory(query: string, topK = 5, minScore = 0.3): Promise<SearchResult[]> {
  // Auto-index if empty.
  const total = (db().prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number }).c;
  if (total === 0) {
    await reindexMemory();
    const after = (db().prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number }).c;
    if (after === 0) return [];
  }

  const queryVector = Float32Array.from(await getQueryEmbedding(query));

  const rows = db().prepare("SELECT id, source, text, vector FROM entries").all() as ChunkRow[];

  const scored: SearchResult[] = [];
  for (const row of rows) {
    const v = blobToVector(row.vector);
    const score = cosineSimilarityF32(queryVector, v);
    if (score >= minScore) {
      scored.push({ text: row.text, source: row.source, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export async function initEmbeddings(): Promise<void> {
  try {
    db(); // Open & migrate schema.
    const stale = getStaleFiles();
    if (stale.length === 0) {
      const total = (db().prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number }).c;
      if (total > 0) return;
    }
    const result = await reindexMemory();
    if (result.indexed > 0) {
      console.log(`🔍 Embeddings: indexed ${result.indexed} chunks (${result.total} total)`);
    }
  } catch (err) {
    console.warn("⚠️ Embeddings init failed:", err instanceof Error ? err.message : err);
  }
}

export function getIndexStats(): { entries: number; files: number; lastReindex: number; sizeBytes: number } {
  let entries = 0;
  let files = 0;
  let lastReindex = 0;
  let sizeBytes = 0;
  try {
    entries = (db().prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number }).c;
    files = (db().prepare("SELECT COUNT(*) AS c FROM file_mtimes").get() as { c: number }).c;
    const meta = getMeta("lastReindex");
    if (meta) lastReindex = Number(meta);
    sizeBytes = fs.statSync(EMBEDDINGS_DB).size;
  } catch {
    /* DB not yet initialised */
  }
  return { entries, files, lastReindex, sizeBytes };
}

// ── Re-export embedding dim for tests / debugging ──────

export { EMBEDDING_DIMENSION, EMBEDDING_MODEL };
