/**
 * One-shot migration from legacy .embeddings.json → SQLite .embeddings.db.
 *
 * Triggered on startup if .embeddings.json exists but .embeddings.db does not.
 * Idempotent: skips silently if the DB is already populated.
 *
 * Hardening (v4.20.1):
 *  - Lazy require of better-sqlite3 — missing native binary degrades to a clear
 *    warning + skip (bot keeps running, falls back to legacy JSON path until
 *    the user fixes their install).
 *  - Pre-flight disk-space check: refuses to start if free space < 2× source.
 *  - Progress logging every 1 000 entries on large indexes.
 *  - Corrupt source JSON is renamed to `.broken.<timestamp>` so the next run
 *    doesn't loop on the same parse error.
 *
 * Safety:
 *  - Source JSON is renamed to .embeddings.json.bak-pre-sqlite (kept on disk).
 *  - Entry counts are compared after import; mismatch → throw, leaving the
 *    half-written DB removed and the source JSON untouched.
 */

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { EMBEDDINGS_IDX, EMBEDDINGS_DB } from "../paths.js";

const cjsRequire = createRequire(import.meta.url);

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
 * Best-effort free-space probe. Returns Infinity if the platform has no
 * statfs (which means we'll proceed without the safety check rather than
 * blocking the migration). Node 18.15+ ships statfsSync on all major platforms.
 */
function freeBytesOnVolume(forPath: string): number {
  try {
    const fsAny = fs as unknown as {
      statfsSync?: (p: string) => { bavail: number | bigint; bsize: number | bigint };
    };
    if (typeof fsAny.statfsSync !== "function") return Number.POSITIVE_INFINITY;
    const stat = fsAny.statfsSync(forPath);
    const bavail = typeof stat.bavail === "bigint" ? Number(stat.bavail) : stat.bavail;
    const bsize = typeof stat.bsize === "bigint" ? Number(stat.bsize) : stat.bsize;
    return bavail * bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Run the migration. Returns the entry count migrated, or null if skipped.
 */
export function migrateEmbeddingsToSqlite(): { entries: number; sourceMb: number; targetMb: number } | null {
  if (!shouldMigrateEmbeddingsToSqlite()) return null;

  // ── Pre-flight: better-sqlite3 loadable? ───────────────────────────────────
  let Database: typeof import("better-sqlite3");
  try {
    Database = cjsRequire("better-sqlite3");
  } catch (err) {
    console.warn(
      "⚠️ Embeddings migration skipped: better-sqlite3 native binary unavailable. " +
        "Bot continues with legacy JSON index. Fix: `npm rebuild better-sqlite3` " +
        "or reinstall alvin-bot. Underlying error:",
      err instanceof Error ? err.message : err
    );
    return null;
  }

  const sourceSize = fs.statSync(EMBEDDINGS_IDX).size;

  // ── Pre-flight: enough free space? ─────────────────────────────────────────
  const targetDir = path.dirname(EMBEDDINGS_DB);
  fs.mkdirSync(targetDir, { recursive: true });
  const free = freeBytesOnVolume(targetDir);
  // We need source + about half of source for the SQLite file, plus headroom
  // for WAL during the transaction. Demand 2× source size to be comfortable.
  const required = sourceSize * 2;
  if (free < required) {
    console.warn(
      `⚠️ Embeddings migration skipped: insufficient free disk space on ${targetDir}. ` +
        `Need ~${(required / 1024 / 1024).toFixed(0)} MB, have ${(free / 1024 / 1024).toFixed(0)} MB. ` +
        `Free up some space and restart the bot to retry.`
    );
    return null;
  }

  // ── Read & parse source ────────────────────────────────────────────────────
  const t0 = Date.now();
  console.log(`📦 Migrating embeddings JSON (${(sourceSize / 1024 / 1024).toFixed(0)} MB) → SQLite...`);

  const raw = fs.readFileSync(EMBEDDINGS_IDX, "utf-8");
  let legacy: LegacyIndex;
  try {
    legacy = JSON.parse(raw);
  } catch (err) {
    // Move the broken JSON aside so we don't try to migrate it again next boot.
    const broken = `${EMBEDDINGS_IDX}.broken.${Date.now()}`;
    try {
      fs.renameSync(EMBEDDINGS_IDX, broken);
      console.error(
        `❌ Embeddings migration: source JSON is corrupt — renamed to ${path.basename(broken)} ` +
          `and skipped. The bot will rebuild the index from scratch on first search ` +
          `(this may incur Google API calls). Underlying parse error:`,
        err
      );
    } catch (renameErr) {
      console.error(
        "❌ Embeddings migration: source JSON is corrupt AND could not be renamed:",
        err,
        "Rename error:",
        renameErr
      );
    }
    return null;
  }

  const validEntries = (legacy.entries ?? []).filter(
    e => Array.isArray(e.vector) && e.vector.length > 0
  );

  // ── Write DB ───────────────────────────────────────────────────────────────
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
    setMeta.run("model", legacy.model || "gemini-embedding-001");
    setMeta.run("schemaVersion", "1");
    setMeta.run("lastReindex", String(legacy.lastReindex || 0));
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

    // Write entries in chunks of 1 000 so we can log progress on huge indexes.
    const CHUNK = 1000;
    const total = validEntries.length;
    let written = 0;
    const writeChunk = db.transaction((rows: LegacyEntry[]) => {
      for (const e of rows) {
        insEntry.run(e.id, e.source, e.text, vectorToBlob(e.vector), e.indexedAt);
      }
    });
    for (let i = 0; i < total; i += CHUNK) {
      const slice = validEntries.slice(i, i + CHUNK);
      writeChunk(slice);
      written += slice.length;
      if (total > 5000 && (written === total || written % 5000 === 0)) {
        console.log(`   …migrated ${written} / ${total} entries (${Math.round((written / total) * 100)} %)`);
      }
    }

    const writtenCount = (db.prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number }).c;
    if (writtenCount !== validEntries.length) {
      throw new Error(
        `Entry-count mismatch after migration: expected ${validEntries.length}, got ${writtenCount}`
      );
    }

    db.close();

    // ── Move source JSON aside so we never re-migrate ────────────────────────
    const bak = `${EMBEDDINGS_IDX}.bak-pre-sqlite`;
    try {
      fs.renameSync(EMBEDDINGS_IDX, bak);
    } catch (err) {
      console.warn("⚠️ Could not rename source JSON (migration still succeeded):", err);
    }

    const targetSize = fs.statSync(EMBEDDINGS_DB).size;
    const dt = Date.now() - t0;
    console.log(
      `✅ Embeddings migrated: ${writtenCount} entries, ${(sourceSize / 1024 / 1024).toFixed(0)} MB JSON → ${(targetSize / 1024 / 1024).toFixed(0)} MB SQLite in ${dt} ms`
    );
    return { entries: writtenCount, sourceMb: sourceSize / 1024 / 1024, targetMb: targetSize / 1024 / 1024 };
  } catch (err) {
    db.close();
    // Remove half-written DB so the next boot retries cleanly with the original JSON intact.
    try {
      fs.unlinkSync(EMBEDDINGS_DB);
      // also unlink WAL/SHM if present
      for (const ext of ["-wal", "-shm"]) {
        const p = `${EMBEDDINGS_DB}${ext}`;
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
}
