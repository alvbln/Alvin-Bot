/**
 * Setup API — Platform & Model configuration endpoints.
 *
 * Handles:
 * - Platform setup (Discord, WhatsApp, Signal tokens + dependency installation)
 * - Model/Provider management (API keys, custom models, presets)
 * - Runtime activation/deactivation
 */

import fs from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import http from "http";
import { getRegistry } from "../engine.js";
import { PROVIDER_PRESETS, type ProviderConfig } from "../providers/types.js";
import { listJobs, createJob, deleteJob, toggleJob, updateJob, runJobNow, formatNextRun, humanReadableSchedule, type CronJob, type JobType } from "../services/cron.js";
import { storePassword, revokePassword, getSudoStatus, verifyPassword, sudoExec, requestAdminViaDialog, openSystemSettings } from "../services/sudo.js";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_FILE = resolve(BOT_ROOT, ".env");
const CUSTOM_MODELS_FILE = resolve(BOT_ROOT, "docs", "custom-models.json");

// ── Env Helpers ─────────────────────────────────────────

function readEnv(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE)) return {};
  const lines = fs.readFileSync(ENV_FILE, "utf-8").split("\n");
  const env: Record<string, string> = {};
  for (const line of lines) {
    if (line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

function writeEnvVar(key: string, value: string): void {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf-8") : "";
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_FILE, content);
}

function removeEnvVar(key: string): void {
  if (!fs.existsSync(ENV_FILE)) return;
  let content = fs.readFileSync(ENV_FILE, "utf-8");
  content = content.replace(new RegExp(`^${key}=.*\n?`, "m"), "");
  fs.writeFileSync(ENV_FILE, content);
}

// ── Custom Models Storage ───────────────────────────────

interface CustomModelDef {
  key: string;
  name: string;
  model: string;
  type: "openai-compatible";
  baseUrl: string;
  apiKeyEnv: string; // Env var name for the API key
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  maxTokens?: number;
  temperature?: number;
}

function loadCustomModels(): CustomModelDef[] {
  try {
    return JSON.parse(fs.readFileSync(CUSTOM_MODELS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveCustomModels(models: CustomModelDef[]): void {
  fs.writeFileSync(CUSTOM_MODELS_FILE, JSON.stringify(models, null, 2));
}

// ── Platform Definitions ────────────────────────────────

interface PlatformDef {
  id: string;
  name: string;
  icon: string;
  description: string;
  envVars: Array<{ key: string; label: string; placeholder: string; secret?: boolean; type?: string }>;
  npmPackages?: string[];
  setupUrl?: string;
  setupSteps: string[];
}

const PLATFORMS: PlatformDef[] = [
  {
    id: "telegram",
    name: "Telegram",
    icon: "📱",
    description: "Telegram Bot via BotFather. Der Standard-Messaging-Kanal.",
    envVars: [
      { key: "BOT_TOKEN", label: "Bot Token", placeholder: "123456:ABC-DEF...", secret: true },
      { key: "ALLOWED_USERS", label: "Erlaubte User IDs", placeholder: "123456789,987654321" },
    ],
    setupUrl: "https://t.me/BotFather",
    setupSteps: [
      "Öffne @BotFather auf Telegram",
      "Sende /newbot und folge den Anweisungen",
      "Kopiere den Bot Token hierher",
      "Für deine User-ID: Sende eine Nachricht an @userinfobot",
    ],
  },
  {
    id: "discord",
    name: "Discord",
    icon: "🎮",
    description: "Discord Bot für Server und DMs. Braucht discord.js.",
    envVars: [
      { key: "DISCORD_TOKEN", label: "Bot Token", placeholder: "MTIz...abc", secret: true },
    ],
    npmPackages: ["discord.js"],
    setupUrl: "https://discord.com/developers/applications",
    setupSteps: [
      "Erstelle eine Application auf discord.com/developers",
      "Gehe zu Bot → Reset Token → Token kopieren",
      "Aktiviere Message Content Intent unter Bot → Privileged Intents",
      "Lade den Bot auf deinen Server: OAuth2 → URL Generator → bot + messages.read + messages.write",
    ],
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    icon: "💬",
    description: "WhatsApp Web Verbindung via whatsapp-web.js. QR-Code Scan beim ersten Start.",
    envVars: [
      { key: "WHATSAPP_ENABLED", label: "Aktivieren", placeholder: "true", type: "toggle" },
      { key: "WHATSAPP_SELF_CHAT_ONLY", label: "Nur Self-Chat (empfohlen)", placeholder: "true", type: "toggle" },
      { key: "WHATSAPP_ALLOW_GROUPS", label: "In Gruppen antworten (bei @Mention)", placeholder: "", type: "toggle" },
      { key: "WHATSAPP_ALLOW_DMS", label: "Auf private Nachrichten antworten", placeholder: "", type: "toggle" },
    ],
    npmPackages: ["whatsapp-web.js"],
    setupSteps: [
      "Klicke 'Dependencies installieren' (falls nötig)",
      "Aktiviere WhatsApp (Toggle oben) und klicke 'Speichern'",
      "Starte den Bot neu (Maintenance → Bot neustarten)",
      "Der QR-Code erscheint hier unten — scanne ihn mit WhatsApp → Verknüpfte Geräte → Gerät hinzufügen",
      "Die Verbindung bleibt gespeichert (data/whatsapp-auth/)",
    ],
  },
  {
    id: "signal",
    name: "Signal",
    icon: "🔒",
    description: "Signal Messenger via signal-cli REST API. Braucht einen separaten signal-cli Container.",
    envVars: [
      { key: "SIGNAL_API_URL", label: "signal-cli REST API URL", placeholder: "http://localhost:8080" },
      { key: "SIGNAL_NUMBER", label: "Signal Nummer", placeholder: "+491234567890" },
    ],
    setupUrl: "https://github.com/bbernhard/signal-cli-rest-api",
    setupSteps: [
      "Starte signal-cli REST API (Docker empfohlen):",
      "docker run -p 8080:8080 bbernhard/signal-cli-rest-api",
      "Registriere deine Nummer über die API",
      "Trage URL und Nummer oben ein",
    ],
  },
];

// ── Provider/Model Definitions ──────────────────────────

interface ProviderDef {
  id: string;
  name: string;
  icon: string;
  description: string;
  envKey: string; // Env var for the API key
  models: Array<{ key: string; name: string; model: string }>;
  signupUrl?: string;
  docsUrl?: string;
  setupSteps: string[];
  free?: boolean;
}

const PROVIDERS: ProviderDef[] = [
  {
    id: "claude-sdk",
    name: "Claude Agent SDK",
    icon: "🟣",
    description: "Voller Tool-Use via Agent SDK. Braucht Claude CLI Login (Max Abo oder API Key).",
    envKey: "",
    models: [
      { key: "claude-sdk", name: "Claude (Agent SDK)", model: "claude-opus-4-6" },
    ],
    signupUrl: "https://console.anthropic.com",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
    setupSteps: [
      "npm install -g @anthropic-ai/claude-code",
      "claude login (Browser-Auth oder API Key)",
      "Voller Tool-Use: Dateien lesen/schreiben, Shell-Befehle, Browser",
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic API",
    icon: "🟣",
    description: "Claude Opus, Sonnet, Haiku direkt via API Key. OpenAI-kompatibel.",
    envKey: "ANTHROPIC_API_KEY",
    models: [
      { key: "claude-opus", name: "Claude Opus 4", model: "claude-opus-4-6" },
      { key: "claude-sonnet", name: "Claude Sonnet 4", model: "claude-sonnet-4-20250514" },
      { key: "claude-haiku", name: "Claude 3.5 Haiku", model: "claude-3-5-haiku-20241022" },
    ],
    signupUrl: "https://console.anthropic.com/settings/keys",
    docsUrl: "https://docs.anthropic.com/en/api",
    setupSteps: [
      "Account auf console.anthropic.com erstellen",
      "API Key unter Settings → API Keys generieren",
      "Credits aufladen (Pay-as-you-go) oder Abo nutzen",
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    icon: "🟢",
    description: "GPT-4o, GPT-4.1, o3/o4 und andere OpenAI Modelle.",
    envKey: "OPENAI_API_KEY",
    models: [
      { key: "gpt-4o", name: "GPT-4o", model: "gpt-4o" },
      { key: "gpt-4o-mini", name: "GPT-4o Mini", model: "gpt-4o-mini" },
      { key: "gpt-4.1", name: "GPT-4.1", model: "gpt-4.1" },
      { key: "gpt-4.1-mini", name: "GPT-4.1 Mini", model: "gpt-4.1-mini" },
      { key: "o3-mini", name: "o3 Mini", model: "o3-mini" },
    ],
    signupUrl: "https://platform.openai.com/api-keys",
    docsUrl: "https://platform.openai.com/docs",
    setupSteps: [
      "Account auf platform.openai.com erstellen",
      "API Key generieren unter API Keys",
      "Credits aufladen (Pay-as-you-go)",
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    icon: "🔵",
    description: "Gemini 2.5/3 Pro/Flash via Google AI Studio. Kostenloser Tier verfügbar.",
    envKey: "GOOGLE_API_KEY",
    models: [
      { key: "gemini-2.5-pro", name: "Gemini 2.5 Pro", model: "gemini-2.5-pro" },
      { key: "gemini-2.5-flash", name: "Gemini 2.5 Flash", model: "gemini-2.5-flash" },
      { key: "gemini-3-pro", name: "Gemini 3 Pro (Preview)", model: "gemini-3-pro-preview" },
      { key: "gemini-3-flash", name: "Gemini 3 Flash (Preview)", model: "gemini-3-flash-preview" },
    ],
    signupUrl: "https://aistudio.google.com/apikey",
    docsUrl: "https://ai.google.dev/docs",
    setupSteps: [
      "Google AI Studio öffnen (aistudio.google.com)",
      "API Key erstellen → sofort nutzbar",
      "Kostenloser Tier: 15 RPM, 1M TPM",
    ],
    free: true,
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    icon: "🟩",
    description: "150+ Modelle gratis (Llama, Kimi, Mistral, etc.) via NVIDIA API.",
    envKey: "NVIDIA_API_KEY",
    models: [
      { key: "nvidia-llama-3.3-70b", name: "Llama 3.3 70B", model: "meta/llama-3.3-70b-instruct" },
      { key: "nvidia-kimi-k2.5", name: "Kimi K2.5", model: "moonshotai/kimi-k2.5" },
    ],
    signupUrl: "https://build.nvidia.com",
    docsUrl: "https://docs.api.nvidia.com",
    setupSteps: [
      "Account auf build.nvidia.com erstellen",
      "Kostenlose API Key generieren",
      "150+ Modelle gratis verfügbar (1000 Credits/Monat)",
    ],
    free: true,
  },
  {
    id: "groq",
    name: "Groq",
    icon: "⚡",
    description: "Ultraschnelle Inferenz. Llama, Mixtral, Gemma — kostenlos und blitzschnell.",
    envKey: "GROQ_API_KEY",
    models: [
      { key: "groq", name: "Llama 3.3 70B (Groq)", model: "llama-3.3-70b-versatile" },
      { key: "groq-llama-3.1-8b", name: "Llama 3.1 8B (Groq)", model: "llama-3.1-8b-instant" },
      { key: "groq-mixtral", name: "Mixtral 8x7B (Groq)", model: "mixtral-8x7b-32768" },
    ],
    signupUrl: "https://console.groq.com",
    docsUrl: "https://console.groq.com/docs",
    setupSteps: [
      "Account auf console.groq.com erstellen (keine Kreditkarte nötig)",
      "API Key generieren",
      "Sofort nutzbar — kostenloser Tier mit Rate Limits",
    ],
    free: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "🌐",
    description: "Ein API Key, 200+ Modelle. Claude, GPT, Gemini, Llama — alles über eine API.",
    envKey: "OPENROUTER_API_KEY",
    models: [
      { key: "openrouter", name: "OpenRouter (Standard)", model: "anthropic/claude-sonnet-4" },
    ],
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    setupSteps: [
      "Account auf openrouter.ai erstellen",
      "API Key generieren",
      "Credits aufladen oder Free-Modelle nutzen",
    ],
  },
  {
    id: "ollama",
    name: "Ollama (Lokal)",
    icon: "🦙",
    description: "Lokale Modelle auf deinem Rechner. Kein API Key nötig, läuft offline.",
    envKey: "",
    models: [
      { key: "ollama", name: "Ollama (Local)", model: "llama3.2" },
    ],
    signupUrl: "https://ollama.com/download",
    docsUrl: "https://ollama.com/library",
    setupSteps: [
      "Ollama installieren: brew install ollama (macOS) oder ollama.com/download",
      "Model laden: ollama pull llama3.2",
      "Läuft automatisch auf localhost:11434",
    ],
    free: true,
  },
];

// ── API Handler ─────────────────────────────────────────

export async function handleSetupAPI(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string,
  body: string
): Promise<boolean> {
  res.setHeader("Content-Type", "application/json");

  // ── Platforms ───────────────────────────────────────

  // GET /api/platforms/setup — full setup info for all platforms
  if (urlPath === "/api/platforms/setup") {
    const env = readEnv();
    const platforms = PLATFORMS.map(p => ({
      ...p,
      configured: (() => {
        // A platform is "configured" if its primary env var(s) are set
        // Toggles: the first toggle being true is enough (e.g., WHATSAPP_ENABLED)
        // Text fields: all non-toggle fields must have a value
        const required = p.envVars.filter(v => v.type !== "toggle");
        const toggles = p.envVars.filter(v => v.type === "toggle");
        if (required.length > 0) return required.every(v => !!env[v.key]);
        if (toggles.length > 0) return toggles[0] && env[toggles[0].key] === "true";
        return false;
      })(),
      values: Object.fromEntries(
        p.envVars.map(v => [v.key, v.secret && env[v.key] ? maskSecret(env[v.key]) : (env[v.key] || "")])
      ),
      depsInstalled: p.npmPackages ? checkNpmDeps(p.npmPackages) : true,
    }));
    res.end(JSON.stringify({ platforms }));
    return true;
  }

  // POST /api/platforms/configure — save platform env vars
  if (urlPath === "/api/platforms/configure" && req.method === "POST") {
    try {
      const { platformId, values } = JSON.parse(body);
      const platform = PLATFORMS.find(p => p.id === platformId);
      if (!platform) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Unknown platform" }));
        return true;
      }
      for (const v of platform.envVars) {
        if (values[v.key] !== undefined && values[v.key] !== "") {
          writeEnvVar(v.key, values[v.key]);
          process.env[v.key] = values[v.key]; // Hot-apply for toggle changes
        } else if (values[v.key] === "") {
          removeEnvVar(v.key);
          delete process.env[v.key]; // Hot-remove
        }
      }
      // WhatsApp toggle-only changes (self-chat, groups, DMs) don't need restart
      const onlyToggles = platform.envVars.every(v => v.type === "toggle") ||
        (platformId === "whatsapp" && platform.envVars.filter(v => v.type !== "toggle").every(v => !values[v.key]));
      const restartNeeded = !onlyToggles;
      res.end(JSON.stringify({ ok: true, restartNeeded, note: restartNeeded ? "Neustart nötig um Änderungen zu aktivieren." : "Gespeichert." }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // POST /api/platforms/install-deps — install npm packages for a platform
  if (urlPath === "/api/platforms/install-deps" && req.method === "POST") {
    try {
      const { platformId } = JSON.parse(body);
      const platform = PLATFORMS.find(p => p.id === platformId);
      if (!platform?.npmPackages?.length) {
        res.end(JSON.stringify({ ok: true, note: "Keine Dependencies nötig." }));
        return true;
      }
      const pkgs = platform.npmPackages.join(" ");
      const output = execSync(`cd "${BOT_ROOT}" && npm install ${pkgs} --save-optional 2>&1`, {
        timeout: 120000,
        env: { ...process.env, PATH: process.env.PATH + ":/opt/homebrew/bin:/usr/local/bin" },
      }).toString();
      res.end(JSON.stringify({ ok: true, output: output.slice(0, 5000) }));
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.end(JSON.stringify({ error }));
    }
    return true;
  }

  // ── Models / Providers ─────────────────────────────

  // GET /api/providers/setup — full setup info for all providers
  if (urlPath === "/api/providers/setup") {
    const env = readEnv();
    const registry = getRegistry();
    const activeKey = registry.getActiveKey();
    const registeredModels = await registry.listAll();

    const providers = PROVIDERS.map(p => ({
      ...p,
      hasKey: p.envKey ? !!env[p.envKey] : true, // Ollama doesn't need key
      keyPreview: p.envKey && env[p.envKey] ? maskSecret(env[p.envKey]) : "",
      modelsActive: p.models.map(m => ({
        ...m,
        registered: registeredModels.some(rm => rm.key === m.key),
        active: activeKey === m.key,
        status: registeredModels.find(rm => rm.key === m.key)?.status || "not configured",
      })),
    }));

    const customModels = loadCustomModels();

    res.end(JSON.stringify({ providers, customModels, activeModel: activeKey }));
    return true;
  }

  // POST /api/providers/set-key — save an API key
  if (urlPath === "/api/providers/set-key" && req.method === "POST") {
    try {
      const { providerId, apiKey } = JSON.parse(body);
      const provider = PROVIDERS.find(p => p.id === providerId);
      if (!provider?.envKey) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Provider braucht keinen API Key" }));
        return true;
      }
      writeEnvVar(provider.envKey, apiKey);
      res.end(JSON.stringify({ ok: true, note: "Neustart nötig um den neuen Key zu aktivieren." }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // POST /api/providers/set-primary — set primary provider
  if (urlPath === "/api/providers/set-primary" && req.method === "POST") {
    try {
      const { key } = JSON.parse(body);
      writeEnvVar("PRIMARY_PROVIDER", key);
      // Also switch runtime
      const registry = getRegistry();
      registry.switchTo(key);
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // POST /api/providers/set-fallbacks — set fallback chain
  if (urlPath === "/api/providers/set-fallbacks" && req.method === "POST") {
    try {
      const { keys } = JSON.parse(body);
      writeEnvVar("FALLBACK_PROVIDERS", keys.join(","));
      res.end(JSON.stringify({ ok: true, note: "Neustart nötig." }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // GET /api/providers/live-models?id=<providerId> — fetch available models from provider API
  if (urlPath?.startsWith("/api/providers/live-models") && req.method === "GET") {
    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const providerId = url.searchParams.get("id") || "";
      const models = await fetchLiveModels(providerId);
      res.end(JSON.stringify({ ok: true, providerId, models }));
    } catch (err: unknown) {
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), models: [] }));
    }
    return true;
  }

  // POST /api/providers/add-custom — add a custom model
  if (urlPath === "/api/providers/add-custom" && req.method === "POST") {
    try {
      const model: CustomModelDef = JSON.parse(body);
      if (!model.key || !model.name || !model.baseUrl || !model.model) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "key, name, baseUrl und model sind Pflichtfelder" }));
        return true;
      }
      model.type = "openai-compatible";
      const models = loadCustomModels();
      // Upsert
      const idx = models.findIndex(m => m.key === model.key);
      if (idx >= 0) models[idx] = model;
      else models.push(model);
      saveCustomModels(models);

      // Save API key if provided
      if (model.apiKeyEnv && (model as any).apiKey) {
        writeEnvVar(model.apiKeyEnv, (model as any).apiKey);
      }

      res.end(JSON.stringify({ ok: true, note: "Neustart nötig um das Modell zu aktivieren." }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // DELETE /api/providers/remove-custom — remove a custom model
  if (urlPath === "/api/providers/remove-custom" && req.method === "POST") {
    try {
      const { key } = JSON.parse(body);
      const models = loadCustomModels().filter(m => m.key !== key);
      saveCustomModels(models);
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // POST /api/providers/test-key — quick API key validation
  if (urlPath === "/api/providers/test-key" && req.method === "POST") {
    try {
      const { providerId, apiKey } = JSON.parse(body);
      const result = await testApiKey(providerId, apiKey);
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.end(JSON.stringify({ ok: false, error }));
    }
    return true;
  }

  // ── Sudo / Elevated Access ─────────────────────────

  // GET /api/sudo/status — check sudo configuration
  if (urlPath === "/api/sudo/status") {
    const status = await getSudoStatus();
    res.end(JSON.stringify(status));
    return true;
  }

  // POST /api/sudo/setup — store sudo password
  if (urlPath === "/api/sudo/setup" && req.method === "POST") {
    try {
      const { password } = JSON.parse(body);
      if (!password) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Passwort erforderlich" }));
        return true;
      }
      const result = storePassword(password);
      if (result.ok) {
        // Verify it works
        const verify = await verifyPassword();
        if (verify.ok) {
          res.end(JSON.stringify({ ok: true, method: result.method, verified: true }));
        } else {
          revokePassword(); // Clean up if wrong password
          res.end(JSON.stringify({ ok: false, error: "Passwort gespeichert aber Verifikation fehlgeschlagen: " + verify.error }));
        }
      } else {
        res.end(JSON.stringify({ ok: false, error: result.error }));
      }
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // POST /api/sudo/revoke — delete stored password
  if (urlPath === "/api/sudo/revoke" && req.method === "POST") {
    const ok = revokePassword();
    res.end(JSON.stringify({ ok }));
    return true;
  }

  // POST /api/sudo/verify — test if stored password works
  if (urlPath === "/api/sudo/verify" && req.method === "POST") {
    const result = await verifyPassword();
    res.end(JSON.stringify(result));
    return true;
  }

  // POST /api/sudo/exec — execute a command with sudo
  if (urlPath === "/api/sudo/exec" && req.method === "POST") {
    try {
      const { command } = JSON.parse(body);
      if (!command) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Kein Command angegeben" }));
        return true;
      }
      const result = await sudoExec(command);
      res.end(JSON.stringify(result));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // POST /api/sudo/admin-dialog — show macOS admin dialog
  if (urlPath === "/api/sudo/admin-dialog" && req.method === "POST") {
    try {
      const { reason } = JSON.parse(body);
      const result = await requestAdminViaDialog(reason || "Mr. Levin benötigt Administrator-Rechte");
      res.end(JSON.stringify(result));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // POST /api/sudo/open-settings — open macOS system settings
  if (urlPath === "/api/sudo/open-settings" && req.method === "POST") {
    try {
      const { pane } = JSON.parse(body);
      const ok = openSystemSettings(pane || "security");
      res.end(JSON.stringify({ ok }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // ── Skills ────────────────────────────────────────────

  // GET /api/skills — list all loaded skills
  if (urlPath === "/api/skills") {
    const { getSkills } = await import("../services/skills.js");
    const skills = getSkills().map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      triggers: s.triggers,
      priority: s.priority,
      category: s.category,
    }));
    res.end(JSON.stringify({ skills }));
    return true;
  }

  // ── Cron Jobs ───────────────────────────────────────

  // GET /api/cron — list all jobs
  if (urlPath === "/api/cron") {
    const jobs = listJobs();
    const enriched = jobs.map(j => ({
      ...j,
      nextRunFormatted: formatNextRun(j.nextRunAt),
      lastRunFormatted: j.lastRunAt ? new Date(j.lastRunAt).toLocaleString("de-DE") : null,
      scheduleReadable: humanReadableSchedule(j.schedule),
    }));
    res.end(JSON.stringify({ jobs: enriched }));
    return true;
  }

  // POST /api/cron/create — create a new job
  if (urlPath === "/api/cron/create" && req.method === "POST") {
    try {
      const data = JSON.parse(body);
      const job = createJob({
        name: data.name,
        type: data.type as JobType,
        schedule: data.schedule,
        oneShot: data.oneShot || false,
        payload: data.payload || {},
        target: data.target || { platform: "web", chatId: "dashboard" },
        createdBy: "web-ui",
      });
      res.end(JSON.stringify({ ok: true, job }));
    } catch (err: unknown) {
      res.statusCode = 400;
      const error = err instanceof Error ? err.message : "Invalid request";
      res.end(JSON.stringify({ error }));
    }
    return true;
  }

  // POST /api/cron/delete — delete a job
  if (urlPath === "/api/cron/delete" && req.method === "POST") {
    try {
      const { id } = JSON.parse(body);
      const ok = deleteJob(id);
      res.end(JSON.stringify({ ok }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // POST /api/cron/update — update job fields (schedule, name, oneShot)
  if (urlPath === "/api/cron/update" && req.method === "POST") {
    try {
      const { id, ...updates } = JSON.parse(body);
      if (!id) { res.statusCode = 400; res.end(JSON.stringify({ error: "id required" })); return true; }
      // Only allow safe fields
      const allowed: Partial<CronJob> = {};
      if (updates.schedule !== undefined) (allowed as any).schedule = updates.schedule;
      if (updates.name !== undefined) (allowed as any).name = updates.name;
      if (updates.oneShot !== undefined) (allowed as any).oneShot = updates.oneShot;
      const job = updateJob(id, allowed);
      if (!job) { res.statusCode = 404; res.end(JSON.stringify({ error: "Job not found" })); return true; }
      res.end(JSON.stringify({ ok: true, job }));
    } catch (err: unknown) {
      res.statusCode = 400;
      const error = err instanceof Error ? err.message : "Invalid request";
      res.end(JSON.stringify({ error }));
    }
    return true;
  }

  // POST /api/cron/toggle — enable/disable a job
  if (urlPath === "/api/cron/toggle" && req.method === "POST") {
    try {
      const { id } = JSON.parse(body);
      const job = toggleJob(id);
      res.end(JSON.stringify({ ok: !!job, job }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // POST /api/cron/run — run a job immediately
  if (urlPath === "/api/cron/run" && req.method === "POST") {
    try {
      const { id } = JSON.parse(body);
      const result = await (runJobNow(id) || Promise.resolve({ output: "", error: "Job not found" }));
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.end(JSON.stringify({ error }));
    }
    return true;
  }

  // ── Platform Connection Status ─────────────────────────

  // GET /api/platforms/status — live connection status for all platforms
  if (urlPath === "/api/platforms/status") {
    const statuses: Record<string, any> = {};

    // Telegram
    try {
      const { getTelegramState } = await import("../platforms/telegram.js");
      statuses.telegram = getTelegramState();
    } catch {
      statuses.telegram = { status: !!process.env.BOT_TOKEN ? "unknown" : "not_configured" };
    }

    // Discord
    try {
      const { getDiscordState } = await import("../platforms/discord.js");
      statuses.discord = getDiscordState();
    } catch {
      statuses.discord = { status: !!process.env.DISCORD_TOKEN ? "unknown" : "not_configured" };
    }

    // WhatsApp
    try {
      const { getWhatsAppState } = await import("../platforms/whatsapp.js");
      statuses.whatsapp = getWhatsAppState();
    } catch {
      statuses.whatsapp = { status: process.env.WHATSAPP_ENABLED === "true" ? "unknown" : "not_configured" };
    }

    // Signal
    try {
      const { getSignalState } = await import("../platforms/signal.js");
      statuses.signal = getSignalState();
    } catch {
      statuses.signal = { status: !!process.env.SIGNAL_API_URL ? "unknown" : "not_configured" };
    }

    res.end(JSON.stringify(statuses));
    return true;
  }

  // GET /api/whatsapp/status — WhatsApp-specific (QR code needs its own endpoint)
  if (urlPath === "/api/whatsapp/status") {
    try {
      const { getWhatsAppState } = await import("../platforms/whatsapp.js");
      const state = getWhatsAppState();
      res.end(JSON.stringify(state));
    } catch {
      res.end(JSON.stringify({ status: "disconnected", qrString: null, error: "WhatsApp adapter not loaded" }));
    }
    return true;
  }

  // POST /api/whatsapp/disconnect — clear auth and disconnect
  if (urlPath === "/api/whatsapp/disconnect" && req.method === "POST") {
    try {
      const authDir = resolve(BOT_ROOT, "data", "whatsapp-auth");
      if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true });
      }
      res.end(JSON.stringify({ ok: true, note: "Auth-Daten gelöscht. Neustart nötig für neue Verbindung." }));
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.end(JSON.stringify({ ok: false, error }));
    }
    return true;
  }

  // POST /api/platforms/test-connection — test a specific platform
  if (urlPath === "/api/platforms/test-connection" && req.method === "POST") {
    try {
      const { platformId } = JSON.parse(body);

      if (platformId === "telegram") {
        const token = process.env.BOT_TOKEN;
        if (!token) { res.end(JSON.stringify({ ok: false, error: "BOT_TOKEN nicht gesetzt" })); return true; }
        const apiRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const data = await apiRes.json() as any;
        if (data.ok) {
          res.end(JSON.stringify({ ok: true, info: `@${data.result.username} (${data.result.first_name})` }));
        } else {
          res.end(JSON.stringify({ ok: false, error: data.description || "Token ungültig" }));
        }
        return true;
      }

      if (platformId === "discord") {
        const token = process.env.DISCORD_TOKEN;
        if (!token) { res.end(JSON.stringify({ ok: false, error: "DISCORD_TOKEN nicht gesetzt" })); return true; }
        const apiRes = await fetch("https://discord.com/api/v10/users/@me", {
          headers: { Authorization: `Bot ${token}` },
        });
        const data = await apiRes.json() as any;
        if (data.id) {
          res.end(JSON.stringify({ ok: true, info: `${data.username}#${data.discriminator || '0'} (ID: ${data.id})` }));
        } else {
          res.end(JSON.stringify({ ok: false, error: data.message || "Token ungültig" }));
        }
        return true;
      }

      if (platformId === "signal") {
        const apiUrl = process.env.SIGNAL_API_URL;
        if (!apiUrl) { res.end(JSON.stringify({ ok: false, error: "SIGNAL_API_URL nicht gesetzt" })); return true; }
        const apiRes = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/about`);
        if (apiRes.ok) {
          const data = await apiRes.json() as any;
          res.end(JSON.stringify({ ok: true, info: `signal-cli API v${data.version || '?'} erreichbar` }));
        } else {
          res.end(JSON.stringify({ ok: false, error: `API antwortet mit ${apiRes.status}` }));
        }
        return true;
      }

      if (platformId === "whatsapp") {
        try {
          const { getWhatsAppState } = await import("../platforms/whatsapp.js");
          const state = getWhatsAppState();
          res.end(JSON.stringify({ ok: state.status === "connected", info: `Status: ${state.status}` }));
        } catch {
          res.end(JSON.stringify({ ok: false, error: "WhatsApp adapter nicht geladen" }));
        }
        return true;
      }

      res.end(JSON.stringify({ ok: false, error: "Unbekannte Plattform" }));
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.end(JSON.stringify({ ok: false, error }));
    }
    return true;
  }

  return false; // Not handled
}

// ── Helpers ─────────────────────────────────────────────

function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "..." + value.slice(-4);
}

function checkNpmDeps(packages: string[]): boolean {
  const nodeModules = resolve(BOT_ROOT, "node_modules");
  return packages.every(pkg => {
    try {
      return fs.existsSync(resolve(nodeModules, pkg.split("/")[0]));
    } catch {
      return false;
    }
  });
}

async function testApiKey(providerId: string, apiKey: string): Promise<{ ok: boolean; error?: string; model?: string }> {
  try {
    const provider = PROVIDERS.find(p => p.id === providerId);
    if (!provider) return { ok: false, error: "Unknown provider" };

    // Use stored key if requested (input was empty but key already configured)
    // Skip for providers that don't use API keys (e.g. claude-sdk uses CLI auth)
    if (apiKey === "__USE_STORED__") {
      if (providerId === "claude-sdk" || providerId === "ollama") {
        apiKey = ""; // These don't need keys — test will check CLI/service availability
      } else {
        const envKey = provider.envKey;
        const storedKey = envKey ? process.env[envKey] : undefined;
        if (!storedKey) return { ok: false, error: "Kein gespeicherter Key vorhanden" };
        apiKey = storedKey;
      }
    }

    switch (providerId) {
      case "openai": {
        const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${await r.text()}` };
        return { ok: true, model: "gpt-4o" };
      }
      case "google": {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${await r.text()}` };
        return { ok: true, model: "gemini-2.5-pro" };
      }
      case "nvidia": {
        const r = await fetch("https://integrate.api.nvidia.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${await r.text()}` };
        return { ok: true, model: "meta/llama-3.3-70b-instruct" };
      }
      case "openrouter": {
        const r = await fetch("https://openrouter.ai/api/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${await r.text()}` };
        return { ok: true, model: "anthropic/claude-sonnet-4" };
      }
      case "groq": {
        const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${await r.text()}` };
        return { ok: true, model: "llama-3.3-70b-versatile" };
      }
      case "claude-sdk": {
        // Claude SDK uses CLI auth, not an API key — check if CLI is available
        const { execSync } = await import("child_process");
        try {
          execSync("claude --version", { timeout: 5000, stdio: "pipe" });
          return { ok: true, model: "claude-opus-4-6" };
        } catch {
          return { ok: false, error: "Claude CLI nicht installiert oder nicht eingeloggt" };
        }
      }
      case "anthropic": {
        // Anthropic API via OpenAI-compatible endpoint
        const r = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        });
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${(await r.text()).substring(0, 200)}` };
        return { ok: true, model: "claude-sonnet-4" };
      }
      default:
        return { ok: false, error: "Key-Test für diesen Provider nicht verfügbar" };
    }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Live Model Fetching ─────────────────────────────────

interface LiveModel {
  id: string;
  name: string;
  owned_by?: string;
}

async function fetchLiveModels(providerId: string): Promise<LiveModel[]> {
  const env = process.env;

  switch (providerId) {
    case "anthropic": {
      const key = env.ANTHROPIC_API_KEY;
      if (!key) return [];
      const r = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!r.ok) return [];
      const data = await r.json() as any;
      return (data.data || [])
        .filter((m: any) => m.id && !m.id.includes("pdfs"))
        .map((m: any) => ({ id: m.id, name: m.display_name || m.id, owned_by: "anthropic" }))
        .sort((a: LiveModel, b: LiveModel) => a.id.localeCompare(b.id));
    }
    case "openai": {
      const key = env.OPENAI_API_KEY;
      if (!key) return [];
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) return [];
      const data = await r.json() as any;
      // Filter to chat-relevant models only
      const chatPrefixes = ["gpt-4", "gpt-3.5", "o1", "o3", "o4", "chatgpt"];
      return (data.data || [])
        .filter((m: any) => chatPrefixes.some(p => m.id.startsWith(p)))
        .map((m: any) => ({ id: m.id, name: m.id, owned_by: m.owned_by || "openai" }))
        .sort((a: LiveModel, b: LiveModel) => a.id.localeCompare(b.id));
    }
    case "google": {
      const key = env.GOOGLE_API_KEY;
      if (!key) return [];
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      if (!r.ok) return [];
      const data = await r.json() as any;
      return (data.models || [])
        .filter((m: any) => m.name && m.supportedGenerationMethods?.includes("generateContent"))
        .map((m: any) => ({
          id: m.name.replace("models/", ""),
          name: m.displayName || m.name.replace("models/", ""),
          owned_by: "google",
        }))
        .sort((a: LiveModel, b: LiveModel) => a.id.localeCompare(b.id));
    }
    case "groq": {
      const key = env.GROQ_API_KEY;
      if (!key) return [];
      const r = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) return [];
      const data = await r.json() as any;
      return (data.data || [])
        .filter((m: any) => m.id && m.active !== false)
        .map((m: any) => ({ id: m.id, name: m.id, owned_by: m.owned_by || "groq" }))
        .sort((a: LiveModel, b: LiveModel) => a.id.localeCompare(b.id));
    }
    case "nvidia": {
      const key = env.NVIDIA_API_KEY;
      if (!key) return [];
      const r = await fetch("https://integrate.api.nvidia.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) return [];
      const data = await r.json() as any;
      return (data.data || [])
        .map((m: any) => ({ id: m.id, name: m.id, owned_by: m.owned_by || "nvidia" }))
        .sort((a: LiveModel, b: LiveModel) => a.id.localeCompare(b.id));
    }
    case "openrouter": {
      const key = env.OPENROUTER_API_KEY;
      if (!key) return [];
      const r = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) return [];
      const data = await r.json() as any;
      return (data.data || [])
        .slice(0, 100) // OpenRouter has 200+ models, limit display
        .map((m: any) => ({ id: m.id, name: m.name || m.id, owned_by: "openrouter" }))
        .sort((a: LiveModel, b: LiveModel) => a.id.localeCompare(b.id));
    }
    default:
      return [];
  }
}
