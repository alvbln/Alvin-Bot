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
import { getRegistry } from "../engine.js";
import type { QueryOptions } from "../providers/types.js";
import type { SubAgentResult } from "./subagents.js";
import { CRON_FILE, BOT_ROOT, DATA_DIR } from "../paths.js";
import {
  prepareForExecution,
  handleStartupCatchup,
  calculateNextRunFrom,
} from "./cron-scheduling.js";
import { resolveJobByNameOrId } from "./cron-resolver.js";

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
  /** When the job last STARTED running (pre-execution). Paired with
   *  lastRunAt: if lastAttemptAt > lastRunAt, the last attempt crashed
   *  or is still in flight. Used by handleStartupCatchup to nachholen
   *  interrupted runs within the grace window. */
  lastAttemptAt?: number | null;
  lastRunAt: number | null;
  lastResult: string | null;
  lastError: string | null;
  nextRunAt: number | null;
  runCount: number;
  /** Creator info */
  createdBy: string;
  /** Optional per-job timeout in ms. Semantics:
   *   - undefined → inherit the current /subagents default (for ai-query),
   *     or run without a timeout (for shell / http).
   *   - ≤ 0       → no timeout (agent / command can run forever).
   *   - > 0       → hard cap in milliseconds. */
  timeoutMs?: number;
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
  const dir = dirname(CRON_FILE);
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

        // v4.12.2 — Cron shell jobs now go through exec-guard. Before
        // v4.12.2 cron bypassed the allowlist, which was inconsistent
        // with the rest of the bot's shell execution policy. With
        // EXEC_SECURITY=allowlist (default) this rejects jobs with
        // shell metacharacters or non-allowlisted binaries. Operators
        // who legitimately need complex shell pipelines in cron set
        // EXEC_SECURITY=full explicitly.
        const { checkExecAllowed } = await import("./exec-guard.js");
        const guard = checkExecAllowed(cmd);
        if (!guard.allowed) {
          const msg = `Cron shell job blocked by exec-guard: ${guard.reason}`;
          console.warn(`[cron] ${job.name}: ${msg}`);
          if (notifyCallback) {
            await notifyCallback(
              job.target,
              `🛑 ${job.name}\n${msg}\n\nSet EXEC_SECURITY=full if this is intentional.`,
            );
          }
          return { output: msg };
        }

        // Per-job timeout, default = no timeout (execSync treats timeout=0
        // or "undefined" as infinite). Users opt in via /cron add … --timeout N.
        const shellOpts: Parameters<typeof execSync>[1] = {
          stdio: "pipe",
          env: { ...process.env, PATH: process.env.PATH + ":/opt/homebrew/bin:/usr/local/bin" },
        };
        if (typeof job.timeoutMs === "number" && job.timeoutMs > 0) {
          shellOpts.timeout = job.timeoutMs;
        }
        const output = execSync(cmd, shellOpts).toString().trim();
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
        // AI queries run as isolated sub-agents rather than directly against
        // the registry. This gives cron jobs timeout/cancel/state-tracking
        // "for free" via the existing subagents infrastructure, and — most
        // importantly — keeps them completely independent of any user's
        // active main session. A cron job can run in the background while
        // the user chats with Alvin in the foreground; neither interferes
        // with the other.
        const prompt = job.payload.prompt || "";

        // Dynamic import to avoid circular dep chain (cron → engine → registry
        // and subagents → engine). Type-only import at file top is erased,
        // so no runtime cycle is created.
        const { spawnSubAgent } = await import("./subagents.js");

        try {
          // Turn the fire-and-forget spawnSubAgent into an awaitable via
          // the onComplete callback. Rejection of the spawn promise itself
          // means the max-parallel limit was hit.
          // Parse the target chat id for I3 delivery routing. Only telegram
          // targets get a numeric parentChatId — other platforms/web get
          // undefined and fall through the delivery router's warning path.
          const parentChatId =
            job.target.platform === "telegram" && job.target.chatId
              ? Number(job.target.chatId)
              : undefined;

          const result: SubAgentResult = await new Promise<SubAgentResult>((resolve, reject) => {
            // Only pass `timeout` through when the job has a per-job value.
            // Otherwise the sub-agent inherits the current /subagents default.
            const spawnConfig: Parameters<typeof spawnSubAgent>[0] = {
              name: job.name,
              prompt,
              workingDir: BOT_ROOT,
              source: "cron",
              parentChatId,
              onComplete: (r) => resolve(r),
            };
            if (typeof job.timeoutMs === "number") {
              spawnConfig.timeout = job.timeoutMs;
            }
            spawnSubAgent(spawnConfig).catch(reject);
          });

          // Non-success: don't notify here. The I3 delivery router has
          // already posted the appropriate banner (cancelled / timeout /
          // error) to parentChatId, so a legacy notifyCallback would
          // produce a duplicate message.
          if (result.status !== "completed") {
            return {
              output: "",
              error: `Sub-agent ${result.status}: ${result.error || result.status}`,
            };
          }

          const fullResponse = result.output;

          // NOTE: No notifyCallback for ai-query jobs. The I3 delivery
          // router (src/services/subagent-delivery.ts) fires from
          // spawnSubAgent().finally() and sends a proper banner+final to
          // parentChatId. Legacy notifyCallback stays in use for the
          // other job types (reminder, shell, http, message) which do
          // not route through spawnSubAgent.

          return { output: fullResponse.slice(0, 500) };
        } catch (err) {
          // Re-throw without notifying — the outer catch will record
          // lastError on the job, and the I3 delivery router has already
          // posted a banner if the failure came from inside spawnSubAgent.
          throw err;
        }
      }

      default:
        return { output: "", error: `Unknown job type: ${job.type}` };
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    // Skip notification for ai-query jobs — the I3 delivery router has
    // already posted the banner. Other job types still get the legacy
    // notify path because they don't route through spawnSubAgent.
    if (notifyCallback && job.type !== "ai-query") {
      await notifyCallback(job.target, `❌ Cron Error (${job.name}): ${error}`);
    }
    return { output: "", error };
  }
}

// ── Scheduler Loop ──────────────────────────────────────

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
const runningJobs = new Set<string>(); // Guard against overlapping executions

export function startScheduler(): void {
  if (schedulerTimer) return;

  // Startup catch-up — nachholen runs whose last attempt crashed within
  // the grace window. Must run BEFORE the first scheduler tick so the
  // catch-up nextRunAt rewind is visible on the very next pass.
  try {
    const bootJobs = loadJobs();
    const caught = handleStartupCatchup(bootJobs, Date.now());
    // Only persist if something actually changed to avoid needless writes
    const mutated = caught.some((j, i) => j.nextRunAt !== bootJobs[i].nextRunAt);
    if (mutated) {
      saveJobs(caught);
      const names = caught
        .filter((j, i) => j.nextRunAt !== bootJobs[i].nextRunAt)
        .map((j) => j.name);
      console.log(`⏰ Cron startup catch-up: rewound ${names.length} job(s): ${names.join(", ")}`);
    }
  } catch (err) {
    console.error("⏰ Cron startup catch-up failed:", err);
  }

  // Check every 30 seconds for due jobs
  schedulerTimer = setInterval(async () => {
    const jobs = loadJobs();
    const now = Date.now();
    let changed = false;

    for (const job of jobs) {
      if (!job.enabled) continue;

      // Skip if this job is already running in THIS bot instance
      if (runningJobs.has(job.id)) continue;

      // Calculate next run if not set
      if (!job.nextRunAt) {
        job.nextRunAt = calculateNextRun(job);
        changed = true;
      }

      if (job.nextRunAt && now >= job.nextRunAt) {
        console.log(`Cron: Running job "${job.name}" (${job.id})`);

        // Pre-execution state update: advance nextRunAt to the NEXT regular
        // trigger (NOT null) and stamp lastAttemptAt. If the bot crashes
        // mid-execution, handleStartupCatchup will notice the attempt
        // without completion and nachholen within the grace window.
        runningJobs.add(job.id);
        const prepared = prepareForExecution(job, now);
        Object.assign(job, prepared);
        saveJobs(jobs);

        try {
          const result = await executeJob(job);
          // Re-load jobs in case they were modified during execution
          const freshJobs = loadJobs();
          const freshJob = freshJobs.find(j => j.id === job.id);
          if (freshJob) {
            freshJob.lastRunAt = Date.now();
            freshJob.lastResult = result.output.slice(0, 4000);
            freshJob.lastError = result.error || null;
            freshJob.runCount++;

            if (freshJob.oneShot) {
              freshJob.enabled = false;
              freshJob.nextRunAt = null;
            } else {
              // nextRunAt already set pre-execution, but recalculate in case
              // the schedule or enabled state changed during execution.
              freshJob.nextRunAt = calculateNextRunFrom(freshJob, Date.now());
            }
            saveJobs(freshJobs);
          }
        } finally {
          runningJobs.delete(job.id);
        }
        continue; // Skip the outer changed/save since we save inside
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
    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
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

/**
 * Result of a manual `/cron run` trigger.
 *   - `not-found` → no job matches the name-or-ID query
 *   - `already-running` → the job is currently executing (scheduler
 *     loop or previous manual call) — avoids double-firing the same
 *     multi-minute sub-agent when users retry via natural language.
 *   - `ran` → executeJob finished; `output` / `error` mirror its result.
 */
export type RunJobNowOutcome =
  | { status: "not-found" }
  | { status: "already-running"; job: CronJob }
  | { status: "ran"; job: CronJob; output: string; error?: string };

/**
 * Manual /cron run — resolves `nameOrId` against the job list, then
 * executes the job while honouring the in-memory `runningJobs` guard
 * so a simultaneous scheduler-trigger can't overlap.
 */
export async function runJobNow(nameOrId: string): Promise<RunJobNowOutcome> {
  const job = resolveJobByNameOrId(loadJobs(), nameOrId);
  if (!job) return { status: "not-found" };

  if (runningJobs.has(job.id)) {
    return { status: "already-running", job };
  }

  runningJobs.add(job.id);
  try {
    // executeJob catches its own errors and returns { output, error }.
    // The inner try/catch here is a defensive belt against future
    // refactors that might remove executeJob's outer catch — it
    // guarantees runJobNow's typed contract, so commands.ts never
    // sees an uncaught throw escape into grammy's middleware.
    let result: { output: string; error?: string };
    try {
      result = await executeJob(job);
    } catch (err) {
      result = {
        output: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Persist the manual run the same way the scheduler does so the
    // timeline stays honest: lastAttemptAt + lastRunAt + runCount bump.
    try {
      const freshJobs = loadJobs();
      const freshJob = freshJobs.find((j) => j.id === job.id);
      if (freshJob) {
        const now = Date.now();
        freshJob.lastAttemptAt = now;
        freshJob.lastRunAt = now;
        freshJob.lastResult = result.output.slice(0, 4000);
        freshJob.lastError = result.error || null;
        freshJob.runCount++;
        saveJobs(freshJobs);
      }
    } catch (err) {
      console.error("[cron] failed to persist manual run state:", err);
    }
    return { status: "ran", job, output: result.output, error: result.error };
  } finally {
    runningJobs.delete(job.id);
  }
}

/**
 * Convert a cron expression or interval string to a human-readable German description.
 */
export function humanReadableSchedule(schedule: string): string {
  // Interval strings (5m, 1h, 30s, 2d)
  const intervalMatch = schedule.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)s?$/i);
  if (intervalMatch) {
    const value = parseFloat(intervalMatch[1]);
    const unit = intervalMatch[2].toLowerCase();
    const labels: Record<string, [string, string]> = {
      s: ["second", "seconds"], sec: ["second", "seconds"],
      m: ["minute", "minutes"], min: ["minute", "minutes"],
      h: ["hour", "hours"], hr: ["hour", "hours"],
      d: ["day", "days"], day: ["day", "days"],
    };
    const [sing, plur] = labels[unit] || ["?", "?"];
    return `Every ${value} ${value === 1 ? sing : plur}`;
  }

  // Cron expression: MIN HOUR DAY MONTH WEEKDAY
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [minExpr, hourExpr, dayExpr, monthExpr, weekdayExpr] = parts;

  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Helper: format time from hour + minute expressions
  function formatTime(h: string, m: string): string {
    if (h === "*" && m === "*") return "";
    const hh = h === "*" ? "*" : h.padStart(2, "0");
    const mm = m === "*" ? "00" : m.padStart(2, "0");
    return `${hh}:${mm}`;
  }

  // Helper: expand comma/range fields to readable list
  function expandField(expr: string, names?: string[]): string {
    if (expr === "*") return "";
    const vals = expr.split(",").map(v => {
      if (v.includes("-")) {
        const [a, b] = v.split("-");
        if (names) return `${names[+a]}–${names[+b]}`;
        return `${a}–${b}`;
      }
      return names ? (names[+v] || v) : v;
    });
    return vals.join(", ");
  }

  const time = formatTime(hourExpr, minExpr);
  const hasStep = [minExpr, hourExpr].some(e => e.includes("/"));

  // Every X minutes/hours
  if (minExpr.includes("/") && hourExpr === "*" && dayExpr === "*" && monthExpr === "*" && weekdayExpr === "*") {
    const step = minExpr.split("/")[1];
    return `Every ${step} min`;
  }
  if (hourExpr.includes("/") && dayExpr === "*" && monthExpr === "*" && weekdayExpr === "*") {
    const step = hourExpr.split("/")[1];
    return `Every ${step}h`;
  }

  // Build description
  const descParts: string[] = [];

  // Weekday specific
  if (weekdayExpr !== "*") {
    const days = expandField(weekdayExpr, weekdayNames);
    if (weekdayExpr === "1-5") descParts.push("Weekdays");
    else if (weekdayExpr === "0,6" || weekdayExpr === "6,0") descParts.push("Weekends");
    else descParts.push(`Every ${days}`);
  }
  // Day of month specific
  else if (dayExpr !== "*") {
    const dayList = expandField(dayExpr);
    if (monthExpr !== "*") {
      const monthList = expandField(monthExpr, monthNames);
      descParts.push(`On the ${dayList}. of ${monthList}`);
    } else {
      descParts.push(`On the ${dayList}. of every month`);
    }
  }
  // Month specific only
  else if (monthExpr !== "*") {
    const monthList = expandField(monthExpr, monthNames);
    descParts.push(`In ${monthList}`);
  }
  // Daily (all wildcards except time)
  else if (!hasStep) {
    descParts.push("Daily");
  }

  if (time && !hasStep) descParts.push(time);

  return descParts.join(", ") || schedule;
}

/**
 * Format next run time as human-readable.
 */
export function formatNextRun(nextRunAt: number | null): string {
  if (!nextRunAt) return "—";
  const diff = nextRunAt - Date.now();
  if (diff < 0) return "overdue";
  if (diff < 60_000) return `in ${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)} Min`;
  if (diff < 86_400_000) return `in ${(diff / 3_600_000).toFixed(1)}h`;
  return `in ${(diff / 86_400_000).toFixed(1)} days`;
}
