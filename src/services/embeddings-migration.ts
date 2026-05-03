/**
 * One-shot migration from legacy .embeddings.json → SQLite .embeddings.db.
 *
 * Triggered on startup if .embeddings.json exists but .embeddings.db does not.
 * Idempotent: skips silently if the DB is already populated.
 *
 * Safety:
 *  - Source JSON is renamed to .embeddings.json.bak-pre-sqlite (kept on disk).
 *  - Entry counts are compared after import; mismatch → throw, leaving the bak
 *    file in place for manual recovery.
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { EMBEDDINGS_IDX, EMBEDDINGS_DB } from "../paths.js";

interface LegacyEntry {
  id: string;
  source: string;
  text: string;
  vector: number[];
  indexedAt: number;
}

interface LegacyIndex {
  model: string;
  lastReindex: number;
  fileMtimes: Record<string, number>;
  entries: LegacyEntry[];
}

function vectorToBlob(v: number[]): Buffer {
  const f32 = new Float32Array(v);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function shouldMigrateEmbeddingsToSqlite(): boolean {
  return fs.existsSync(EMBEDDINGS_IDX) && !fs.existsSync(EMBEDDINGS_DB);
}

/**
 * Run the migration. Returns the entry count migrated, or null if skipped.
 */
export function migrateEmbeddingsToSqlite(): { entries: number; sourceMb: number; targetMb: number } | null {
  if (!shouldMigrateEmbeddingsToSqlite()) return null;

  const t0 = Date.now();
  const sourceSize = fs.statSync(EMBEDDINGS_IDX).size;
  console.log(`📦 Migrating embeddings JSON (${(sourceSize / 1024 / 1024).toFixed(0)} MB) → SQLite...`);

  const raw = fs.readFileSync(EMBEDDINGS_IDX, "utf-8");
  let legacy: LegacyIndex;
  try {
    legacy = JSON.parse(raw);
  } catch (err) {
    console.error("⚠️ Embeddings migration: source JSON is corrupt — skipping.", err);
    return null;
  }

  fs.mkdirSync(path.dirname(EMBEDDINGS_DB), { recursive: true });
  const db = new Database(EMBEDDINGS_DB);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");

    db.exec(`
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

    const setMeta = db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    setMeta.run("model", legacy.model);
    setMeta.run("schemaVersion", "1");
    setMeta.run("lastReindex", String(legacy.lastReindex));
    setMeta.run("migratedFromJson", String(Date.now()));

    const insMtime = db.prepare(
      "INSERT INTO file_mtimes (source, mtime_ms) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET mtime_ms = excluded.mtime_ms"
    );
    const writeMtimes = db.transaction((rows: Array<[string, number]>) => {
      for (const [s, m] of rows) insMtime.run(s, m);
    });
    writeMtimes(Object.entries(legacy.fileMtimes ?? {}));

    const insEntry = db.prepare(
      "INSERT INTO entries (id, source, text, vector, indexed_at) VALUES (?, ?, ?, ?, ?)"
    );
    const writeEntries = db.transaction((rows: LegacyEntry[]) => {
      for (const e of rows) {
        if (!Array.isArray(e.vector) || e.vector.length === 0) continue;
        insEntry.run(e.id, e.source, e.text, vectorToBlob(e.vector), e.indexedAt);
      }
    });
    writeEntries(legacy.entries ?? []);

    const written = (db.prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number }).c;
    const expected = (legacy.entries ?? []).filter(e => Array.isArray(e.vector) && e.vector.length > 0).length;

    if (written !== expected) {
      throw new Error(`Entry-count mismatch after migration: expected ${expected}, got ${written}`);
    }

    db.close();

    // Move source JSON aside so we never re-migrate.
    const bak = `${EMBEDDINGS_IDX}.bak-pre-sqlite`;
    try {
      fs.renameSync(EMBEDDINGS_IDX, bak);
    } catch (err) {
      console.warn("⚠️ Could not rename source JSON:", err);
    }

    const targetSize = fs.statSync(EMBEDDINGS_DB).size;
    const dt = Date.now() - t0;
    console.log(
      `✅ Embeddings migrated: ${written} entries, ${(sourceSize / 1024 / 1024).toFixed(0)} MB JSON → ${(targetSize / 1024 / 1024).toFixed(0)} MB SQLite in ${dt} ms`
    );
    return { entries: written, sourceMb: sourceSize / 1024 / 1024, targetMb: targetSize / 1024 / 1024 };
  } catch (err) {
    db.close();
    // Remove half-written DB so the next boot retries cleanly.
    try {
      fs.unlinkSync(EMBEDDINGS_DB);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
}
