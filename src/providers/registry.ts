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
import { CodexCLIProvider } from "./codex-cli-provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { OllamaProvider } from "./ollama-provider.js";
import { PROVIDER_PRESETS } from "./types.js";
import { t } from "../i18n.js";

/**
 * Identify an Ollama endpoint by its baseUrl rather than by a hardcoded
 * provider key. This lets users define aliases (e.g. `my-ollama`,
 * `ollama-local`) in FALLBACK_PROVIDERS or custom-models.json and still
 * get the on-demand lifecycle behaviour automatically.
 */
function isOllamaEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  return baseUrl.includes("localhost:11434") || baseUrl.includes("127.0.0.1:11434");
}

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
   *
   * Two invariants beyond the obvious chain-walk:
   *
   * 1. Lifecycle-managed providers (local runners like Ollama) get booted
   *    on-demand if they're not already running. Without this, a
   *    mid-session Claude failure would silently skip Ollama because its
   *    daemon isn't awake yet — the heartbeat's 5-minute cadence can't
   *    react fast enough to save an in-flight user request.
   *
   * 2. If the active provider has already emitted text to the user and
   *    then errors out mid-stream, we do NOT silently failover to the
   *    next provider. Chaining a second model underneath a half-finished
   *    Claude response is more confusing than surfacing a clear error
   *    and asking the user to retry. The failover is only silent when
   *    the failing provider hadn't committed any visible text yet.
   */
  async *queryWithFallback(options: QueryOptions): AsyncGenerator<StreamChunk> {
    const chain = [this.activeKey, ...this.fallbackKeys.filter(k => k !== this.activeKey)];
    const errors: Array<{ key: string; error: string }> = [];

    for (const key of chain) {
      const provider = this.providers.get(key);
      if (!provider) continue;

      // Check availability. For lifecycle-managed providers (Ollama et al.)
      // that are currently asleep, actively try to boot them before giving up.
      let available = await provider.isAvailable().catch(() => false);
      if (!available && provider.lifecycle) {
        console.log(`Provider "${key}" asleep — booting on-demand…`);
        const booted = await provider.lifecycle.ensureRunning().catch(() => false);
        if (booted) {
          available = await provider.isAvailable().catch(() => false);
        }
      }
      if (!available) {
        console.log(`Provider "${key}" not available, trying next...`);
        errors.push({ key, error: "not available (check auth/config)" });
        continue;
      }

      // ─── Query with silent retry for transient mid-stream aborts ─────
      // Anthropic occasionally drops streams (network hiccup, server-side
      // flap, rate-limit blip). Rather than surfacing the error on the
      // first failure, we retry the SAME provider once with a short delay.
      // Only mid-stream abort-shaped errors trigger the retry — pre-stream
      // failures and user cancels go straight to the fallback / error path.
      const MAX_ATTEMPTS = 2;
      const RETRY_DELAY_MS = 2_000;
      let attempts = 0;
      let hadError = false;
      let lastError = "";
      let hadVisibleText = false;

      while (attempts < MAX_ATTEMPTS) {
        attempts++;
        hadError = false;
        lastError = "";
        hadVisibleText = false;

        try {
          for await (const chunk of provider.query(options)) {
            if (chunk.type === "error") {
              hadError = true;
              lastError = chunk.error || "Unknown error";
              break;
            }
            if (chunk.type === "text" && chunk.text && chunk.text.length > 0) {
              hadVisibleText = true;
            }
            yield chunk;
            if (chunk.type === "done") return;
          }
        } catch (err) {
          hadError = true;
          lastError = err instanceof Error ? err.message : String(err);
        }

        if (!hadError) {
          // Loop ended naturally without a done — unusual, fall through.
          break;
        }

        // Retry eligibility:
        //   - mid-stream (had visible text before error)
        //   - not a user-initiated cancel (abortSignal is externally fired)
        //   - error looks transient (contains "abort")
        //   - still have attempts left
        const isUserAbort = options.abortSignal?.aborted === true;
        const isTransientLooking = lastError.toLowerCase().includes("abort");
        const shouldRetry =
          hadVisibleText
          && attempts < MAX_ATTEMPTS
          && !isUserAbort
          && isTransientLooking;

        if (!shouldRetry) break;

        console.log(`Provider "${key}" mid-stream abort (attempt ${attempts}/${MAX_ATTEMPTS}) — retrying in ${RETRY_DELAY_MS}ms: ${lastError}`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        // If the user cancelled during the delay, bail before the next attempt.
        if (options.abortSignal?.aborted === true) break;
      }

      if (hadError) {
        console.log(`Provider "${key}" failed: ${lastError}. ${hadVisibleText ? "Mid-stream — surfacing error." : "Trying next..."}`);
        errors.push({ key, error: lastError });

        // Mid-stream failure: the user already has partial text on screen.
        // Yield a terminal error instead of switching to a different model
        // that would write a second, unrelated response underneath.
        if (hadVisibleText) {
          yield {
            type: "error",
            error: t("bot.error.midStream", options.locale, {
              name: provider.getInfo().name,
              detail: lastError,
            }),
          };
          return;
        }

        // Pre-stream failure: safe to silently switch to the next provider.
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

    // All providers failed — show specific errors
    const errorDetail = errors.map(e => `  ${e.key}: ${e.error}`).join("\n");
    yield {
      type: "error",
      error: `No provider available.\n${errorDetail}\n\nFix: alvin-bot setup | Telegram: /model`,
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
      case "codex-cli":
        return new CodexCLIProvider(config);
      case "openai-compatible":
        // Local runners that happen to speak the OpenAI-compat protocol
        // get a subclass that layers on-demand lifecycle management.
        if (isOllamaEndpoint(config.baseUrl)) {
          return new OllamaProvider(config);
        }
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
    anthropic?: string;
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

  // Register Codex CLI if referenced
  if (config.primary === "codex-cli" || config.fallbacks?.includes("codex-cli")) {
    providers["codex-cli"] = {
      ...PROVIDER_PRESETS["codex-cli"],
      type: "codex-cli",
      name: "Codex CLI (OpenAI)",
      model: "gpt-5.4",
    } as ProviderConfig;
  }

  // Claude (Agent SDK) — the base provider plus three tier-aliased virtual
  // entries. All four route through the same ClaudeSDKProvider implementation
  // but pass a different `model:` to the Agent SDK at query time. The aliases
  // ("opus" | "sonnet" | "haiku") auto-resolve to the latest tier on the
  // Claude CLI — no hardcoded version IDs, no manual updates when Anthropic
  // releases a new model.
  const claudeKeys = ["claude-sdk", "claude-opus", "claude-sonnet", "claude-haiku"];
  const claudeReferenced = claudeKeys.some(
    (k) => config.primary === k || config.fallbacks?.includes(k),
  );
  if (claudeReferenced) {
    providers["claude-sdk"] = {
      ...PROVIDER_PRESETS["claude-sdk"],
      type: "claude-sdk",
      name: "Claude (Agent SDK)",
      model: "inherit", // CLI default → currently Opus 4.7 on Max plan
    } as ProviderConfig;
    providers["claude-opus"] = {
      ...PROVIDER_PRESETS["claude-sdk"],
      type: "claude-sdk",
      name: "Claude Opus (auto-latest)",
      model: "opus",
    } as ProviderConfig;
    providers["claude-sonnet"] = {
      ...PROVIDER_PRESETS["claude-sdk"],
      type: "claude-sdk",
      name: "Claude Sonnet (auto-latest)",
      model: "sonnet",
    } as ProviderConfig;
    providers["claude-haiku"] = {
      ...PROVIDER_PRESETS["claude-sdk"],
      type: "claude-sdk",
      name: "Claude Haiku (auto-latest)",
      model: "haiku",
    } as ProviderConfig;
  }

  // Register Google Gemini only if explicitly referenced as primary/fallback
  // (GOOGLE_API_KEY is also used for image generation — doesn't mean Gemini should be a chat provider)
  if (config.primary === "google" || config.fallbacks?.includes("google")) {
    providers["google"] = {
      ...PROVIDER_PRESETS["gemini-2.5-flash"],
      name: "Google Gemini",
      apiKey: config.apiKeys?.google,
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
