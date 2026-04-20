/**
 * Usage Tracker — Persistent daily/weekly usage stats.
 *
 * Tracks token counts, costs, and query counts per provider per day.
 * Persists to ~/.alvin-bot/usage.json. Calculates daily/weekly summaries.
 *
 * Also stores the last-seen rate limit headers from providers (in-memory only).
 */

import fs from "fs";
import path from "path";
import { DATA_DIR } from "../paths.js";

const USAGE_FILE = path.join(DATA_DIR, "usage.json");

// ── Types ────────────────────────────────────────────────────────────

export interface ProviderDayStats {
  queries: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface DayStats {
  queries: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  byProvider: Record<string, ProviderDayStats>;
}

interface UsageData {
  daily: Record<string, DayStats>; // keyed by YYYY-MM-DD
}

export interface RateLimitInfo {
  requestsLimit?: number;
  requestsRemaining?: number;
  requestsReset?: string;
  tokensLimit?: number;
  tokensRemaining?: number;
  tokensReset?: string;
  inputTokensRemaining?: number;
  outputTokensRemaining?: number;
  updatedAt: number;
}

export interface UsageSummary {
  today: DayStats;
  week: DayStats;
  daysTracked: number;
  avgDailyTokens: number;
  avgDailyCost: number;
}

// ── State ────────────────────────────────────────────────────────────

/** Last-seen rate limit info per provider (in-memory, not persisted) */
const rateLimits = new Map<string, RateLimitInfo>();

// ── Persistence ──────────────────────────────────────────────────────

function loadUsage(): UsageData {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8"));
  } catch {
    return { daily: {} };
  }
}

function saveUsage(data: UsageData): void {
  // Prune entries older than 90 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  for (const key of Object.keys(data.daily)) {
    if (key < cutoffStr) delete data.daily[key];
  }

  fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Public API ───────────────────────────────────────────────────────

/** Record a completed query's usage. Called after each provider response. */
export function trackUsage(
  providerKey: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  const data = loadUsage();
  const key = todayKey();

  if (!data.daily[key]) {
    data.daily[key] = { queries: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, byProvider: {} };
  }
  const day = data.daily[key];
  day.queries++;
  day.inputTokens += inputTokens;
  day.outputTokens += outputTokens;
  day.costUsd += costUsd;

  if (!day.byProvider[providerKey]) {
    day.byProvider[providerKey] = { queries: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
  const prov = day.byProvider[providerKey];
  prov.queries++;
  prov.inputTokens += inputTokens;
  prov.outputTokens += outputTokens;
  prov.costUsd += costUsd;

  saveUsage(data);
}

/** Get usage summary (today + last 7 days). */
export function getUsageSummary(): UsageSummary {
  const data = loadUsage();
  const today = todayKey();

  const emptyDay: DayStats = { queries: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, byProvider: {} };
  const todayStats = data.daily[today] || emptyDay;

  // Week = last 7 days including today
  const weekStats: DayStats = { queries: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, byProvider: {} };
  const now = new Date();
  let daysWithData = 0;

  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const day = data.daily[key];
    if (day) {
      daysWithData++;
      weekStats.queries += day.queries;
      weekStats.inputTokens += day.inputTokens;
      weekStats.outputTokens += day.outputTokens;
      weekStats.costUsd += day.costUsd;

      for (const [pk, ps] of Object.entries(day.byProvider)) {
        if (!weekStats.byProvider[pk]) {
          weekStats.byProvider[pk] = { queries: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        }
        weekStats.byProvider[pk].queries += ps.queries;
        weekStats.byProvider[pk].inputTokens += ps.inputTokens;
        weekStats.byProvider[pk].outputTokens += ps.outputTokens;
        weekStats.byProvider[pk].costUsd += ps.costUsd;
      }
    }
  }

  const totalDays = Object.keys(data.daily).length;

  // Average is computed over the same 7-day window as `week` so it
  // stays internally consistent: a user reading "Week: 250M" directly
  // above "Avg: 50M/day" would otherwise rightly assume 50×7=350 and
  // conclude the bot was lying. Previously the avg was total-ever/days-ever
  // which diverged from week/7 as soon as usage was uneven or the bot
  // was only a few days old.
  const weekTokens = weekStats.inputTokens + weekStats.outputTokens;
  const avgTokensPerDay = Math.round(weekTokens / 7);
  const avgCostPerDay = weekStats.costUsd / 7;

  return {
    today: todayStats,
    week: weekStats,
    daysTracked: totalDays,
    avgDailyTokens: avgTokensPerDay,
    avgDailyCost: avgCostPerDay,
  };
}

/** Store rate limit info from provider response headers. */
export function updateRateLimits(providerKey: string, info: Partial<RateLimitInfo>): void {
  rateLimits.set(providerKey, { ...info, updatedAt: Date.now() } as RateLimitInfo);
}

/** Get last-seen rate limits for a provider. Returns null if no data or stale (>5min). */
export function getRateLimits(providerKey: string): RateLimitInfo | null {
  const info = rateLimits.get(providerKey);
  if (!info) return null;
  // Stale after 5 minutes
  if (Date.now() - info.updatedAt > 300_000) return null;
  return info;
}

/** Get all non-stale rate limits. */
export function getAllRateLimits(): Map<string, RateLimitInfo> {
  const result = new Map<string, RateLimitInfo>();
  const now = Date.now();
  for (const [key, info] of rateLimits) {
    if (now - info.updatedAt < 300_000) {
      result.set(key, info);
    }
  }
  return result;
}

/** Format token count for display (e.g., 45200 → "45.2K") */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
