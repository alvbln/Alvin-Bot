/**
 * Embeddings Service — public API shim.
 *
 * v4.22.0 refactor: the implementation moved to src/services/embeddings/ with
 * pluggable providers (Gemini, OpenAI, Ollama, FTS5). This file re-exports the
 * facade so existing callers (memory.ts, personality.ts, self-search.ts,
 * commands.ts, index.ts) keep working without import changes.
 */

export {
  initEmbeddings,
  searchMemory,
  reindexMemory,
  getIndexStats,
  getEmbeddingsBackendStatus,
  closeEmbeddingsDb,
} from "./embeddings/index.js";
export type { SearchResult, IndexStats } from "./embeddings/index.js";
