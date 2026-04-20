/**
 * Asset Index — Scans ~/.alvin-bot/assets/ and builds a searchable registry.
 *
 * Produces:
 * - INDEX.json — machine-readable, used by self-search and skill injection
 * - INDEX.md — human-readable, injected into prompts for asset awareness
 *
 * Scan is filesystem-only (<5ms for ~60 files). No API calls.
 * Re-scans only when ASSETS_DIR has changed since last scan.
 */

import fs from "fs";
import path from "path";
import { ASSETS_DIR, ASSETS_INDEX_JSON, ASSETS_INDEX_MD } from "../paths.js";

// ── Types ───────────────────────────────────────────────

export interface AssetEntry {
  /** Relative path from ASSETS_DIR (e.g. "letters/acme-intro.html") */
  path: string;
  /** Full absolute path */
  absolutePath: string;
  /** Category derived from parent directory name */
  category: string;
  /** Filename only */
  filename: string;
  /** File extension including dot */
  ext: string;
  /** File size in bytes */
  size: number;
  /** Last modified ISO timestamp */
  modified: string;
  /** Auto-generated description from filename */
  description: string;
}

export interface AssetIndex {
  /** ISO timestamp of last scan */
  lastScan: string;
  /** All discovered assets */
  assets: AssetEntry[];
}

// ── Cache ───────────────────────────────────────────────

let cachedIndex: AssetIndex | null = null;

// ── Helpers ─────────────────────────────────────────────

/**
 * Walk a directory recursively, yielding file entries.
 */
function walkDir(dir: string): Array<{ name: string; path: string; relativePath: string }> {
  const results: Array<{ name: string; path: string; relativePath: string }> = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        // Skip INDEX.json and INDEX.md at ASSETS_DIR root
        if (currentDir === dir && (entry.name === "INDEX.json" || entry.name === "INDEX.md")) {
          continue;
        }
        results.push({
          name: entry.name,
          path: fullPath,
          relativePath: path.relative(dir, fullPath),
        });
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Generate a human-readable description from a filename.
 * "profile-photo.jpeg" → "Profile Photo"
 * "my-document.html"   → "My Document"
 */
function descriptionFromFilename(filename: string, category: string): string {
  const name = filename.replace(/\.[^.]+$/, ""); // strip extension
  const words = name.replace(/[-_]/g, " ").trim();
  // Prefix with capitalized category for disambiguation when the filename alone is terse
  const prefix = category ? category.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()) + ": " : "";
  const title = words.replace(/\b\w/g, c => c.toUpperCase());
  return prefix ? `${prefix}${title}` : title;
}

/**
 * Determine category for a file.
 * Files in subdirectories get the directory name as category.
 * Root-level files get a special category based on naming.
 */
function categorize(relativePath: string): string {
  const parts = relativePath.split(path.sep);
  if (parts.length > 1) {
    return parts[0]; // directory name
  }
  // Root-level file — categorize by pattern
  const filename = parts[0].toLowerCase();
  if (filename.includes("signature")) return "signatures";
  return "misc";
}

// ── Public API ──────────────────────────────────────────

/**
 * Scan ASSETS_DIR and write INDEX.json + INDEX.md.
 * Only re-scans if directory has changed since last scan.
 * Returns the asset index.
 */
export function scanAssets(): AssetIndex {
  if (!fs.existsSync(ASSETS_DIR)) {
    const empty: AssetIndex = { lastScan: new Date().toISOString(), assets: [] };
    cachedIndex = empty;
    return empty;
  }

  // Check if re-scan needed
  if (fs.existsSync(ASSETS_INDEX_JSON)) {
    try {
      const existing = JSON.parse(fs.readFileSync(ASSETS_INDEX_JSON, "utf-8")) as AssetIndex;
      const dirStat = fs.statSync(ASSETS_DIR);
      const lastScanTime = new Date(existing.lastScan).getTime();

      // Also check subdirectory mtimes (adding a file to a subdir changes subdir mtime, not parent)
      let newestMtime = dirStat.mtimeMs;
      try {
        const subdirs = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
        for (const d of subdirs) {
          if (d.isDirectory()) {
            const subStat = fs.statSync(path.resolve(ASSETS_DIR, d.name));
            if (subStat.mtimeMs > newestMtime) newestMtime = subStat.mtimeMs;
          }
        }
      } catch { /* ignore */ }

      if (newestMtime <= lastScanTime) {
        cachedIndex = existing;
        return existing;
      }
    } catch {
      // Corrupted index — re-scan
    }
  }

  // Full scan
  const files = walkDir(ASSETS_DIR);
  const assets: AssetEntry[] = [];

  for (const file of files) {
    try {
      const stat = fs.statSync(file.path);
      const category = categorize(file.relativePath);
      assets.push({
        path: file.relativePath,
        absolutePath: file.path,
        category,
        filename: file.name,
        ext: path.extname(file.name),
        size: stat.size,
        modified: new Date(stat.mtimeMs).toISOString(),
        description: descriptionFromFilename(file.name, category),
      });
    } catch {
      // File disappeared between readdir and stat — skip
    }
  }

  // Sort by category then filename
  assets.sort((a, b) => a.category.localeCompare(b.category) || a.filename.localeCompare(b.filename));

  const index: AssetIndex = {
    lastScan: new Date().toISOString(),
    assets,
  };

  // Write INDEX.json
  fs.writeFileSync(ASSETS_INDEX_JSON, JSON.stringify(index, null, 2));

  // Write INDEX.md
  const md = generateIndexMd(index);
  fs.writeFileSync(ASSETS_INDEX_MD, md);

  cachedIndex = index;
  return index;
}

/**
 * Load asset index from disk (cached after first call).
 */
export function loadAssetIndex(): AssetIndex {
  if (cachedIndex) return cachedIndex;

  if (fs.existsSync(ASSETS_INDEX_JSON)) {
    try {
      cachedIndex = JSON.parse(fs.readFileSync(ASSETS_INDEX_JSON, "utf-8")) as AssetIndex;
      return cachedIndex;
    } catch { /* fall through */ }
  }

  // No index — run scan
  return scanAssets();
}

/**
 * Get INDEX.md content for prompt injection.
 */
export function getAssetIndexMd(): string {
  if (fs.existsSync(ASSETS_INDEX_MD)) {
    return fs.readFileSync(ASSETS_INDEX_MD, "utf-8");
  }
  return "";
}

/**
 * Find assets by category name.
 */
export function findAssetsByCategory(category: string): AssetEntry[] {
  const index = loadAssetIndex();
  return index.assets.filter(a => a.category === category);
}

/**
 * Find assets by keyword match on filename, category, or description.
 */
export function findAssetsByKeyword(keywords: string[]): AssetEntry[] {
  const index = loadAssetIndex();
  const lower = keywords.map(k => k.toLowerCase());
  return index.assets.filter(a =>
    lower.some(k =>
      a.filename.toLowerCase().includes(k) ||
      a.category.toLowerCase().includes(k) ||
      a.description.toLowerCase().includes(k)
    )
  );
}

// ── INDEX.md Generator ──────────────────────────────────

function generateIndexMd(index: AssetIndex): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`## Your Assets (~/.alvin-bot/assets/) — ${date}\n`];

  // Group by category
  const byCategory = new Map<string, AssetEntry[]>();
  for (const a of index.assets) {
    const list = byCategory.get(a.category) || [];
    list.push(a);
    byCategory.set(a.category, list);
  }

  // Sort categories alphabetically
  const sortedCategories = [...byCategory.keys()].sort();

  for (const cat of sortedCategories) {
    const assets = byCategory.get(cat)!;
    const names = assets.map(a => a.filename);

    // Compact display: show up to 6 names, then "..."
    const display = names.length > 6
      ? names.slice(0, 5).join(", ") + `, ... (+${names.length - 5} more)`
      : names.join(", ");

    lines.push(`- **${cat}/** (${assets.length}): ${display}`);
  }

  const totalSize = index.assets.reduce((sum, a) => sum + a.size, 0);
  const sizeMB = (totalSize / 1_048_576).toFixed(1);
  lines.push(`\nTotal: ${index.assets.length} files, ${sizeMB} MB`);

  return lines.join("\n") + "\n";
}
