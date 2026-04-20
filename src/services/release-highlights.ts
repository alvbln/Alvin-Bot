/**
 * Release Highlights — extract a short human-readable summary for a given
 * version from CHANGELOG.md.
 *
 * Used by the /update command to tell users what actually changed after a
 * successful upgrade. Deliberately short — Telegram-friendly (<500 chars),
 * headline + up to 5 bullets, no markdown tables, no code blocks.
 */

import fs from "fs";
import path from "path";
import { BOT_ROOT } from "../paths.js";

const CHANGELOG_PATH = path.resolve(BOT_ROOT, "CHANGELOG.md");
const MAX_BULLETS = 5;
const MAX_CHARS = 500;

/**
 * Find the block for `## [<version>]` in CHANGELOG.md and return a
 * compact summary (headline + a few bullet points). Returns null if the
 * version block is not found or CHANGELOG.md is missing.
 */
export function getReleaseHighlights(version: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(CHANGELOG_PATH, "utf8");
  } catch {
    return null;
  }

  const versionEscaped = version.replace(/\./g, "\\.");
  // Match from "## [X.Y.Z]" up to the next "## [" (or end of file)
  const blockRe = new RegExp(
    `^##\\s*\\[${versionEscaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^##\\s*\\[|\\Z)`,
    "m",
  );
  const match = content.match(blockRe);
  if (!match) return null;

  return compactHighlights(match[1]);
}

/**
 * Extract up to MAX_BULLETS short lines from a CHANGELOG block.
 * Strategy:
 *   1. Prefer "### " subsection headlines (feature/fix titles)
 *   2. Otherwise the first few non-empty lines of the first paragraph
 * Truncate to MAX_CHARS total so it fits comfortably in a Telegram message.
 */
function compactHighlights(block: string): string {
  const lines = block.split("\n");
  const headlines: string[] = [];
  for (const line of lines) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (!m) continue;
    // Strip leading emoji/punctuation like "🚀 Feature: ..."
    const title = m[1].replace(/^[^a-zA-Z0-9]+/, "").replace(/\s+/g, " ").trim();
    if (title) headlines.push(title);
  }

  let bullets: string[];
  if (headlines.length > 0) {
    bullets = headlines.slice(0, MAX_BULLETS);
  } else {
    // Fallback: grab the first non-empty lines (skip bold marker paragraphs,
    // keep narrative). Limit to MAX_BULLETS lines.
    const flat = lines
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("```") && !l.startsWith("|"));
    bullets = flat.slice(0, MAX_BULLETS);
  }

  const rendered = bullets.map((b) => `• ${b}`).join("\n");
  if (rendered.length <= MAX_CHARS) return rendered;
  // Trim to fit — add a soft ellipsis on a whole line
  let out = "";
  for (const b of bullets) {
    const next = out ? out + "\n• " + b : "• " + b;
    if (next.length > MAX_CHARS - 4) break;
    out = next;
  }
  return out + "\n…";
}
