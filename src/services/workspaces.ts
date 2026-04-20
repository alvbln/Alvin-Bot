/**
 * Workspace Registry (v4.12.0)
 *
 * A workspace represents an isolated "project context" for Alvin. On Slack
 * each channel maps to a workspace (1:1 by explicit channel ID or by name
 * match). On Telegram, the user selects a workspace via /workspace.
 *
 * Config format: markdown files under ~/.alvin-bot/workspaces/<name>.md
 * with YAML frontmatter. The markdown body is the persona/system-prompt
 * override that gets appended to the base Alvin system prompt for queries
 * in that workspace.
 *
 * Example:
 *
 *   ---
 *   purpose: my-project website dev
 *   cwd: ~/Projects/my-project
 *   emoji: "🏢"
 *   color: "#6366f1"
 *   channels: ["C01EXAMPLE"]
 *   ---
 *   You are the my-project dev assistant. Stack: React + Express + Drizzle + MySQL.
 *   Prefer concise, directly actionable answers about deployment...
 *
 * If no workspaces are configured or no match is found, a built-in "default"
 * workspace is used — it has an empty persona, inherits the global default
 * working directory, and is the natural fallback so existing single-session
 * behavior is preserved for users who don't create any workspace configs.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { WORKSPACES_DIR } from "../paths.js";
import { config } from "../config.js";

export interface Workspace {
  /** Filename without .md extension, also the display key */
  name: string;
  /** Short one-liner purpose/description */
  purpose: string;
  /** Absolute working directory for Claude SDK queries in this workspace */
  cwd: string;
  /** Optional display color (hex) */
  color?: string;
  /** Optional display emoji */
  emoji?: string;
  /** Explicit channel IDs mapped to this workspace (e.g. Slack C01ABC...) */
  channels: string[];
  /** Markdown body — injected into the system prompt as a persona block */
  systemPromptOverride: string;
  /**
   * Optional per-workspace model override. Accepts Claude CLI aliases
   * ("opus" | "sonnet" | "haiku") for auto-latest, or a pinned ID
   * ("claude-opus-4-7"). When undefined, the globally active provider's
   * model is used — i.e. whatever the user has picked via /model.
   */
  model?: string;
}

const registry = new Map<string, Workspace>();

/** Expand ~ at the start of a path to the user's home directory. */
function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.resolve(os.homedir(), p.slice(2));
  return p;
}

/** Parse a very simple YAML subset: key: value pairs + arrays in JSON form.
 *  We deliberately don't pull in a full YAML library — the frontmatter schema
 *  is tiny and well-defined. Falls back to an empty object on any parse error. */
function parseFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (!value) continue;
    // JSON array
    if (value.startsWith("[")) {
      try {
        out[key] = JSON.parse(value);
        continue;
      } catch {
        continue;
      }
    }
    // Quoted string
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Split a markdown file into frontmatter (YAML) and body. Returns both as
 *  strings. If no frontmatter delimiters are found, frontmatter is empty and
 *  the whole content is the body. */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const trimmed = content.replace(/^\uFEFF/, "");
  const match = trimmed.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: "", body: trimmed };
  return { frontmatter: match[1], body: match[2] };
}

/** Read a single workspace file and return the parsed object, or null on failure. */
function readWorkspaceFile(filePath: string, name: string): Workspace | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter, body } = splitFrontmatter(content);
    const fm = parseFrontmatter(frontmatter);

    const purpose = typeof fm.purpose === "string" ? fm.purpose : "";
    const rawCwd = typeof fm.cwd === "string" ? fm.cwd : config.defaultWorkingDir;
    const cwd = expandHome(rawCwd);
    const color = typeof fm.color === "string" ? fm.color : undefined;
    const emoji = typeof fm.emoji === "string" ? fm.emoji : undefined;
    const model = typeof fm.model === "string" && fm.model.trim() ? fm.model.trim() : undefined;
    const channels = Array.isArray(fm.channels)
      ? fm.channels.filter((c): c is string => typeof c === "string")
      : [];

    return {
      name,
      purpose,
      cwd,
      color,
      emoji,
      channels,
      model,
      systemPromptOverride: body.trim(),
    };
  } catch (err) {
    console.warn(
      `⚠️ workspaces: failed to load ${filePath} —`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Load all workspaces from ~/.alvin-bot/workspaces/*.md. Returns the count loaded. */
export function loadWorkspaces(): number {
  registry.clear();
  if (!fs.existsSync(WORKSPACES_DIR)) return 0;

  let count = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(WORKSPACES_DIR);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
    const name = entry.replace(/\.md$/, "");
    const filePath = path.resolve(WORKSPACES_DIR, entry);
    const ws = readWorkspaceFile(filePath, name);
    if (ws) {
      registry.set(name, ws);
      count++;
    }
  }

  return count;
}

/** Alias for loadWorkspaces — used by the hot-reload file watcher. */
export function reloadWorkspaces(): number {
  return loadWorkspaces();
}

/** Return all registered workspaces. */
export function listWorkspaces(): Workspace[] {
  return Array.from(registry.values());
}

/** Get a workspace by name, or null. */
export function getWorkspace(name: string): Workspace | null {
  return registry.get(name) ?? null;
}

/** Built-in fallback workspace. Returned when no user workspaces exist or
 *  no channel-match can be made. Preserves the pre-v4.12.0 behavior. */
export function getDefaultWorkspace(): Workspace {
  return {
    name: "default",
    purpose: "",
    cwd: config.defaultWorkingDir,
    channels: [],
    systemPromptOverride: "",
  };
}

/** Try to resolve a platform + channel to a specific workspace.
 *
 * Resolution order:
 *   1. Explicit channel ID match (workspace frontmatter `channels: ["C01ABC"]`)
 *   2. Channel name match (workspace filename equals the normalized channel name)
 *   3. Return null (caller should fall back to the default workspace)
 *
 * Normalization: strips leading `#`, lowercases, trims whitespace.
 */
export function matchWorkspaceForChannel(
  _platform: string,
  channelId: string,
  channelName: string | undefined,
): Workspace | null {
  // 1. Channel ID match
  for (const ws of registry.values()) {
    if (ws.channels.includes(channelId)) return ws;
  }

  // 2. Channel name match against workspace filename
  if (channelName) {
    const normalized = channelName.replace(/^#/, "").trim().toLowerCase();
    for (const ws of registry.values()) {
      if (ws.name.toLowerCase() === normalized) return ws;
    }
  }

  return null;
}

/** Resolve a channel to a workspace, falling back to the default when no
 *  match is found. This is the one-call path handlers should use. */
export function resolveWorkspaceOrDefault(
  platform: string,
  channelId: string,
  channelName?: string,
): Workspace {
  const match = matchWorkspaceForChannel(platform, channelId, channelName);
  return match ?? getDefaultWorkspace();
}

// ── Hot-reload watcher ──────────────────────────────────────────────────

let watcher: fs.FSWatcher | null = null;
let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Start watching the workspaces directory for file changes. Debounced reload
 *  at 500 ms so a burst of edits (e.g. git checkout) coalesces into one reload. */
export function startWorkspaceWatcher(): void {
  if (watcher) return;
  if (!fs.existsSync(WORKSPACES_DIR)) return;
  try {
    watcher = fs.watch(WORKSPACES_DIR, () => {
      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = setTimeout(() => {
        const count = reloadWorkspaces();
        console.log(`🧭 workspaces: hot-reloaded (${count} registered)`);
      }, 500);
    });
  } catch {
    // ignore — hot-reload is a nice-to-have
  }
}

/** Stop the hot-reload watcher (for graceful shutdown). */
export function stopWorkspaceWatcher(): void {
  if (watcher) {
    try { watcher.close(); } catch { /* ignore */ }
    watcher = null;
  }
  if (reloadDebounceTimer) {
    clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = null;
  }
}

/** Initialize: load all workspaces + start hot-reload watcher. Called once at startup. */
export function initWorkspaces(): number {
  const count = loadWorkspaces();
  startWorkspaceWatcher();
  if (count > 0) {
    const names = listWorkspaces().map(w => `${w.emoji ?? "🧭"} ${w.name}`).join(", ");
    console.log(`🧭 Workspaces: ${count} loaded — ${names}`);
  }
  return count;
}
