/**
 * Auto-detect picks the highest-tier available provider, with explicit
 * EMBEDDINGS_PROVIDER override winning unconditionally.
 *
 * Network probes (Ollama HTTP, Gemini API) are mocked off so the tests run
 * deterministically without a network dependency.
 *
 * Important: config.ts re-runs dotenv.config() on every fresh import, which
 * would re-populate GOOGLE_API_KEY etc. from the user's real ~/.alvin-bot/.env.
 * We point ALVIN_DATA_DIR at a temp dir with no .env so dotenv has nothing to
 * load, then explicitly re-set the keys we want for each test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-autodetect-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  delete process.env.EMBEDDINGS_PROVIDER;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_EMBEDDING_MODEL;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider auto-detect", () => {
  it("picks FTS5 when no keys are set and Ollama is unreachable", async () => {
    // Make any fetch (Ollama probe) fail.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    // Re-import config so it sees the cleared env.
    const { detectProvider } = await import("../src/services/embeddings/auto-detect.js");
    const p = await detectProvider();
    expect(p.name).toBe("fts5-bm25");
    expect(p.tier).toBe("keyword-local");
  });

  it("picks Gemini when GOOGLE_API_KEY is set", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    vi.resetModules();
    const { detectProvider } = await import("../src/services/embeddings/auto-detect.js");
    const p = await detectProvider();
    expect(p.name).toBe("gemini-embedding-001");
    expect(p.tier).toBe("vector-cloud");
    expect(p.dim).toBe(3072);
  });

  it("picks OpenAI when only OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();
    const { detectProvider } = await import("../src/services/embeddings/auto-detect.js");
    const p = await detectProvider();
    expect(p.name).toBe("text-embedding-3-small");
    expect(p.tier).toBe("vector-cloud");
    expect(p.dim).toBe(1536);
  });

  it("Gemini wins over OpenAI when both keys are set", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();
    const { detectProvider } = await import("../src/services/embeddings/auto-detect.js");
    const p = await detectProvider();
    expect(p.name).toBe("gemini-embedding-001");
  });

  it("EMBEDDINGS_PROVIDER override forces FTS5 even when Gemini is available", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    process.env.EMBEDDINGS_PROVIDER = "fts5";
    vi.resetModules();
    const { detectProvider, parseProviderKey } = await import("../src/services/embeddings/auto-detect.js");
    const p = await detectProvider(parseProviderKey(process.env.EMBEDDINGS_PROVIDER));
    expect(p.name).toBe("fts5-bm25");
  });

  it("EMBEDDINGS_PROVIDER=auto behaves like default", async () => {
    process.env.EMBEDDINGS_PROVIDER = "auto";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    vi.resetModules();
    const { detectProvider, parseProviderKey } = await import("../src/services/embeddings/auto-detect.js");
    const p = await detectProvider(parseProviderKey(process.env.EMBEDDINGS_PROVIDER));
    expect(p.name).toBe("fts5-bm25");
  });

  it("invalid EMBEDDINGS_PROVIDER value parses to auto", async () => {
    const { parseProviderKey } = await import("../src/services/embeddings/auto-detect.js");
    expect(parseProviderKey("nonsense")).toBe("auto");
    expect(parseProviderKey(undefined)).toBe("auto");
    expect(parseProviderKey("")).toBe("auto");
    expect(parseProviderKey("FTS5")).toBe("fts5"); // case-insensitive
  });

  it("Ollama is picked when /api/tags reports the embedding model", async () => {
    process.env.OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: "nomic-embed-text:latest" }] }),
      })
    );
    vi.resetModules();
    const { detectProvider } = await import("../src/services/embeddings/auto-detect.js");
    const p = await detectProvider();
    expect(p.name).toBe("ollama:nomic-embed-text");
    expect(p.tier).toBe("vector-local");
  });

  it("Ollama is skipped when /api/tags returns no embedding model", async () => {
    process.env.OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
    // Only a chat model is pulled — Ollama should NOT be picked.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: "llama3:8b" }] }),
      })
    );
    vi.resetModules();
    const { detectProvider } = await import("../src/services/embeddings/auto-detect.js");
    const p = await detectProvider();
    expect(p.name).toBe("fts5-bm25"); // falls through to FTS5
  });
});
