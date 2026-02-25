/**
 * Engine — Central AI query dispatcher.
 *
 * Bridges the gap between Telegram handlers and the provider system.
 * Handlers call engine.query(), engine routes to the right provider.
 */

import fs from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { createRegistry, type ProviderRegistry, type StreamChunk, type QueryOptions } from "./providers/index.js";
import type { ProviderConfig } from "./providers/types.js";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CUSTOM_MODELS_FILE = resolve(BOT_ROOT, "docs", "custom-models.json");

let registry: ProviderRegistry | null = null;

/**
 * Load custom models from docs/custom-models.json
 */
function loadCustomProviders(): Record<string, ProviderConfig> {
  try {
    const models = JSON.parse(fs.readFileSync(CUSTOM_MODELS_FILE, "utf-8"));
    const result: Record<string, ProviderConfig> = {};
    for (const m of models) {
      result[m.key] = {
        type: "openai-compatible",
        name: m.name,
        model: m.model,
        baseUrl: m.baseUrl,
        apiKey: m.apiKeyEnv ? process.env[m.apiKeyEnv] : undefined,
        supportsVision: m.supportsVision ?? false,
        supportsStreaming: m.supportsStreaming ?? true,
        maxTokens: m.maxTokens,
        temperature: m.temperature,
      };
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Initialize the provider registry from config.
 * Called once at bot startup.
 */
export function initEngine(): ProviderRegistry {
  const customProviders = loadCustomProviders();

  registry = createRegistry({
    primary: config.primaryProvider,
    fallbacks: config.fallbackProviders.length > 0 ? config.fallbackProviders : undefined,
    apiKeys: {
      anthropic: config.apiKeys.anthropic || undefined,
      groq: config.apiKeys.groq || undefined,
      openai: config.apiKeys.openai || undefined,
      google: config.apiKeys.google || undefined,
      nvidia: config.apiKeys.nvidia || undefined,
      openrouter: config.apiKeys.openrouter || undefined,
    },
    customProviders: Object.keys(customProviders).length > 0 ? customProviders : undefined,
  });

  if (Object.keys(customProviders).length > 0) {
    console.log(`Custom models loaded: ${Object.keys(customProviders).join(", ")}`);
  }

  return registry;
}

/**
 * Get the provider registry. Must call initEngine() first.
 */
export function getRegistry(): ProviderRegistry {
  if (!registry) {
    throw new Error("Engine not initialized. Call initEngine() first.");
  }
  return registry;
}

/**
 * Run a query through the active provider (with fallback).
 * This is the main entry point for handlers.
 */
export async function* engineQuery(options: QueryOptions): AsyncGenerator<StreamChunk> {
  const reg = getRegistry();
  yield* reg.queryWithFallback(options);
}

/**
 * Get info about the current model setup for /status.
 */
export async function getEngineStatus(): Promise<string> {
  const reg = getRegistry();
  const providers = await reg.listAll();

  const lines = providers.map(p => {
    const marker = p.active ? "→" : "  ";
    return `${marker} ${p.key}: ${p.name} (${p.model}) ${p.status}`;
  });

  return `Model: ${reg.getActiveKey()}\n\n${lines.join("\n")}`;
}
