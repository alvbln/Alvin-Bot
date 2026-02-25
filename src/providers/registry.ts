/**
 * Provider Registry — Model selection, fallback chain, and runtime switching.
 *
 * This is the central hub for multi-model support. It manages:
 * - Which providers are configured and available
 * - The active provider (switchable at runtime via /model)
 * - Fallback chain when the active provider fails
 */

import type { Provider, ProviderConfig, StreamChunk, QueryOptions } from "./types.js";
import { ClaudeSDKProvider } from "./claude-sdk-provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { PROVIDER_PRESETS } from "./types.js";

export interface RegistryConfig {
  /** Primary provider key */
  primary: string;
  /** Fallback provider keys (in order) */
  fallbacks?: string[];
  /** Provider configurations */
  providers: Record<string, ProviderConfig>;
}

export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  private primaryKey: string;
  private fallbackKeys: string[];
  private activeKey: string;

  constructor(config: RegistryConfig) {
    this.primaryKey = config.primary;
    this.fallbackKeys = config.fallbacks || [];
    this.activeKey = config.primary;

    // Register all configured providers
    for (const [key, providerConfig] of Object.entries(config.providers)) {
      this.register(key, providerConfig);
    }
  }

  /**
   * Register a provider by key.
   */
  register(key: string, config: ProviderConfig): void {
    const provider = this.createProvider(config);
    this.providers.set(key, provider);
  }

  /**
   * Get the currently active provider.
   */
  getActive(): Provider {
    const provider = this.providers.get(this.activeKey);
    if (!provider) {
      throw new Error(`Active provider "${this.activeKey}" not found`);
    }
    return provider;
  }

  /**
   * Get a specific provider by key.
   */
  get(key: string): Provider | undefined {
    return this.providers.get(key);
  }

  /**
   * Switch the active provider (e.g., via /model command).
   */
  switchTo(key: string): boolean {
    if (!this.providers.has(key)) return false;
    this.activeKey = key;
    return true;
  }

  /**
   * Get the active provider key.
   */
  getActiveKey(): string {
    return this.activeKey;
  }

  /**
   * List all registered providers with their status.
   */
  async listAll(): Promise<Array<{ key: string; name: string; model: string; status: string; active: boolean }>> {
    const result: Array<{ key: string; name: string; model: string; status: string; active: boolean }> = [];
    for (const [key, provider] of this.providers) {
      const info = provider.getInfo();
      result.push({
        key,
        ...info,
        active: key === this.activeKey,
      });
    }
    return result;
  }

  /**
   * Query with automatic fallback.
   * Tries the active provider first, then fallbacks in order.
   */
  async *queryWithFallback(options: QueryOptions): AsyncGenerator<StreamChunk> {
    const chain = [this.activeKey, ...this.fallbackKeys.filter(k => k !== this.activeKey)];

    for (const key of chain) {
      const provider = this.providers.get(key);
      if (!provider) continue;

      // Check availability before trying
      const available = await provider.isAvailable().catch(() => false);
      if (!available) {
        console.log(`Provider "${key}" not available, trying next...`);
        continue;
      }

      let hadError = false;
      let lastError = "";

      try {
        for await (const chunk of provider.query(options)) {
          if (chunk.type === "error") {
            hadError = true;
            lastError = chunk.error || "Unknown error";
            break;
          }
          yield chunk;
          if (chunk.type === "done") return;
        }
      } catch (err) {
        hadError = true;
        lastError = err instanceof Error ? err.message : String(err);
      }

      if (hadError) {
        console.log(`Provider "${key}" failed: ${lastError}. Trying next...`);
        // Find next provider to notify about fallback
        const nextIdx = chain.indexOf(key) + 1;
        if (nextIdx < chain.length) {
          const nextProvider = this.providers.get(chain[nextIdx]);
          if (nextProvider) {
            yield {
              type: "fallback",
              failedProvider: provider.getInfo().name,
              providerName: nextProvider.getInfo().name,
              error: lastError,
            };
          }
        }
        continue;
      }

      // If we got here without done or error, something's off
      return;
    }

    // All providers failed
    yield {
      type: "error",
      error: "All providers failed. Check your API keys and configuration.",
    };
  }

  /**
   * Reset to primary provider.
   */
  resetToDefault(): void {
    this.activeKey = this.primaryKey;
  }

  // ── Private ─────────────────────────────────────────

  private createProvider(config: ProviderConfig): Provider {
    switch (config.type) {
      case "claude-sdk":
        return new ClaudeSDKProvider(config);
      case "openai-compatible":
        return new OpenAICompatibleProvider(config);
      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }
  }
}

// ── Factory: Create registry from simple config ─────────

export interface SimpleConfig {
  primary: string;
  fallbacks?: string[];
  apiKeys?: {
    openai?: string;
    google?: string;
    nvidia?: string;
    groq?: string;
    openrouter?: string;
  };
  customProviders?: Record<string, ProviderConfig>;
}

/**
 * Create a ProviderRegistry from a simple, user-friendly config.
 * Auto-configures providers based on available API keys.
 */
export function createRegistry(config: SimpleConfig): ProviderRegistry {
  const providers: Record<string, ProviderConfig> = {};

  // Always register Claude SDK if it's referenced
  if (config.primary === "claude-sdk" || config.fallbacks?.includes("claude-sdk")) {
    providers["claude-sdk"] = {
      ...PROVIDER_PRESETS["claude-sdk"],
      type: "claude-sdk",
      name: "Claude (Agent SDK)",
      model: "claude-opus-4-6",
    } as ProviderConfig;
  }

  // Auto-register Groq if key is available
  if (config.apiKeys?.groq) {
    providers["groq"] = {
      ...PROVIDER_PRESETS["groq"],
      apiKey: config.apiKeys.groq,
    } as ProviderConfig;
  }

  // Auto-register OpenAI models if key is available
  if (config.apiKeys?.openai) {
    providers["gpt-4o"] = {
      ...PROVIDER_PRESETS["gpt-4o"],
      apiKey: config.apiKeys.openai,
    } as ProviderConfig;
    providers["gpt-4o-mini"] = {
      ...PROVIDER_PRESETS["gpt-4o-mini"],
      apiKey: config.apiKeys.openai,
    } as ProviderConfig;
  }

  // Auto-register Gemini if key is available
  if (config.apiKeys?.google) {
    providers["google"] = {
      ...PROVIDER_PRESETS["gemini-2.5-flash"],
      name: "Google Gemini",
      apiKey: config.apiKeys.google,
    } as ProviderConfig;
    providers["gemini-2.5-pro"] = {
      ...PROVIDER_PRESETS["gemini-2.5-pro"],
      apiKey: config.apiKeys.google,
    } as ProviderConfig;
    providers["gemini-2.5-flash"] = {
      ...PROVIDER_PRESETS["gemini-2.5-flash"],
      apiKey: config.apiKeys.google,
    } as ProviderConfig;
    providers["gemini-3-pro"] = {
      ...PROVIDER_PRESETS["gemini-3-pro"],
      apiKey: config.apiKeys.google,
    } as ProviderConfig;
    providers["gemini-3-flash"] = {
      ...PROVIDER_PRESETS["gemini-3-flash"],
      apiKey: config.apiKeys.google,
    } as ProviderConfig;
  }

  // Auto-register OpenAI newer models
  if (config.apiKeys?.openai) {
    providers["gpt-4.1"] = {
      ...PROVIDER_PRESETS["gpt-4.1"],
      apiKey: config.apiKeys.openai,
    } as ProviderConfig;
    providers["gpt-4.1-mini"] = {
      ...PROVIDER_PRESETS["gpt-4.1-mini"],
      apiKey: config.apiKeys.openai,
    } as ProviderConfig;
    providers["o3-mini"] = {
      ...PROVIDER_PRESETS["o3-mini"],
      apiKey: config.apiKeys.openai,
    } as ProviderConfig;
  }

  // Auto-register Groq additional models
  if (config.apiKeys?.groq) {
    providers["groq-llama-3.1-8b"] = {
      ...PROVIDER_PRESETS["groq-llama-3.1-8b"],
      apiKey: config.apiKeys.groq,
    } as ProviderConfig;
    providers["groq-mixtral"] = {
      ...PROVIDER_PRESETS["groq-mixtral"],
      apiKey: config.apiKeys.groq,
    } as ProviderConfig;
  }

  // Auto-register NVIDIA NIM if key is available
  if (config.apiKeys?.nvidia) {
    providers["nvidia-llama-3.3-70b"] = {
      ...PROVIDER_PRESETS["nvidia-llama-3.3-70b"],
      apiKey: config.apiKeys.nvidia,
    } as ProviderConfig;
    providers["nvidia-kimi-k2.5"] = {
      ...PROVIDER_PRESETS["nvidia-kimi-k2.5"],
      apiKey: config.apiKeys.nvidia,
    } as ProviderConfig;
  }

  // Auto-register OpenRouter if key is available
  if (config.apiKeys?.openrouter) {
    providers["openrouter"] = {
      ...PROVIDER_PRESETS["openrouter"],
      apiKey: config.apiKeys.openrouter,
    } as ProviderConfig;
  }

  // Always try to detect local Ollama
  providers["ollama"] = {
    ...PROVIDER_PRESETS["ollama"],
  } as ProviderConfig;

  // Add custom providers
  if (config.customProviders) {
    Object.assign(providers, config.customProviders);
  }

  return new ProviderRegistry({
    primary: config.primary,
    fallbacks: config.fallbacks,
    providers,
  });
}
