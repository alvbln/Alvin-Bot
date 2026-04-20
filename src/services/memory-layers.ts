/**
 * Memory Layers Service (v4.11.0)
 *
 * Layered memory loader inspired by mempalace's L0–L3 stack:
 *
 *   L0 identity.md       always loaded, ~200 tokens (core user facts)
 *   L1 preferences.md    always loaded (communication style)
 *   L1 MEMORY.md         backwards-compat: monolithic curated knowledge
 *   L2 projects/*.md     loaded on topic match against the user's query
 *   L3 daily logs        only via vector search (handled by embeddings.ts)
 *
 * If neither identity.md nor preferences.md exists, this loader still works
 * via the monolithic MEMORY.md fallback, so existing setups need no migration.
 *
 * Token budget: capped at ~5000 chars for L0+L1, +~3000 chars for matched L2.
 */
import fs from "fs";
import path from "path";
import {
  IDENTITY_FILE,
  PREFERENCES_FILE,
  PROJECTS_MEMORY_DIR,
  MEMORY_FILE,
} from "../paths.js";

const MAX_L0_L1_CHARS = 5000;
const MAX_L2_PROJECT_CHARS = 1500;
const MAX_L2_TOTAL_CHARS = 3000;

export interface ProjectMemory {
  topic: string;
  content: string;
}

export interface MemoryLayers {
  identity: string;
  preferences: string;
  longTerm: string; // backwards-compat MEMORY.md
  projects: ProjectMemory[];
}

function readSafe(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Load all memory layers from disk. Cheap — no API calls, just file reads.
 */
export function loadMemoryLayers(): MemoryLayers {
  const identity = readSafe(IDENTITY_FILE);
  const preferences = readSafe(PREFERENCES_FILE);
  const longTerm = readSafe(MEMORY_FILE);

  const projects: ProjectMemory[] = [];
  try {
    if (fs.existsSync(PROJECTS_MEMORY_DIR)) {
      const entries = fs.readdirSync(PROJECTS_MEMORY_DIR);
      for (const entry of entries) {
        if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
        const fullPath = path.resolve(PROJECTS_MEMORY_DIR, entry);
        const content = readSafe(fullPath);
        if (content.trim()) {
          projects.push({
            topic: entry.replace(/\.md$/, ""),
            content,
          });
        }
      }
    }
  } catch {
    // projects dir missing or unreadable — fine
  }

  return { identity, preferences, longTerm, projects };
}

/**
 * Match L2 projects against the user query.
 * Topic match is naive substring (case-insensitive) on filename + first 200 chars
 * of the project content. For v4.11.0 this is intentionally simple — vector
 * search via embeddings.ts handles the deep cases.
 */
function matchProjectsToQuery(projects: ProjectMemory[], query: string): ProjectMemory[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const matched: ProjectMemory[] = [];
  for (const p of projects) {
    const topicLower = p.topic.toLowerCase();
    if (q.includes(topicLower)) {
      matched.push(p);
      continue;
    }
    // Also check the first 200 chars of project content — this catches cases
    // where the user mentions a project's headline term that isn't the
    // filename (e.g., "VPS" matching my-project.md which mentions "VPS:" upfront).
    const head = p.content.slice(0, 200).toLowerCase();
    const headWords = head.split(/[\s\W]+/).filter(w => w.length >= 4);
    if (headWords.some(w => q.includes(w))) {
      matched.push(p);
    }
  }
  return matched;
}

/**
 * Build a token-budgeted layered context string suitable for system prompt injection.
 *
 * @param query Optional user query. If provided, L2 projects matching the query
 *              get included. If omitted, only L0+L1 are loaded (boot-up brief).
 */
export function buildLayeredContext(query?: string): string {
  const layers = loadMemoryLayers();
  const parts: string[] = [];
  let l0l1Chars = 0;

  if (layers.identity) {
    const truncated = layers.identity.length > MAX_L0_L1_CHARS
      ? layers.identity.slice(0, MAX_L0_L1_CHARS) + "\n[...truncated]"
      : layers.identity;
    parts.push("## Identity (L0)\n" + truncated);
    l0l1Chars += truncated.length;
  }

  if (layers.preferences && l0l1Chars < MAX_L0_L1_CHARS) {
    const remaining = MAX_L0_L1_CHARS - l0l1Chars;
    const truncated = layers.preferences.length > remaining
      ? layers.preferences.slice(0, remaining) + "\n[...truncated]"
      : layers.preferences;
    parts.push("## Preferences (L1)\n" + truncated);
    l0l1Chars += truncated.length;
  }

  // Backwards-compat: if no identity AND no preferences, use the monolithic
  // MEMORY.md as L1 fully (existing user setups). If split files exist,
  // include MEMORY.md as a secondary L1 with tighter truncation.
  if (!layers.identity && !layers.preferences && layers.longTerm) {
    const truncated = layers.longTerm.length > MAX_L0_L1_CHARS
      ? layers.longTerm.slice(0, MAX_L0_L1_CHARS) + "\n[...truncated]"
      : layers.longTerm;
    parts.push("## Long-term Memory (L1, monolithic)\n" + truncated);
  } else if (layers.longTerm) {
    const SECONDARY_CAP = 1500;
    const truncated = layers.longTerm.length > SECONDARY_CAP
      ? layers.longTerm.slice(0, SECONDARY_CAP) + "\n[...truncated]"
      : layers.longTerm;
    parts.push("## Long-term Memory (L1, legacy MEMORY.md)\n" + truncated);
  }

  // L2: project-specific, only when a query is provided
  if (query && layers.projects.length > 0) {
    const matched = matchProjectsToQuery(layers.projects, query);
    let l2TotalChars = 0;
    for (const p of matched) {
      if (l2TotalChars >= MAX_L2_TOTAL_CHARS) break;
      const remaining = MAX_L2_TOTAL_CHARS - l2TotalChars;
      const cap = Math.min(MAX_L2_PROJECT_CHARS, remaining);
      const content = p.content.length > cap
        ? p.content.slice(0, cap) + "\n[...truncated]"
        : p.content;
      parts.push(`## Project: ${p.topic} (L2)\n${content}`);
      l2TotalChars += content.length;
    }
  }

  return parts.join("\n\n");
}
