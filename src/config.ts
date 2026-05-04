import dotenv from "dotenv";
import { resolve } from "path";
import os from "os";
import { existsSync } from "fs";

// Load .env from ~/.alvin-bot/.env (primary) with cwd fallback (dev mode)
const dataEnv = resolve(process.env.ALVIN_DATA_DIR || resolve(os.homedir(), ".alvin-bot"), ".env");
const cwdEnv = resolve(process.cwd(), ".env");

if (existsSync(dataEnv)) {
  dotenv.config({ path: dataEnv });
} else if (existsSync(cwdEnv)) {
  dotenv.config({ path: cwdEnv });
} else {
  dotenv.config(); // default behavior
}

export const config = {
  // Telegram
  botToken: process.env.BOT_TOKEN || "",
  allowedUsers: (process.env.ALLOWED_USERS || "")
    .split(",")
    .map(Number)
    .filter(Boolean),
  telegramMaxLength: 4096,
  streamThrottleMs: 1500,

  // Agent
  defaultWorkingDir: process.env.WORKING_DIR || os.homedir(),
  maxBudgetUsd: Number(process.env.MAX_BUDGET_USD) || 5.0,

  // Model provider (primary)
  primaryProvider: process.env.PRIMARY_PROVIDER || "claude-sdk",
  fallbackProviders: (process.env.FALLBACK_PROVIDERS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean),

  // API Keys (for multi-model support)
  apiKeys: {
    anthropic: process.env.ANTHROPIC_API_KEY || "",
    groq: process.env.GROQ_API_KEY || "",
    openai: process.env.OPENAI_API_KEY || "",
    google: process.env.GOOGLE_API_KEY || "",
    nvidia: process.env.NVIDIA_API_KEY || "",
    openrouter: process.env.OPENROUTER_API_KEY || "",
  },

  // Compaction
  compactionThreshold: Number(process.env.COMPACTION_THRESHOLD) || 80000,

  // Sub-Agents
  maxSubAgents: Number(process.env.MAX_SUBAGENTS) || 4,
  // Default sub-agent timeout. -1 / 0 = unlimited (no hard cut-off).
  // The runtime value lives in sub-agents.json and can be changed at runtime
  // via /subagents timeout; this constant only seeds the initial config on
  // first launch when SUBAGENT_TIMEOUT is not set.
  subAgentTimeout:
    process.env.SUBAGENT_TIMEOUT !== undefined && process.env.SUBAGENT_TIMEOUT !== ""
      ? Number(process.env.SUBAGENT_TIMEOUT)
      : -1,

  // TTS Provider
  ttsProvider: (process.env.TTS_PROVIDER || "edge") as "edge" | "elevenlabs",
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || "",
    voiceId: process.env.ELEVENLABS_VOICE_ID || "iP95p4xoKVk53GoZ742B",
    modelId: process.env.ELEVENLABS_MODEL_ID || "eleven_v3",
  },
  authMode: (process.env.AUTH_MODE || "allowlist") as "allowlist" | "pairing" | "open",
  sessionMode: (process.env.SESSION_MODE || "per-user") as "per-user" | "per-channel" | "per-channel-peer",
  webhookEnabled: process.env.WEBHOOK_ENABLED === "true",
  webhookToken: process.env.WEBHOOK_TOKEN || "",

  // Web UI bind host. Default is 127.0.0.1 (loopback only) — set to "0.0.0.0"
  // explicitly if you want LAN/external access. Combined with WEB_PASSWORD
  // this is the safe default since v4.20.2; previous versions defaulted to
  // listening on all interfaces with no auth required when WEB_PASSWORD was
  // empty.
  webHost: process.env.WEB_HOST || "127.0.0.1",

  // Slack caller allowlist. Comma-separated Slack user IDs (e.g. "U0ABC123,U0DEF456").
  // When non-empty, only these users can talk to the bot in Slack DMs and via @mention.
  // When empty, the bot accepts any Slack workspace member (legacy behavior; safe iff
  // the workspace is private to you).
  slackAllowedUsers: (process.env.SLACK_ALLOWED_USERS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean),

  // Browser
  cdpUrl: process.env.CDP_URL || "",
  browseServerPort: Number(process.env.BROWSE_SERVER_PORT) || 3800,

  // Exec Security
  execSecurity: (process.env.EXEC_SECURITY || "full") as "full" | "allowlist" | "deny",
} as const;
