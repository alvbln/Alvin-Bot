/**
 * Fallback Order Manager — Persistent, user-configurable provider fallback chain.
 *
 * Supports reading/writing the fallback order from:
 * - Telegram (/fallback command)
 * - Web UI (API endpoint)
 * - CLI/Terminal
 *
 * Persists to docs/fallback-order.json and syncs with .env FALLBACK_PROVIDERS.
 */

import fs from "fs";
import { dirname } from "path";
import { FALLBACK_FILE, ENV_FILE, DATA_DIR } from "../paths.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface FallbackConfig {
  primary: string;
  fallbacks: string[];
  updatedAt: string;
  updatedBy: string; // "telegram", "webui", "cli", "setup"
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the current fallback order.
 */
export function getFallbackOrder(): FallbackConfig {
  try {
    if (fs.existsSync(FALLBACK_FILE)) {
      return JSON.parse(fs.readFileSync(FALLBACK_FILE, "utf-8"));
    }
  } catch { /* ignore */ }

  // Default from env
  return {
    primary: process.env.PRIMARY_PROVIDER || "groq",
    fallbacks: (process.env.FALLBACK_PROVIDERS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean),
    updatedAt: new Date().toISOString(),
    updatedBy: "env",
  };
}

/**
 * Set the fallback order.
 * Updates both docs/fallback-order.json and .env file.
 */
export function setFallbackOrder(
  primary: string,
  fallbacks: string[],
  updatedBy: string = "unknown"
): FallbackConfig {
  const config: FallbackConfig = {
    primary,
    fallbacks,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };

  // Ensure data dir exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Write JSON
  fs.writeFileSync(FALLBACK_FILE, JSON.stringify(config, null, 2));

  // Sync to .env
  syncToEnv(primary, fallbacks);

  return config;
}

/**
 * Move a provider up in the fallback order.
 */
export function moveUp(providerKey: string, updatedBy: string = "unknown"): FallbackConfig {
  const current = getFallbackOrder();
  const idx = current.fallbacks.indexOf(providerKey);
  if (idx > 0) {
    // Swap with previous
    [current.fallbacks[idx - 1], current.fallbacks[idx]] =
      [current.fallbacks[idx], current.fallbacks[idx - 1]];
  } else if (idx === 0) {
    // Move to primary, old primary becomes first fallback
    const oldPrimary = current.primary;
    current.primary = providerKey;
    current.fallbacks[0] = oldPrimary;
  }
  return setFallbackOrder(current.primary, current.fallbacks, updatedBy);
}

/**
 * Move a provider down in the fallback order.
 */
export function moveDown(providerKey: string, updatedBy: string = "unknown"): FallbackConfig {
  const current = getFallbackOrder();

  if (providerKey === current.primary && current.fallbacks.length > 0) {
    // Move primary to first fallback, first fallback becomes primary
    const newPrimary = current.fallbacks[0];
    current.fallbacks[0] = providerKey;
    current.primary = newPrimary;
  } else {
    const idx = current.fallbacks.indexOf(providerKey);
    if (idx >= 0 && idx < current.fallbacks.length - 1) {
      [current.fallbacks[idx], current.fallbacks[idx + 1]] =
        [current.fallbacks[idx + 1], current.fallbacks[idx]];
    }
  }
  return setFallbackOrder(current.primary, current.fallbacks, updatedBy);
}

/**
 * Add a provider to the fallback chain (at the end).
 */
export function addFallback(providerKey: string, updatedBy: string = "unknown"): FallbackConfig {
  const current = getFallbackOrder();
  if (!current.fallbacks.includes(providerKey) && providerKey !== current.primary) {
    current.fallbacks.push(providerKey);
  }
  return setFallbackOrder(current.primary, current.fallbacks, updatedBy);
}

/**
 * Remove a provider from the fallback chain.
 */
export function removeFallback(providerKey: string, updatedBy: string = "unknown"): FallbackConfig {
  const current = getFallbackOrder();
  current.fallbacks = current.fallbacks.filter(k => k !== providerKey);
  return setFallbackOrder(current.primary, current.fallbacks, updatedBy);
}

/**
 * Format the current order as a human-readable string.
 */
export function formatOrder(): string {
  const config = getFallbackOrder();
  const lines: string[] = [];
  lines.push(`1. 🥇 ${config.primary} (Primary)`);
  config.fallbacks.forEach((fb, i) => {
    lines.push(`${i + 2}. ${i === 0 ? "🥈" : i === 1 ? "🥉" : "  "} ${fb}`);
  });
  return lines.join("\n");
}

// ── Internal ────────────────────────────────────────────────────────────────

function syncToEnv(primary: string, fallbacks: string[]): void {
  try {
    if (!fs.existsSync(ENV_FILE)) return;

    let env = fs.readFileSync(ENV_FILE, "utf-8");

    // Update PRIMARY_PROVIDER
    if (env.match(/^PRIMARY_PROVIDER=.*/m)) {
      env = env.replace(/^PRIMARY_PROVIDER=.*/m, `PRIMARY_PROVIDER=${primary}`);
    } else {
      env += `\nPRIMARY_PROVIDER=${primary}`;
    }

    // Update FALLBACK_PROVIDERS
    const fallbackStr = fallbacks.join(",");
    if (env.match(/^FALLBACK_PROVIDERS=.*/m)) {
      env = env.replace(/^FALLBACK_PROVIDERS=.*/m, `FALLBACK_PROVIDERS=${fallbackStr}`);
    } else {
      env += `\nFALLBACK_PROVIDERS=${fallbackStr}`;
    }

    fs.writeFileSync(ENV_FILE, env);
  } catch (err) {
    console.error("Failed to sync fallback order to .env:", err);
  }
}
