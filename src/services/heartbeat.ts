/**
 * Heartbeat Service — Provider health monitoring with auto-failover.
 *
 * Periodically pings providers (tiny completion request) to detect outages.
 * If the primary provider fails, auto-switches to the first healthy fallback.
 * When the primary recovers, switches back automatically.
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
}

// ── Configuration ───────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const HEARTBEAT_TIMEOUT_MS = 15_000;          // 15s timeout per check
const FAIL_THRESHOLD = 2;                     // Switch after 2 consecutive failures
const RECOVERY_THRESHOLD = 1;                 // Switch back after 1 success

// Default heartbeat/fallback provider (free, no key needed for check)
const HEARTBEAT_PROVIDER = "groq";

// ── State ───────────────────────────────────────────────────────────────────

const state: HeartbeatState = {
  providers: new Map(),
  intervalId: null,
  isRunning: false,
  originalPrimary: "",
  wasFailedOver: false,
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

  // Initial health state for all providers
  const allProviders = registry as any;
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

  for (const [key, health] of state.providers) {
    const provider = registry.get(key);
    if (!provider) continue;

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
      health.failCount++;
      health.lastLatencyMs = Date.now() - start;
      health.lastCheck = Date.now();
      health.lastError = err instanceof Error ? err.message : String(err);

      if (health.failCount >= FAIL_THRESHOLD) {
        health.healthy = false;
        console.log(`💓 ❌ ${key}: unhealthy (${health.failCount} failures: ${health.lastError})`);
      } else {
        console.log(`💓 ⚠️ ${key}: failure ${health.failCount}/${FAIL_THRESHOLD} (${health.lastError})`);
      }
    }
  }

  // Auto-failover logic
  handleFailover(registry);
}

async function pingProvider(provider: any, key: string): Promise<string> {
  // For Claude SDK, just check CLI availability (no API call needed)
  if (key === "claude-sdk") {
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

function handleFailover(registry: any): void {
  const primaryHealth = state.providers.get(state.originalPrimary);
  const currentKey = registry.getActiveKey();

  // Case 1: Primary is down → switch to first healthy fallback
  if (primaryHealth && !primaryHealth.healthy && currentKey === state.originalPrimary) {
    const fallbackOrder = config.fallbackProviders;
    for (const fbKey of fallbackOrder) {
      const fbHealth = state.providers.get(fbKey);
      if (fbHealth?.healthy) {
        console.log(`💓 🔄 Auto-failover: ${state.originalPrimary} → ${fbKey}`);
        registry.switchTo(fbKey);
        state.wasFailedOver = true;
        return;
      }
    }
    console.log("💓 ⚠️ All providers unhealthy — staying on primary");
  }

  // Case 2: Primary recovered → switch back
  if (primaryHealth?.healthy && state.wasFailedOver && currentKey !== state.originalPrimary) {
    console.log(`💓 ✅ Primary recovered — switching back to ${state.originalPrimary}`);
    registry.switchTo(state.originalPrimary);
    state.wasFailedOver = false;
  }
}
