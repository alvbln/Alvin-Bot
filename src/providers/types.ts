/**
 * Alvin Bot — Multi-Model Provider Abstraction
 *
 * Unified interfaces for different LLM backends.
 * Every provider implements the same interface, making model switching seamless.
 */

// ── Chat Message Types ──────────────────────────────────

export type MessageRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** Optional image paths/URLs for vision-capable models */
  images?: string[];
}

// ── Streaming ───────────────────────────────────────────

export interface StreamChunk {
  type: "text" | "tool_use" | "tool_result" | "done" | "error" | "fallback";
  /** Accumulated full text so far (for text chunks) */
  text?: string;
  /** Delta text (new text in this chunk only) */
  delta?: string;
  /** Tool name (for tool_use chunks) */
  toolName?: string;
  /** Tool input (for tool_use chunks) */
  toolInput?: string;
  /** Tool use id correlation — matches the Anthropic tool_use block id.
   *  Set on BOTH tool_use and tool_result chunks so consumers can
   *  correlate request/response (e.g. the task-aware stuck timer tracks
   *  pending sync Task/Agent tool calls by this id). */
  toolUseId?: string;
  /** v4.12.1 — For tool_use chunks of type Task/Agent: whether the tool
   *  call has `run_in_background: true` in its input. Extracted by the
   *  provider BEFORE any serialization truncation so the flag survives
   *  long prompts. The message handler uses this to decide between the
   *  normal and extended stuck-timeout. `undefined` = not set / unknown /
   *  not a Task tool; `false` = explicit sync; `true` = async. */
  runInBackground?: boolean;
  /** Raw text content of a tool_result block. For Anthropic SDK: the
   *  concatenated `text` fields of the tool_result.content[] array. The
   *  async-agent watcher inspects this to detect run_in_background launches. */
  toolResultContent?: string;
  /** Error message (for error chunks) */
  error?: string;
  /** Session ID for resumable conversations */
  sessionId?: string;
  /** Cost of this turn in USD */
  costUsd?: number;
  /** Token usage for this turn */
  inputTokens?: number;
  outputTokens?: number;
  /** Provider name (for fallback notifications) */
  providerName?: string;
  /** Failed provider name (for fallback notifications) */
  failedProvider?: string;
  /** Rate limit info from response headers */
  rateLimits?: {
    requestsLimit?: number;
    requestsRemaining?: number;
    requestsReset?: string;
    tokensLimit?: number;
    tokensRemaining?: number;
    tokensReset?: string;
  };
  /** v4.18.5 — Provider-requested session reset. When true, the message
   *  handler should clear the session's stored sessionId so the next query
   *  starts a fresh SDK session instead of resuming a corrupt/stale one.
   *  Signalled by claude-sdk-provider when it detects an empty-stream
   *  termination (typically caused by resuming a session that the Claude
   *  backend has silently dropped). */
  sessionResetRequested?: boolean;
}

// ── Provider Configuration ──────────────────────────────

export interface ProviderConfig {
  /** Provider type identifier */
  type: "claude-sdk" | "openai-compatible" | "codex-cli";
  /** Display name for this provider */
  name: string;
  /** Model identifier (e.g., "gpt-4o", "claude-opus-4-6", "llama-3.3-70b-instruct") */
  model: string;
  /** API key (not needed for Claude SDK with Max subscription) */
  apiKey?: string;
  /** Base URL for OpenAI-compatible endpoints */
  baseUrl?: string;
  /** Max tokens for response */
  maxTokens?: number;
  /** Temperature (0-2) */
  temperature?: number;
  /** Context window size in tokens. Used by /status to render a
   *  "Context: X/Y (Z%)" progress meter. Best-effort — values come
   *  from PROVIDER_PRESETS and may go stale when models change. */
  contextWindow?: number;
  /** Whether this provider supports tool use */
  supportsTools?: boolean;
  /** Whether this provider supports vision (image input) */
  supportsVision?: boolean;
  /** Whether this provider supports streaming */
  supportsStreaming?: boolean;
  /** Provider-specific options */
  options?: Record<string, unknown>;
}

// ── Query Options ───────────────────────────────────────

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface QueryOptions {
  /** The user's message */
  prompt: string;
  /** Conversation history (for non-SDK providers) */
  history?: ChatMessage[];
  /** System prompt */
  systemPrompt?: string;
  /** Working directory for tool-using providers */
  workingDir?: string;
  /**
   * Per-query model override. Takes precedence over the provider's
   * config.model. Accepts CLI aliases ("opus" | "sonnet" | "haiku")
   * or pinned IDs ("claude-opus-4-7"). Currently honored by the
   * Claude Agent SDK provider only; other providers ignore it.
   */
  model?: string;
  /** Resume a previous session (provider-specific) */
  sessionId?: string | null;
  /** Thinking effort level */
  effort?: EffortLevel;
  /** Abort signal */
  abortSignal?: AbortSignal;
  /** User's preferred UI locale — used by the registry to localize
   *  failure messages (mid-stream error, "No provider available", …).
   *  Does not affect what language the LLM replies in. */
  locale?: "en" | "de" | "es" | "fr";
  /** v4.12.2 — Override the default allowedTools list. Used by sub-agents
   *  with toolset="readonly" or "research" to restrict what Claude can do.
   *  When undefined, the provider uses its default (full tool access). */
  allowedTools?: string[];
  /**
   * v4.13 — Context for Alvin's custom MCP tools (alvin_dispatch_agent).
   * When set, the claude-sdk provider registers the Alvin MCP server
   * with this context so Claude can call alvin_dispatch_agent to spawn
   * truly detached background sub-agents.
   *
   * When undefined, the custom tools are not exposed — Claude falls
   * back to the built-in Task tool only. Non-SDK providers ignore this.
   */
  alvinDispatchContext?: {
    /** v4.14 — string for Slack/Discord/WhatsApp, number for Telegram. */
    chatId: number | string;
    userId: number | string;
    sessionKey: string;
    /** v4.14 — platform for watcher delivery routing. Default "telegram". */
    platform?: "telegram" | "slack" | "discord" | "whatsapp";
  };
}

// ── Provider Interface ──────────────────────────────────

/**
 * Optional lifecycle hooks for providers that need to start/stop external
 * infrastructure on demand — e.g. local LLM runners like Ollama, LM Studio,
 * llama.cpp, vLLM, Jan.ai, etc. Cloud providers (OpenAI, Groq, Gemini, …)
 * leave this undefined — they are either reachable or not, nothing to boot.
 *
 * The heartbeat, the /model switch helper, /status rendering, and the
 * graceful shutdown path all check for the presence of `lifecycle` and
 * treat such providers as "on-demand" without any hardcoded key matching.
 */
export interface ProviderLifecycle {
  /** Spawn the daemon (if not already running) and preload the model.
   *  Returns true on success. Idempotent — safe to call multiple times. */
  ensureRunning(): Promise<boolean>;

  /** Stop the daemon (only if bot-managed) and unload the model.
   *  No-op if the daemon was started externally. */
  ensureStopped(): Promise<void>;

  /** Live probe — is the daemon currently reachable? */
  isRunning(): Promise<boolean>;

  /** Was the currently-running daemon spawned by this bot?
   *  Used to distinguish bot-managed vs externally-managed instances. */
  isBotManaged(): boolean;
}

export interface Provider {
  /** Provider configuration */
  readonly config: ProviderConfig;

  /**
   * Send a query and stream the response.
   * Yields StreamChunks as the response is generated.
   */
  query(options: QueryOptions): AsyncGenerator<StreamChunk>;

  /**
   * Check if this provider is available and configured.
   * Returns true if API key is set, endpoint is reachable, etc.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get provider display info for /status command.
   */
  getInfo(): { name: string; model: string; status: string };

  /**
   * Optional on-demand lifecycle hooks for local runners. Cloud providers
   * leave this undefined.
   */
  readonly lifecycle?: ProviderLifecycle;
}

// ── Provider Presets (common configurations) ────────────

export const PROVIDER_PRESETS: Record<string, Partial<ProviderConfig>> = {
  // OpenAI (via Codex CLI — full tool use)
  "codex-cli": {
    type: "codex-cli",
    name: "Codex CLI (OpenAI)",
    model: "gpt-5.4",
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    contextWindow: 400_000,
  },

  // Anthropic (via Agent SDK — full tool use, 1M-context beta enabled)
  "claude-sdk": {
    type: "claude-sdk",
    name: "Claude (Agent SDK)",
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    contextWindow: 1_000_000,
  },

  // Anthropic API (via OpenAI-compatible endpoint — no Agent SDK needed)
  "claude-opus": {
    type: "openai-compatible",
    name: "Claude Opus 4",
    model: "claude-opus-4-6",
    baseUrl: "https://api.anthropic.com/v1/",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 200_000,
  },
  "claude-sonnet": {
    type: "openai-compatible",
    name: "Claude Sonnet 4.6",
    model: "claude-sonnet-4-6",
    baseUrl: "https://api.anthropic.com/v1/",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 200_000,
  },
  "claude-haiku": {
    type: "openai-compatible",
    name: "Claude Haiku 4.5",
    model: "claude-haiku-4-5",
    baseUrl: "https://api.anthropic.com/v1/",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 200_000,
  },

  // Groq (fast inference, free tier, supports function calling)
  "groq": {
    type: "openai-compatible",
    name: "Groq (Llama 3.3 70B)",
    model: "llama-3.3-70b-versatile",
    baseUrl: "https://api.groq.com/openai/v1",
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 128_000,
  },

  // OpenAI (supports function calling)
  "gpt-4o": {
    type: "openai-compatible",
    name: "GPT-4o",
    model: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 128_000,
  },
  "gpt-4o-mini": {
    type: "openai-compatible",
    name: "GPT-4o Mini",
    model: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 128_000,
  },

  // Google Gemini (via OpenAI-compatible endpoint, supports function calling)
  "gemini-2.5-pro": {
    type: "openai-compatible",
    name: "Gemini 2.5 Pro",
    model: "gemini-2.5-pro",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 1_000_000,
  },
  "gemini-2.5-flash": {
    type: "openai-compatible",
    name: "Gemini 2.5 Flash",
    model: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 1_000_000,
  },
  "gemini-3-pro": {
    type: "openai-compatible",
    name: "Gemini 3 Pro (Preview)",
    model: "gemini-3-pro-preview",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 2_000_000,
  },
  "gemini-3-flash": {
    type: "openai-compatible",
    name: "Gemini 3 Flash (Preview)",
    model: "gemini-3-flash-preview",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 1_000_000,
  },

  // OpenAI newer models
  "gpt-4.1": {
    type: "openai-compatible",
    name: "GPT-4.1",
    model: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 1_000_000,
  },
  "gpt-4.1-mini": {
    type: "openai-compatible",
    name: "GPT-4.1 Mini",
    model: "gpt-4.1-mini",
    baseUrl: "https://api.openai.com/v1",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 1_000_000,
  },
  "o3-mini": {
    type: "openai-compatible",
    name: "o3 Mini",
    model: "o3-mini",
    baseUrl: "https://api.openai.com/v1",
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 200_000,
  },

  // Groq additional models
  "groq-llama-3.1-8b": {
    type: "openai-compatible",
    name: "Llama 3.1 8B (Groq)",
    model: "llama-3.1-8b-instant",
    baseUrl: "https://api.groq.com/openai/v1",
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 128_000,
  },
  "groq-mixtral": {
    type: "openai-compatible",
    name: "Mixtral 8x7B (Groq)",
    model: "mixtral-8x7b-32768",
    baseUrl: "https://api.groq.com/openai/v1",
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 32_768,
  },

  // NVIDIA NIM (150+ free models)
  "nvidia-llama-3.3-70b": {
    type: "openai-compatible",
    name: "Llama 3.3 70B (NVIDIA)",
    model: "meta/llama-3.3-70b-instruct",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 128_000,
  },
  "nvidia-kimi-k2.5": {
    type: "openai-compatible",
    name: "Kimi K2.5 (NVIDIA)",
    model: "moonshotai/kimi-k2.5",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 200_000,
  },

  // Ollama (local models) — Gemma 4 E4B has an 8k context window
  "ollama": {
    type: "openai-compatible",
    name: "Gemma 4 E4B (Ollama)",
    model: "gemma4:e4b",
    baseUrl: "http://localhost:11434/v1",
    supportsVision: true,
    supportsStreaming: true,
    contextWindow: 8_192,
  },

  // OpenRouter (any model, one API, supports function calling).
  // Context window varies by model — default 200k is a middle-ground guess.
  "openrouter": {
    type: "openai-compatible",
    name: "OpenRouter",
    model: "anthropic/claude-sonnet-4",
    baseUrl: "https://openrouter.ai/api/v1",
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    contextWindow: 200_000,
  },
};
