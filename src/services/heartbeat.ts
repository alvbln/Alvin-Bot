/**
 * Heartbeat Service — Provider health monitoring with auto-failover.
 *
 * Periodically pings providers (tiny completion request) to detect outages.
 * If the primary provider fails, auto-switches to the first healthy fallback.
 * When the primary recovers, switches back automatically.
 *
 * v4.15.2 — Sleep-aware: detects macOS/Linux suspend via wall-clock drift
 * (gap between expected and actual heartbeat tick > 2× the interval). After
 * wake, gives providers a grace period before counting failures, and schedules
 * a quick recovery probe 60s after any failover so recovery doesn't wait for
 * the full 5-minute cycle.
 *
 * The heartbeat provider (Groq by default) is always registered as the
 * last-resort fallback — free, fast, reliable.
 */

import { getRegistry } from "../engine.js";
import { config } from "../config.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface ProviderHealth {
  key: string;
  healthy: boolean;
  lastCheck: number;
  lastLatencyMs: number;
  failCount: number;
  lastError?: string;
}

interface HeartbeatState {
  providers: Map<string, ProviderHealth>;
  intervalId: ReturnType<typeof setInterval> | null;
  isRunning: boolean;
  originalPrimary: string;
  wasFailedOver: boolean;
  /** Wall-clock timestamp of the last runHeartbeat() invocation. Used to
   *  detect macOS sleep: if now − lastRunAt > 2× interval, the machine was
   *  suspended and providers need a warm-up grace period. */
  lastRunAt: number;
  /** When set, we're in a post-sleep grace period. Probes run but failures
   *  don't count toward the fail threshold until this timestamp passes. */
  graceUntil: number;
  /** Pending quick-recovery timer (cleared on stop / new failover). */
  quickRecoveryTimer: ReturnType<typeof setTimeout> | null;
}

// ── Configuration ───────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const HEARTBEAT_TIMEOUT_MS = 15_000;          // 15s timeout per check
const FAIL_THRESHOLD = 2;                     // Switch after 2 consecutive failures
const RECOVERY_THRESHOLD = 1;                 // Switch back after 1 success

/** After detecting macOS sleep/wake, skip failure accounting for this long.
 *  Gives network, DNS, and OAuth token refresh time to settle. */
const POST_SLEEP_GRACE_MS = 60_000;           // 60s grace after wake

/** After a failover, schedule an extra recovery probe after this delay
 *  instead of waiting for the full HEARTBEAT_INTERVAL_MS cycle. */
const QUICK_RECOVERY_DELAY_MS = 60_000;       // 60s after failover → re-check

// Default heartbeat/fallback provider (free, no key needed for check)
const HEARTBEAT_PROVIDER = "groq";

// ── State ───────────────────────────────────────────────────────────────────

const state: HeartbeatState = {
  providers: new Map(),
  intervalId: null,
  isRunning: false,
  originalPrimary: "",
  wasFailedOver: false,
  lastRunAt: 0,
  graceUntil: 0,
  quickRecoveryTimer: null,
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Start the heartbeat monitor.
 */
export function startHeartbeat(): void {
  if (state.isRunning) return;

  const registry = getRegistry();
  state.originalPrimary = registry.getActiveKey();
  state.isRunning = true;
  state.lastRunAt = Date.now();
  state.graceUntil = 0;

  // Initial health state for all providers
  // We'll check providers in the fallback chain
  const chain = [
    config.primaryProvider,
    ...config.fallbackProviders,
  ].filter((v, i, a) => a.indexOf(v) === i); // dedupe

  for (const key of chain) {
    state.providers.set(key, {
      key,
      healthy: true, // assume healthy until proven otherwise
      lastCheck: 0,
      lastLatencyMs: 0,
      failCount: 0,
    });
  }

  console.log(`💓 Heartbeat monitor started (${HEARTBEAT_INTERVAL_MS / 1000}s interval, ${chain.length} providers)`);

  // Run first check after 30s (let bot fully start)
  setTimeout(() => {
    runHeartbeat();
    state.intervalId = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS);
  }, 30_000);
}

/**
 * Stop the heartbeat monitor.
 */
export function stopHeartbeat(): void {
  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
  if (state.quickRecoveryTimer) {
    clearTimeout(state.quickRecoveryTimer);
    state.quickRecoveryTimer = null;
  }
  state.isRunning = false;
  console.log("💓 Heartbeat monitor stopped");
}

/**
 * Get current health status of all monitored providers.
 */
export function getHealthStatus(): Array<{
  key: string;
  healthy: boolean;
  latencyMs: number;
  failCount: number;
  lastCheck: string;
  lastError?: string;
}> {
  return Array.from(state.providers.values()).map(p => ({
    key: p.key,
    healthy: p.healthy,
    latencyMs: p.lastLatencyMs,
    failCount: p.failCount,
    lastCheck: p.lastCheck ? new Date(p.lastCheck).toISOString() : "never",
    lastError: p.lastError,
  }));
}

/**
 * Get the fallback order (user-configurable).
 */
export function getFallbackOrder(): string[] {
  return config.fallbackProviders;
}

/**
 * Whether we're currently failed over from the primary.
 */
export function isFailedOver(): boolean {
  return state.wasFailedOver;
}

// ── Internal ────────────────────────────────────────────────────────────────

async function runHeartbeat(): Promise<void> {
  const registry = getRegistry();
  const now = Date.now();

  // ── Sleep detection ────────────────────────────────────────────────────
  // Node.js setInterval pauses during macOS/Linux suspend. If the wall-clock
  // gap since the last tick exceeds 2× the interval, the machine was asleep.
  // In that case, providers (especially CLI-based ones like claude-sdk) need
  // time to warm up — network re-connects, OAuth tokens refresh, DNS caches
  // re-populate. Without a grace period, the first probe after wake almost
  // always fails, triggering a premature failover to Ollama.
  const elapsed = now - state.lastRunAt;
  const justWoke = state.lastRunAt > 0 && elapsed > HEARTBEAT_INTERVAL_MS * 2;

  if (justWoke) {
    const sleepDuration = Math.round(elapsed / 60_000);
    console.log(`💓 😴 Sleep detected (~${sleepDuration}min gap). Grace period ${POST_SLEEP_GRACE_MS / 1000}s — failures won't count.`);
    state.graceUntil = now + POST_SLEEP_GRACE_MS;

    // Invalidate isAvailable() caches on all providers so the first probe
    // after wake doesn't serve a 7-hour-old cached "unavailable" result.
    for (const [key] of state.providers) {
      const provider = registry.get(key);
      if (provider && typeof (provider as any).invalidateAvailabilityCache === "function") {
        (provider as any).invalidateAvailabilityCache();
      }
    }

    // Reset fail counters — stale failures from before sleep are meaningless.
    for (const [, health] of state.providers) {
      if (!health.healthy) {
        health.failCount = 0;
        health.healthy = true;
        console.log(`💓 😴 Reset ${health.key} to healthy (post-sleep clean slate)`);
      }
    }
  }

  state.lastRunAt = now;
  const inGracePeriod = now < state.graceUntil;

  // ── Provider health checks ─────────────────────────────────────────────
  for (const [key, health] of state.providers) {
    const provider = registry.get(key);
    if (!provider) continue;

    // Providers with an on-demand lifecycle (local runners: Ollama, LM
    // Studio, llama.cpp, …) are not pinged periodically — they're off
    // until we actively boot them during failover. Mark as always-healthy
    // so they remain a valid failover target.
    if (provider.lifecycle) {
      health.healthy = true;
      health.lastCheck = Date.now();
      health.lastLatencyMs = 0;
      health.failCount = 0;
      health.lastError = undefined;
      continue;
    }

    const start = Date.now();
    try {
      // Quick availability check first
      const available = await Promise.race([
        provider.isAvailable(),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), HEARTBEAT_TIMEOUT_MS)
        ),
      ]);

      if (!available) {
        throw new Error("Provider reported unavailable");
      }

      // Tiny completion request to verify actual functionality
      const testResult = await Promise.race([
        pingProvider(provider, key),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), HEARTBEAT_TIMEOUT_MS)
        ),
      ]);

      // Success
      health.healthy = true;
      health.lastLatencyMs = Date.now() - start;
      health.lastCheck = Date.now();
      health.lastError = undefined;

      // Recovery check: if primary was down and is back
      if (health.failCount > 0) {
        console.log(`💓 ${key}: recovered (${health.lastLatencyMs}ms)`);
      }
      health.failCount = 0;

    } catch (err) {
      health.lastLatencyMs = Date.now() - start;
      health.lastCheck = Date.now();
      health.lastError = err instanceof Error ? err.message : String(err);

      // During the post-sleep grace period, log the failure but don't
      // increment the counter — transient post-wake unavailability is
      // expected and should not trigger a failover.
      if (inGracePeriod) {
        console.log(`💓 😴 ${key}: probe failed during grace period (${health.lastError}) — not counting`);
        continue;
      }

      health.failCount++;

      if (health.failCount >= FAIL_THRESHOLD) {
        health.healthy = false;
        console.log(`💓 ❌ ${key}: unhealthy (${health.failCount} failures: ${health.lastError})`);
      } else {
        console.log(`💓 ⚠️ ${key}: failure ${health.failCount}/${FAIL_THRESHOLD} (${health.lastError})`);
      }
    }
  }

  // Auto-failover logic
  await handleFailover(registry);
}

async function pingProvider(provider: any, key: string): Promise<string> {
  // For CLI-based providers, just check availability (no full query needed)
  if (key === "claude-sdk" || key === "codex-cli") {
    const available = await provider.isAvailable();
    return available ? "ok" : "unavailable";
  }

  // For OpenAI-compatible: tiny completion
  let text = "";
  for await (const chunk of provider.query({
    prompt: "Hi",
    systemPrompt: "Reply with exactly: ok",
    history: [],
  })) {
    if (chunk.type === "text") text = chunk.text;
    if (chunk.type === "done") return text || "ok";
    if (chunk.type === "error") throw new Error(chunk.error);
  }
  return text || "ok";
}

async function handleFailover(registry: any): Promise<void> {
  const primaryHealth = state.providers.get(state.originalPrimary);
  const currentKey = registry.getActiveKey();

  // Case 1: Primary is down → switch to first healthy fallback
  if (primaryHealth && !primaryHealth.healthy && currentKey === state.originalPrimary) {
    const fallbackOrder = config.fallbackProviders;
    for (const fbKey of fallbackOrder) {
      const fbHealth = state.providers.get(fbKey);
      if (!fbHealth?.healthy) continue;

      const fbProvider = registry.get(fbKey);
      if (!fbProvider) continue;

      // Providers with a lifecycle (local runners) must be booted before
      // the switch. If boot fails, skip and try the next fallback.
      if (fbProvider.lifecycle) {
        console.log(`💓 🔄 Auto-failover: ${state.originalPrimary} → ${fbKey} — booting ${fbKey}…`);
        const ok = await fbProvider.lifecycle.ensureRunning();
        if (!ok) {
          console.log(`💓 ⚠️ ${fbKey} boot failed — skipping`);
          continue;
        }
      } else {
        console.log(`💓 🔄 Auto-failover: ${state.originalPrimary} → ${fbKey}`);
      }
      registry.switchTo(fbKey);
      state.wasFailedOver = true;

      // v4.15.2 — Schedule a quick recovery probe so we don't sit on
      // the fallback for a full 5 minutes when the primary might already
      // be back. Clear any previous pending timer first.
      scheduleQuickRecovery();
      return;
    }
    console.log("💓 ⚠️ All providers unhealthy — staying on primary");
    return;
  }

  // Case 2: Primary recovered → switch back, tearing down any lifecycle-
  // managed fallback we booted during the outage.
  if (primaryHealth?.healthy && state.wasFailedOver && currentKey !== state.originalPrimary) {
    const currentProvider = registry.get(currentKey);
    console.log(`💓 ✅ Primary recovered — switching back to ${state.originalPrimary}`);
    registry.switchTo(state.originalPrimary);
    state.wasFailedOver = false;
    if (currentProvider?.lifecycle) {
      console.log(`💓 🧹 Tearing down ${currentKey} daemon + unloading model`);
      await currentProvider.lifecycle.ensureStopped();
    }
  }
}

/**
 * Schedule an extra heartbeat probe after QUICK_RECOVERY_DELAY_MS. This runs
 * in addition to the regular 5-minute interval — its sole purpose is to detect
 * primary recovery quickly after a failover instead of waiting up to 5 minutes.
 */
function scheduleQuickRecovery(): void {
  if (state.quickRecoveryTimer) {
    clearTimeout(state.quickRecoveryTimer);
  }
  console.log(`💓 ⏱️ Quick recovery probe scheduled in ${QUICK_RECOVERY_DELAY_MS / 1000}s`);
  state.quickRecoveryTimer = setTimeout(async () => {
    state.quickRecoveryTimer = null;
    if (!state.wasFailedOver || !state.isRunning) return;
    console.log("💓 ⏱️ Quick recovery probe firing…");
    await runHeartbeat();
  }, QUICK_RECOVERY_DELAY_MS);
}
