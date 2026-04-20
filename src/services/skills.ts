/**
 * Skill System — Specialized knowledge for complex tasks.
 *
 * Skills are SKILL.md files in the skills/ directory that provide
 * domain-specific instructions, workflows, and best practices.
 *
 * When a user message matches a skill's triggers, the skill's content
 * is injected into the system prompt — giving the agent deep expertise
 * for that specific task type.
 *
 * Philosophy: A generalist agent with specialist knowledge on demand.
 *
 * Features:
 * - Bundled skills (skills/ in repo) + User skills (~/.alvin-bot/skills/)
 * - User skills override bundled skills with the same ID
 * - Hot-reload via fs.watch() on both directories
 * - Self-modification via createSkill()
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, watch } from "fs";
import { resolve } from "path";
import { SKILLS_DIR } from "../paths.js";
import { USER_SKILLS_DIR } from "../paths.js";
import { loadAssetIndex, type AssetEntry } from "./asset-index.js";
import { debounce } from "../util/debounce.js";

// ── Types ───────────────────────────────────────────────

export interface Skill {
  /** Unique skill ID (directory name) */
  id: string;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
  /** Trigger keywords/phrases (lowercase) */
  triggers: string[];
  /** Full SKILL.md content */
  content: string;
  /** Priority (higher = preferred when multiple match) */
  priority: number;
  /** Category for grouping */
  category: string;
  /** Source: "bundled" or "user" */
  source: "bundled" | "user";
  /** Asset categories this skill needs (from frontmatter or static map) */
  assetCategories?: string[];
}

// ── Skill Registry ──────────────────────────────────────

let cachedSkills: Skill[] = [];
let lastScanAt = 0;

/**
 * Parse SKILL.md frontmatter (simple YAML-like header).
 *
 * Format:
 * ---
 * name: Video Creation
 * description: Create videos with Remotion
 * triggers: video, remotion, animation, render
 * priority: 5
 * category: media
 * ---
 * (rest is the skill content)
 */
function parseSkillFile(id: string, content: string, source: "bundled" | "user"): Skill | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    // No frontmatter — treat entire file as content with defaults
    return {
      id,
      name: id.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      description: "",
      triggers: [id.replace(/-/g, " ")],
      content: content.trim(),
      priority: 1,
      category: "general",
      source,
    };
  }

  const frontmatter = fmMatch[1];
  const body = fmMatch[2].trim();

  function getField(key: string): string {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match ? match[1].trim() : "";
  }

  const name = getField("name") || id;
  const description = getField("description") || "";
  const triggersRaw = getField("triggers") || id;
  const priority = parseInt(getField("priority")) || 1;
  const category = getField("category") || "general";

  const assetCategoriesRaw = getField("assetCategories");
  const assetCategories = assetCategoriesRaw
    ? assetCategoriesRaw.replace(/[\[\]]/g, "").split(",").map(s => s.trim()).filter(Boolean)
    : undefined;

  const triggers = triggersRaw
    .split(",")
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);

  return { id, name, description, triggers, content: body, priority, category, source, assetCategories };
}

/**
 * Scan a single skills directory and return all parsed skills.
 */
function scanDirectory(dir: string, source: "bundled" | "user"): Skill[] {
  if (!existsSync(dir)) return [];

  const skills: Skill[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillFile = resolve(dir, entry.name, "SKILL.md");
      if (existsSync(skillFile)) {
        try {
          const content = readFileSync(skillFile, "utf-8");
          const skill = parseSkillFile(entry.name, content, source);
          if (skill) skills.push(skill);
        } catch (err) {
          console.warn(`\u26a0\ufe0f Failed to load skill ${entry.name}:`, err);
        }
      }
    }
    // Also support flat .md files in skills/
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const id = entry.name.replace(/\.md$/, "");
      try {
        const content = readFileSync(resolve(dir, entry.name), "utf-8");
        const skill = parseSkillFile(id, content, source);
        if (skill) skills.push(skill);
      } catch (err) {
        console.warn(`\u26a0\ufe0f Failed to load skill ${id}:`, err);
      }
    }
  }

  return skills;
}

/**
 * Reload all skills from both directories.
 * User skills override bundled skills with the same ID.
 */
function reloadAllSkills(): void {
  // Ensure bundled directory exists
  if (!existsSync(SKILLS_DIR)) {
    mkdirSync(SKILLS_DIR, { recursive: true });
  }

  const bundled = scanDirectory(SKILLS_DIR, "bundled");
  const user = scanDirectory(USER_SKILLS_DIR, "user");

  // Merge: user skills override bundled skills with same ID
  const skillMap = new Map<string, Skill>();
  for (const s of bundled) skillMap.set(s.id, s);
  for (const s of user) skillMap.set(s.id, s); // override

  cachedSkills = [...skillMap.values()];
  lastScanAt = Date.now();

  if (cachedSkills.length > 0) {
    const bundledCount = cachedSkills.filter(s => s.source === "bundled").length;
    const userCount = cachedSkills.filter(s => s.source === "user").length;
    console.log(`\ud83c\udfaf Skills loaded: ${cachedSkills.length} (${bundledCount} bundled, ${userCount} user) — ${cachedSkills.map(s => s.name).join(", ")}`);
  }
}

/**
 * Scan both skills directories and load all SKILL.md files.
 * Sets up fs.watch() for hot-reload on both directories.
 */
export function loadSkills(): Skill[] {
  reloadAllSkills();

  // Hot-reload watchers — macOS FSEvents delivers many duplicate events
  // for a single logical change, so we coalesce bursts into one reload.
  const bundledReload = debounce(() => {
    console.log("Skills changed (bundled) \u2014 reloading");
    reloadAllSkills();
  }, 300);
  const userReload = debounce(() => {
    console.log("Skills changed (user) \u2014 reloading");
    reloadAllSkills();
  }, 300);

  try {
    watch(SKILLS_DIR, { recursive: true }, () => bundledReload());
  } catch { /* ignore — watcher failures fall back to manual reload */ }
  try {
    if (existsSync(USER_SKILLS_DIR)) {
      watch(USER_SKILLS_DIR, { recursive: true }, () => userReload());
    }
  } catch { /* ignore */ }

  return cachedSkills;
}

/**
 * Get all loaded skills. Cached after the first loadSkills() call; hot-reload
 * happens via fs.watch when files change on disk. We only force a scan here if
 * the cache is empty (init-order edge case).
 */
export function getSkills(): Skill[] {
  if (cachedSkills.length === 0) {
    reloadAllSkills();
  }
  return cachedSkills;
}

/**
 * Find a skill by its ID.
 */
export function getSkillById(id: string): Skill | undefined {
  return cachedSkills.find(s => s.id === id);
}

/**
 * Create or update a user skill (self-modification).
 * Writes to USER_SKILLS_DIR and triggers reload.
 */
export function createSkill(id: string, content: string): boolean {
  const dir = resolve(USER_SKILLS_DIR, id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "SKILL.md"), content);
  // Trigger reload
  reloadAllSkills();
  return true;
}

/**
 * Find skills that match a user message.
 * Returns matched skills sorted by priority (highest first).
 */
export function matchSkills(userMessage: string, maxResults = 2): Skill[] {
  const skills = getSkills();
  if (skills.length === 0) return [];

  const msgLower = userMessage.toLowerCase();
  const words = msgLower.split(/[\s,.!?;:()[\]{}'"]+/).filter(w => w.length >= 2);
  const wordSet = new Set(words);

  const scored: Array<{ skill: Skill; score: number }> = [];

  for (const skill of skills) {
    let score = 0;

    for (const trigger of skill.triggers) {
      // Exact phrase match (strongest signal)
      if (msgLower.includes(trigger)) {
        score += trigger.split(" ").length * 3; // multi-word triggers score higher
      }
      // Single-word trigger match
      else if (trigger.split(" ").length === 1 && wordSet.has(trigger)) {
        score += 1;
      }
    }

    if (score > 0) {
      scored.push({ skill, score: score * skill.priority });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.skill);
}

// ── Skill-Asset Mapping ────────────────────────────────

/** Default mapping for skills that don't declare assetCategories in frontmatter.
 *  Skills can override this by declaring `assetCategories:` in their SKILL.md
 *  frontmatter. This map is only the fallback. */
const SKILL_ASSET_MAP: Record<string, string[]> = {};

/**
 * Find assets relevant to a skill.
 * Uses frontmatter assetCategories if declared, otherwise falls back to static map.
 */
function findAssetsForSkill(skill: Skill): AssetEntry[] {
  const categories = skill.assetCategories || SKILL_ASSET_MAP[skill.id];
  if (!categories || categories.length === 0) return [];

  const index = loadAssetIndex();
  return index.assets.filter(a => categories.includes(a.category));
}

/**
 * Build a skill injection block for the system prompt.
 * Includes matched skill content + relevant asset references.
 */
export function buildSkillContext(userMessage: string): string {
  const matched = matchSkills(userMessage, 1); // inject top 1 skill only
  if (matched.length === 0) return "";

  const skill = matched[0];
  let context = `\n\n## 🎯 Active Skill: ${skill.name}\n\n${skill.content}`;

  // Inject relevant assets for this skill
  const assets = findAssetsForSkill(skill);
  if (assets.length > 0) {
    context += `\n\n### 📂 Relevant Assets\n`;
    for (const a of assets) {
      context += `- ${a.category}/${a.filename} → \`${a.absolutePath}\`\n`;
    }
  }

  return context;
}

/**
 * Get a summary of all available skills (for /skills command or status).
 */
export function getSkillsSummary(): string {
  const skills = getSkills();
  if (skills.length === 0) return "No skills installed.";

  const byCategory = new Map<string, Skill[]>();
  for (const s of skills) {
    const list = byCategory.get(s.category) || [];
    list.push(s);
    byCategory.set(s.category, list);
  }

  const lines: string[] = [`\ud83c\udfaf **Skills (${skills.length}):**\n`];
  for (const [cat, list] of byCategory) {
    lines.push(`**${cat}:**`);
    for (const s of list) {
      const badge = s.source === "user" ? " \ud83d\udc64" : "";
      lines.push(`  \u2022 ${s.name}${badge} \u2014 ${s.description || "(no description)"}`);
    }
  }
  return lines.join("\n");
}
