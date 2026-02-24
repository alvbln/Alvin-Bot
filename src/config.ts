import "dotenv/config";
import os from "os";

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
    groq: process.env.GROQ_API_KEY || "",
    openai: process.env.OPENAI_API_KEY || "",
    google: process.env.GOOGLE_API_KEY || "",
    nvidia: process.env.NVIDIA_API_KEY || "",
    openrouter: process.env.OPENROUTER_API_KEY || "",
  },
} as const;
