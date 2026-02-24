/**
 * Cron Service — Persistent scheduled tasks.
 *
 * Supports:
 * - Interval-based jobs (every 5m, 1h, etc.)
 * - Cron expressions (0 9 * * 1 = every Monday 9am)
 * - One-shot scheduled tasks (run once at a specific time)
 * - Job types: reminder, shell, ai-query, http
 * - Management via /cron command + Web UI
 * - Persisted to docs/cron-jobs.json (survives restarts)
 */

import fs from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CRON_FILE = resolve(BOT_ROOT, "docs", "cron-jobs.json");

// ── Types ───────────────────────────────────────────────

export type JobType = "reminder" | "shell" | "ai-query" | "http" | "message";

export interface CronJob {
  /** Unique ID */
  id: string;
  /** Display name */
  name: string;
  /** Job type */
  type: JobType;
  /** Schedule: cron expression OR interval string (5m, 1h, 1d) */
  schedule: string;
  /** Whether this is a one-shot (run once then delete) */
  oneShot: boolean;
  /** Job payload */
  payload: {
    /** For reminder/message: text to send */
    text?: string;
    /** For shell: command to execute */
    command?: string;
    /** For ai-query: prompt to send to AI */
    prompt?: string;
    /** For http: URL + method */
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
  /** Target: where to send results (chatId for Telegram, "web" for dashboard) */
  target: {
    platform: "telegram" | "discord" | "whatsapp" | "web";
    chatId: string;
  };
  /** Job state */
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  lastResult: string | null;
  lastError: string | null;
  nextRunAt: number | null;
  runCount: number;
  /** Creator info */
  createdBy: string;
}

// ── Storage ─────────────────────────────────────────────

function loadJobs(): CronJob[] {
  try {
    return JSON.parse(fs.readFileSync(CRON_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveJobs(jobs: CronJob[]): void {
  const dir = resolve(BOT_ROOT, "docs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CRON_FILE, JSON.stringify(jobs, null, 2));
}

// ── Cron Parsing ────────────────────────────────────────

/**
 * Parse an interval string (5m, 1h, 30s, 2d) to milliseconds.
 */
function parseInterval(input: string): number | null {
  const match = input.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)s?$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const mult: Record<string, number> = { s: 1000, sec: 1000, m: 60_000, min: 60_000, h: 3_600_000, hr: 3_600_000, d: 86_400_000, day: 86_400_000 };
  return value * (mult[unit] || 60_000);
}

/**
 * Parse a cron expression and find the next run time.
 * Supports: minute hour day month weekday
 * Simple implementation — covers common cases.
 */
function nextCronRun(expression: string, after: Date = new Date()): Date | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minExpr, hourExpr, dayExpr, monthExpr, weekdayExpr] = parts;

  function parseField(expr: string, min: number, max: number): number[] {
    if (expr === "*") return Array.from({ length: max - min + 1 }, (_, i) => i + min);
    if (expr.includes("/")) {
      const [, step] = expr.split("/");
      const s = parseInt(step);
      return Array.from({ length: max - min + 1 }, (_, i) => i + min).filter(v => v % s === 0);
    }
    if (expr.includes(",")) return expr.split(",").map(Number);
    if (expr.includes("-")) {
      const [a, b] = expr.split("-").map(Number);
      return Array.from({ length: b - a + 1 }, (_, i) => i + a);
    }
    return [parseInt(expr)];
  }

  const minutes = parseField(minExpr, 0, 59);
  const hours = parseField(hourExpr, 0, 23);
  const days = parseField(dayExpr, 1, 31);
  const months = parseField(monthExpr, 1, 12);
  const weekdays = parseField(weekdayExpr, 0, 6); // 0=Sun

  // Search forward up to 366 days
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60; i++) {
    const m = candidate.getMinutes();
    const h = candidate.getHours();
    const d = candidate.getDate();
    const mo = candidate.getMonth() + 1;
    const wd = candidate.getDay();

    if (minutes.includes(m) && hours.includes(h) && days.includes(d) && months.includes(mo) && weekdays.includes(wd)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

/**
 * Calculate next run time for a job.
 */
function calculateNextRun(job: CronJob): number | null {
  if (!job.enabled) return null;

  // Interval-based
  const intervalMs = parseInterval(job.schedule);
  if (intervalMs) {
    const base = job.lastRunAt || job.createdAt;
    return base + intervalMs;
  }

  // Cron expression
  const next = nextCronRun(job.schedule);
  return next ? next.getTime() : null;
}

// ── Job Execution ───────────────────────────────────────

type NotifyFn = (target: CronJob["target"], text: string) => Promise<void>;
let notifyCallback: NotifyFn | null = null;

export function setNotifyCallback(fn: NotifyFn): void {
  notifyCallback = fn;
}

async function executeJob(job: CronJob): Promise<{ output: string; error?: string }> {
  try {
    switch (job.type) {
      case "reminder":
      case "message": {
        const text = job.payload.text || "(no message)";
        if (notifyCallback) {
          await notifyCallback(job.target, `⏰ ${job.name}\n\n${text}`);
        }
        return { output: `Sent: ${text.slice(0, 100)}` };
      }

      case "shell": {
        const cmd = job.payload.command || "echo 'no command'";
        const output = execSync(cmd, {
          timeout: 60_000,
          stdio: "pipe",
          env: { ...process.env, PATH: process.env.PATH + ":/opt/homebrew/bin:/usr/local/bin" },
        }).toString().trim();
        // Notify with output
        if (notifyCallback && output) {
          await notifyCallback(job.target, `🔧 ${job.name}\n\`\`\`\n${output.slice(0, 3000)}\n\`\`\``);
        }
        return { output: output.slice(0, 5000) };
      }

      case "http": {
        const url = job.payload.url || "";
        const method = job.payload.method || "GET";
        const headers = job.payload.headers || {};
        const fetchOpts: RequestInit = { method, headers };
        if (job.payload.body && method !== "GET") {
          fetchOpts.body = job.payload.body;
        }
        const res = await fetch(url, fetchOpts);
        const text = await res.text();
        const output = `HTTP ${res.status}: ${text.slice(0, 2000)}`;
        if (notifyCallback) {
          await notifyCallback(job.target, `🌐 ${job.name}\n${output.slice(0, 500)}`);
        }
        return { output };
      }

      case "ai-query": {
        // AI queries are handled by sending the prompt as a message
        const prompt = job.payload.prompt || "";
        if (notifyCallback) {
          await notifyCallback(job.target, `🤖 Cron AI-Query: ${prompt}`);
        }
        return { output: `AI query sent: ${prompt.slice(0, 100)}` };
      }

      default:
        return { output: "", error: `Unknown job type: ${job.type}` };
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    if (notifyCallback) {
      await notifyCallback(job.target, `❌ Cron-Fehler (${job.name}): ${error}`);
    }
    return { output: "", error };
  }
}

// ── Scheduler Loop ──────────────────────────────────────

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startScheduler(): void {
  if (schedulerTimer) return;

  // Check every 30 seconds for due jobs
  schedulerTimer = setInterval(async () => {
    const jobs = loadJobs();
    const now = Date.now();
    let changed = false;

    for (const job of jobs) {
      if (!job.enabled) continue;

      // Calculate next run if not set
      if (!job.nextRunAt) {
        job.nextRunAt = calculateNextRun(job);
        changed = true;
      }

      if (job.nextRunAt && now >= job.nextRunAt) {
        console.log(`Cron: Running job "${job.name}" (${job.id})`);

        const result = await executeJob(job);
        job.lastRunAt = now;
        job.lastResult = result.output.slice(0, 500);
        job.lastError = result.error || null;
        job.runCount++;

        if (job.oneShot) {
          job.enabled = false;
          job.nextRunAt = null;
        } else {
          job.nextRunAt = calculateNextRun(job);
        }
        changed = true;
      }
    }

    if (changed) saveJobs(jobs);
  }, 30_000);

  console.log("⏰ Cron scheduler started (30s interval)");
}

export function stopScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// ── Public CRUD API ─────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function createJob(input: Partial<CronJob> & { name: string; type: JobType; schedule: string; payload: CronJob["payload"]; target: CronJob["target"] }): CronJob {
  const job: CronJob = {
    id: generateId(),
    name: input.name,
    type: input.type,
    schedule: input.schedule,
    oneShot: input.oneShot ?? false,
    payload: input.payload,
    target: input.target,
    enabled: input.enabled ?? true,
    createdAt: Date.now(),
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    nextRunAt: null,
    runCount: 0,
    createdBy: input.createdBy || "unknown",
  };

  // Calculate first run
  job.nextRunAt = calculateNextRun(job);

  const jobs = loadJobs();
  jobs.push(job);
  saveJobs(jobs);
  return job;
}

export function listJobs(): CronJob[] {
  return loadJobs();
}

export function getJob(id: string): CronJob | undefined {
  return loadJobs().find(j => j.id === id);
}

export function updateJob(id: string, updates: Partial<CronJob>): CronJob | null {
  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx < 0) return null;
  Object.assign(jobs[idx], updates);
  if (updates.schedule || updates.enabled !== undefined) {
    jobs[idx].nextRunAt = calculateNextRun(jobs[idx]);
  }
  saveJobs(jobs);
  return jobs[idx];
}

export function deleteJob(id: string): boolean {
  const jobs = loadJobs();
  const filtered = jobs.filter(j => j.id !== id);
  if (filtered.length === jobs.length) return false;
  saveJobs(filtered);
  return true;
}

export function toggleJob(id: string): CronJob | null {
  const jobs = loadJobs();
  const job = jobs.find(j => j.id === id);
  if (!job) return null;
  job.enabled = !job.enabled;
  job.nextRunAt = calculateNextRun(job);
  saveJobs(jobs);
  return job;
}

export function runJobNow(id: string): Promise<{ output: string; error?: string }> | null {
  const job = getJob(id);
  if (!job) return null;
  return executeJob(job);
}

/**
 * Format next run time as human-readable.
 */
export function formatNextRun(nextRunAt: number | null): string {
  if (!nextRunAt) return "—";
  const diff = nextRunAt - Date.now();
  if (diff < 0) return "überfällig";
  if (diff < 60_000) return `in ${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)} Min`;
  if (diff < 86_400_000) return `in ${(diff / 3_600_000).toFixed(1)}h`;
  return `in ${(diff / 86_400_000).toFixed(1)} Tagen`;
}
