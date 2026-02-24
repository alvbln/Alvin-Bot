/**
 * Engine — Central AI query dispatcher.
 *
 * Bridges the gap between Telegram handlers and the provider system.
 * Handlers call engine.query(), engine routes to the right provider.
 */

import { config } from "./config.js";
import { createRegistry, type ProviderRegistry, type StreamChunk, type QueryOptions } from "./providers/index.js";

let registry: ProviderRegistry | null = null;

/**
 * Initialize the provider registry from config.
 * Called once at bot startup.
 */
export function initEngine(): ProviderRegistry {
  registry = createRegistry({
    primary: config.primaryProvider,
    fallbacks: config.fallbackProviders.length > 0 ? config.fallbackProviders : undefined,
    apiKeys: {
      openai: config.apiKeys.openai || undefined,
      google: config.apiKeys.google || undefined,
      nvidia: config.apiKeys.nvidia || undefined,
      openrouter: config.apiKeys.openrouter || undefined,
    },
  });

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
