/**
 * Memory Service — Persistent memory across sessions.
 *
 * Manages:
 * - MEMORY.md (long-term, curated knowledge)
 * - memory/YYYY-MM-DD.md (daily session logs)
 * - Auto-write session summaries on /new
 * - Load context at session start
 */

import fs from "fs";
import path from "path";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS_DIR = resolve(BOT_ROOT, "docs");
const MEMORY_DIR = resolve(DOCS_DIR, "memory");
const MEMORY_FILE = resolve(DOCS_DIR, "MEMORY.md");

// Ensure dirs exist
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });

/** Get today's date as YYYY-MM-DD */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Get current time as HH:MM */
function now(): string {
  return new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Load long-term memory (MEMORY.md).
 */
export function loadLongTermMemory(): string {
  try {
    return fs.readFileSync(MEMORY_FILE, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Load today's daily log.
 */
export function loadDailyLog(date?: string): string {
  const d = date || today();
  const filePath = resolve(MEMORY_DIR, `${d}.md`);
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Append an entry to today's daily log.
 */
export function appendDailyLog(entry: string): void {
  const filePath = resolve(MEMORY_DIR, `${today()}.md`);
  const header = `# ${today()} — Session Log\n\n`;

  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    content = header;
  }

  content += `\n## ~${now()}\n\n${entry}\n`;
  fs.writeFileSync(filePath, content);
}

/**
 * Build memory context for injection into non-SDK prompts.
 * Returns relevant memory as a compact string.
 */
export function buildMemoryContext(): string {
  const parts: string[] = [];

  // Long-term memory (truncate if too long)
  const ltm = loadLongTermMemory();
  if (ltm) {
    const truncated = ltm.length > 2000 ? ltm.slice(0, 2000) + "\n[...truncated]" : ltm;
    parts.push(`## Langzeitgedächtnis\n${truncated}`);
  }

  // Today's log
  const todayLog = loadDailyLog();
  if (todayLog) {
    const truncated = todayLog.length > 1500 ? todayLog.slice(-1500) : todayLog;
    parts.push(`## Heutiges Log\n${truncated}`);
  }

  // Yesterday's log (for continuity)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const yesterdayLog = loadDailyLog(yesterday);
  if (yesterdayLog) {
    const truncated = yesterdayLog.length > 500 ? yesterdayLog.slice(-500) : yesterdayLog;
    parts.push(`## Gestriges Log (Kurzfassung)\n${truncated}`);
  }

  if (parts.length === 0) return "";

  return `\n\n---\n## Dein Gedächtnis (automatisch geladen)\n\n${parts.join("\n\n")}`;
}

/**
 * Write a session summary to daily log.
 * Called when user does /new or session is long enough.
 */
export function writeSessionSummary(summary: {
  messageCount: number;
  toolUseCount: number;
  costUsd: number;
  provider: string;
  topics?: string[];
}): void {
  const lines = [
    `**Session-Zusammenfassung:**`,
    `- Nachrichten: ${summary.messageCount}`,
    `- Tool-Calls: ${summary.toolUseCount}`,
    `- Kosten: $${summary.costUsd.toFixed(4)}`,
    `- Provider: ${summary.provider}`,
  ];

  if (summary.topics && summary.topics.length > 0) {
    lines.push(`- Themen: ${summary.topics.join(", ")}`);
  }

  appendDailyLog(lines.join("\n"));
}

/**
 * Get memory stats for /status.
 */
export function getMemoryStats(): { longTermSize: number; dailyLogs: number; todayEntries: number } {
  let longTermSize = 0;
  try {
    longTermSize = fs.statSync(MEMORY_FILE).size;
  } catch { /* empty */ }

  let dailyLogs = 0;
  try {
    dailyLogs = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md") && f !== ".gitkeep").length;
  } catch { /* empty */ }

  let todayEntries = 0;
  const todayLog = loadDailyLog();
  if (todayLog) {
    todayEntries = (todayLog.match(/^## ~/gm) || []).length;
  }

  return { longTermSize, dailyLogs, todayEntries };
}
