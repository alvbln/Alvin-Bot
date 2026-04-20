/**
 * v4.11.0 — Auto-fact-extraction.
 *
 * When compaction archives messages, instead of just dumping prose into
 * the daily log, run a structured extraction pass that pulls user_facts,
 * preferences, and decisions out of the chunk and appends them to MEMORY.md
 * (de-duplicated by exact-string match).
 *
 * Marked experimental in v4.11.0. Opt out via MEMORY_EXTRACTION_DISABLED=1.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-mem-extract-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(resolve(TEST_DATA_DIR, "memory"), { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  delete process.env.MEMORY_EXTRACTION_DISABLED;
  vi.resetModules();
});

describe("memory-extractor (v4.11.0)", () => {
  it("parseExtractedFacts handles a clean JSON response", async () => {
    const { parseExtractedFacts } = await import("../src/services/memory-extractor.js");
    const json = JSON.stringify({
      user_facts: ["User User lives in Berlin"],
      preferences: ["Replies in German"],
      decisions: ["Use VPS VPS for production"],
    });
    const facts = parseExtractedFacts(json);
    expect(facts.user_facts).toEqual(["User User lives in Berlin"]);
    expect(facts.preferences).toEqual(["Replies in German"]);
    expect(facts.decisions).toEqual(["Use VPS VPS for production"]);
  });

  it("parseExtractedFacts handles JSON wrapped in markdown code fences", async () => {
    const { parseExtractedFacts } = await import("../src/services/memory-extractor.js");
    const wrapped = "```json\n" + JSON.stringify({
      user_facts: ["fact 1"],
    }) + "\n```";
    const facts = parseExtractedFacts(wrapped);
    expect(facts.user_facts).toEqual(["fact 1"]);
  });

  it("parseExtractedFacts handles JSON with surrounding prose", async () => {
    const { parseExtractedFacts } = await import("../src/services/memory-extractor.js");
    const messy = `Sure, here are the extracted facts:
${JSON.stringify({ user_facts: ["x"], preferences: [], decisions: [] })}
Hope this helps!`;
    const facts = parseExtractedFacts(messy);
    expect(facts.user_facts).toEqual(["x"]);
  });

  it("parseExtractedFacts returns empty arrays on garbage input", async () => {
    const { parseExtractedFacts } = await import("../src/services/memory-extractor.js");
    const facts = parseExtractedFacts("not json at all");
    expect(facts.user_facts).toEqual([]);
    expect(facts.preferences).toEqual([]);
    expect(facts.decisions).toEqual([]);
  });

  it("parseExtractedFacts filters non-string entries from arrays", async () => {
    const { parseExtractedFacts } = await import("../src/services/memory-extractor.js");
    const messy = JSON.stringify({
      user_facts: ["good", 42, null, "good2"],
      preferences: [],
      decisions: [],
    });
    const facts = parseExtractedFacts(messy);
    expect(facts.user_facts).toEqual(["good", "good2"]);
  });

  it("appendFactsToMemoryFile writes new facts under structured headers", async () => {
    const { appendFactsToMemoryFile } = await import("../src/services/memory-extractor.js");
    await appendFactsToMemoryFile({
      user_facts: ["User uses launchd for the bot"],
      preferences: [],
      decisions: ["v4.11.0 ships memory persistence"],
    });
    const memFile = resolve(TEST_DATA_DIR, "memory", "MEMORY.md");
    expect(fs.existsSync(memFile)).toBe(true);
    const content = fs.readFileSync(memFile, "utf-8");
    expect(content).toMatch(/User uses launchd for the bot/);
    expect(content).toMatch(/v4\.11\.0 ships memory persistence/);
  });

  it("appendFactsToMemoryFile dedupes on exact-string match", async () => {
    const { appendFactsToMemoryFile } = await import("../src/services/memory-extractor.js");
    await appendFactsToMemoryFile({
      user_facts: ["User uses launchd for the bot"],
      preferences: [],
      decisions: [],
    });
    await appendFactsToMemoryFile({
      user_facts: ["User uses launchd for the bot", "User drinks coffee"],
      preferences: [],
      decisions: [],
    });
    const content = fs.readFileSync(resolve(TEST_DATA_DIR, "memory", "MEMORY.md"), "utf-8");
    const matches = content.match(/User uses launchd for the bot/g);
    expect(matches).toHaveLength(1); // not duplicated
    expect(content).toMatch(/User drinks coffee/);
  });

  it("appendFactsToMemoryFile returns 0 when all facts are duplicates", async () => {
    const { appendFactsToMemoryFile } = await import("../src/services/memory-extractor.js");
    await appendFactsToMemoryFile({
      user_facts: ["unique fact"],
      preferences: [],
      decisions: [],
    });
    const stored = await appendFactsToMemoryFile({
      user_facts: ["unique fact"],
      preferences: [],
      decisions: [],
    });
    expect(stored).toBe(0);
  });

  it("extractAndStoreFacts is a no-op when MEMORY_EXTRACTION_DISABLED=1", async () => {
    process.env.MEMORY_EXTRACTION_DISABLED = "1";
    vi.resetModules();
    const { extractAndStoreFacts } = await import("../src/services/memory-extractor.js");
    const result = await extractAndStoreFacts("some conversation text");
    expect(result.disabled).toBe(true);
    expect(result.factsStored).toBe(0);
  });

  it("extractAndStoreFacts returns 0 stored on too-short input", async () => {
    const { extractAndStoreFacts } = await import("../src/services/memory-extractor.js");
    const result = await extractAndStoreFacts("hi");
    expect(result.disabled).toBe(false);
    expect(result.factsStored).toBe(0);
  });

  it("extractAndStoreFacts gracefully handles AI provider failure", async () => {
    // No API keys in test env — provider will fail, extractor should swallow
    const { extractAndStoreFacts } = await import("../src/services/memory-extractor.js");
    const result = await extractAndStoreFacts(
      "This is a long enough conversation about Berlin, Postgres databases, " +
      "and how to set up nginx properly. Should be more than 50 characters easily.",
    );
    expect(result.disabled).toBe(false);
    expect(result).toHaveProperty("factsStored");
    // Either succeeded or failed silently — but didn't throw
  });
});
