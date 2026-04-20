/**
 * Sub-Agent System — Parallel Task Execution
 *
 * Spawns isolated AI workers that run in the background using the engine registry.
 * Each sub-agent gets its own query call (not a persistent session).
 * Results are stored and can be retrieved by the caller.
 */

import os from "os";
import fs from "fs";
import { resolve, dirname } from "path";
import crypto from "crypto";
import { config } from "../config.js";

// ── File-based config (persistent, runtime-editable) ───────────────────

const DATA_DIR = process.env.ALVIN_DATA_DIR || resolve(os.homedir(), ".alvin-bot");
const CONFIG_FILE = resolve(DATA_DIR, "sub-agents.json");
const ABSOLUTE_MAX_AGENTS = 16; // Hard cap no matter what
const MAX_SUBAGENT_DEPTH = 2;   // F2: hard cap on nested spawning
const DEFAULT_QUEUE_CAP = 20;   // D3: default bounded-queue size
const ABSOLUTE_MAX_QUEUE = 200; // D3: absolute ceiling on queue length

interface SubAgentsConfig {
  /** Max parallel agents. 0 = auto (min(cpu cores, ABSOLUTE_MAX_AGENTS)). */
  maxParallel: number;
  /** A4 default delivery visibility for new spawns (auto|banner|silent|live). */
  visibility: VisibilityMode;
  /** D3 bounded-queue cap. 0 = queue disabled (old reject-when-full behaviour). */
  queueCap: number;
  /** Default timeout in ms applied when a spawn does not pass its own.
   *  Values <= 0 mean "no timeout" — the agent runs until it finishes,
   *  is cancelled, or the process dies. */
  defaultTimeoutMs: number;
}

let configCache: SubAgentsConfig | null = null;

function isValidVisibility(v: unknown): v is VisibilityMode {
  return v === "auto" || v === "banner" || v === "silent" || v === "live";
}

/** Resolve the initial default timeout from config.ts, which itself seeds
 *  from the SUBAGENT_TIMEOUT env var. -1 = unlimited. */
function seedDefaultTimeout(): number {
  const raw = config.subAgentTimeout;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return -1;
  return Math.floor(raw);
}

function loadSubAgentsConfig(): SubAgentsConfig {
  if (configCache) return configCache;
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SubAgentsConfig>;
    configCache = {
      maxParallel: typeof parsed.maxParallel === "number" ? parsed.maxParallel : 0,
      visibility: isValidVisibility(parsed.visibility) ? parsed.visibility : "auto",
      queueCap:
        typeof parsed.queueCap === "number"
          ? Math.max(0, Math.min(Math.floor(parsed.queueCap), ABSOLUTE_MAX_QUEUE))
          : DEFAULT_QUEUE_CAP,
      defaultTimeoutMs:
        typeof parsed.defaultTimeoutMs === "number" && Number.isFinite(parsed.defaultTimeoutMs)
          ? (parsed.defaultTimeoutMs <= 0 ? -1 : Math.floor(parsed.defaultTimeoutMs))
          : seedDefaultTimeout(),
    };
  } catch {
    // File missing or invalid — seed from env vars then default to auto/unlimited
    configCache = {
      maxParallel: Number(process.env.MAX_SUBAGENTS) || 0,
      visibility: "auto",
      queueCap: DEFAULT_QUEUE_CAP,
      defaultTimeoutMs: seedDefaultTimeout(),
    };
  }
  return configCache;
}

function saveSubAgentsConfig(cfg: SubAgentsConfig): void {
  try {
    fs.mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
    configCache = cfg;
  } catch (err) {
    console.error("[subagents] failed to write config:", err);
  }
}

/** Resolves max parallel agents, interpreting 0 as "auto = cpu cores capped". */
export function getMaxParallelAgents(): number {
  const cfg = loadSubAgentsConfig();
  if (cfg.maxParallel === 0) {
    return Math.min(os.cpus().length, ABSOLUTE_MAX_AGENTS);
  }
  return Math.min(Math.max(1, cfg.maxParallel), ABSOLUTE_MAX_AGENTS);
}

/** Returns the raw configured value (for display). 0 means "auto". */
export function getConfiguredMaxParallel(): number {
  return loadSubAgentsConfig().maxParallel;
}

/** Sets max parallel agents. Value is clamped to [0, ABSOLUTE_MAX_AGENTS].
 *  Returns the resolved effective value (with auto-expansion if set to 0). */
export function setMaxParallelAgents(n: number): number {
  const clamped = Math.max(0, Math.min(Math.floor(n), ABSOLUTE_MAX_AGENTS));
  const cfg = loadSubAgentsConfig();
  saveSubAgentsConfig({ ...cfg, maxParallel: clamped });
  return getMaxParallelAgents();
}

/** A4: Current default visibility mode for new spawns. */
export function getVisibility(): VisibilityMode {
  return loadSubAgentsConfig().visibility;
}

/**
 * A4: Set the default visibility mode. Throws if the value is invalid.
 * Writes through to the on-disk config so restart-resilient.
 */
export function setVisibility(mode: VisibilityMode): void {
  if (!isValidVisibility(mode)) {
    throw new Error(
      `Invalid visibility mode "${mode}". Expected: auto | banner | silent | live.`,
    );
  }
  const cfg = loadSubAgentsConfig();
  saveSubAgentsConfig({ ...cfg, visibility: mode });
}

/** D3: Current bounded-queue cap. 0 = queue disabled (reject on full pool). */
export function getQueueCap(): number {
  return loadSubAgentsConfig().queueCap;
}

/** D3: Set the queue cap. Clamped to [0, ABSOLUTE_MAX_QUEUE].
 *  Returns the effective value after clamping. */
export function setQueueCap(n: number): number {
  const clamped = Math.max(0, Math.min(Math.floor(n), ABSOLUTE_MAX_QUEUE));
  const cfg = loadSubAgentsConfig();
  saveSubAgentsConfig({ ...cfg, queueCap: clamped });
  return clamped;
}

/** Current default timeout in ms. -1 = unlimited. */
export function getDefaultTimeoutMs(): number {
  return loadSubAgentsConfig().defaultTimeoutMs;
}

/** Set the default timeout in ms. Any value ≤ 0 or non-finite collapses
 *  to -1 (unlimited). Returns the persisted value. */
export function setDefaultTimeoutMs(ms: number): number {
  const normalized = !Number.isFinite(ms) || ms <= 0 ? -1 : Math.floor(ms);
  const cfg = loadSubAgentsConfig();
  saveSubAgentsConfig({ ...cfg, defaultTimeoutMs: normalized });
  return normalized;
}

// ── Interfaces ──────────────────────────────────────────

export type VisibilityMode = "auto" | "banner" | "silent" | "live";

export interface SubAgentConfig {
  name: string;
  prompt: string;
  model?: string;           // not used yet, reserved
  workingDir?: string;      // defaults to os.homedir()
  maxTurns?: number;        // default 20 (safety limit)
  timeout?: number;         // ms; falls back to getDefaultTimeoutMs(). ≤0 = unlimited
  /** Where this sub-agent originated — used to filter /sub-agents list
   *  between user-explicit (/agent spawn) and cron-triggered agents. */
  source?: "cron" | "user" | "implicit";
  /** Called once after the sub-agent finishes (completed, error, timeout,
   *  or cancelled) with the final SubAgentResult. Used by cron.ts to
   *  turn the fire-and-forget spawnSubAgent() into a Promise that
   *  resolves when work is done, so cron job execution can await results
   *  while still running in full isolation from the main session. */
  onComplete?: (result: SubAgentResult) => void;
  /** F2: Depth in the sub-agent tree. 0 = root (spawned by main thread),
   *  1 = spawned by a depth-0 agent, 2 = spawned by a depth-1 agent.
   *  Hard-capped at MAX_SUBAGENT_DEPTH (2) to prevent runaway recursion. */
  depth?: number;
  /** G1: Tool allow-list preset. v4.12.2 — extended with "readonly" and
   *  "research" presets for restricted sub-agents.
   *  - "full"     — all tools (Read, Write, Edit, Bash, Glob, Grep,
   *                 WebSearch, WebFetch, Task). Default. Inherits parent
   *                 permissions. Use when the sub-agent is trusted.
   *  - "readonly" — Read, Glob, Grep only. No Write, no Edit, no Bash, no
   *                 network. Useful when a sub-agent should only analyze,
   *                 not modify, and should not be able to exfiltrate.
   *  - "research" — Read, Glob, Grep, WebSearch, WebFetch. No Write, no
   *                 Edit, no Bash. Useful for research/analysis tasks
   *                 that need to fetch web pages but not modify the host. */
  toolset?: "full" | "readonly" | "research";
  /** C3: Whether the sub-agent inherits the parent's workingDir. When
   *  false, the agent starts in os.homedir() regardless of what the
   *  caller passed. Default: true. */
  inheritCwd?: boolean;
  /** I3: Chat-ID of the parent's conversation — used by the delivery
   *  router to route user-spawn finals back to the right Telegram chat. */
  parentChatId?: number;
  /** A4: Per-spawn visibility override. When omitted, the source-based
   *  default applies: user=banner, cron=banner, implicit=parent-stream. */
  visibility?: VisibilityMode;
}

export interface SubAgentResult {
  id: string;
  name: string;
  status: "completed" | "timeout" | "error" | "cancelled";
  output: string;           // final text output
  tokensUsed: { input: number; output: number };
  duration: number;         // ms
  error?: string;
}

export interface SubAgentInfo {
  id: string;
  name: string;
  status: "queued" | "running" | "completed" | "timeout" | "error" | "cancelled";
  startedAt: number;
  model?: string;
  /** Origin — lets /sub-agents list filter user vs cron vs implicit agents. */
  source?: "cron" | "user" | "implicit";
  /** F2: Depth in the sub-agent tree. Always present (defaults to 0). */
  depth: number;
  /**
   * I3: Chat-ID to route delivery to, when delivery is active for this source.
   *
   * v4.14 — Widened to `number | string` to support Slack/Discord/WhatsApp
   * channel IDs (strings). Telegram keeps passing numbers — the delivery
   * router tolerates both.
   */
  parentChatId?: number | string;
  /**
   * v4.14 — Platform the parent session runs on. Used by the delivery
   * router to pick the right adapter (grammy for telegram, delivery-
   * registry for slack/discord/whatsapp). Undefined = "telegram" for
   * pre-v4.14 back-compat.
   */
  platform?: "telegram" | "slack" | "discord" | "whatsapp";
  /** B2: If the requested name collided, the numeric suffix that was appended. */
  nameIndex?: number;
  /** D3: Position in the bounded queue (1-based, only set when status="queued"). */
  queuePosition?: number;
}

// ── State ───────────────────────────────────────────────

const activeAgents = new Map<string, {
  info: SubAgentInfo;
  abort: AbortController;
  result?: SubAgentResult;
  /** True once the entry has been routed through the I3 delivery router.
   *  Prevents double-delivery when cancelAllSubAgents synthesises a
   *  cancelled result while runSubAgent is still mid-stream. */
  delivered: boolean;
}>();

// ── Name resolver (B2) ──────────────────────────────────

/**
 * Return all currently-tracked agents whose *base* name matches `base`.
 * Base name = the part before any "#N" suffix.
 */
function agentsByBaseName(base: string): SubAgentInfo[] {
  const out: SubAgentInfo[] = [];
  for (const entry of activeAgents.values()) {
    const info = entry.info;
    const entryBase = info.name.replace(/#\d+$/, "");
    if (entryBase === base) out.push(info);
  }
  return out;
}

/**
 * Given a requested name, return a unique variant. If no collision exists,
 * returns `requested` unchanged (with the base form). Otherwise returns
 * `base#N` with the smallest free N ≥ 2.
 */
function resolveAgentName(requested: string): { name: string; index?: number } {
  const base = requested.replace(/#\d+$/, "");
  const siblings = agentsByBaseName(base);
  if (siblings.length === 0) return { name: base };

  // Find the smallest free index ≥ 2. The bare base name counts as "#1".
  const takenIndices = new Set<number>();
  for (const s of siblings) {
    const m = s.name.match(/#(\d+)$/);
    if (m) takenIndices.add(parseInt(m[1], 10));
    else takenIndices.add(1);
  }
  let n = 2;
  while (takenIndices.has(n)) n++;
  return { name: `${base}#${n}`, index: n };
}

/**
 * Public name-resolution API used by /sub-agents cancel / result.
 * - Exact name match wins (e.g. "review#2" finds exactly that entry).
 * - If only one agent matches the base name, returns that one.
 * - If the caller opted into `ambiguousAsList`, returns a disambiguation
 *   marker with all candidates instead of a single result.
 */
export function findSubAgentByName(
  name: string,
  opts: { ambiguousAsList?: boolean } = {},
):
  | SubAgentInfo
  | { ambiguous: true; candidates: SubAgentInfo[] }
  | null {
  // An explicit "base#N" query must always resolve to that exact entry,
  // even when the caller opted into ambiguity. Otherwise users who type
  // out the disambiguated form get an unhelpful 'which one?' reply.
  const hasExplicitSuffix = /#\d+$/.test(name);
  if (hasExplicitSuffix) {
    for (const entry of activeAgents.values()) {
      if (entry.info.name === name) return { ...entry.info };
    }
    return null;
  }

  // No explicit suffix → base-name query. Ambiguity detection runs here
  // when the caller opted in and there are multiple siblings.
  const siblings = agentsByBaseName(name);
  if (siblings.length === 0) return null;

  if (opts.ambiguousAsList && siblings.length > 1) {
    return {
      ambiguous: true,
      candidates: siblings.map((s) => ({ ...s })),
    };
  }

  // Without ambiguity opt-in, prefer an exact name match over just the
  // first sibling — the bare base name is itself a unique key.
  for (const entry of activeAgents.values()) {
    if (entry.info.name === name) return { ...entry.info };
  }
  return { ...siblings[0] };
}

// ── Core execution ──────────────────────────────────────

async function runSubAgent(
  id: string,
  agentConfig: SubAgentConfig,
  abort: AbortController,
  resolvedName: string,
): Promise<void> {
  const startTime = Date.now();
  const entry = activeAgents.get(id)!;

  // A4 live-stream state — set up if the effective visibility is "live"
  // AND this is a user spawn with a parent chat. Cron and implicit spawns
  // don't get live-streaming (cron because there's no interactive watcher,
  // implicit because the parent Claude stream already shows everything).
  let liveStream: {
    update: (text: string) => void;
    finalize: (info: SubAgentInfo, result: SubAgentResult) => Promise<void>;
    failed: boolean;
  } | null = null;

  const effectiveVisibility = agentConfig.visibility ?? loadSubAgentsConfig().visibility;
  if (
    effectiveVisibility === "live" &&
    agentConfig.source === "user" &&
    typeof agentConfig.parentChatId === "number"
  ) {
    try {
      const { createLiveStream } = await import("./subagent-delivery.js");
      const stream = createLiveStream(agentConfig.parentChatId, resolvedName);
      if (stream) {
        await stream.start();
        if (!stream.failed) liveStream = stream;
      }
    } catch (err) {
      console.error(`[subagent ${id}] live-stream init failed:`, err);
    }
  }

  // These live OUTSIDE the try block so the catch handler can read
  // whatever was buffered before the stream failed. Moving them into
  // the try scope was the cause of the "output: ''" regression.
  let finalText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let streamError: string | null = null;

  try {
    const { getRegistry } = await import("../engine.js");
    const registry = getRegistry();

    // C3: inheritCwd (default true) decides whether the parent's working
    // dir flows through. When false, we fall back to the home directory —
    // useful for cron jobs that must run in a well-known root regardless
    // of what the caller was doing.
    const inheritCwd = agentConfig.inheritCwd ?? true;
    const effectiveCwd = inheritCwd
      ? agentConfig.workingDir || os.homedir()
      : os.homedir();

    const systemPrompt = `You are a sub-agent named "${resolvedName}". Complete the following task autonomously and report your results clearly when done. Working directory: ${effectiveCwd}`;

    // v4.12.2 — Map the toolset preset to an explicit allowedTools list.
    // The provider honors this override (see src/providers/claude-sdk-provider.ts
    // line ~140). Passing undefined = full access (provider default).
    const allowedToolsForToolset = (preset: "full" | "readonly" | "research"): string[] | undefined => {
      switch (preset) {
        case "readonly":
          // Read, analyze, search — no writes, no shell, no network.
          return ["Read", "Glob", "Grep"];
        case "research":
          // Same as readonly + web access for research tasks.
          return ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
        case "full":
        default:
          // undefined → provider uses its full default set.
          return undefined;
      }
    };

    for await (const chunk of registry.queryWithFallback({
      prompt: agentConfig.prompt,
      systemPrompt,
      workingDir: effectiveCwd,
      effort: "high",
      abortSignal: abort.signal,
      allowedTools: allowedToolsForToolset(agentConfig.toolset ?? "full"),
    })) {
      if (chunk.type === "text") {
        // Both SDK providers emit `text` as the accumulated string.
        // Keep the last non-empty one we've seen so a final tool-only
        // turn doesn't wipe our buffer.
        if (chunk.text && chunk.text.length > 0) {
          finalText = chunk.text;
        }
        if (liveStream && !liveStream.failed) {
          liveStream.update(finalText);
        }
      }
      if (chunk.type === "done") {
        // done.text is the authoritative final accumulated text from
        // the provider. Prefer it over the buffered value so runs that
        // end on a tool_use don't leave us with a pre-tool snippet.
        if (chunk.text && chunk.text.length > 0) {
          finalText = chunk.text;
        }
        inputTokens = chunk.inputTokens || 0;
        outputTokens = chunk.outputTokens || 0;
      }
      if (chunk.type === "error") {
        // Providers surface mid-stream errors as an `error` chunk
        // instead of throwing. Capture the reason so the post-loop
        // status resolution below can distinguish this from a clean
        // finish, and keep whatever text we already buffered.
        streamError = chunk.error || "stream error";
      }
    }

    // If cancelAllSubAgents has already taken over (shutdown path), don't
    // overwrite the cancelled result it synthesised. Also: if the generator
    // exited gracefully but the abort signal fired mid-stream (e.g. the
    // provider's queryWithFallback returned `type:error` and we fell out
    // of the loop without throwing), mark the run as cancelled rather
    // than completed — the result output is whatever we buffered.
    if (entry.result && entry.result.status === "cancelled") {
      // cancelAllSubAgents already set this; nothing to do.
    } else if (abort.signal.aborted) {
      entry.result = {
        id,
        name: resolvedName,
        status: "cancelled",
        output: finalText,
        tokensUsed: { input: inputTokens, output: outputTokens },
        duration: Date.now() - startTime,
      };
      entry.info.status = "cancelled";
    } else if (streamError) {
      // Provider emitted an error chunk but the generator ended cleanly —
      // record it as an error, but preserve the text buffered before the
      // failure so the caller sees useful partial output instead of "".
      entry.result = {
        id,
        name: resolvedName,
        status: "error",
        output: finalText,
        tokensUsed: { input: inputTokens, output: outputTokens },
        duration: Date.now() - startTime,
        error: streamError,
      };
      entry.info.status = "error";
    } else {
      entry.result = {
        id,
        name: resolvedName,
        status: "completed",
        output: finalText,
        tokensUsed: { input: inputTokens, output: outputTokens },
        duration: Date.now() - startTime,
      };
      entry.info.status = "completed";
    }

    // A4: finalize the live-stream if we had one. On success, mark the
    // entry as delivered so spawnSubAgent.finally() skips the normal
    // deliverSubAgentResult path — the live stream already posted the
    // body, and finalize() already posted the banner.
    if (liveStream && !liveStream.failed && entry.result) {
      try {
        await liveStream.finalize(entry.info, entry.result);
        entry.delivered = true;
      } catch (err) {
        console.error(`[subagent ${id}] live-stream finalize failed:`, err);
        // Let the normal delivery path fire as a fallback.
      }
    }
  } catch (err) {
    // If cancelAllSubAgents already set a cancelled result, keep it.
    if (entry.result && entry.result.status === "cancelled") return;

    const isAbort = err instanceof Error && err.message.includes("abort");
    const isTimeout = abort.signal.aborted;

    const status: SubAgentResult["status"] = isTimeout
      ? "timeout"
      : isAbort
        ? "cancelled"
        : "error";

    entry.result = {
      id,
      name: resolvedName,
      // Preserve whatever text was buffered before the failure.
      // Empty output here used to throw away multi-minute runs.
      output: finalText,
      tokensUsed: { input: inputTokens, output: outputTokens },
      duration: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
      status,
    };
    entry.info.status = status;
  }
}

// ── Public API ──────────────────────────────────────────

/**
 * Spawn an isolated sub-agent that runs in the background.
 * Returns the agent ID immediately (does NOT await completion).
 */
// ── D3: bounded priority queue ──────────────────────────────

/** Entry in the bounded queue awaiting a free execution slot. */
interface QueuedSpawn {
  id: string;
  resolvedName: string;
  agentConfig: SubAgentConfig;
  depth: number;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

const pendingQueue: QueuedSpawn[] = [];

/** Priority order used when draining the queue — higher index = lower priority. */
const SOURCE_PRIORITY: Array<"user" | "cron" | "implicit"> = ["user", "cron", "implicit"];

function sourceOf(cfg: SubAgentConfig): "user" | "cron" | "implicit" {
  return cfg.source ?? "implicit";
}

/** Count how many agents are currently running. */
function runningCount(): number {
  return [...activeAgents.values()].filter((a) => a.info.status === "running").length;
}

/**
 * Pop the next queued spawn according to priority (user > cron > implicit)
 * and within each priority in FIFO order. Returns null if the queue is empty.
 */
function popHighestPriorityQueued(): QueuedSpawn | null {
  for (const priority of SOURCE_PRIORITY) {
    const idx = pendingQueue.findIndex((q) => sourceOf(q.agentConfig) === priority);
    if (idx >= 0) {
      const [entry] = pendingQueue.splice(idx, 1);
      return entry;
    }
  }
  return null;
}

/**
 * Recalculate queuePosition for every entry still in the queue. Called
 * after a pop or a cancel so /subagents list reflects the current state.
 */
function reindexQueue(): void {
  for (let i = 0; i < pendingQueue.length; i++) {
    const q = pendingQueue[i];
    const entry = activeAgents.get(q.id);
    if (entry) entry.info.queuePosition = i + 1;
  }
}

/** Drain as many queued spawns as fit into the current free slots. */
function drainQueue(): void {
  const maxParallel = getMaxParallelAgents();
  while (pendingQueue.length > 0 && runningCount() < maxParallel) {
    const next = popHighestPriorityQueued();
    if (!next) break;
    const entry = activeAgents.get(next.id);
    if (!entry) continue; // was cancelled while queued
    reindexQueue();
    // Transition to running
    entry.info.status = "running";
    entry.info.startedAt = Date.now();
    entry.info.queuePosition = undefined;
    startRun(next);
  }
}

// ── Spawn pipeline ──────────────────────────────────────────

function startRun(q: QueuedSpawn): void {
  const { id, resolvedName, agentConfig, timeoutId } = q;
  const entry = activeAgents.get(id);
  if (!entry) return;
  // Run in background — don't await
  runSubAgent(id, agentConfig, entry.abort, resolvedName)
    .finally(() => {
      if (timeoutId) clearTimeout(timeoutId);

      const currentEntry = activeAgents.get(id);
      if (agentConfig.onComplete && currentEntry?.result) {
        try {
          agentConfig.onComplete(currentEntry.result);
        } catch (err) {
          console.error(`[subagent ${id}] onComplete callback threw:`, err);
        }
      }

      // I3: fire delivery router (non-blocking, errors logged). Guarded
      // by the `delivered` flag.
      if (currentEntry?.result && !currentEntry.delivered) {
        currentEntry.delivered = true;
        const resultSnapshot = currentEntry.result;
        const infoSnapshot = currentEntry.info;
        import("./subagent-delivery.js")
          .then(({ deliverSubAgentResult }) =>
            deliverSubAgentResult(infoSnapshot, resultSnapshot, {
              visibility: agentConfig.visibility,
            }),
          )
          .catch((err) =>
            console.error(`[subagent ${id}] delivery failed:`, err),
          );
      }

      // H3: record this run in the rolling 24h stats (non-blocking).
      if (currentEntry?.result) {
        const resultSnapshot = currentEntry.result;
        const infoSnapshot = currentEntry.info;
        import("./subagent-stats.js")
          .then(({ recordSubAgentRun }) =>
            recordSubAgentRun(infoSnapshot, resultSnapshot),
          )
          .catch((err) =>
            console.error(`[subagent ${id}] stats recording failed:`, err),
          );
      }

      // D3: drain the queue now that a slot has freed up
      drainQueue();

      // Auto-cleanup: remove completed agents after 30 minutes
      setTimeout(() => {
        const e = activeAgents.get(id);
        if (e && e.info.status !== "running" && e.info.status !== "queued") {
          activeAgents.delete(id);
        }
      }, 30 * 60 * 1000);
    });
}

export function spawnSubAgent(agentConfig: SubAgentConfig): Promise<string> {
  // F2: enforce depth cap before touching any state.
  const depth = agentConfig.depth ?? 0;
  if (depth > MAX_SUBAGENT_DEPTH) {
    return Promise.reject(
      new Error(
        `Sub-agent depth limit reached (${MAX_SUBAGENT_DEPTH}). Agents can only spawn ${MAX_SUBAGENT_DEPTH} level(s) of nested agents.`,
      ),
    );
  }

  // G1: toolset preset (v4.12.2 — extended with readonly + research).
  // The literal type constrains at compile time; the runtime check catches
  // callers that bypass TypeScript (e.g. plugin code loaded at runtime).
  const toolset = agentConfig.toolset ?? "full";
  if (toolset !== "full" && toolset !== "readonly" && toolset !== "research") {
    return Promise.reject(
      new Error(
        `Invalid toolset "${toolset}". Valid presets: full, readonly, research.`,
      ),
    );
  }

  const maxParallel = getMaxParallelAgents();
  const queueCap = getQueueCap();
  const running = runningCount();
  const queuedLen = pendingQueue.length;

  // B2: resolve the requested name to a unique variant.
  const resolved = resolveAgentName(agentConfig.name);
  const resolvedName = resolved.name;

  const id = crypto.randomUUID();
  // Timeout resolution order:
  //   1. Per-spawn override (agentConfig.timeout) — used by cron jobs that
  //      carry their own timeoutMs.
  //   2. Runtime default from sub-agents.json (set via /subagents timeout).
  //   3. config.subAgentTimeout fallback (seeded from SUBAGENT_TIMEOUT env).
  // Any value ≤ 0 means "no timeout" — we simply don't arm the abort timer.
  // The existing null-safe `clearTimeout(timeoutId)` call sites make this
  // a safe no-op when the agent finishes or is cancelled.
  const timeout = agentConfig.timeout ?? getDefaultTimeoutMs();
  const abort = new AbortController();
  const timeoutId: ReturnType<typeof setTimeout> | null =
    timeout > 0 ? setTimeout(() => abort.abort(), timeout) : null;

  const willRunImmediately = running < maxParallel;
  const canQueue = !willRunImmediately && queueCap > 0 && queuedLen < queueCap;

  if (!willRunImmediately && !canQueue) {
    // No slot, no queue room → priority-aware reject
    if (timeoutId) clearTimeout(timeoutId);
    const source = sourceOf(agentConfig);
    const runningAgents = [...activeAgents.values()].filter(
      (a) => a.info.status === "running",
    );
    const userSlots = runningAgents.filter((a) => a.info.source === "user").length;
    const bgSlots = runningAgents.length - userSlots;
    let message: string;
    if (source === "user") {
      if (bgSlots > 0) {
        message = `Alle Slots belegt (${running}/${maxParallel}), davon ${bgSlots} cron/implicit im Hintergrund. Queue voll (${queuedLen}/${queueCap}). /subagents list für Details oder /subagents cancel <name>.`;
      } else {
        message = `Alle Slots belegt (${running}/${maxParallel}) mit eigenen user-Spawns. Queue voll (${queuedLen}/${queueCap}). /subagents cancel <name> oder warten.`;
      }
    } else {
      message = `Sub-agent limit reached (${maxParallel} running, ${queuedLen}/${queueCap} queued). Wait for a running agent to finish or cancel one.`;
    }
    return Promise.reject(new Error(message));
  }

  const info: SubAgentInfo = {
    id,
    name: resolvedName,
    status: willRunImmediately ? "running" : "queued",
    startedAt: Date.now(),
    model: agentConfig.model,
    source: agentConfig.source,
    depth,
    parentChatId: agentConfig.parentChatId,
    nameIndex: resolved.index,
    queuePosition: willRunImmediately ? undefined : queuedLen + 1,
  };

  activeAgents.set(id, { info, abort, delivered: false });

  const queuedSpawn: QueuedSpawn = { id, resolvedName, agentConfig, depth, timeoutId };

  if (willRunImmediately) {
    startRun(queuedSpawn);
  } else {
    pendingQueue.push(queuedSpawn);
    reindexQueue();
  }

  return Promise.resolve(id);
}


/**
 * List all agents (active + recent completed).
 *
 * This is the v4.0.0 API — shows only agents from the bot-level
 * registry (activeAgents Map). Does NOT include v4.13+ detached
 * `alvin_dispatch_agent` subprocesses which live in async-agent-
 * watcher. For the merged view used by `/subagents list`, use
 * `listActiveSubAgents()` instead.
 */
export function listSubAgents(): SubAgentInfo[] {
  return [...activeAgents.values()].map((a) => ({ ...a.info }));
}

/**
 * v4.14.1 — Merged view of BOTH sub-agent registries:
 *   1. Bot-level agents (subagents.ts activeAgents Map) — v4.0.0+
 *      the /sub-agents spawn CLI, cron-spawned sub-agents, implicit
 *      Task-tool children.
 *   2. Detached `alvin_dispatch_agent` subprocesses (async-agent-
 *      watcher pending Map) — v4.13+ the MCP-tool-dispatched
 *      agents that survive parent aborts.
 *
 * The user doesn't care which registry an agent lives in — "is there
 * anything running right now?" is the question `/subagents list`
 * answers. This function unifies the view.
 *
 * Pending async agents are synthesized into SubAgentInfo shape:
 *   - id: PendingAsyncAgent.agentId (alvin-prefixed hex)
 *   - name: PendingAsyncAgent.description
 *   - status: "running" (we wouldn't be pending otherwise)
 *   - startedAt: PendingAsyncAgent.startedAt
 *   - source: "cron" — matches the delivery banner's source tag
 *   - depth: 0 — dispatch agents are always top-level (no nesting)
 *   - platform: preserved from the pending entry
 *   - parentChatId: from the pending entry
 *
 * Lazy import of the watcher keeps this function cheap for callers
 * who only need the v4.0.0 view (importing the watcher pulls in its
 * whole startup cost otherwise).
 */
export async function listActiveSubAgents(): Promise<SubAgentInfo[]> {
  const botLevel = listSubAgents();

  let pending: SubAgentInfo[] = [];
  try {
    // Lazy dynamic import so this module doesn't depend on the watcher
    // at load time (preserves test isolation + avoids a circular boot).
    const watcher = await import("./async-agent-watcher.js");
    if (typeof watcher.listPendingAgents === "function") {
      const raw = watcher.listPendingAgents();
      pending = raw.map((p) => ({
        id: p.agentId,
        name: p.description,
        status: "running" as const,
        startedAt: p.startedAt,
        source: "cron" as const,
        depth: 0,
        platform: p.platform,
        parentChatId: p.chatId,
      }));
    }
  } catch {
    /* never break listing because of merge errors */
  }

  return [...botLevel, ...pending];
}

/**
 * Cancel a running sub-agent by ID.
 * Returns true if the agent was found and aborted.
 */
export function cancelSubAgent(id: string): boolean {
  const entry = activeAgents.get(id);
  if (!entry) return false;

  if (entry.info.status === "queued") {
    // D3: remove from the pending queue, reindex, mark cancelled.
    const idx = pendingQueue.findIndex((q) => q.id === id);
    if (idx >= 0) {
      const [removed] = pendingQueue.splice(idx, 1);
      if (removed.timeoutId) clearTimeout(removed.timeoutId);
      reindexQueue();
    }
    entry.info.status = "cancelled";
    return true;
  }

  if (entry.info.status !== "running") return false;

  entry.abort.abort();
  entry.info.status = "cancelled";
  return true;
}

/**
 * Get the result of a completed sub-agent.
 * Returns null if not found or still running.
 */
export function getSubAgentResult(id: string): SubAgentResult | null {
  const entry = activeAgents.get(id);
  return entry?.result ?? null;
}

/**
 * Cancel a sub-agent by name (or name#N). Returns true if a running agent
 * was found and aborted. Uses findSubAgentByName for resolution; in an
 * ambiguous case (multiple siblings under the same base name, caller did
 * not disambiguate), cancels the first candidate.
 */
export function cancelSubAgentByName(name: string): boolean {
  const match = findSubAgentByName(name);
  if (!match || "ambiguous" in match) return false;
  return cancelSubAgent(match.id);
}

/**
 * Get a sub-agent's result by name. Returns null if no such agent, no
 * result yet (still running), or the name is ambiguous without explicit
 * disambiguation.
 */
export function getSubAgentResultByName(name: string): SubAgentResult | null {
  const match = findSubAgentByName(name);
  if (!match || "ambiguous" in match) return null;
  return getSubAgentResult(match.id);
}

/**
 * Cancel all active sub-agents. Used during shutdown.
 *
 * When notify=true (default), each running agent gets a Telegram
 * delivery explaining that it was interrupted by a restart. Errors
 * during delivery are logged but never block shutdown. The whole
 * notify phase is capped at 5s so a hung Telegram send can't hold
 * the process hostage.
 */
export async function cancelAllSubAgents(notify: boolean = true): Promise<void> {
  const deliveryPromises: Promise<unknown>[] = [];

  // Iterate once: for each running agent (1) abort the SDK stream,
  // (2) synthesise and store a cancelled SubAgentResult, (3) mark
  // delivered=true so runSubAgent.finally() can't fire a second
  // delivery on the next microtask, (4) queue the I3 delivery.
  const runningEntries: Array<{
    id: string;
    info: SubAgentInfo;
    cancelResult: SubAgentResult;
  }> = [];

  // D3: clear the pending queue first so no entry starts during shutdown.
  for (const q of pendingQueue.splice(0)) {
    if (q.timeoutId) clearTimeout(q.timeoutId);
    const entry = activeAgents.get(q.id);
    if (entry) {
      entry.info.status = "cancelled";
      entry.delivered = true; // no delivery for queued-never-ran agents
    }
  }

  for (const [id, entry] of activeAgents) {
    if (entry.info.status !== "running") continue;

    entry.abort.abort();
    entry.info.status = "cancelled";

    const cancelResult: SubAgentResult = {
      id,
      name: entry.info.name,
      status: "cancelled",
      output: "⚠️ Agent wurde durch Bot-Restart unterbrochen. Bitte neu triggern.",
      tokensUsed: { input: 0, output: 0 },
      duration: Date.now() - entry.info.startedAt,
    };
    entry.result = cancelResult;
    entry.delivered = true;

    runningEntries.push({ id, info: entry.info, cancelResult });
  }

  if (!notify || runningEntries.length === 0) return;

  // Import once, then reuse. Doing one dynamic import per running agent
  // races with Vitest's mock-resolution in tests and can occasionally
  // resolve to the real module instead of the mock for later calls.
  const { deliverSubAgentResult } = await import("./subagent-delivery.js");

  for (const { id, info, cancelResult } of runningEntries) {
    const p = Promise.resolve(deliverSubAgentResult(info, cancelResult)).catch(
      (err) => {
        console.error(`[subagents] shutdown-notify failed for ${id}:`, err);
      },
    );
    deliveryPromises.push(p);
  }

  // Wait up to 5s total — long enough for real Telegram sends, short
  // enough that shutdown isn't held hostage by a hang.
  await Promise.race([
    Promise.all(deliveryPromises),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
}
