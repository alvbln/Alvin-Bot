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
 */

import fs from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILLS_DIR = resolve(BOT_ROOT, "skills");

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
function parseSkillFile(id: string, content: string): Skill | null {
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

  const triggers = triggersRaw
    .split(",")
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);

  return { id, name, description, triggers, content: body, priority, category };
}

/**
 * Scan the skills/ directory and load all SKILL.md files.
 */
export function loadSkills(): Skill[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    return [];
  }

  const skills: Skill[] = [];

  // Scan for directories with SKILL.md
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillFile = resolve(SKILLS_DIR, entry.name, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        try {
          const content = fs.readFileSync(skillFile, "utf-8");
          const skill = parseSkillFile(entry.name, content);
          if (skill) skills.push(skill);
        } catch (err) {
          console.warn(`⚠️ Failed to load skill ${entry.name}:`, err);
        }
      }
    }
    // Also support flat .md files in skills/
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const id = entry.name.replace(/\.md$/, "");
      try {
        const content = fs.readFileSync(resolve(SKILLS_DIR, entry.name), "utf-8");
        const skill = parseSkillFile(id, content);
        if (skill) skills.push(skill);
      } catch (err) {
        console.warn(`⚠️ Failed to load skill ${id}:`, err);
      }
    }
  }

  cachedSkills = skills;
  lastScanAt = Date.now();
  if (skills.length > 0) {
    console.log(`🎯 Skills loaded: ${skills.map(s => s.name).join(", ")}`);
  }
  return skills;
}

/**
 * Get all loaded skills.
 */
export function getSkills(): Skill[] {
  if (cachedSkills.length === 0 || Date.now() - lastScanAt > 300_000) {
    loadSkills();
  }
  return cachedSkills;
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

/**
 * Build a skill injection block for the system prompt.
 * Only injects if relevant skills are found.
 */
export function buildSkillContext(userMessage: string): string {
  const matched = matchSkills(userMessage, 1); // inject top 1 skill only
  if (matched.length === 0) return "";

  const skill = matched[0];
  return `\n\n## 🎯 Active Skill: ${skill.name}\n\n${skill.content}`;
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

  const lines: string[] = [`🎯 **Skills (${skills.length}):**\n`];
  for (const [cat, list] of byCategory) {
    lines.push(`**${cat}:**`);
    for (const s of list) {
      lines.push(`  • ${s.name} — ${s.description || "(no description)"}`);
    }
  }
  return lines.join("\n");
}
