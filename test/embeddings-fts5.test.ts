/**
 * FTS5 provider: zero-config keyword search via SQLite full-text.
 *
 * The FTS5 path is the universal fallback for users without any embedding
 * provider configured. These tests exercise it directly against an in-memory
 * SQLite DB — no network, no API keys.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { Fts5Provider } from "../src/services/embeddings/fts5.js";

const cjsRequire = createRequire(import.meta.url);

function freshDb() {
  const Database = cjsRequire("better-sqlite3");
  // ":memory:" gives us an isolated DB per test, no disk I/O, no cleanup.
  return new Database(":memory:");
}

describe("Fts5Provider", () => {
  it("isAvailable always returns true (no key, no network)", async () => {
    const p = new Fts5Provider();
    expect(await p.isAvailable()).toBe(true);
    expect(p.dim).toBe(0);
    expect(p.tier).toBe("keyword-local");
  });

  it("indexes chunks and finds them by keyword", async () => {
    const db = freshDb();
    const p = new Fts5Provider();
    p.initSchema(db);

    await p.indexChunks(db, [
      { id: "1", source: "MEMORY.md", text: "NIEMALS pm2 kill — zerstört alle Services auf dem VPS" },
      { id: "2", source: "MEMORY.md", text: "Stripe Live-Mode aktiv auf Production" },
      { id: "3", source: "MEMORY.md", text: "Ollama läuft als lokaler Inferenz-Server" },
    ]);

    expect(p.countEntries(db)).toBe(3);

    const hits = await p.search(db, "pm2 kill", 5, 0);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe("MEMORY.md");
    expect(hits[0].text).toContain("pm2");
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeLessThanOrEqual(1);
  });

  it("ranks more relevant hits higher (BM25)", async () => {
    const db = freshDb();
    const p = new Fts5Provider();
    p.initSchema(db);

    await p.indexChunks(db, [
      { id: "a", source: "log.md", text: "trivial mention of stripe" },
      { id: "b", source: "stripe.md", text: "Stripe stripe stripe — payment integration details for Stripe Live mode" },
    ]);

    const hits = await p.search(db, "stripe", 5, 0);
    expect(hits[0].source).toBe("stripe.md");
  });

  it("returns empty for unmatched query", async () => {
    const db = freshDb();
    const p = new Fts5Provider();
    p.initSchema(db);
    await p.indexChunks(db, [{ id: "x", source: "x.md", text: "hello world" }]);

    const hits = await p.search(db, "nonexistentterm", 5, 0);
    expect(hits).toEqual([]);
  });

  it("dropEntriesForSources removes only matching rows", async () => {
    const db = freshDb();
    const p = new Fts5Provider();
    p.initSchema(db);
    await p.indexChunks(db, [
      { id: "1", source: "a.md", text: "alpha" },
      { id: "2", source: "b.md", text: "beta" },
      { id: "3", source: "a.md", text: "alpha second" },
    ]);
    expect(p.countEntries(db)).toBe(3);

    p.dropEntriesForSources(db, ["a.md"]);
    expect(p.countEntries(db)).toBe(1);

    const hits = await p.search(db, "beta", 5, 0);
    expect(hits.length).toBe(1);
    expect(hits[0].source).toBe("b.md");
  });

  it("sanitises FTS5 operator characters out of user queries", async () => {
    const db = freshDb();
    const p = new Fts5Provider();
    p.initSchema(db);
    await p.indexChunks(db, [{ id: "1", source: "x.md", text: "deploy script for production" }]);

    // Quotes / parens / boolean operators in raw query should not crash —
    // sanitiser strips them down to plain word-OR.
    const hits = await p.search(db, '"deploy" AND (NEAR script) NOT *', 5, 0);
    expect(hits.length).toBe(1);
  });

  it("dropSchema removes the virtual table", () => {
    const db = freshDb();
    const p = new Fts5Provider();
    p.initSchema(db);
    p.dropSchema(db);

    // After drop the virtual table is gone; countEntries returns 0 (catches
    // the missing-table error internally).
    expect(p.countEntries(db)).toBe(0);
  });

  it("respects topK limit", async () => {
    const db = freshDb();
    const p = new Fts5Provider();
    p.initSchema(db);
    const chunks = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      source: `f${i}.md`,
      text: `chunk ${i} mentions deploy`,
    }));
    await p.indexChunks(db, chunks);

    const hits = await p.search(db, "deploy", 3, 0);
    expect(hits.length).toBe(3);
  });
});
