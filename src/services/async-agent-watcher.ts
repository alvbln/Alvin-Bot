/**
 * Async Sub-Agent Watcher (Fix #17 Stage 2)
 *
 * Tracks pending background sub-agents that Claude launched with
 * `run_in_background: true`. Polls each agent's outputFile every
 * POLL_INTERVAL_MS, detects completion (success/failure/timeout),
 * and delivers the final result as a separate Telegram message via
 * the existing subagent-delivery.ts pipeline.
 *
 * Persistence: pending agents survive bot restarts via
 * ~/.alvin-bot/state/async-agents.json. On boot, startWatcher() loads
 * the file and resumes polling — same catchup pattern as the v4.9.0
 * cron scheduler.
 *
 * Why this exists: Claude's Agent tool defaults to synchronous, which
 * blocks the main Telegram session for 10+ minutes during long audits.
 * Stage 1 of the fix tells Claude to use run_in_background; Stage 2
 * (this file) catches the resulting outputFile and delivers the result
 * when ready, so the user can keep chatting while the agent works.
 *
 * See docs/superpowers/plans/2026-04-13-async-subagents.md for the
 * full plan and docs/superpowers/specs/sdk-async-agent-outputfile-format.md
 * for the JSONL format details.
 */
import fs from "fs";
import { dirname } from "path";
import type { SubAgentInfo, SubAgentResult } from "./subagents.js";
import { parseOutputFileStatus } from "./async-agent-parser.js";
import { ASYNC_AGENTS_STATE_FILE } from "../paths.js";
import { getAllSessions } from "./session.js";

export interface PendingAsyncAgent {
  agentId: string;
  outputFile: string;
  description: string;
  prompt: string;
  /**
   * v4.14 — chatId is string for Slack/Discord/WhatsApp (channel IDs
   * like "C012ABC…"), number for Telegram (native int chat id). Pre-v4.14
   * entries with `chatId: number` remain valid.
   */
  chatId: number | string;
  userId: number | string;
  startedAt: number;
  lastCheckedAt: number;
  giveUpAt: number;
  toolUseId: string | null;
  /**
   * v4.12.3 — Session key (from buildSessionKey) so the watcher can
   * decrement session.pendingBackgroundCount when delivering the result.
   * Optional for backward compat with pre-v4.12.3 persisted state files —
   * old entries have no sessionKey and will simply skip the decrement.
   */
  sessionKey?: string;
  /**
   * v4.14 — Platform the parent session runs on. Routes the delivery
   * path: "telegram" (default, unchanged behavior via grammy api) vs.
   * "slack" / "discord" / "whatsapp" (new — routed via
   * delivery-registry). Old persisted entries without this field are
   * treated as "telegram" for backward compat.
   */
  platform?: "telegram" | "slack" | "discord" | "whatsapp";
}

export interface RegisterInput {
  agentId: string;
  outputFile: string;
  description: string;
  prompt: string;
  chatId: number | string;
  userId: number | string;
  toolUseId: string | null;
  /** v4.12.3 — session key for decrement routing. Omit for orphan agents. */
  sessionKey?: string;
  /** v4.14 — platform for delivery routing. Default "telegram". */
  platform?: "telegram" | "slack" | "discord" | "whatsapp";
  /** Test-only override; production code never sets this. */
  giveUpAt?: number;
}

/** How often the polling loop runs against each pending agent. */
const POLL_INTERVAL_MS = 15_000;

/** Hard ceiling per agent — 12h. After this, give up and deliver
 *  a timeout banner. SEO audits historically take ~13 min, so 12h
 *  is absurdly generous and protects against state-file growth. */
const MAX_AGENT_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * v4.14.2 — When a dispatched subprocess never creates its outputFile
 * (spawn failure, crash before first write, file deleted externally),
 * `parseOutputFileStatus` returns "missing" on every poll. Pre-v4.14.2
 * that meant waiting the full 12h MAX_AGENT_AGE_MS before delivering a
 * timeout — a 12-hour zombie in `/subagents list`.
 *
 * This threshold caps how long we tolerate a missing file before
 * declaring the agent failed. `claude -p` normally writes its first
 * JSONL line within seconds of spawn; 10 minutes is way above any
 * legitimate startup variance and well below the 12h ceiling.
 *
 * Configurable via the ALVIN_MISSING_FILE_FAILURE_MS env var. Tests
 * use shorter values via the same hook. Only the getter is exposed
 * so callers always see the current env value, not a stale constant.
 */
function getMissingFileFailureMs(): number {
  const raw = process.env.ALVIN_MISSING_FILE_FAILURE_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 10 * 60 * 1000; // default 10 min
}

// ── Module state ──────────────────────────────────────────────────

const pending = new Map<string, PendingAsyncAgent>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

/**
 * Hard cap on the pending-agents map. Without this, a bot that runs many
 * async agents but sees some fail to write their outputFile would see
 * entries linger up to `giveUpAt` (12h default). If the rate of
 * registerPending() outpaces resolutions for days, memory and the disk
 * state file grow unbounded. We evict oldest-first when over the cap.
 */
const MAX_PENDING_AGENTS = 500;

function enforcePendingCap(): void {
  if (pending.size < MAX_PENDING_AGENTS) return;
  const entries = [...pending.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
  const target = Math.floor(MAX_PENDING_AGENTS * 0.9);
  let toEvict = pending.size - target;
  for (const [id] of entries) {
    if (toEvict <= 0) break;
    pending.delete(id);
    toEvict--;
  }
  console.warn(`[async-agent-watcher] pending map hit cap ${MAX_PENDING_AGENTS}, evicted to ${pending.size}`);
}

// ── Persistence ───────────────────────────────────────────────────

function loadFromDisk(): void {
  try {
    const raw = fs.readFileSync(ASYNC_AGENTS_STATE_FILE, "utf-8");
    const arr = JSON.parse(raw) as PendingAsyncAgent[];
    if (!Array.isArray(arr)) return;
    for (const entry of arr) {
      if (typeof entry?.agentId === "string" && typeof entry?.outputFile === "string") {
        pending.set(entry.agentId, entry);
      }
    }
  } catch {
    // No state file yet — fresh start. Not an error.
  }
}

function saveToDisk(): void {
  try {
    fs.mkdirSync(dirname(ASYNC_AGENTS_STATE_FILE), { recursive: true });
    fs.writeFileSync(
      ASYNC_AGENTS_STATE_FILE,
      JSON.stringify([...pending.values()], null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error("[async-watcher] failed to persist state:", err);
  }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Register a new async agent that Claude just launched. Persists
 * immediately so a crash right after registration still delivers
 * the result on the next boot.
 */
export function registerPendingAgent(input: RegisterInput): void {
  const now = Date.now();
  const entry: PendingAsyncAgent = {
    agentId: input.agentId,
    outputFile: input.outputFile,
    description: input.description,
    prompt: input.prompt,
    chatId: input.chatId,
    userId: input.userId,
    startedAt: now,
    lastCheckedAt: 0,
    giveUpAt: input.giveUpAt ?? now + MAX_AGENT_AGE_MS,
    toolUseId: input.toolUseId,
    sessionKey: input.sessionKey,
    platform: input.platform,
  };
  enforcePendingCap();
  pending.set(input.agentId, entry);
  saveToDisk();
}

/**
 * v4.12.3 — Decrement the session's pendingBackgroundCount. Called on
 * every delivery (completed/failed/timeout). Clamped at 0 so drift
 * scenarios (counter was already 0, or session was reset) never crash.
 * Missing/unknown sessionKey → no-op. Never throws.
 */
function decrementPendingCount(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  try {
    const all = getAllSessions();
    const s = all.get(sessionKey);
    if (!s) return;
    s.pendingBackgroundCount = Math.max(0, (s.pendingBackgroundCount ?? 0) - 1);
  } catch (err) {
    // Never let a decrement failure break delivery.
    console.error("[async-watcher] decrement failed:", err);
  }
}

/** Returns a snapshot of in-memory pending agents (for /subagents + diagnostics). */
export function listPendingAgents(): PendingAsyncAgent[] {
  return [...pending.values()];
}

/** Start the polling loop. Idempotent. Loads any persisted state from disk. */
export function startWatcher(): void {
  if (started) return;
  started = true;
  loadFromDisk();
  pollTimer = setInterval(() => {
    pollOnce().catch((err) =>
      console.error("[async-watcher] poll cycle failed:", err),
    );
  }, POLL_INTERVAL_MS);
  console.log(
    `⏳ Async-agent watcher started (${pending.size} pending, ${POLL_INTERVAL_MS / 1000}s interval)`,
  );
}

/** Stop the polling loop. Idempotent. */
export function stopWatcher(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  started = false;
}

/**
 * Run one poll cycle: check every pending agent, deliver the completed
 * ones, drop them from the in-memory + on-disk state. Exported for
 * tests; production uses the setInterval from startWatcher().
 */
export async function pollOnce(): Promise<void> {
  const now = Date.now();
  const toRemove: string[] = [];
  const missingFileFailureMs = getMissingFileFailureMs();

  for (const entry of pending.values()) {
    entry.lastCheckedAt = now;

    // Timeout check first — if the agent is past its giveUpAt, give up
    // regardless of whether the file shows progress.
    if (now >= entry.giveUpAt) {
      await deliverAsFailure(entry, "timeout", "Agent ran longer than 12h — giving up");
      toRemove.push(entry.agentId);
      continue;
    }

    const status = await parseOutputFileStatus(entry.outputFile);
    if (status.state === "completed") {
      await deliverAsCompleted(entry, status.output, status.tokensUsed);
      toRemove.push(entry.agentId);
    } else if (status.state === "failed") {
      await deliverAsFailure(entry, "error", status.error);
      toRemove.push(entry.agentId);
    } else if (
      status.state === "missing" &&
      now - entry.startedAt > missingFileFailureMs
    ) {
      // v4.14.2 — Zombie guard: the subprocess never created its
      // output file within `missingFileFailureMs` (default 10 min).
      // Declare failed instead of polling until the 12h giveUpAt.
      await deliverAsFailure(
        entry,
        "error",
        `Dispatched subprocess never wrote its output file (${Math.round(
          (now - entry.startedAt) / 60_000,
        )}m after start). Likely crashed before initializing, or the file was removed externally.`,
      );
      toRemove.push(entry.agentId);
    }
    // running / missing-but-young → keep polling next cycle
  }

  if (toRemove.length > 0) {
    for (const id of toRemove) pending.delete(id);
    saveToDisk();
  }
}

// ── Delivery helpers ──────────────────────────────────────────────

async function deliverAsCompleted(
  entry: PendingAsyncAgent,
  output: string,
  tokensUsed?: { input: number; output: number },
): Promise<void> {
  const { deliverSubAgentResult } = await import("./subagent-delivery.js");
  const info: SubAgentInfo = {
    id: entry.agentId,
    name: entry.description,
    status: "completed",
    startedAt: entry.startedAt,
    source: "cron", // Reuse cron banner format — fits async background agents.
    depth: 0,
    parentChatId: entry.chatId,
    platform: entry.platform,
  };
  const result: SubAgentResult = {
    id: entry.agentId,
    name: entry.description,
    status: "completed",
    output,
    tokensUsed: tokensUsed ?? { input: 0, output: 0 },
    duration: Date.now() - entry.startedAt,
  };
  try {
    await deliverSubAgentResult(info, result);
  } catch (err) {
    console.error(`[async-watcher] delivery failed for ${entry.agentId}:`, err);
  }
  decrementPendingCount(entry.sessionKey);
}

async function deliverAsFailure(
  entry: PendingAsyncAgent,
  status: "error" | "timeout",
  error: string,
): Promise<void> {
  const { deliverSubAgentResult } = await import("./subagent-delivery.js");
  const info: SubAgentInfo = {
    id: entry.agentId,
    name: entry.description,
    status,
    startedAt: entry.startedAt,
    source: "cron",
    depth: 0,
    parentChatId: entry.chatId,
    platform: entry.platform,
  };
  const result: SubAgentResult = {
    id: entry.agentId,
    name: entry.description,
    status,
    output: "",
    tokensUsed: { input: 0, output: 0 },
    duration: Date.now() - entry.startedAt,
    error,
  };
  try {
    await deliverSubAgentResult(info, result);
  } catch (err) {
    console.error(`[async-watcher] failure delivery failed for ${entry.agentId}:`, err);
  }
  decrementPendingCount(entry.sessionKey);
}

// ── Test helpers ──────────────────────────────────────────────────

/** Test-only: drop in-memory state. Doesn't touch disk. */
export function __resetForTest(): void {
  pending.clear();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  started = false;
}
