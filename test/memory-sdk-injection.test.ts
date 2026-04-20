/**
 * v4.11.0 — SDK system prompts now receive MEMORY.md context.
 *
 * Before v4.11.0, only non-SDK providers (Groq, Gemini, NVIDIA) got
 * buildMemoryContext() injected into their system prompt — the SDK was
 * expected to read memory files via tools. In practice it rarely did,
 * resulting in "frickelig" memory after restart even with persisted
 * sessions. v4.11.0 closes this gap.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-sdk-mem-inject-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.mkdirSync(resolve(TEST_DATA_DIR, "memory"), { recursive: true });
  fs.writeFileSync(
    resolve(TEST_DATA_DIR, "memory", "MEMORY.md"),
    "# Long-term Memory\n\n- User User prefers terse answers.\n- HOMES uses Postgres `homes_production`.\n",
  );
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  vi.resetModules();
});

describe("SDK memory injection (v4.11.0)", () => {
  it("buildSystemPrompt(isSDK=true) now includes MEMORY.md content", async () => {
    const { buildSystemPrompt } = await import("../src/services/personality.js");
    const prompt = buildSystemPrompt(true, "en", "1234");
    expect(prompt).toMatch(/User User prefers terse answers/);
    expect(prompt).toMatch(/HOMES uses Postgres/);
  });

  it("non-SDK still gets memory injection (regression check)", async () => {
    const { buildSystemPrompt } = await import("../src/services/personality.js");
    const prompt = buildSystemPrompt(false, "en", "1234");
    expect(prompt).toMatch(/User User prefers terse answers/);
  });

  it("no MEMORY.md → SDK prompt builds without crash and without memory section", async () => {
    fs.unlinkSync(resolve(TEST_DATA_DIR, "memory", "MEMORY.md"));
    vi.resetModules();
    const { buildSystemPrompt } = await import("../src/services/personality.js");
    const prompt = buildSystemPrompt(true, "en", "1234");
    expect(prompt).toBeTruthy();
    expect(prompt).not.toMatch(/Your Memory \(auto-loaded\)/);
  });
});

describe("SDK smart prompt (semantic recall) on first turn (v4.11.0)", () => {
  it("buildSmartSystemPrompt for SDK with isFirstTurn=false does NOT call searchMemory", async () => {
    let searchCalls = 0;
    vi.doMock("../src/services/embeddings.js", () => ({
      searchMemory: async () => {
        searchCalls++;
        return [];
      },
      reindexMemory: async () => ({ indexed: 0, total: 0 }),
      initEmbeddings: async () => {},
      getIndexStats: () => ({ entries: 0, files: 0, lastReindex: 0, sizeBytes: 0 }),
    }));
    vi.resetModules();
    const { buildSmartSystemPrompt } = await import("../src/services/personality.js");

    await buildSmartSystemPrompt(true, "en", "tell me about HOMES", "1234", false);
    expect(searchCalls).toBe(0);
  });

  it("buildSmartSystemPrompt for SDK with isFirstTurn=true CALLS searchMemory", async () => {
    let searchCalls = 0;
    vi.doMock("../src/services/embeddings.js", () => ({
      searchMemory: async () => {
        searchCalls++;
        return [
          { text: "HOMES uses homes_production database", source: "MEMORY.md", score: 0.9 },
        ];
      },
      reindexMemory: async () => ({ indexed: 0, total: 0 }),
      initEmbeddings: async () => {},
      getIndexStats: () => ({ entries: 0, files: 0, lastReindex: 0, sizeBytes: 0 }),
    }));
    vi.resetModules();
    const { buildSmartSystemPrompt } = await import("../src/services/personality.js");

    const prompt = await buildSmartSystemPrompt(true, "en", "tell me about HOMES", "1234", true);
    expect(searchCalls).toBe(1);
    expect(prompt).toMatch(/Relevant Memories \(auto-retrieved\)/);
    expect(prompt).toMatch(/homes_production/);
  });

  it("non-SDK calls searchMemory regardless of isFirstTurn flag", async () => {
    let searchCalls = 0;
    vi.doMock("../src/services/embeddings.js", () => ({
      searchMemory: async () => {
        searchCalls++;
        return [];
      },
      reindexMemory: async () => ({ indexed: 0, total: 0 }),
      initEmbeddings: async () => {},
      getIndexStats: () => ({ entries: 0, files: 0, lastReindex: 0, sizeBytes: 0 }),
    }));
    vi.resetModules();
    const { buildSmartSystemPrompt } = await import("../src/services/personality.js");

    await buildSmartSystemPrompt(false, "en", "HOMES backup question", "1234", false);
    expect(searchCalls).toBe(1);
  });

  it("buildSmartSystemPrompt for SDK with no userMessage skips search even when isFirstTurn=true", async () => {
    let searchCalls = 0;
    vi.doMock("../src/services/embeddings.js", () => ({
      searchMemory: async () => {
        searchCalls++;
        return [];
      },
      reindexMemory: async () => ({ indexed: 0, total: 0 }),
      initEmbeddings: async () => {},
      getIndexStats: () => ({ entries: 0, files: 0, lastReindex: 0, sizeBytes: 0 }),
    }));
    vi.resetModules();
    const { buildSmartSystemPrompt } = await import("../src/services/personality.js");

    await buildSmartSystemPrompt(true, "en", undefined, "1234", true);
    expect(searchCalls).toBe(0);
  });

  it("graceful failure: SDK first turn search throws → returns base prompt without crashing", async () => {
    vi.doMock("../src/services/embeddings.js", () => ({
      searchMemory: async () => {
        throw new Error("Embedding API down");
      },
      reindexMemory: async () => ({ indexed: 0, total: 0 }),
      initEmbeddings: async () => {},
      getIndexStats: () => ({ entries: 0, files: 0, lastReindex: 0, sizeBytes: 0 }),
    }));
    vi.resetModules();
    const { buildSmartSystemPrompt } = await import("../src/services/personality.js");

    const prompt = await buildSmartSystemPrompt(true, "en", "test query", "1234", true);
    expect(prompt).toBeTruthy();
    expect(prompt).toMatch(/User User prefers terse answers/); // base still works
  });
});
