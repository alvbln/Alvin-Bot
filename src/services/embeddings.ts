/**
 * Embeddings Service — Vector-based semantic memory search.
 *
 * Uses Google's text-embedding-004 model for generating embeddings.
 * Stores embeddings in a local JSON index file for fast cosine similarity search.
 *
 * Architecture:
 * - Each memory entry (paragraph/section) gets an embedding vector
 * - Vectors are stored in docs/memory/.embeddings.json
 * - On query, the search text is embedded and compared via cosine similarity
 * - Top-K results returned with similarity scores
 */

import fs from "fs";
import path from "path";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS_DIR = resolve(BOT_ROOT, "docs");
const MEMORY_DIR = resolve(DOCS_DIR, "memory");
const MEMORY_FILE = resolve(DOCS_DIR, "MEMORY.md");
const INDEX_FILE = resolve(MEMORY_DIR, ".embeddings.json");

// ── Types ───────────────────────────────────────────────

interface EmbeddingEntry {
  /** Unique ID (file:lineStart) */
  id: string;
  /** Source file (relative to docs/) */
  source: string;
  /** The text content */
  text: string;
  /** Embedding vector */
  vector: number[];
  /** Timestamp when indexed */
  indexedAt: number;
}

interface EmbeddingIndex {
  /** Model used for embeddings */
  model: string;
  /** Last full reindex timestamp */
  lastReindex: number;
  /** File modification times (to detect changes) */
  fileMtimes: Record<string, number>;
  /** All embedding entries */
  entries: EmbeddingEntry[];
}

export interface SearchResult {
  /** The matched text */
  text: string;
  /** Source file */
  source: string;
  /** Cosine similarity score (0-1) */
  score: number;
}

// ── Google Embeddings API ───────────────────────────────

const EMBEDDING_MODEL = "text-embedding-004";
const EMBEDDING_DIMENSION = 768; // text-embedding-004 default

/**
 * Get embeddings for one or more texts via Google's API.
 * Batches up to 100 texts per request.
 */
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

    const data = await response.json() as { embeddings: Array<{ values: number[] }> };
    for (const emb of data.embeddings) {
      results.push(emb.values);
    }
  }

  return results;
}

/**
 * Get embedding for a single query text.
 */
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

  const data = await response.json() as { embedding: { values: number[] } };
  return data.embedding.values;
}

// ── Vector Math ─────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
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

/**
 * Split a markdown file into meaningful chunks.
 * Splits on ## headers, keeping each section as a chunk.
 * Falls back to paragraph splitting for files without headers.
 */
function chunkMarkdown(content: string, source: string): Array<{ id: string; text: string }> {
  const chunks: Array<{ id: string; text: string }> = [];

  // Split on ## headers
  const sections = content.split(/^(?=## )/gm);

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i].trim();
    if (!section || section.length < 20) continue; // Skip tiny sections

    // If section is too long (>1000 chars), split into paragraphs
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

// ── Index Management ────────────────────────────────────

function loadIndex(): EmbeddingIndex {
  try {
    const raw = fs.readFileSync(INDEX_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      model: EMBEDDING_MODEL,
      lastReindex: 0,
      fileMtimes: {},
      entries: [],
    };
  }
}

function saveIndex(index: EmbeddingIndex): void {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
}

/**
 * Get all memory files that should be indexed.
 */
function getMemoryFiles(): Array<{ path: string; relativePath: string }> {
  const files: Array<{ path: string; relativePath: string }> = [];

  // MEMORY.md
  if (fs.existsSync(MEMORY_FILE)) {
    files.push({ path: MEMORY_FILE, relativePath: "MEMORY.md" });
  }

  // Daily logs
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

  return files;
}

/**
 * Check which files need reindexing (new or modified).
 */
function getStaleFiles(index: EmbeddingIndex): Array<{ path: string; relativePath: string }> {
  const allFiles = getMemoryFiles();
  const stale: typeof allFiles = [];

  for (const file of allFiles) {
    try {
      const stat = fs.statSync(file.path);
      const mtime = stat.mtimeMs;
      if (!index.fileMtimes[file.relativePath] || index.fileMtimes[file.relativePath] < mtime) {
        stale.push(file);
      }
    } catch {
      // File disappeared — skip
    }
  }

  return stale;
}

// ── Public API ──────────────────────────────────────────

/**
 * Reindex all memory files (or just stale ones).
 * Returns number of chunks indexed.
 */
export async function reindexMemory(force = false): Promise<{ indexed: number; total: number }> {
  const index = loadIndex();
  const filesToIndex = force ? getMemoryFiles() : getStaleFiles(index);

  if (filesToIndex.length === 0) {
    return { indexed: 0, total: index.entries.length };
  }

  // Remove old entries for files being reindexed
  const reindexSources = new Set(filesToIndex.map(f => f.relativePath));
  index.entries = index.entries.filter(e => !reindexSources.has(e.source));

  // Chunk all files
  const allChunks: Array<{ id: string; text: string; source: string }> = [];
  for (const file of filesToIndex) {
    try {
      const content = fs.readFileSync(file.path, "utf-8");
      const chunks = chunkMarkdown(content, file.relativePath);
      for (const chunk of chunks) {
        allChunks.push({ ...chunk, source: file.relativePath });
      }
      // Update mtime
      const stat = fs.statSync(file.path);
      index.fileMtimes[file.relativePath] = stat.mtimeMs;
    } catch (err) {
      console.error(`Failed to chunk ${file.relativePath}:`, err);
    }
  }

  if (allChunks.length === 0) {
    saveIndex(index);
    return { indexed: 0, total: index.entries.length };
  }

  // Get embeddings for all chunks
  const texts = allChunks.map(c => c.text);
  const vectors = await getEmbeddings(texts);

  // Add to index
  for (let i = 0; i < allChunks.length; i++) {
    index.entries.push({
      id: allChunks[i].id,
      source: allChunks[i].source,
      text: allChunks[i].text,
      vector: vectors[i],
      indexedAt: Date.now(),
    });
  }

  index.lastReindex = Date.now();
  saveIndex(index);

  return { indexed: allChunks.length, total: index.entries.length };
}

/**
 * Semantic search across all indexed memory.
 * Returns top-K results sorted by similarity.
 */
export async function searchMemory(query: string, topK = 5, minScore = 0.3): Promise<SearchResult[]> {
  const index = loadIndex();

  if (index.entries.length === 0) {
    // Auto-index if empty
    await reindexMemory();
    // Reload
    const reloaded = loadIndex();
    if (reloaded.entries.length === 0) return [];
  }

  // Get query embedding
  const queryVector = await getQueryEmbedding(query);

  // Calculate similarities
  const scored = index.entries.map(entry => ({
    text: entry.text,
    source: entry.source,
    score: cosineSimilarity(queryVector, entry.vector),
  }));

  // Sort by score descending, filter by minScore, take topK
  return scored
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Get index stats for /status.
 */
export function getIndexStats(): { entries: number; files: number; lastReindex: number; sizeBytes: number } {
  const index = loadIndex();
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(INDEX_FILE).size;
  } catch { /* empty */ }

  return {
    entries: index.entries.length,
    files: Object.keys(index.fileMtimes).length,
    lastReindex: index.lastReindex,
    sizeBytes,
  };
}
