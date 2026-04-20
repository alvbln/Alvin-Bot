/**
 * Self-Search — Unified search across all of Alvin-Bot's knowledge.
 *
 * Combines three search strategies:
 * 1. Semantic (embeddings) — finds memories AND assets by meaning
 * 2. Capability (skills) — finds matching skills by keyword triggers
 * 3. Keyword fallback — finds assets by filename/category match
 *
 * Used by:
 * - CLI: `alvin-bot search "query"` (for SDK agents to call via Bash)
 * - Internal: personality.ts for prompt enrichment
 */

import { searchMemory } from "./embeddings.js";
import { matchSkills } from "./skills.js";
import { loadAssetIndex } from "./asset-index.js";

// ── Types ───────────────────────────────────────────────

export interface SelfSearchResult {
  /** What kind of result this is */
  type: "memory" | "asset" | "capability";
  /** Preview text or description */
  text: string;
  /** Relative path (assets/..., memory/...) or skill ID (skills/...) */
  source: string;
  /** Relevance score 0-1 */
  score: number;
  /** Full filesystem path — only for assets */
  absolutePath?: string;
}

// ── Search Strategies ───────────────────────────────────

/**
 * Semantic search via embeddings (memories + assets).
 * Results from asset sources get type "asset", others get "memory".
 */
async function searchSemantic(query: string, topK: number, minScore: number): Promise<SelfSearchResult[]> {
  try {
    const results = await searchMemory(query, topK, minScore);
    const index = loadAssetIndex();

    // Build a lookup map for absolute paths
    const assetPathMap = new Map<string, string>();
    for (const a of index.assets) {
      assetPathMap.set(`assets/${a.path}`, a.absolutePath);
    }

    return results.map(r => {
      const isAsset = r.source.startsWith("assets/");
      return {
        type: isAsset ? "asset" as const : "memory" as const,
        text: r.text.length > 200 ? r.text.slice(0, 200) + "..." : r.text,
        source: r.source,
        score: r.score,
        absolutePath: isAsset ? assetPathMap.get(r.source) : undefined,
      };
    });
  } catch {
    // Embeddings unavailable — return empty (keyword fallback will catch)
    return [];
  }
}

/**
 * Capability search — match skills by their trigger keywords.
 */
function searchCapabilities(query: string): SelfSearchResult[] {
  const matched = matchSkills(query, 3);
  return matched.map(s => ({
    type: "capability" as const,
    text: `Skill: ${s.name} — ${s.description}`,
    source: `skills/${s.id}`,
    score: 0.5,
  }));
}

/**
 * Keyword fallback — match assets by filename, category, or description.
 * Used when embeddings are unavailable or as a supplement.
 */
function searchKeyword(query: string): SelfSearchResult[] {
  const index = loadAssetIndex();
  if (index.assets.length === 0) return [];

  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
  if (keywords.length === 0) return [];

  return index.assets
    .filter(a =>
      keywords.some(k =>
        a.filename.toLowerCase().includes(k) ||
        a.category.toLowerCase().includes(k) ||
        a.description.toLowerCase().includes(k)
      )
    )
    .map(a => {
      // Score based on match quality: filename hits rank higher than category-only
      const filenameLower = a.filename.toLowerCase();
      const matchCount = keywords.filter(k => filenameLower.includes(k)).length;
      const score = matchCount >= 2 ? 0.75 : matchCount === 1 ? 0.65 : 0.5;

      return {
        type: "asset" as const,
        text: a.description,
        source: `assets/${a.path}`,
        score,
        absolutePath: a.absolutePath,
      };
    });
}

// ── Public API ──────────────────────────────────────────

/**
 * Search across all knowledge sources: memories, assets, capabilities.
 * Merges results, deduplicates by source, sorts by score.
 */
export async function searchSelf(
  query: string,
  topK = 5,
  minScore = 0.3
): Promise<SelfSearchResult[]> {
  // Run all searches (semantic is async, others are sync)
  const [semantic, capabilities, keyword] = await Promise.all([
    searchSemantic(query, topK, minScore),
    Promise.resolve(searchCapabilities(query)),
    Promise.resolve(searchKeyword(query)),
  ]);

  // Merge all results
  const all = [...semantic, ...capabilities, ...keyword];

  // Deduplicate by source (keep highest score)
  const deduped = new Map<string, SelfSearchResult>();
  for (const r of all) {
    const existing = deduped.get(r.source);
    if (!existing || r.score > existing.score) {
      deduped.set(r.source, r);
    }
  }

  // Sort by score descending, take topK
  return [...deduped.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Format search results for CLI output.
 */
export function formatSearchResults(results: SelfSearchResult[]): string {
  if (results.length === 0) return "No results found.";

  return results.map(r => {
    const score = `[${r.score.toFixed(2)}]`;
    const type = r.type.padEnd(10);
    const source = r.source;
    const detail = r.absolutePath
      ? `\n${"".padEnd(16)}${r.absolutePath}`
      : `\n${"".padEnd(16)}"${r.text.slice(0, 80)}${r.text.length > 80 ? "..." : ""}"`;
    return `${score} ${type} ${source}${detail}`;
  }).join("\n");
}
