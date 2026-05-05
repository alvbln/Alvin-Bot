/**
 * Embeddings Facade — provider-agnostic memory search.
 *
 * Manages the SQLite DB, picks an active provider via auto-detect, handles
 * schema migrations on provider switch, and exposes the legacy public API
 * (initEmbeddings, searchMemory, reindexMemory, getIndexStats) so callers
 * outside this module don't need to know which backend is running.
 *
 * Provider tiers (auto-detected in this order, override via EMBEDDINGS_PROVIDER):
 *   1. Gemini   (3072-dim, GOOGLE_API_KEY)        — free tier
 *   2. OpenAI   (1536-dim, OPENAI_API_KEY)        — ~$0.02/1M tokens
 *   3. Ollama   (768-dim default, local)          — free, private
 *   4. FTS5     (BM25 keyword, no key needed)     — universal fallback
 *
 * Schema-mismatch handling: when meta.embedding_model differs from the active
 * provider's name (e.g. user added GOOGLE_API_KEY after running on FTS5), we
 * drop the previous provider's tables, clear file_mtimes, and initialise the
 * new provider's schema. The next reindexMemory() call repopulates everything
 * from disk. This is what makes the "user adds key later" flow seamless.
 */

import fs from "fs";
import path from "path";
import { resolve } from "path";
import os from "os";
import { createRequire } from "module";
import { MEMORY_DIR, MEMORY_FILE, EMBEDDINGS_DB } from "../../paths.js";
import { ASSETS_DIR, ASSETS_INDEX_MD } from "../../paths.js";
import { detectProvider, parseProviderKey } from "./auto-detect.js";
import type { Chunk, MemoryProvider, SearchResult } from "./provider.js";

// ── better-sqlite3 lazy load ────────────────────────────

type SqliteCtor = typeof import("better-sqlite3");
type SqliteDb = import("better-sqlite3").Database;

let SqliteClass: SqliteCtor | null = null;
let sqliteLoadAttempted = false;
let sqliteLoadError: Error | null = null;
const cjsRequire = createRequire(import.meta.url);

function loadSqlite(): SqliteCtor | null {
  if (sqliteLoadAttempted) return SqliteClass;
  sqliteLoadAttempted = true;
  try {
    SqliteClass = cjsRequire("better-sqlite3") as SqliteCtor;
    return SqliteClass;
  } catch (err) {
    sqliteLoadError = err instanceof Error ? err : new Error(String(err));
    console.warn(
      "⚠️ better-sqlite3 native binary unavailable — embeddings disabled. " +
        "Bot continues without semantic memory search. Fix: rebuild deps with " +
        "`cd $(npm root -g)/alvin-bot && npm rebuild better-sqlite3` or reinstall " +
        "alvin-bot. Underlying error: " +
        sqliteLoadError.message
    );
    return null;
  }
}

// ── State ────────────────────────────────────────────────

const HUB_MEMORY_DIR = resolve(os.homedir(), ".claude", "hub", "MEMORY");
const SCHEMA_VERSION = "2"; // bumped from 1 when introducing multi-provider

let dbInstance: SqliteDb | null = null;
let activeProvider: MemoryProvider | null = null;
let initialised = false;
let initInFlight: Promise<void> | null = null;

// ── DB lifecycle ────────────────────────────────────────

function openDb(): SqliteDb | null {
  if (dbInstance) return dbInstance;
  const Database = loadSqlite();
  if (!Database) return null;

  fs.mkdirSync(path.dirname(EMBEDDINGS_DB), { recursive: true });
  dbInstance = new Database(EMBEDDINGS_DB);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("synchronous = NORMAL");
  dbInstance.pragma("temp_store = MEMORY");
  dbInstance.pragma("mmap_size = 268435456"); // 256 MB

  // Shared tables — owned by the facade, not by any single provider.
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_mtimes (
      source   TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL
    );
  `);
  return dbInstance;
}

export function closeEmbeddingsDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  activeProvider = null;
  initialised = false;
  initInFlight = null;
}

// ── Meta helpers ────────────────────────────────────────

function getMeta(db: SqliteDb, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setMeta(db: SqliteDb, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

function clearAllProviderSchemas(db: SqliteDb): void {
  // Drop both possible provider-owned tables. Defensive — covers any past
  // schema regardless of which provider wrote it.
  db.exec("DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS entries_fts;");
  db.exec("DELETE FROM file_mtimes;");
}

// ── File mtime tracking ─────────────────────────────────

function getFileMtimes(db: SqliteDb): Record<string, number> {
  const rows = db.prepare("SELECT source, mtime_ms FROM file_mtimes").all() as Array<{
    source: string;
    mtime_ms: number;
  }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.source] = r.mtime_ms;
  return out;
}

function setFileMtime(db: SqliteDb, source: string, mtimeMs: number): void {
  db.prepare(
    "INSERT INTO file_mtimes (source, mtime_ms) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET mtime_ms = excluded.mtime_ms"
  ).run(source, mtimeMs);
}

// ── File discovery ──────────────────────────────────────

const TEXT_EXTENSIONS = new Set([".md", ".html", ".txt", ".css", ".ts"]);

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
      /* hub dir not available */
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

function getStaleFiles(db: SqliteDb): Array<{ path: string; relativePath: string }> {
  const all = getIndexableFiles();
  const known = getFileMtimes(db);
  const stale: typeof all = [];
  for (const f of all) {
    try {
      const mtime = fs.statSync(f.path).mtimeMs;
      if (!known[f.relativePath] || known[f.relativePath] < mtime) {
        stale.push(f);
      }
    } catch {
      /* file disappeared */
    }
  }
  return stale;
}

// ── Chunking ────────────────────────────────────────────

function chunkMarkdown(content: string, source: string): Chunk[] {
  const chunks: Chunk[] = [];
  const sections = content.split(/^(?=## )/gm);
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i].trim();
    if (!section || section.length < 20) continue;
    if (section.length > 1000) {
      const paragraphs = section.split(/\n\n+/);
      let cur = "";
      let chunkIdx = 0;
      for (const p of paragraphs) {
        if (cur.length + p.length > 800 && cur.length > 100) {
          chunks.push({ id: `${source}:${i}:${chunkIdx}`, source, text: cur.trim() });
          cur = "";
          chunkIdx++;
        }
        cur += p + "\n\n";
      }
      if (cur.trim().length > 20) {
        chunks.push({ id: `${source}:${i}:${chunkIdx}`, source, text: cur.trim() });
      }
    } else {
      chunks.push({ id: `${source}:${i}`, source, text: section });
    }
  }
  return chunks;
}

// ── Provider sync ───────────────────────────────────────

/**
 * Ensure the DB schema matches the active provider. If the stored model name
 * differs from the active provider's, wipe provider-owned tables + file_mtimes
 * so the next reindex repopulates from disk against the new schema. Idempotent.
 */
function syncProviderSchema(db: SqliteDb, provider: MemoryProvider): { switched: boolean; previous: string | null } {
  // Legacy v4.20 DBs only have meta.model (set by embeddings-migration.ts).
  // Treat that as the previous embedding_model so we don't accidentally
  // wipe a 49 MB vector store just because the meta key was renamed.
  const storedModel = getMeta(db, "embedding_model") ?? getMeta(db, "model");

  // Schema mismatch is detected by provider-name change ONLY. Bumping
  // SCHEMA_VERSION alone must NOT trigger a drop — vector providers (Gemini,
  // OpenAI, Ollama) all share the same `entries` table layout, so a refactor
  // version bump shouldn't cost users a full re-embed against the API.
  const switched = storedModel !== null && storedModel !== provider.name;

  if (switched) {
    clearAllProviderSchemas(db);
  }

  // Initialise the active provider's schema (idempotent — IF NOT EXISTS guards).
  provider.initSchema(db);

  setMeta(db, "embedding_model", provider.name);
  setMeta(db, "embedding_dim", String(provider.dim));
  setMeta(db, "embedding_tier", provider.tier);
  setMeta(db, "schemaVersion", SCHEMA_VERSION);

  return { switched, previous: storedModel };
}

// ── Internal init ───────────────────────────────────────

async function ensureInit(): Promise<{ db: SqliteDb; provider: MemoryProvider } | null> {
  if (initialised && dbInstance && activeProvider) {
    return { db: dbInstance, provider: activeProvider };
  }
  if (initInFlight) {
    await initInFlight;
    return initialised && dbInstance && activeProvider
      ? { db: dbInstance, provider: activeProvider }
      : null;
  }

  initInFlight = (async () => {
    const db = openDb();
    if (!db) return; // sqlite unavailable — leave initialised=false

    const overrideKey = parseProviderKey(process.env.EMBEDDINGS_PROVIDER);
    const provider = await detectProvider(overrideKey);
    const sync = syncProviderSchema(db, provider);

    if (sync.switched) {
      console.log(
        `ℹ️ Memory provider changed: ${sync.previous ?? "none"} → ${provider.name} (${provider.tier}). Reindex on next access.`
      );
    } else {
      // Quiet info log on first startup of a new install.
      const total = provider.countEntries(db);
      if (total === 0) {
        console.log(
          `ℹ️ Memory provider: ${provider.name} (${provider.tier}). Initial index will run on first use.`
        );
      }
    }

    activeProvider = provider;
    initialised = true;
  })();

  try {
    await initInFlight;
  } finally {
    initInFlight = null;
  }

  return initialised && dbInstance && activeProvider
    ? { db: dbInstance, provider: activeProvider }
    : null;
}

// ── Public API ──────────────────────────────────────────

export async function reindexMemory(force = false): Promise<{ indexed: number; total: number }> {
  const ctx = await ensureInit();
  if (!ctx) return { indexed: 0, total: 0 };
  const { db, provider } = ctx;

  const filesToIndex = force ? getIndexableFiles() : getStaleFiles(db);
  if (filesToIndex.length === 0) {
    return { indexed: 0, total: provider.countEntries(db) };
  }

  // Drop existing entries for these files (per-source DELETE).
  provider.dropEntriesForSources(
    db,
    filesToIndex.map(f => f.relativePath)
  );

  // Chunk all files.
  const allChunks: Chunk[] = [];
  const fileMtimeMap: Array<{ relativePath: string; path: string }> = [];
  for (const file of filesToIndex) {
    try {
      const content = fs.readFileSync(file.path, "utf-8");
      const chunks = chunkMarkdown(content, file.relativePath);
      for (const c of chunks) allChunks.push(c);
      fileMtimeMap.push(file);
    } catch (err) {
      console.error(`Failed to chunk ${file.relativePath}:`, err);
    }
  }

  if (allChunks.length === 0) {
    // No content to embed — but DO update mtimes so we don't re-walk these
    // files every startup.
    const updMtime = db.transaction((files: typeof fileMtimeMap) => {
      for (const f of files) {
        try {
          setFileMtime(db, f.relativePath, fs.statSync(f.path).mtimeMs);
        } catch {
          /* file vanished */
        }
      }
    });
    updMtime(fileMtimeMap);
    return { indexed: 0, total: provider.countEntries(db) };
  }

  await provider.indexChunks(db, allChunks);

  // Update mtimes for indexed files.
  const updMtime = db.transaction((files: typeof fileMtimeMap) => {
    for (const f of files) {
      try {
        setFileMtime(db, f.relativePath, fs.statSync(f.path).mtimeMs);
      } catch {
        /* file vanished */
      }
    }
  });
  updMtime(fileMtimeMap);

  setMeta(db, "lastReindex", String(Date.now()));

  // For Ollama with unknown dim, set it now from the actual vector size.
  if (provider.dim === 0) {
    // Probe one entry; vector providers store as BLOB, FTS5 doesn't have one.
    try {
      const row = db.prepare("SELECT vector FROM entries LIMIT 1").get() as
        | { vector: Buffer }
        | undefined;
      if (row?.vector) {
        const detectedDim = row.vector.byteLength / 4;
        setMeta(db, "embedding_dim", String(detectedDim));
      }
    } catch {
      /* not a vector provider */
    }
  }

  return { indexed: allChunks.length, total: provider.countEntries(db) };
}

export async function searchMemory(
  query: string,
  topK = 5,
  minScore = 0.3
): Promise<SearchResult[]> {
  const ctx = await ensureInit();
  if (!ctx) return [];
  const { db, provider } = ctx;

  // Lazy first-time index if empty.
  if (provider.countEntries(db) === 0) {
    try {
      await reindexMemory();
    } catch (err) {
      // Reindex failure (e.g. API key missing for vector provider) — return
      // empty so the caller can degrade gracefully.
      console.log(
        `ℹ️ Memory search unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
    if (provider.countEntries(db) === 0) return [];
  }

  try {
    return await provider.search(db, query, topK, minScore);
  } catch (err) {
    console.log(
      `ℹ️ Memory search failed (${provider.name}): ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

export async function initEmbeddings(): Promise<void> {
  const ctx = await ensureInit();
  if (!ctx) return; // sqlite unavailable — already warned in loadSqlite
  const { db, provider } = ctx;

  try {
    const stale = getStaleFiles(db);
    if (stale.length === 0 && provider.countEntries(db) > 0) {
      return; // already up to date
    }
    const result = await reindexMemory();
    if (result.indexed > 0) {
      console.log(
        `🔍 Memory indexed: ${result.indexed} chunks via ${provider.name} (${result.total} total)`
      );
    }
  } catch (err) {
    // Don't crash the bot if reindexing fails (e.g. API down). Log INFO not
    // WARN — bot keeps running, search just returns empty until conditions
    // recover. Public users without keys hit the FTS5 path which never throws.
    console.log(
      `ℹ️ Memory init deferred: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export interface IndexStats {
  entries: number;
  files: number;
  lastReindex: number;
  sizeBytes: number;
  provider: string;
  tier: string;
  dim: number;
}

export function getIndexStats(): IndexStats {
  const stats: IndexStats = {
    entries: 0,
    files: 0,
    lastReindex: 0,
    sizeBytes: 0,
    provider: "unavailable",
    tier: "none",
    dim: 0,
  };
  if (!loadSqlite()) return stats;

  const db = openDb();
  if (!db) return stats;

  try {
    if (activeProvider) {
      stats.entries = activeProvider.countEntries(db);
      stats.provider = activeProvider.name;
      stats.tier = activeProvider.tier;
      stats.dim = activeProvider.dim;
    } else {
      // Fall back to stored meta if init never ran.
      stats.provider = getMeta(db, "embedding_model") ?? "unknown";
      stats.tier = getMeta(db, "embedding_tier") ?? "unknown";
      stats.dim = Number(getMeta(db, "embedding_dim") ?? 0);
    }
    stats.files = (db.prepare("SELECT COUNT(*) AS c FROM file_mtimes").get() as { c: number }).c;
    const lr = getMeta(db, "lastReindex");
    if (lr) stats.lastReindex = Number(lr);
    if (fs.existsSync(EMBEDDINGS_DB)) stats.sizeBytes = fs.statSync(EMBEDDINGS_DB).size;
  } catch {
    /* DB not initialised or partial */
  }
  return stats;
}

export function getEmbeddingsBackendStatus(): { available: boolean; error: string | null } {
  loadSqlite();
  return { available: SqliteClass !== null, error: sqliteLoadError?.message ?? null };
}

/**
 * Synchronous probe: does the SQLite memory store have at least one indexed
 * entry, regardless of which provider wrote it? Used by the inject-mode
 * resolver to decide between legacy plain-text and SQLite-backed search at
 * system-prompt build time (which is sync).
 *
 * Cheap: opens the DB if needed (idempotent), runs a single COUNT on whichever
 * provider table exists. Does NOT call out to embedding APIs.
 */
export function isSqliteMemoryReady(): boolean {
  if (!loadSqlite()) return false;
  const db = openDb();
  if (!db) return false;
  for (const tbl of ["entries", "entries_fts"]) {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS c FROM ${tbl}`).get() as
        | { c: number }
        | undefined;
      if (r && r.c > 0) return true;
    } catch {
      /* table missing — try next */
    }
  }
  return false;
}

// ── Re-exports for callers ──────────────────────────────

export type { SearchResult } from "./provider.js";
