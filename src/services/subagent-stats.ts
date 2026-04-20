/**
 * Sub-Agent Stats (H3) — rolling 24h aggregation of per-agent run data.
 *
 * Append-only JSON ring buffer persisted to ~/.alvin-bot/subagent-stats.json.
 * On load, entries older than 24h are pruned. On each append, entries older
 * than 24h are pruned.
 *
 * Used by /subagents stats to show run totals per source (user, cron, implicit)
 * over the last 24 hours. No SQLite dependency — when a real SQLite migration
 * lands we can swap the backend without touching the consumer API.
 */

import os from "os";
import fs from "fs";
import { resolve, dirname } from "path";
import type { SubAgentInfo, SubAgentResult } from "./subagents.js";

const DATA_DIR = process.env.ALVIN_DATA_DIR || resolve(os.homedir(), ".alvin-bot");
const STATS_FILE = resolve(DATA_DIR, "subagent-stats.json");

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 5000; // hard cap to prevent unbounded growth on high-frequency bots

export interface StatsEntry {
  completedAt: number;
  name: string;
  source: "user" | "cron" | "implicit";
  status: "completed" | "timeout" | "error" | "cancelled";
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

let cache: StatsEntry[] | null = null;

function load(): StatsEntry[] {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STATS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      cache = [];
      return cache;
    }
    // Prune stale entries (> 24h old) on load
    const cutoff = Date.now() - WINDOW_MS;
    cache = parsed.filter(
      (e: unknown): e is StatsEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as StatsEntry).completedAt === "number" &&
        (e as StatsEntry).completedAt >= cutoff,
    );
    return cache;
  } catch {
    cache = [];
    return cache;
  }
}

function save(entries: StatsEntry[]): void {
  try {
    fs.mkdirSync(dirname(STATS_FILE), { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(entries, null, 0), "utf-8");
  } catch (err) {
    console.error("[subagent-stats] failed to write:", err);
  }
}

/**
 * Record a completed sub-agent run. Called from runSubAgent.finally() via
 * a side-effect hook. Automatically prunes entries older than 24h and
 * keeps the file bounded at MAX_ENTRIES.
 */
export function recordSubAgentRun(info: SubAgentInfo, result: SubAgentResult): void {
  const entries = load();
  const cutoff = Date.now() - WINDOW_MS;
  // Prune in-place
  const pruned = entries.filter((e) => e.completedAt >= cutoff);

  const newEntry: StatsEntry = {
    completedAt: Date.now(),
    name: info.name,
    source: (info.source ?? "implicit") as StatsEntry["source"],
    status: result.status,
    durationMs: result.duration,
    inputTokens: result.tokensUsed.input,
    outputTokens: result.tokensUsed.output,
  };
  pruned.push(newEntry);

  // Enforce hard cap — oldest entries drop first
  const final = pruned.length > MAX_ENTRIES ? pruned.slice(-MAX_ENTRIES) : pruned;
  cache = final;
  save(final);
}

export interface StatsSummary {
  windowHours: number;
  total: {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    totalDurationMs: number;
  };
  bySource: Record<
    "user" | "cron" | "implicit",
    {
      runs: number;
      inputTokens: number;
      outputTokens: number;
      totalDurationMs: number;
    }
  >;
  byStatus: Record<
    "completed" | "timeout" | "error" | "cancelled",
    number
  >;
}

/**
 * Compute a summary of the last 24h of sub-agent runs. Safe to call
 * concurrently with recordSubAgentRun — both read from the same cache.
 */
export function getSubAgentStats(): StatsSummary {
  const entries = load();
  const cutoff = Date.now() - WINDOW_MS;
  const recent = entries.filter((e) => e.completedAt >= cutoff);

  const empty = () => ({
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalDurationMs: 0,
  });

  const bySource: StatsSummary["bySource"] = {
    user: empty(),
    cron: empty(),
    implicit: empty(),
  };

  const byStatus: StatsSummary["byStatus"] = {
    completed: 0,
    timeout: 0,
    error: 0,
    cancelled: 0,
  };

  const total = empty();

  for (const e of recent) {
    const bucket = bySource[e.source] ?? bySource.implicit;
    bucket.runs += 1;
    bucket.inputTokens += e.inputTokens;
    bucket.outputTokens += e.outputTokens;
    bucket.totalDurationMs += e.durationMs;

    total.runs += 1;
    total.inputTokens += e.inputTokens;
    total.outputTokens += e.outputTokens;
    total.totalDurationMs += e.durationMs;

    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
  }

  return { windowHours: 24, total, bySource, byStatus };
}

/**
 * Reset the in-memory cache — for test isolation. Does NOT delete the
 * file; use ALVIN_DATA_DIR in tests to point at a fresh temp dir.
 */
export function __resetStatsCacheForTest(): void {
  cache = null;
}
