/**
 * Ollama Provider — OpenAI-compatible chat-completions with an on-demand
 * daemon lifecycle.
 *
 * Inherits all the request/response handling (streaming, tool-calling,
 * rate-limit extraction, vision, …) from OpenAICompatibleProvider. Only
 * adds the `lifecycle` field so the rest of the bot (heartbeat, /model
 * switch, /status, shutdown) can manage the local daemon generically
 * without any hardcoded "ollama" string-matching.
 *
 * When the architecture needs another local runner (LM Studio, llama.cpp,
 * vLLM, Jan.ai, …), the pattern is the same: subclass
 * OpenAICompatibleProvider, assign a `lifecycle` with its own
 * ensureRunning/ensureStopped/isRunning/isBotManaged implementation.
 */

import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { ProviderConfig, ProviderLifecycle } from "./types.js";
import {
  ensureRunning as managerEnsureRunning,
  ensureStopped as managerEnsureStopped,
  isDaemonRunning as managerIsDaemonRunning,
  isBotManaged as managerIsBotManaged,
} from "../services/ollama-manager.js";

export class OllamaProvider extends OpenAICompatibleProvider {
  readonly lifecycle: ProviderLifecycle;

  constructor(config: ProviderConfig) {
    super(config);
    // Capture the model name at construction time so the lifecycle closures
    // don't need to reach into this.config on every call.
    const modelName = config.model;
    this.lifecycle = {
      ensureRunning: () => managerEnsureRunning(modelName),
      ensureStopped: () => managerEnsureStopped(),
      isRunning: () => managerIsDaemonRunning(),
      isBotManaged: () => managerIsBotManaged(),
    };
  }
}
