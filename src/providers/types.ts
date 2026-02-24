/**
 * Mr. Levin — Multi-Model Provider Abstraction
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
  type: "text" | "tool_use" | "tool_result" | "done" | "error";
  /** Accumulated full text so far (for text chunks) */
  text?: string;
  /** Delta text (new text in this chunk only) */
  delta?: string;
  /** Tool name (for tool_use chunks) */
  toolName?: string;
  /** Tool input (for tool_use chunks) */
  toolInput?: string;
  /** Error message (for error chunks) */
  error?: string;
  /** Session ID for resumable conversations */
  sessionId?: string;
  /** Cost of this turn in USD */
  costUsd?: number;
}

// ── Provider Configuration ──────────────────────────────

export interface ProviderConfig {
  /** Provider type identifier */
  type: "claude-sdk" | "openai-compatible";
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
  /** Resume a previous session (provider-specific) */
  sessionId?: string | null;
  /** Thinking effort level */
  effort?: EffortLevel;
  /** Abort signal */
  abortSignal?: AbortSignal;
}

// ── Provider Interface ──────────────────────────────────

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
}

// ── Provider Presets (common configurations) ────────────

export const PROVIDER_PRESETS: Record<string, Partial<ProviderConfig>> = {
  // Anthropic (via Agent SDK — full tool use)
  "claude-sdk": {
    type: "claude-sdk",
    name: "Claude (Agent SDK)",
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
  },

  // OpenAI
  "gpt-4o": {
    type: "openai-compatible",
    name: "GPT-4o",
    model: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
    supportsVision: true,
    supportsStreaming: true,
  },
  "gpt-4o-mini": {
    type: "openai-compatible",
    name: "GPT-4o Mini",
    model: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    supportsVision: true,
    supportsStreaming: true,
  },

  // Google Gemini (via OpenAI-compatible endpoint)
  "gemini-2.5-pro": {
    type: "openai-compatible",
    name: "Gemini 2.5 Pro",
    model: "gemini-2.5-pro",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    supportsVision: true,
    supportsStreaming: true,
  },
  "gemini-2.5-flash": {
    type: "openai-compatible",
    name: "Gemini 2.5 Flash",
    model: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    supportsVision: true,
    supportsStreaming: true,
  },

  // NVIDIA NIM (150+ free models)
  "nvidia-llama-3.3-70b": {
    type: "openai-compatible",
    name: "Llama 3.3 70B (NVIDIA)",
    model: "meta/llama-3.3-70b-instruct",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    supportsVision: false,
    supportsStreaming: true,
  },
  "nvidia-kimi-k2.5": {
    type: "openai-compatible",
    name: "Kimi K2.5 (NVIDIA)",
    model: "moonshotai/kimi-k2.5",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    supportsVision: true,
    supportsStreaming: true,
  },

  // Ollama (local models)
  "ollama": {
    type: "openai-compatible",
    name: "Ollama (Local)",
    model: "llama3.2",
    baseUrl: "http://localhost:11434/v1",
    supportsVision: false,
    supportsStreaming: true,
  },

  // OpenRouter (any model, one API)
  "openrouter": {
    type: "openai-compatible",
    name: "OpenRouter",
    model: "anthropic/claude-sonnet-4",
    baseUrl: "https://openrouter.ai/api/v1",
    supportsVision: true,
    supportsStreaming: true,
  },
};
