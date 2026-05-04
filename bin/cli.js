#!/usr/bin/env node

/**
 * Alvin Bot CLI — Setup, manage, and chat with your AI agent.
 *
 * Usage:
 *   alvin-bot setup    — Interactive setup wizard
 *   alvin-bot tui      — Terminal chat UI
 *   alvin-bot doctor   — Check configuration
 *   alvin-bot audit    — Security health check
 *   alvin-bot update   — Pull latest & rebuild
 *   alvin-bot start    — Start the bot
 *   alvin-bot stop     — Stop the bot
 *
 * Flags:
 *   --lang en|de       — Language (default: en, auto-detects from LANG env)
 */

import { createInterface } from "readline";
import { existsSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { initI18n, t, getLocale } from "../dist/i18n.js";

// Data directory — same logic as src/paths.ts
const DATA_DIR = process.env.ALVIN_DATA_DIR || join(homedir(), ".alvin-bot");

// Init i18n early
initI18n();

// Lazy-create the readline interface. If we create it eagerly, stdin becomes
// "active" and Node refuses to exit even when a command like `doctor` has
// finished synchronously. Before v4.4.6 this caused `alvin-bot doctor` to
// hang indefinitely when .env was missing — early-return worked, but the
// process couldn't terminate. Creating rl only when `ask()` is actually
// called keeps non-interactive commands (audit/doctor/version/start/stop)
// terminating cleanly.
let rl = null;
const ensureRL = () => {
  if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl;
};
const closeRL = () => { if (rl) { rl.close(); rl = null; } };
const ask = (q) => new Promise((r) => ensureRL().question(q, r));

const LOGO = `
  ╔══════════════════════════════════════╗
  ║  🤖 Alvin Bot — Setup Wizard v3.0  ║
  ║  Your Personal AI Agent             ║
  ╚══════════════════════════════════════╝
`;

// ── Provider Definitions ────────────────────────────────────────────────────

const PROVIDERS = [
  {
    key: "offline-gemma4",
    name: "🔒 Offline — Gemma 4 E4B (no API key, ~10 GB one-time download)",
    desc: () => "Works without internet. Runs Google Gemma 4 E4B locally via Ollama. Big first-time download, zero running cost, works forever offline.",
    free: true,
    envKey: null,
    signup: null,
    model: "gemma4:e4b",
    needsCLI: false,
    offline: true,
  },
  {
    key: "groq",
    name: "Groq (Llama 3.3 70B)",
    desc: () => t("provider.groq.desc"),
    free: true,
    envKey: "GROQ_API_KEY",
    signup: "https://console.groq.com",
    model: "llama-3.3-70b-versatile",
    needsCLI: false,
  },
  {
    key: "nvidia-kimi-k2.5",
    name: "NVIDIA NIM (Kimi K2.5 — Best Tool Use)",
    desc: () => t("provider.nvidia.desc"),
    free: true,
    envKey: "NVIDIA_API_KEY",
    signup: "https://build.nvidia.com",
    model: "moonshotai/kimi-k2.5",
    needsCLI: false,
    fallbackModel: "meta/llama-3.3-70b-instruct",
  },
  {
    key: "gemini-2.5-flash",
    name: "Google Gemini (2.5 Flash)",
    desc: () => t("provider.gemini.desc"),
    free: true,
    envKey: "GOOGLE_API_KEY",
    signup: "https://aistudio.google.com",
    model: "gemini-2.5-flash",
    needsCLI: false,
  },
  {
    key: "openai",
    name: "OpenAI (GPT-4o)",
    desc: () => t("provider.openai.desc"),
    free: false,
    envKey: "OPENAI_API_KEY",
    signup: "https://platform.openai.com",
    model: "gpt-4o",
    needsCLI: false,
  },
  {
    key: "openrouter",
    name: "OpenRouter (100+ Models)",
    desc: () => t("provider.openrouter.desc"),
    free: false,
    envKey: "OPENROUTER_API_KEY",
    signup: "https://openrouter.ai",
    model: "anthropic/claude-sonnet-4",
    needsCLI: false,
  },
  {
    key: "claude-sdk",
    name: "Claude Agent SDK (Premium)",
    desc: () => t("provider.claude.desc"),
    free: false,
    envKey: null,
    signup: "https://claude.ai",
    model: "claude-sonnet-4-20250514",
    needsCLI: true,
  },
];

// ── Offline mode: Ollama + Gemma 4 E4B ─────────────────────────────────────

/**
 * Check whether the `ollama` binary is present on PATH.
 */
function hasOllama() {
  try {
    execSync("ollama --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether Homebrew is available on PATH (macOS only path normally).
 */
function hasBrew() {
  try {
    execSync("brew --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install Ollama. On macOS prefers `brew install ollama` because the
 * official install.sh wants to drop Ollama.app into /Applications and
 * start it as a GUI app — that needs a real user session with sudo and
 * breaks over SSH or in any non-interactive context.
 *
 * Linux always uses the official install.sh (systemd user services work
 * non-interactively).
 *
 * Returns true on success, false on failure.
 */
function installOllama() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    console.log("  ❌ Offline mode only supported on macOS and Linux.");
    console.log("     Windows users: download from https://ollama.com/download");
    return false;
  }

  // macOS preferred path: Homebrew (non-interactive, no sudo, no GUI dependency)
  if (process.platform === "darwin" && hasBrew()) {
    console.log("\n📥 Installing Ollama via Homebrew (non-interactive)...");
    try {
      execSync("brew install ollama", {
        stdio: "inherit",
        timeout: 300_000,
      });
      if (hasOllama()) {
        console.log("  ✅ Ollama installed via Homebrew");
        return true;
      }
      console.log("  ⚠️  Homebrew finished but `ollama` not on PATH yet.");
    } catch (err) {
      console.log(`\n  ⚠️  brew install ollama failed: ${err.message || err}`);
      console.log("     Falling back to the official install.sh — this may need sudo and a GUI session.\n");
    }
  }

  // Fallback: official installer
  console.log("\n📥 Installing Ollama (official installer)...");
  if (process.platform === "darwin") {
    console.log("  ⚠️  Heads-up: on macOS the installer drops Ollama.app into");
    console.log("     /Applications and wants to start it — this may prompt for");
    console.log("     your admin password and only works in a local terminal,");
    console.log("     not over SSH.\n");
  }
  try {
    execSync("curl -fsSL https://ollama.com/install.sh | sh", {
      stdio: "inherit",
      timeout: 300_000,
    });
    return hasOllama();
  } catch (err) {
    console.log(`\n  ❌ Ollama install failed: ${err.message || err}`);
    if (process.platform === "darwin") {
      console.log("     On macOS, try one of:");
      console.log("       • brew install ollama    (recommended)");
      console.log("       • download the .dmg from https://ollama.com/download");
    } else {
      console.log("     Try manually: curl -fsSL https://ollama.com/install.sh | sh");
    }
    return false;
  }
}

/**
 * Ensure the Ollama daemon is running. Spawns it in the background if not,
 * then polls for readiness — first-run initialization can take 5-15 seconds
 * on macOS (SSH key generation + GPU discovery + runner startup).
 */
function ensureOllamaServe() {
  // Fast path: already running
  try {
    execSync("ollama list", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch { /* not running — try to start */ }

  // Spawn in background (detached via `&` inside a shell)
  try {
    execSync("nohup ollama serve > /tmp/ollama-setup.log 2>&1 &", {
      stdio: "pipe",
      shell: "/bin/sh",
    });
  } catch (err) {
    console.log(`\n  ⚠️  Could not spawn 'ollama serve': ${err.message || err}`);
    return false;
  }

  // Poll for readiness — up to 30 seconds total. First-run init is slow
  // because ollama generates an SSH key pair, discovers GPUs, and starts
  // the runner subprocess.
  const deadlineMs = Date.now() + 30_000;
  let lastError = "";
  let attempt = 0;
  while (Date.now() < deadlineMs) {
    attempt++;
    try {
      execSync("ollama list", { stdio: "pipe", timeout: 5000 });
      if (attempt > 1) console.log(`  ✅ Ollama daemon ready after ${attempt} attempts`);
      return true;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    // Sleep 1 second between polls via execSync (cross-platform, no promise in sync ctx)
    try { execSync("sleep 1", { stdio: "pipe" }); } catch { /* shouldn't fail */ }
  }
  console.log(`  ⚠️  Daemon did not become ready within 30s. Last error: ${lastError}`);
  console.log(`     Tail of /tmp/ollama-setup.log:`);
  try {
    const tail = execSync("tail -15 /tmp/ollama-setup.log", { encoding: "utf-8" });
    tail.split("\n").forEach((line) => console.log(`       ${line}`));
  } catch { /* log missing */ }
  return false;
}

/**
 * Check whether gemma4:e4b is already pulled into Ollama's model cache.
 */
function hasGemma4E4b() {
  try {
    const out = execSync("ollama list", { encoding: "utf-8", timeout: 5000 });
    return /gemma4[:\s].*e4b/i.test(out);
  } catch {
    return false;
  }
}

/**
 * Pull gemma4:e4b from the Ollama registry. Streams progress to stdout.
 * Returns true on success, false on failure.
 */
function pullGemma4E4b() {
  console.log("\n📥 Downloading gemma4:e4b (~10 GB — this can take 10-30 min)...\n");
  try {
    execSync("ollama pull gemma4:e4b", {
      stdio: "inherit",
      timeout: 45 * 60_000, // 45 minutes
    });
    return hasGemma4E4b();
  } catch (err) {
    console.log(`\n  ❌ Pull failed: ${err.message || err}`);
    return false;
  }
}

/**
 * Full offline-mode setup flow: warn about download size, confirm, install
 * Ollama if missing, pull the model, verify. Returns true on success,
 * false if the user bailed or something broke (caller falls back to
 * interactive provider selection).
 */
async function setupOfflineGemma4() {
  console.log("\n  ⚠️  Offline mode uses Google Gemma 4 E4B via Ollama.");
  console.log("     • One-time download: ~10 GB");
  console.log("     • On a 100 Mbps connection: ~15 minutes");
  console.log("     • On a 20 Mbps connection: ~70 minutes");
  console.log("     • Disk usage: ~10 GB in ~/.ollama/models");
  console.log("     • Runs on CPU + GPU via Metal (macOS) / CUDA (Linux)");
  console.log("     • Works 100% offline once downloaded\n");

  const yesChars = getLocale() === "de" ? ["j", "ja", "y", "yes"] : ["y", "yes"];
  const proceed = (await ask("  Continue with offline mode? (y/N): ")).trim().toLowerCase();
  if (!yesChars.includes(proceed)) {
    console.log("\n  ℹ️  Offline mode declined — returning to provider selection.\n");
    return false;
  }

  // Step 1: Ollama binary
  if (!hasOllama()) {
    console.log("\n  ℹ️  Ollama not installed.");
    const installProceed = (await ask("  Install Ollama now? (y/N): ")).trim().toLowerCase();
    if (!yesChars.includes(installProceed)) {
      console.log("\n  ℹ️  Offline mode cancelled — Ollama is required.\n");
      return false;
    }
    if (!installOllama()) return false;
    console.log("  ✅ Ollama installed");
  } else {
    console.log("\n  ✅ Ollama already installed");
  }

  // Step 2: Ensure daemon is running
  if (!ensureOllamaServe()) {
    console.log("\n  ⚠️  Could not start Ollama daemon. Try manually:");
    console.log("     ollama serve");
    console.log("     (in a separate terminal, then re-run alvin-bot setup)\n");
    return false;
  }
  console.log("  ✅ Ollama daemon responding");

  // Step 3: Model already present?
  if (hasGemma4E4b()) {
    console.log("  ✅ gemma4:e4b already downloaded — skipping pull");
    return true;
  }

  // Step 4: Pull the model (big download)
  console.log("\n  📦 gemma4:e4b not in cache yet.");
  const pullProceed = (await ask("  Start 10 GB download now? (y/N): ")).trim().toLowerCase();
  if (!yesChars.includes(pullProceed)) {
    console.log("\n  ℹ️  Pull cancelled. You can run this later:");
    console.log("     ollama pull gemma4:e4b\n");
    return false;
  }

  if (!pullGemma4E4b()) return false;
  console.log("\n  ✅ gemma4:e4b downloaded and ready\n");
  return true;
}

// ── Provider Validation ────────────────────────────────────────────────────

/**
 * Validate a provider's API key or auth by making a lightweight API call.
 * Returns { ok: true, detail: "..." } or { ok: false, error: "..." }.
 */
async function validateProviderKey(providerKey, apiKey) {
  const timeout = 10_000;

  try {
    switch (providerKey) {
      case "groq": {
        const res = await fetch("https://api.groq.com/openai/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status} — ${res.statusText}` };
        return { ok: true, detail: "Groq API key valid" };
      }

      case "nvidia-llama-3.3-70b":
      case "nvidia-kimi-k2.5": {
        const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status} — ${res.statusText}` };
        return { ok: true, detail: "NVIDIA API key valid" };
      }

      case "gemini-2.5-flash": {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) return { ok: false, error: `HTTP ${res.status} — ${res.statusText}` };
        return { ok: true, detail: "Google API key valid" };
      }

      case "openai":
      case "gpt-4o": {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status} — ${res.statusText}` };
        return { ok: true, detail: "OpenAI API key valid" };
      }

      case "openrouter": {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status} — ${res.statusText}` };
        return { ok: true, detail: "OpenRouter API key valid" };
      }

      case "claude-sdk": {
        // The Claude Agent SDK can authenticate through multiple paths that
        // `claude auth status` does not see:
        //   1. ANTHROPIC_API_KEY env var (bypasses CLI entirely)
        //   2. An active Claude Code session (IDE-initiated, not via `auth login`)
        //   3. Native binary session cookies
        // Prior to v4.4.6 this check hard-failed on `loggedIn: false` even when
        // the engine ran fine — confusing users whose bot was actually working.
        if (process.env.ANTHROPIC_API_KEY) {
          return { ok: true, detail: "Claude SDK via ANTHROPIC_API_KEY env var" };
        }

        // Find claude binary — check PATH and common locations
        let claudeBin = null;
        try {
          execSync("claude --version", { stdio: "pipe", timeout: 5000 });
          claudeBin = "claude";
        } catch {
          // Not in PATH — try common native install locations
          const candidates = [
            join(homedir(), ".local", "bin", "claude"),
            "/usr/local/bin/claude",
          ];
          for (const p of candidates) {
            if (existsSync(p)) { claudeBin = p; break; }
          }
        }
        if (!claudeBin) {
          return { ok: false, error: "Claude CLI not installed. Run: curl -fsSL https://claude.ai/install.sh | sh" };
        }

        // Check `claude auth status`. On mismatch, we DON'T hard-fail:
        // we return a warning so the Agent SDK still gets a chance to run
        // (it has independent auth paths the CLI doesn't know about).
        try {
          const authJson = execSync(`${claudeBin} auth status`, {
            stdio: "pipe", timeout: 10000, encoding: "utf-8",
          });
          const authData = JSON.parse(authJson);
          if (authData.loggedIn) {
            return { ok: true, detail: `Claude SDK authenticated (${authData.authMethod || "OK"})` };
          }
          return {
            ok: true,
            warning: "Claude CLI reports not logged in, but the Agent SDK may still work via session/env-var. If the bot fails to respond, run: claude auth login",
            detail: "Claude CLI present (not logged in via `auth status` — Agent SDK may still work)",
          };
        } catch (err) {
          const msg = err.stdout?.toString() || err.stderr?.toString() || err.message || "";
          // Try parsing JSON from stdout (auth status exits with code 1 when not logged in)
          try {
            const authData = JSON.parse(msg);
            if (authData.loggedIn) {
              return { ok: true, detail: `Claude SDK authenticated (${authData.authMethod || "OK"})` };
            }
          } catch {}
          return {
            ok: true,
            warning: "Claude CLI `auth status` failed. Agent SDK may still work via session/env-var. If the bot fails to respond, run: claude auth login",
            detail: "Claude CLI present (auth status check failed — Agent SDK may still work)",
          };
        }
      }

      default:
        return { ok: true, detail: "No validation available for this provider" };
    }
  } catch (err) {
    if (err.name === "TimeoutError" || err.code === "ABORT_ERR") {
      return { ok: false, error: "Connection timed out — check your internet" };
    }
    return { ok: false, error: err.message || "Unknown error" };
  }
}

/**
 * Validate a Telegram bot token by calling getMe.
 * Returns { ok: true, botName: "@username" } or { ok: false, error: "reason" }.
 */
async function validateTelegramToken(token) {
  if (!token) return { ok: false, error: "No token provided" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (data.ok) {
      return { ok: true, botName: `@${data.result.username}` };
    }
    return { ok: false, error: data.description || "Invalid token" };
  } catch (err) {
    return { ok: false, error: err.message || "Connection failed" };
  }
}

/**
 * Run post-setup validation: provider, Telegram, port.
 */
async function runPostSetupValidation(providerKey, apiKey, botToken, webPort) {
  console.log(`\n━━━ Validating Setup ━━━\n`);
  let allGood = true;

  // 1. Provider
  if (providerKey === "claude-sdk" || apiKey) {
    console.log(`  Testing provider...`);
    const pResult = await validateProviderKey(providerKey, apiKey);
    if (pResult.ok) {
      console.log(`  ✅ Provider — ${pResult.detail}`);
    } else {
      console.log(`  ❌ Provider — ${pResult.error}`);
      allGood = false;
    }
  } else {
    console.log(`  ⚠️  Provider: No API key configured`);
    allGood = false;
  }

  // 2. Telegram
  if (botToken) {
    console.log(`  Testing Telegram...`);
    const tResult = await validateTelegramToken(botToken);
    if (tResult.ok) {
      console.log(`  ✅ Telegram: ${tResult.botName}`);
    } else {
      console.log(`  ❌ Telegram: ${tResult.error}`);
      allGood = false;
    }
  } else {
    console.log(`  ℹ️  Telegram: Skipped (no token)`);
  }

  // 3. Web UI port
  const port = webPort || 3100;
  try {
    const net = await import("net");
    await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", () => { srv.close(); reject(); });
      srv.once("listening", () => { srv.close(); resolve(); });
      srv.listen(port);
    });
    console.log(`  ✅ Web UI: Port ${port} available`);
  } catch {
    console.log(`  ⚠️  Web UI: Port ${port} in use (another instance running?)`);
  }

  console.log("");

  if (!allGood) {
    console.log(`  Some checks failed. Run 'alvin-bot doctor' after fixing to verify.\n`);
  } else {
    console.log(`  All checks passed! ✅\n`);
  }

  return allGood;
}

// ── Setup: Argument Parsing ─────────────────────────────────────────────────

/**
 * Parse `alvin-bot setup --non-interactive` style CLI args.
 * Returns a flat object with the values found (or null for unset fields).
 *
 * Supports both `--flag=value` and `--flag value` syntax.
 */
function parseSetupArgs(argv) {
  const args = {};
  const flags = new Set(["--non-interactive", "-y", "--yes", "--skip-validation"]);
  const valueFlags = [
    "--bot-token", "--allowed-users", "--primary-provider",
    "--groq-key", "--google-key", "--openai-key", "--nvidia-key",
    "--openrouter-key", "--anthropic-key",
    "--fallback-providers", "--web-password", "--platform",
  ];
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) {
      args[a.replace(/^-+/, "")] = true;
      continue;
    }
    for (const vf of valueFlags) {
      if (a === vf) {
        args[vf.replace(/^-+/, "")] = argv[++i];
        break;
      }
      if (a.startsWith(vf + "=")) {
        args[vf.replace(/^-+/, "")] = a.slice(vf.length + 1);
        break;
      }
    }
  }
  return args;
}

/**
 * Non-interactive setup path for CI/Docker/automation.
 *
 * Writes ~/.alvin-bot/.env directly from CLI args, with no prompts.
 * The bot's own `ensureDataDirs()` + `seedDefaults()` handle the rest
 * on the next `alvin-bot start`.
 *
 * Usage:
 *   alvin-bot setup --non-interactive \
 *     --bot-token=123:AAE... \
 *     --allowed-users=12345,67890 \
 *     --primary-provider=claude-sdk \
 *     --groq-key=gsk_... \
 *     --fallback-providers=groq,ollama
 */
async function setupNonInteractive(args) {
  console.log("🤖 Alvin Bot — Non-interactive setup\n");

  // Ensure DATA_DIR exists (will also be recreated on bot start, but we
  // need it now to write the .env).
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    console.log(`✓ Created ${DATA_DIR}`);
  }

  const envFile = resolve(DATA_DIR, ".env");
  if (existsSync(envFile)) {
    console.log(`⚠️  ${envFile} already exists — refusing to overwrite.`);
    console.log(`   Delete it manually first, or edit it directly.`);
    process.exit(1);
  }

  // Validate required fields
  const token = args["bot-token"];
  if (token && !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    console.log(`❌ --bot-token format invalid. Expected: 123456789:ABCdef...`);
    process.exit(1);
  }
  const users = args["allowed-users"];
  if (users) {
    const ids = users.split(",").map(s => s.trim());
    const bad = ids.filter(id => !/^\d+$/.test(id));
    if (bad.length > 0) {
      console.log(`❌ --allowed-users must be comma-separated numeric IDs. Got invalid: ${bad.join(", ")}`);
      process.exit(1);
    }
  }

  // Optional: validate token with Telegram API unless --skip-validation
  if (token && !args["skip-validation"]) {
    const tgResult = await validateTelegramToken(token);
    if (tgResult.ok) {
      console.log(`✓ Telegram: ${tgResult.botName}`);
    } else {
      console.log(`⚠️  Telegram token validation failed: ${tgResult.error}`);
      console.log(`   Writing .env anyway. Pass --skip-validation to suppress this warning.`);
    }
  }

  const primary = args["primary-provider"] || "groq";
  const fallbacks = args["fallback-providers"] || "";
  const platform = args["platform"] || "telegram";

  const envLines = [
    "# === Telegram ===",
    `BOT_TOKEN=${token || ""}`,
    `ALLOWED_USERS=${users || ""}`,
    "",
    "# === AI Provider ===",
    `PRIMARY_PROVIDER=${primary}`,
    `FALLBACK_PROVIDERS=${fallbacks}`,
    "",
    "# === API Keys ===",
  ];
  if (args["groq-key"])       envLines.push(`GROQ_API_KEY=${args["groq-key"]}`);
  if (args["google-key"])     envLines.push(`GOOGLE_API_KEY=${args["google-key"]}`);
  if (args["openai-key"])     envLines.push(`OPENAI_API_KEY=${args["openai-key"]}`);
  if (args["nvidia-key"])     envLines.push(`NVIDIA_API_KEY=${args["nvidia-key"]}`);
  if (args["openrouter-key"]) envLines.push(`OPENROUTER_API_KEY=${args["openrouter-key"]}`);
  if (args["anthropic-key"])  envLines.push(`ANTHROPIC_API_KEY=${args["anthropic-key"]}`);
  envLines.push("");
  envLines.push("# === Agent ===");
  envLines.push("WORKING_DIR=" + homedir());
  envLines.push("MAX_BUDGET_USD=5.0");
  envLines.push("WEB_PORT=3100");
  if (args["web-password"]) envLines.push(`WEB_PASSWORD=${args["web-password"]}`);
  envLines.push("");
  envLines.push("# === Platforms ===");
  envLines.push(`WHATSAPP_ENABLED=${platform === "whatsapp" ? "true" : "false"}`);

  writeFileSync(envFile, envLines.join("\n") + "\n", { mode: 0o600 });
  console.log(`✓ Wrote ${envFile} (mode 0600)`);
  console.log(`\n✅ Setup complete. Start the bot with: alvin-bot start\n`);
}

// ── Setup Wizard ────────────────────────────────────────────────────────────

async function setup() {
  // Non-interactive path for CI/automation/scripted installs.
  const args = parseSetupArgs(process.argv);
  if (args["non-interactive"] || args["yes"] || args["y"]) {
    await setupNonInteractive(args);
    return;
  }

  console.log(LOGO);

  // ── Prerequisites
  console.log(t("setup.checkingPrereqs"));

  let hasNode = false;
  try {
    const nodeVersion = execSync("node --version", { encoding: "utf-8" }).trim();
    const major = parseInt(nodeVersion.slice(1));
    hasNode = major >= 18;
    console.log(`  ${hasNode ? "✅" : "❌"} Node.js ${nodeVersion}${major < 18 ? ` (${t("setup.needVersion")})` : ""}`);
  } catch {
    console.log(`  ❌ ${t("setup.nodeNotFound")}`);
  }

  if (!hasNode) {
    console.log(`\n❌ ${t("setup.nodeRequired")}`);
    closeRL();
    return;
  }

  // ── Step 1: Telegram Bot
  console.log(`\n━━━ ${t("setup.step1")} ━━━`);
  console.log(t("setup.step1.intro"));
  console.log(`  (Press Enter to skip — WebUI-only mode)\n`);
  let botToken = (await ask(t("setup.botToken"))).trim();

  if (!botToken) {
    console.log(`  ℹ️  Skipping Telegram — bot will run in WebUI-only mode.`);
    console.log(`  You can add BOT_TOKEN to ~/.alvin-bot/.env later.\n`);
  } else if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
    console.log(`\n  ⚠️  That doesn't look like a valid bot token.`);
    console.log(`  Expected format: 123456789:ABCdefGHI-jklMNO`);
    console.log(`  Get one from @BotFather on Telegram.\n`);
    const proceed = (await ask(`  Continue anyway? (y/n): `)).trim().toLowerCase();
    if (proceed !== "y" && proceed !== "yes" && proceed !== "j" && proceed !== "ja") {
      closeRL();
      return;
    }
  }

  // Validate token with Telegram API
  if (botToken && /^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
    console.log(`  Validating...`);
    const tgResult = await validateTelegramToken(botToken);
    if (tgResult.ok) {
      console.log(`  ✅ Bot: ${tgResult.botName}\n`);
    } else {
      console.log(`  ❌ ${tgResult.error}`);
      console.log(`  Check your token at @BotFather on Telegram.\n`);
      const retryToken = (await ask(`  Re-enter token (or Enter to skip): `)).trim();
      if (retryToken) {
        botToken = retryToken;
        const retry = await validateTelegramToken(botToken);
        if (retry.ok) console.log(`  ✅ Bot: ${retry.botName}\n`);
        else console.log(`  ⚠️  Still invalid — continuing anyway.\n`);
      }
    }
  }

  // ── Step 2: User ID
  let userId = "";
  if (botToken) {
    console.log(`\n━━━ ${t("setup.step2")} ━━━`);
    console.log(t("setup.step2.intro"));
    console.log(`  💡 Send /start to @userinfobot on Telegram to find your ID.`);
    console.log(`  (Press Enter to skip — you can add it later)\n`);
    userId = (await ask(t("setup.userId"))).trim();

    if (!userId) {
      console.log(`  ℹ️  Skipping — add ALLOWED_USERS to ~/.alvin-bot/.env later.\n`);
    } else {
      // Validate user ID is numeric
      const userIds = userId.split(",").map(s => s.trim());
      const invalidIds = userIds.filter(id => !/^\d+$/.test(id));
      if (invalidIds.length > 0) {
        console.log(`\n  ⚠️  User IDs must be numbers, got: ${invalidIds.join(", ")}`);
        console.log(`  Send /start to @userinfobot on Telegram to get your numeric ID.\n`);
        const proceed = (await ask(`  Continue anyway? (y/n): `)).trim().toLowerCase();
        if (proceed !== "y" && proceed !== "yes" && proceed !== "j" && proceed !== "ja") {
          closeRL();
          return;
        }
      }

      // Warn if user ID matches bot token prefix (common mistake)
      const botIdPrefix = botToken.split(":")[0];
      const userIdList = userId.split(",").map(s => s.trim());
      if (userIdList.includes(botIdPrefix)) {
        console.log(`\n  ⚠️  "${botIdPrefix}" looks like the bot's own ID, not yours!`);
        console.log(`  The bot token starts with the bot's ID. You need YOUR user ID.`);
        console.log(`  Send /start to @userinfobot on Telegram to get your ID.\n`);
        const proceed = (await ask(`  Continue anyway? (y/n): `)).trim().toLowerCase();
        if (proceed !== "y" && proceed !== "yes" && proceed !== "j" && proceed !== "ja") {
          userId = "";
          console.log(`  ℹ️  Cleared — add ALLOWED_USERS to ~/.alvin-bot/.env later.\n`);
        }
      }
    }
  }

  // ── Step 3: AI Provider
  console.log(`\n━━━ ${t("setup.step3")} ━━━`);
  console.log(t("setup.step3.intro") + "\n");

  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[i];
    const badge = p.free ? "🆓" : "💰";
    const premium = p.needsCLI ? " ⭐" : "";
    console.log(`  ${i + 1}. ${badge} ${p.name}${premium}`);
    console.log(`     ${p.desc()}`);
    if (p.signup) console.log(`     → ${p.signup}`);
    console.log("");
  }

  const providerChoice = parseInt((await ask(t("setup.yourChoice"))).trim()) || 1;
  let provider = PROVIDERS[Math.max(0, Math.min(providerChoice - 1, PROVIDERS.length - 1))];

  console.log(`\n✅ ${t("setup.providerSelected")} ${provider.name}`);

  // ── Offline mode: Gemma 4 E4B via Ollama ────────────────────────
  // Handled specially because it needs a 10 GB model download, not an
  // API key. If the user bails out anywhere in the flow, we loop back
  // to the normal provider picker so setup isn't a dead-end.
  if (provider.offline) {
    const ok = await setupOfflineGemma4();
    if (!ok) {
      // User declined or something failed — pick a different provider
      console.log(`\n  Choose a different provider:\n`);
      for (let i = 0; i < PROVIDERS.length; i++) {
        if (PROVIDERS[i].offline) continue;
        const p = PROVIDERS[i];
        const badge = p.free ? "🆓" : "💰";
        const premium = p.needsCLI ? " ⭐" : "";
        console.log(`  ${i + 1}. ${badge} ${p.name}${premium}`);
      }
      console.log("");
      const fallbackChoice = parseInt((await ask(t("setup.yourChoice"))).trim()) || 2;
      provider = PROVIDERS[Math.max(1, Math.min(fallbackChoice - 1, PROVIDERS.length - 1))];
      console.log(`\n✅ ${t("setup.providerSelected")} ${provider.name}`);
    }
    // Note: if setupOfflineGemma4 succeeded, we skip further API-key
    // validation below — offline mode doesn't need a key. The .env
    // write step reads provider.offline and sets PRIMARY_PROVIDER=ollama.
  }

  // ── Validate Provider ────────────────────────────────────────────

  // Claude SDK: show requirements upfront
  if (provider.needsCLI) {
    console.log(`\n  ⚠️  Claude SDK requires one of:`);
    console.log(`     • Claude Max/Team subscription ($20+/mo)`);
    console.log(`     • Anthropic API key with Agent SDK access\n`);

    const yesChars = getLocale() === "de" ? ["j", "ja", "y", "yes", ""] : ["y", "yes", ""];
    const proceed = (await ask(`  Continue with Claude SDK? (Y/n): `)).trim().toLowerCase();
    if (!yesChars.includes(proceed)) {
      console.log(`\n  Switching to provider selection...\n`);
      provider = PROVIDERS[0];
      console.log(`  ✅ Switched to ${provider.name} (free)\n`);
    } else {
      // Check CLI installed
      let cliInstalled = false;
      try {
        execSync("claude --version", { encoding: "utf-8", stdio: "pipe" });
        cliInstalled = true;
        console.log(`  ✅ Claude CLI found`);
      } catch {
        console.log(`  ⚠️  Claude CLI not found (native binary required).`);
        console.log(`\n  The Claude Agent SDK needs the native Claude Code binary.`);
        console.log(`  Install it with:\n`);
        console.log(`    curl -fsSL https://claude.ai/install.sh | sh\n`);
        console.log(`  (npm install @anthropic-ai/claude-code does NOT work for this)\n`);
        const yc = getLocale() === "de" ? ["j", "ja"] : ["y", "yes"];
        const doInstall = (await ask(`  Already installed or want to try now? (y/n): `)).trim().toLowerCase();
        if (yc.includes(doInstall)) {
          console.log(`\n  Installing Claude CLI (native)...`);
          try {
            execSync("curl -fsSL https://claude.ai/install.sh | sh", { stdio: "inherit", timeout: 120_000 });
            // Add ~/.local/bin to PATH for this process (installer puts claude there)
            const localBin = join(homedir(), ".local", "bin");
            if (!process.env.PATH.includes(localBin)) {
              process.env.PATH = `${localBin}:${process.env.PATH}`;
            }
            cliInstalled = true;
            console.log(`  ✅ Claude CLI installed\n`);
          } catch {
            console.log(`  ❌ Installation failed. Try manually: curl -fsSL https://claude.ai/install.sh | sh`);
          }
        }
      }

      if (cliInstalled) {
        console.log(`\n  Checking Claude SDK authentication...`);
        const authResult = await validateProviderKey("claude-sdk", null);
        if (!authResult.ok) {
          console.log(`  ⚠️  ${authResult.error}`);
          console.log(`\n  Logging in to Claude...`);
          console.log(`  This will open your browser for authentication.\n`);
          try {
            // Find claude binary for auth login
            let authBin = "claude";
            const authLocalBin = join(homedir(), ".local", "bin", "claude");
            if (existsSync(authLocalBin)) authBin = `"${authLocalBin}"`;
            execSync(`${authBin} auth login --claudeai`, {
              stdio: "inherit",
              timeout: 120000,
            });
          } catch {
            console.log(`\n  ⚠️  Auto-login failed. Please run manually in another terminal:`);
            console.log(`     claude auth login\n`);
            await ask(`  Press Enter when you've logged in...`);
          }

          const recheck = await validateProviderKey("claude-sdk", null);
          if (recheck.ok) {
            console.log(`\n  ✅ Claude SDK authenticated!\n`);
          } else {
            console.log(`\n  ❌ Claude SDK still not working: ${recheck.error}`);
            console.log(`  Switching to a free provider.\n`);
            provider = PROVIDERS[0];
            console.log(`  ✅ Switched to ${provider.name} (free)\n`);
          }
        } else {
          console.log(`  ✅ ${authResult.detail}\n`);
        }
      } else {
        console.log(`\n  Claude CLI not available. Switching to a free provider.\n`);
        provider = PROVIDERS[0];
        console.log(`  ✅ Switched to ${provider.name} (free)\n`);
      }
    }
  }

  // Get and validate API key
  let providerApiKey = "";
  if (provider.envKey) {
    console.log(`\n  API key for ${provider.name}:`);
    console.log(`  Get one at: ${provider.signup}\n`);
    providerApiKey = (await ask(`  ${provider.envKey}: `)).trim();

    if (providerApiKey) {
      console.log(`\n  Validating...`);
      let keyResult = await validateProviderKey(provider.key, providerApiKey);
      if (keyResult.ok) {
        console.log(`  ✅ ${keyResult.detail}\n`);
      } else {
        console.log(`  ❌ ${keyResult.error}\n`);
        let resolved = false;
        for (let attempt = 0; attempt < 2 && !resolved; attempt++) {
          const choice = (await ask(`  1. Enter new key  2. Switch provider  3. Skip\n  Choice: `)).trim();
          if (choice === "1") {
            providerApiKey = (await ask(`\n  ${provider.envKey}: `)).trim();
            if (providerApiKey) {
              console.log(`  Validating...`);
              keyResult = await validateProviderKey(provider.key, providerApiKey);
              if (keyResult.ok) {
                console.log(`  ✅ ${keyResult.detail}\n`);
                resolved = true;
              } else {
                console.log(`  ❌ ${keyResult.error}\n`);
              }
            }
          } else if (choice === "2") {
            provider = PROVIDERS[0];
            console.log(`\n  Switched to ${provider.name} (free)`);
            console.log(`  Get a free key at: ${provider.signup}\n`);
            providerApiKey = (await ask(`  ${provider.envKey}: `)).trim();
            if (providerApiKey) {
              const gr = await validateProviderKey(provider.key, providerApiKey);
              if (gr.ok) console.log(`  ✅ ${gr.detail}\n`);
              else console.log(`  ⚠️  ${gr.error} — continuing anyway\n`);
            }
            resolved = true;
          } else {
            console.log(`  ⚠️  Skipping — bot won't work until a valid key is configured.\n`);
            providerApiKey = "";
            resolved = true;
          }
        }
      }
    } else {
      console.log(`\n  ⚠️  No API key provided. Bot won't work until configured.`);
      console.log(`  Get one at: ${provider.signup}\n`);
    }
  }

  // ── Step 4: Fallback & Extras
  console.log(`\n━━━ ${t("setup.step4")} ━━━\n`);

  let groqKey = "";
  if (provider.key !== "groq") {
    console.log(`  ${t("setup.groqFallback")}\n`);
    groqKey = (await ask(t("setup.groqKeyPrompt"))).trim();
    if (!groqKey) {
      console.log(`  ℹ️  ${t("setup.noGroqKey")}\n`);
    }
  } else {
    groqKey = providerApiKey;
  }

  console.log(`  ${t("setup.extraKeys")}\n`);
  const extraKeys = {};
  if (provider.key !== "nvidia-llama-3.3-70b" && provider.key !== "nvidia-kimi-k2.5") {
    const nk = (await ask(`  ${t("setup.nvidiaKeyPrompt")}`)).trim();
    if (nk) extraKeys["NVIDIA_API_KEY"] = nk;
  }
  if (provider.key !== "gemini-2.5-flash") {
    const gk = (await ask(`  ${t("setup.googleKeyPrompt")}`)).trim();
    if (gk) extraKeys["GOOGLE_API_KEY"] = gk;
  }
  if (provider.key !== "openai" && provider.key !== "gpt-4o") {
    const ok = (await ask(`  ${t("setup.openaiKeyPrompt")}`)).trim();
    if (ok) extraKeys["OPENAI_API_KEY"] = ok;
  }

  // Fallback order
  console.log(`\n  ${t("setup.fallbackOrder")}`);
  const availableFallbacks = [];
  if (groqKey && provider.key !== "groq") availableFallbacks.push("groq");
  if (extraKeys["NVIDIA_API_KEY"]) availableFallbacks.push("nvidia-llama-3.3-70b");
  // If NVIDIA is primary, add llama as fallback automatically
  if (provider.key === "nvidia-kimi-k2.5" && !availableFallbacks.includes("nvidia-llama-3.3-70b")) {
    availableFallbacks.push("nvidia-llama-3.3-70b");
  }
  if (extraKeys["GOOGLE_API_KEY"]) availableFallbacks.push("gemini-2.5-flash");
  if (extraKeys["OPENAI_API_KEY"]) availableFallbacks.push("gpt-4o");

  if (availableFallbacks.length > 0) {
    console.log(`     ${t("setup.defaultOrder")} ${availableFallbacks.join(" → ")}`);
    const customOrder = (await ask(`     ${t("setup.customOrder")}`)).trim();
    if (customOrder) {
      availableFallbacks.length = 0;
      availableFallbacks.push(...customOrder.split(",").map(s => s.trim()).filter(Boolean));
    }
  } else {
    console.log(`     ${t("setup.noFallbacks")}`);
  }

  console.log("");
  const webPassword = (await ask(t("setup.webPassword"))).trim();

  // ── Step 5: Platforms
  console.log(`\n━━━ ${t("setup.step5")} ━━━`);
  console.log(`${t("setup.step5.intro")}\n`);
  console.log(`  1. ${t("setup.platform.telegramOnly")}`);
  console.log(`  2. ${t("setup.platform.whatsapp")}`);
  console.log(`  3. ${t("setup.platform.later")}\n`);

  const platformChoice = parseInt((await ask(t("setup.platformChoice"))).trim()) || 1;
  const enableWhatsApp = platformChoice === 2;

  // ── Write .env
  console.log(`\n${t("setup.writingConfig")}`);

  // Offline mode translates to PRIMARY_PROVIDER=ollama — the registry's
  // ollama preset already points at gemma4:e4b, so no extra env needed.
  const primaryKey = provider.offline ? "ollama" : provider.key;

  const envLines = [
    "# === Telegram ===",
    `BOT_TOKEN=${botToken || ""}`,
    `ALLOWED_USERS=${userId || ""}`,
    "",
    "# === AI Provider ===",
    `PRIMARY_PROVIDER=${primaryKey}`,
  ];

  if (provider.envKey && providerApiKey) {
    envLines.push(`${provider.envKey}=${providerApiKey}`);
  }

  if (groqKey && provider.key !== "groq") {
    envLines.push(`GROQ_API_KEY=${groqKey}`);
  }

  for (const [envKey, value] of Object.entries(extraKeys)) {
    envLines.push(`${envKey}=${value}`);
  }

  if (availableFallbacks.length > 0) {
    envLines.push(`FALLBACK_PROVIDERS=${availableFallbacks.join(",")}`);
  }

  envLines.push("");
  envLines.push("# === Agent ===");
  envLines.push(`WORKING_DIR=${homedir()}`);
  envLines.push("MAX_BUDGET_USD=5.0");

  if (webPassword) {
    envLines.push(`WEB_PASSWORD=${webPassword}`);
  }

  envLines.push("WEB_PORT=3100");

  if (enableWhatsApp) {
    envLines.push("");
    envLines.push("# === WhatsApp ===");
    envLines.push("WHATSAPP_ENABLED=true");
  }

  const envContent = envLines.join("\n") + "\n";

  // Ensure DATA_DIR exists
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  // Write .env to ~/.alvin-bot/.env (works for both global npm install and local dev)
  const envPath = resolve(DATA_DIR, ".env");

  if (existsSync(envPath)) {
    const backup = `${envPath}.backup-${Date.now()}`;
    writeFileSync(backup, readFileSync(envPath));
    console.log(`  ${t("setup.backup")} ${backup}`);
  }

  writeFileSync(envPath, envContent);
  console.log(`  ✅ Config saved to ${envPath}`);

  // Also write to cwd if we're in a dev/git environment (convenience)
  const cwdEnvPath = resolve(process.cwd(), ".env");
  const isDevMode = existsSync(resolve(process.cwd(), ".git"));
  if (isDevMode && cwdEnvPath !== envPath) {
    writeFileSync(cwdEnvPath, envContent);
    console.log(`  ✅ Dev copy saved to ${cwdEnvPath}`);
  }

  // Create ~/.alvin-bot/ data directory
  const memoryDir = resolve(DATA_DIR, "memory");
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  // Create soul.md if not exists
  const soulPath = resolve(DATA_DIR, "soul.md");
  if (!existsSync(soulPath)) {
    const soulExample = resolve(process.cwd(), "SOUL.example.md");
    if (existsSync(soulExample)) {
      copyFileSync(soulExample, soulPath);
      console.log("  ✅ soul.md initialized from example");
    } else {
      writeFileSync(soulPath, t("soul.default"));
      console.log(`  ✅ ${t("setup.soulCreated")}`);
    }
  }

  // Initialize memory/MEMORY.md if not exists
  const memoryMdPath = resolve(DATA_DIR, "memory", "MEMORY.md");
  if (!existsSync(memoryMdPath)) {
    writeFileSync(memoryMdPath, "# Long-term Memory\n\n> This file is your agent's long-term memory. Add important context here.\n> It persists across sessions and is read at every startup.\n");
    console.log("  ✅ memory/MEMORY.md created");
  }

  // Initialize custom-models.json if not exists
  const customModelsPath = resolve(DATA_DIR, "custom-models.json");
  if (!existsSync(customModelsPath)) {
    writeFileSync(customModelsPath, "[]");
    console.log("  ✅ custom-models.json initialized");
  }

  // Copy TOOLS.example.md → tools.md if not exists
  const toolsMdPath = resolve(DATA_DIR, "tools.md");
  const toolsMdExample = resolve(process.cwd(), "TOOLS.example.md");
  if (!existsSync(toolsMdPath) && existsSync(toolsMdExample)) {
    copyFileSync(toolsMdExample, toolsMdPath);
    console.log("  ✅ Custom tools initialized from example (tools.md)");
  }

  // Copy CLAUDE.example.md → CLAUDE.md in BOT_ROOT if not exists
  const claudePath = resolve(process.cwd(), "CLAUDE.md");
  const claudeExample = resolve(process.cwd(), "CLAUDE.example.md");
  if (!existsSync(claudePath) && existsSync(claudeExample)) {
    copyFileSync(claudeExample, claudePath);
    console.log("  ✅ CLAUDE.md initialized from example");
  }

  // ── Build (only for local/dev installs — global npm installs already have dist/)
  const isGlobalInstall = !existsSync(resolve(process.cwd(), "tsconfig.json"));
  if (!isGlobalInstall) {
    console.log(`\n${t("setup.building")}`);
    try {
      execSync("npm run build", { stdio: "inherit" });
      console.log(`  ✅ ${t("setup.buildOk")}`);
    } catch {
      console.log(`\n  ❌ ${t("setup.buildFailed")}`);
      console.log(`  The bot cannot start without a successful build.`);
      console.log(`  Try running 'npm run build' manually to see the error.\n`);
      closeRL();
      return;
    }
  }

  // ── Post-Setup Validation ──────────────────────────────────────────────
  await runPostSetupValidation(provider.key, providerApiKey, botToken, 3100);

  // ── Summary
  const providerInfo = "";

  const startCmds = isGlobalInstall
    ? `  alvin-bot start                  (start the bot)
  alvin-bot doctor                 (check configuration)

  # Keep running permanently:
  npm install -g pm2
  pm2 start "alvin-bot start" --name alvin-bot
  pm2 save && pm2 startup`
    : `  npm run dev                       (development, hot reload)
  npm start                         (production)
  pm2 start ecosystem.config.cjs    (production, auto-restart)`;

  console.log(`
━━━ ${t("setup.done")} ━━━

  🤖 Provider: ${provider.name}
  💬 Telegram: @... (check @BotFather)
  🌐 Web UI: http://localhost:3100${webPassword ? ` (${t("setup.passwordProtected")})` : ""}
  📁 Config: ${envPath}
${enableWhatsApp ? `  📱 ${t("setup.scanQr")}\n` : ""}${providerInfo}
Start:
${startCmds}

Bot commands:
  /help     — Show all commands
  /model    — Switch AI model
  /effort   — Set thinking depth
  /imagine  — Generate images
  /web      — Web search
  /cron     — Scheduled tasks

${t("setup.haveFun")}
`);

  closeRL();
}

// ── Doctor ──────────────────────────────────────────────────────────────────

async function doctor() {
  console.log(`\n━━━ Alvin Bot Health Check ━━━\n`);

  // ── System ──
  console.log("  System:");
  try {
    const v = execSync("node --version", { encoding: "utf-8" }).trim();
    const major = parseInt(v.slice(1));
    console.log(`  ${major >= 18 ? "✅" : "❌"} Node.js ${v}${major < 18 ? " (need ≥ 18)" : ""}`);
  } catch {
    console.log("  ❌ Node.js not found");
  }

  // Config file
  const dataEnvPath = resolve(DATA_DIR, ".env");
  const cwdEnvPath = resolve(process.cwd(), ".env");
  const envPath = existsSync(dataEnvPath) ? dataEnvPath : existsSync(cwdEnvPath) ? cwdEnvPath : null;

  if (envPath) {
    console.log(`  ✅ Config: ${envPath}`);
  } else {
    console.log(`  ❌ No .env found`);
    console.log(`     Run: alvin-bot setup\n`);
    return;
  }

  const env = readFileSync(envPath, "utf-8");
  const getEnv = (key) => {
    const m = env.match(new RegExp(`^${key}=(.+)$`, "m"));
    return m?.[1]?.trim() || "";
  };

  // Build
  const distPaths = [
    resolve(process.cwd(), "dist/index.js"),
    resolve(import.meta.dirname || ".", "../dist/index.js"),
  ];
  console.log(`  ${distPaths.some(p => existsSync(p)) ? "✅" : "❌"} Build present`);

  // ── Provider ──
  console.log("\n  Provider:");
  const primary = getEnv("PRIMARY_PROVIDER");
  if (primary) {
    const apiKeyMap = {
      groq: "GROQ_API_KEY",
      "nvidia-llama-3.3-70b": "NVIDIA_API_KEY",
      "nvidia-kimi-k2.5": "NVIDIA_API_KEY",
      "gemini-2.5-flash": "GOOGLE_API_KEY",
      openai: "OPENAI_API_KEY",
      "gpt-4o": "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    };
    const keyName = apiKeyMap[primary];
    const key = keyName ? getEnv(keyName) : null;

    console.log(`  Validating ${primary}...`);
    const result = await validateProviderKey(primary, key);
    if (result.ok && result.warning) {
      console.log(`  ⚠️  ${primary} — ${result.detail}`);
      console.log(`     ${result.warning}`);
    } else if (result.ok) {
      console.log(`  ✅ ${primary} — ${result.detail}`);
    } else {
      console.log(`  ❌ ${primary} — ${result.error}`);
    }

    const fallbacks = getEnv("FALLBACK_PROVIDERS");
    if (fallbacks) {
      console.log(`  ℹ️  Fallbacks: ${fallbacks}`);
    } else {
      console.log(`  ⚠️  No fallback providers configured`);
    }
  } else {
    console.log(`  ❌ PRIMARY_PROVIDER not set`);
  }

  // ── Telegram ──
  console.log("\n  Telegram:");
  const botToken = getEnv("BOT_TOKEN");
  if (botToken) {
    const tResult = await validateTelegramToken(botToken);
    if (tResult.ok) {
      console.log(`  ✅ Bot: ${tResult.botName}`);
    } else {
      console.log(`  ❌ ${tResult.error}`);
    }
  } else {
    console.log(`  ⚠️  BOT_TOKEN not configured (WebUI-only mode)`);
  }

  const users = getEnv("ALLOWED_USERS");
  if (users) {
    const ids = users.split(",").map(s => s.trim());
    const invalid = ids.filter(id => !/^\d+$/.test(id));
    if (invalid.length > 0) {
      console.log(`  ⚠️  ALLOWED_USERS has non-numeric: ${invalid.join(", ")}`);
    } else {
      console.log(`  ✅ ALLOWED_USERS: ${ids.length} user${ids.length > 1 ? "s" : ""}`);
    }
  } else if (botToken) {
    console.log(`  ❌ ALLOWED_USERS not set (nobody can message the bot)`);
  }

  // ── Web UI security ──
  console.log("\n  Web UI:");
  const webHost = getEnv("WEB_HOST") || "127.0.0.1";
  const webPw = getEnv("WEB_PASSWORD");
  if (webHost === "127.0.0.1" || webHost === "::1") {
    console.log(`  ✅ WEB_HOST=${webHost} — loopback only (LAN unreachable)`);
  } else if (webHost === "0.0.0.0" || webHost === "*") {
    if (webPw) {
      console.log(`  ✅ WEB_HOST=${webHost} (LAN-reachable) + WEB_PASSWORD set`);
    } else {
      console.log(`  ❌ WEB_HOST=${webHost} (LAN-reachable) WITHOUT WEB_PASSWORD — anyone on LAN can log in`);
      console.log(`     Fix: set WEB_PASSWORD in .env, or set WEB_HOST=127.0.0.1`);
    }
  } else {
    console.log(`  ℹ️  WEB_HOST=${webHost}${webPw ? " + WEB_PASSWORD set" : " — WEB_PASSWORD empty"}`);
  }

  // ── Slack caller allowlist ──
  if (getEnv("SLACK_BOT_TOKEN")) {
    console.log("\n  Slack:");
    const slackAllow = getEnv("SLACK_ALLOWED_USERS");
    if (slackAllow) {
      const ids = slackAllow.split(",").map(s => s.trim()).filter(Boolean);
      console.log(`  ✅ SLACK_ALLOWED_USERS: ${ids.length} user${ids.length === 1 ? "" : "s"} (caller allowlist active)`);
    } else {
      console.log(`  ⚠️  SLACK_ALLOWED_USERS not set — any workspace member can talk to the bot`);
      console.log(`     Safe iff the Slack workspace is private to you. Otherwise add e.g.:`);
      console.log(`     SLACK_ALLOWED_USERS=U0ABC123,U0DEF456`);
    }
  }

  // ── Browser tools (optional Tier-1.5 agent-browser) ──
  console.log("\n  Browser tools:");
  let agentBrowserVersion = "";
  try {
    agentBrowserVersion = execSync("agent-browser --version 2>/dev/null", { encoding: "utf-8", timeout: 3000 }).trim();
  } catch {}
  if (agentBrowserVersion) {
    // `agent-browser --version` prints "agent-browser X.Y.Z" — strip the prefix.
    const v = agentBrowserVersion.replace(/^agent-browser\s+/i, "");
    console.log(`  ✅ agent-browser ${v} — Tier-1.5 (token-efficient snapshot+ref) available`);
  } else {
    console.log(`  ℹ️  agent-browser not installed (optional Tier-1.5)`);
    console.log(`     Install for ~90% cheaper interactive automation:`);
    console.log(`       npm i -g agent-browser && agent-browser install`);
  }

  // ── Memory (semantic search backend) ──
  console.log("\n  Memory:");
  const embJson = resolve(DATA_DIR, "memory", ".embeddings.json");
  const embDb = resolve(DATA_DIR, "memory", ".embeddings.db");
  const embBakSqlite = resolve(DATA_DIR, "memory", ".embeddings.json.bak-pre-sqlite");

  // better-sqlite3 native binary loadable?
  let sqliteOk = false;
  let sqliteErr = "";
  try {
    const req = (await import("module")).createRequire(import.meta.url);
    req("better-sqlite3");
    sqliteOk = true;
  } catch (err) {
    sqliteErr = err instanceof Error ? err.message : String(err);
  }
  if (sqliteOk) {
    console.log(`  ✅ better-sqlite3 native binary loadable`);
  } else {
    console.log(`  ❌ better-sqlite3 native binary not loadable — semantic search disabled`);
    console.log(`     Fix: cd $(npm root -g)/alvin-bot && npm rebuild better-sqlite3`);
    console.log(`     Detail: ${sqliteErr.split("\n")[0]}`);
  }

  if (sqliteOk && existsSync(embDb)) {
    try {
      const req = (await import("module")).createRequire(import.meta.url);
      const Database = req("better-sqlite3");
      const db = new Database(embDb, { readonly: true });
      const entries = db.prepare("SELECT COUNT(*) AS c FROM entries").get().c;
      const files = db.prepare("SELECT COUNT(*) AS c FROM file_mtimes").get().c;
      const sizeMb = (statSync(embDb).size / 1024 / 1024).toFixed(0);
      db.close();
      console.log(`  ✅ Vector store: ${entries} entries across ${files} sources (${sizeMb} MB SQLite)`);
    } catch (err) {
      console.log(`  ⚠️  Vector store exists but unreadable: ${err.message}`);
    }
  } else if (existsSync(embJson)) {
    const sizeMb = (statSync(embJson).size / 1024 / 1024).toFixed(0);
    console.log(`  ⚠️  Legacy JSON index found (${sizeMb} MB) — will auto-migrate to SQLite on next bot start`);
  } else if (existsSync(embBakSqlite)) {
    console.log(`  ✅ Migration to SQLite already done (legacy JSON kept as .bak-pre-sqlite)`);
  } else {
    console.log(`  ℹ️  No vector store yet — will be built on first message`);
  }

  // ── Extras ──
  console.log("\n  Extras:");

  if (existsSync(resolve(DATA_DIR, "soul.md")) || existsSync(resolve(process.cwd(), "SOUL.md"))) {
    console.log(`  ✅ Personality (soul.md)`);
  } else {
    console.log(`  ⚠️  No soul.md (bot uses default personality)`);
  }

  const pluginsDir = resolve(process.cwd(), "plugins");
  if (existsSync(pluginsDir)) {
    try {
      const plugins = readdirSync(pluginsDir).filter(d => {
        try { return existsSync(resolve(pluginsDir, d, "index.js")); } catch { return false; }
      });
      if (plugins.length > 0) console.log(`  ✅ Plugins: ${plugins.join(", ")}`);
    } catch { /* ignore */ }
  }

  if (env.includes("WHATSAPP_ENABLED=true")) {
    const chromePaths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome", "/usr/bin/chromium",
    ];
    const hasChrome = chromePaths.some(p => existsSync(p));
    console.log(`  ${hasChrome ? "✅" : "⚠️ "} WhatsApp (Chrome: ${hasChrome ? "found" : "not found"})`);
  }

  console.log("");
}

// ── Update ──────────────────────────────────────────────────────────────────

async function update() {
  console.log(`${t("update.title")}\n`);

  try {
    const isGit = existsSync(resolve(process.cwd(), ".git"));

    if (isGit) {
      console.log(`  ${t("update.pulling")}`);
      execSync("git pull", { stdio: "inherit" });
      console.log(`\n  ${t("update.installing")}`);
      execSync("npm install", { stdio: "inherit" });
      console.log(`\n  ${t("update.building")}`);
      execSync("npm run build", { stdio: "inherit" });
      console.log(`\n  ✅ ${t("update.done")}`);
    } else {
      console.log(`  ${t("update.npm")}`);
      execSync("npm update alvin-bot", { stdio: "inherit" });
      console.log(`\n  ✅ ${t("update.done")}`);
    }
  } catch (err) {
    console.error(`\n  ❌ ${t("update.failed")} ${err.message}`);
  }
}

// ── Version ─────────────────────────────────────────────────────────────────

async function version() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname || ".", "../package.json"), "utf-8"));
    console.log(`Alvin Bot v${pkg.version}`);
  } catch {
    console.log("Alvin Bot (version unknown)");
  }
}

// ── LaunchAgent helpers (macOS only) ────────────────────────────────────────

/**
 * Render the launchd plist that runs `node dist/index.js` as a per-user
 * agent. Inherits the GUI login session so the macOS Keychain is
 * automatically unlocked — which means Claude Code OAuth tokens (Max
 * subscription) work without a manual `security unlock-keychain`.
 */
function renderLaunchdPlist({ label, nodePath, entryPoint, cwd, home, logDir }) {
  // PATH covers both Apple Silicon and Intel Homebrew plus the legacy
  // user-local claude binary path.
  const pathValue = `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${entryPoint}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${cwd}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>ProcessType</key>
    <string>Background</string>

    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>

    <key>StandardOutPath</key>
    <string>${logDir}/alvin-bot.out.log</string>

    <key>StandardErrorPath</key>
    <string>${logDir}/alvin-bot.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${pathValue}</string>
        <key>HOME</key>
        <string>${home}</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
</dict>
</plist>
`;
}

/**
 * Common paths + label used by all three launchd subcommands.
 */
function launchdPaths() {
  const home = homedir();
  const label = "com.alvinbot.app";
  const plistPath = join(home, "Library", "LaunchAgents", `${label}.plist`);
  const logDir = join(home, ".alvin-bot", "logs");
  // dist/index.js lives two levels up from bin/cli.js, then dist/
  const entryPoint = resolve(join(import.meta.dirname, "..", "dist", "index.js"));
  const cwd = resolve(join(import.meta.dirname, ".."));
  const nodePath = process.execPath;
  return { home, label, plistPath, logDir, entryPoint, cwd, nodePath };
}

async function launchdInstall() {
  if (process.platform !== "darwin") {
    console.log("❌ alvin-bot launchd is macOS-only.");
    console.log("   Linux users: create a systemd user unit for dist/index.js.");
    console.log("   Windows users: use Task Scheduler or NSSM.");
    process.exit(1);
  }

  const { home, label, plistPath, logDir, entryPoint, cwd, nodePath } = launchdPaths();

  // Sanity-check that dist/ is built
  if (!existsSync(entryPoint)) {
    console.log(`❌ Build not found at ${entryPoint}`);
    console.log("   Run 'npm run build' first.");
    process.exit(1);
  }

  // Ensure the LaunchAgents dir and log dir exist
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(logDir, { recursive: true });

  // Render and write the plist
  const plist = renderLaunchdPlist({ label, nodePath, entryPoint, cwd, home, logDir });
  writeFileSync(plistPath, plist, { mode: 0o644 });
  console.log(`📝 Wrote ${plistPath}`);

  // Unload any previous instance (best-effort)
  try {
    execSync(`launchctl unload -w "${plistPath}"`, { stdio: "pipe" });
  } catch { /* not loaded yet — fine */ }

  // If pm2 is managing an alvin-bot process, tear that one process down.
  // We deliberately do NOT `pm2 kill` the whole daemon — the user may
  // have other pm2-managed projects (polyseus, etc.) and we must not
  // nuke those. Only the alvin-bot entry is removed.
  let pm2HadAlvinBot = false;
  let pm2StillHasOtherProcesses = false;
  try {
    execSync("pm2 --version", { stdio: "pipe" });
    // Check whether alvin-bot is currently pm2-managed
    try {
      const lsOut = execSync("pm2 jlist", { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" });
      const procs = JSON.parse(lsOut);
      if (Array.isArray(procs)) {
        pm2HadAlvinBot = procs.some((p) => p && p.name === "alvin-bot");
        pm2StillHasOtherProcesses = procs.some((p) => p && p.name !== "alvin-bot");
      }
    } catch { /* pm2 jlist can fail on empty list or missing daemon — ignore */ }

    if (pm2HadAlvinBot) {
      try {
        execSync("pm2 delete alvin-bot", { stdio: "pipe" });
        console.log("🧹 Removed alvin-bot from pm2 (other pm2 projects left intact).");
      } catch { /* already gone */ }
    }
  } catch { /* pm2 not installed — nothing to clean up */ }

  // Stop any nohup'd bot that might still be running
  try {
    execSync(`pkill -TERM -f 'node.*dist/index.js' || true`, { stdio: "pipe" });
  } catch { /* nothing to kill */ }

  // Load fresh
  try {
    execSync(`launchctl load -w "${plistPath}"`, { stdio: "inherit" });
  } catch (err) {
    console.log(`❌ launchctl load failed: ${err.message}`);
    console.log("   Try manually: launchctl load -w " + plistPath);
    process.exit(1);
  }

  console.log("");
  console.log("✅ alvin-bot is now a launchd user agent.");
  console.log(`   Label:   ${label}`);
  console.log(`   Logs:    ${logDir}/alvin-bot.out.log`);
  console.log(`   Errors:  ${logDir}/alvin-bot.err.log`);
  console.log("");
  console.log("   Status:    alvin-bot launchd status");
  console.log("   Stop:      alvin-bot launchd uninstall");
  console.log("   Restart:   launchctl kickstart -k gui/$UID/" + label);
  console.log("");
  console.log("   Because launchd runs the bot inside your GUI login session,");
  console.log("   the macOS Keychain is automatically unlocked — Claude Code");
  console.log("   OAuth tokens (Max subscription) just work, no SSH keychain");
  console.log("   dance needed anymore.");
  if (pm2HadAlvinBot && !pm2StillHasOtherProcesses) {
    console.log("");
    console.log("💡 pm2 now has zero managed processes. You can remove it entirely:");
    console.log("      npm uninstall -g pm2");
  } else if (pm2HadAlvinBot && pm2StillHasOtherProcesses) {
    console.log("");
    console.log("💡 pm2 still has other projects running — leaving it installed.");
  }
  process.exit(0);
}

async function launchdUninstall() {
  if (process.platform !== "darwin") {
    console.log("❌ alvin-bot launchd is macOS-only.");
    process.exit(1);
  }
  const { plistPath, label } = launchdPaths();
  if (!existsSync(plistPath)) {
    console.log(`⚠️  No LaunchAgent plist at ${plistPath}`);
    console.log("   Nothing to uninstall.");
    process.exit(0);
  }

  try {
    execSync(`launchctl unload -w "${plistPath}"`, { stdio: "inherit" });
    console.log(`✅ Unloaded ${label}`);
  } catch (err) {
    console.log(`⚠️  Unload reported an error (may not have been running): ${err.message}`);
  }

  try {
    execSync(`rm -f "${plistPath}"`);
    console.log(`🗑  Removed ${plistPath}`);
  } catch (err) {
    console.log(`⚠️  Could not remove plist: ${err.message}`);
  }

  console.log("");
  console.log("✅ alvin-bot is no longer a launchd user agent.");
  process.exit(0);
}

async function launchdStatus() {
  if (process.platform !== "darwin") {
    console.log("❌ alvin-bot launchd is macOS-only.");
    process.exit(1);
  }
  const { plistPath, label, logDir } = launchdPaths();

  console.log(`📋 alvin-bot launchd status`);
  console.log("");
  console.log(`Label:    ${label}`);
  console.log(`Plist:    ${plistPath}`);
  console.log(`Plist exists: ${existsSync(plistPath) ? "yes" : "no"}`);
  console.log("");

  try {
    const out = execSync(`launchctl list | grep ${label} || true`, { encoding: "utf-8" });
    if (out.trim()) {
      // Format: <PID>\t<ExitCode>\t<Label>
      const parts = out.trim().split(/\s+/);
      const pid = parts[0];
      const exitCode = parts[1];
      const isRunning = pid !== "-" && pid !== "0";
      console.log(`Running:  ${isRunning ? "✅ yes (PID " + pid + ")" : "❌ no (last exit " + exitCode + ")"}`);
    } else {
      console.log(`Running:  ❌ not loaded`);
    }
  } catch {
    console.log(`Running:  ❌ unknown (launchctl list failed)`);
  }

  console.log("");
  console.log(`Log dir:  ${logDir}`);
  const outLog = join(logDir, "alvin-bot.out.log");
  const errLog = join(logDir, "alvin-bot.err.log");
  if (existsSync(outLog)) {
    try {
      const tail = execSync(`tail -n 5 "${outLog}"`, { encoding: "utf-8" });
      console.log("");
      console.log("── Last 5 lines of stdout ──");
      console.log(tail.trimEnd());
    } catch { /* ignore */ }
  }
  if (existsSync(errLog)) {
    try {
      const tail = execSync(`tail -n 5 "${errLog}"`, { encoding: "utf-8" });
      const trimmed = tail.trimEnd();
      if (trimmed) {
        console.log("");
        console.log("── Last 5 lines of stderr ──");
        console.log(trimmed);
      }
    } catch { /* ignore */ }
  }
  process.exit(0);
}

// ── CLI Router ──────────────────────────────────────────────────────────────

const cmd = process.argv[2];
switch (cmd) {
  case "setup":
    setup().catch(console.error);
    break;
  case "doctor":
    doctor().catch(console.error);
    break;
  case "update":
    update().catch(console.error);
    break;
  case "start": {
    const fg = process.argv.includes("--foreground") || process.argv.includes("-f");
    if (fg) {
      import("../dist/index.js");
      break;
    }

    // On macOS, if a LaunchAgent plist already exists, we're in "launchd
    // mode" — don't start pm2 in parallel. Reload the LaunchAgent instead
    // so a plain `alvin-bot start` still works as "bring the bot up".
    if (process.platform === "darwin") {
      const { plistPath, label } = launchdPaths();
      if (existsSync(plistPath)) {
        console.log(`🚀 Detected existing LaunchAgent (${label})`);
        console.log(`   Reloading via 'launchctl kickstart -k'...`);
        try {
          execSync(`launchctl kickstart -k gui/$(id -u)/${label}`, {
            stdio: "inherit",
            shell: "/bin/zsh",
          });
        } catch {
          // Maybe unloaded — load it fresh
          try {
            execSync(`launchctl load -w "${plistPath}"`, { stdio: "inherit" });
          } catch (err) {
            console.log(`❌ launchctl load failed: ${err.message}`);
            process.exit(1);
          }
        }
        console.log("\n✅ Bot is running via launchd.");
        console.log("   Status: alvin-bot launchd status");
        console.log("   Stop:   alvin-bot stop");
        console.log("   Logs:   ~/.alvin-bot/logs/alvin-bot.out.log");
        process.exit(0);
      }
    }

    // Fall-through: pm2 path (Linux, Windows, or macOS without LaunchAgent)
    try {
      execSync("pm2 --version", { stdio: "pipe" });
    } catch {
      console.log("Installing PM2 for background operation...");
      try {
        execSync("npm install -g pm2", { stdio: "inherit", timeout: 60000 });
      } catch {
        console.log("Could not install PM2. Starting in foreground instead.");
        console.log("Tip: Install PM2 manually (npm install -g pm2) to run in background.\n");
        await import("../dist/index.js");
        break;
      }
    }
    const cliPath = resolve(join(import.meta.dirname, "cli.js"));
    try {
      execSync("pm2 delete alvin-bot", { stdio: "pipe" });
    } catch { /* not running — fine */ }
    execSync(`pm2 start "${cliPath}" --name alvin-bot -- start --foreground`, {
      stdio: "inherit",
      timeout: 15000,
    });
    console.log("\n✅ Bot is running in the background via PM2.");
    console.log("   Logs:    pm2 logs alvin-bot");
    console.log("   Stop:    alvin-bot stop");
    console.log("   Restart: alvin-bot start");
    if (process.platform === "darwin") {
      console.log("");
      console.log("   💡 Tip: on macOS with Claude Code, switch to launchd for");
      console.log("      automatic Keychain access:  alvin-bot launchd install");
    }
    console.log("");
    process.exit(0);
  }
  case "stop": {
    // On macOS with a LaunchAgent, stopping means unloading the LaunchAgent,
    // not asking pm2 to stop a process it never managed.
    if (process.platform === "darwin") {
      const { plistPath, label } = launchdPaths();
      if (existsSync(plistPath)) {
        console.log(`⏹  Stopping LaunchAgent (${label})...`);
        try {
          execSync(`launchctl unload -w "${plistPath}"`, { stdio: "inherit" });
          console.log("✅ LaunchAgent stopped.");
          console.log("   (The plist is still installed. To remove it: alvin-bot launchd uninstall)");
        } catch (err) {
          console.log(`❌ launchctl unload failed: ${err.message}`);
          process.exit(1);
        }
        process.exit(0);
      }
    }

    // Fall-through: pm2 path
    try {
      execSync("pm2 stop alvin-bot", { stdio: "inherit", timeout: 10000 });
    } catch {
      console.log("Bot is not running via PM2. If running in foreground, use Ctrl+C.");
    }
    process.exit(0);
  }
  case "launchd": {
    const sub = process.argv[3];
    if (sub === "install") {
      await launchdInstall();
    } else if (sub === "uninstall") {
      await launchdUninstall();
    } else if (sub === "status") {
      await launchdStatus();
    } else {
      console.log("Usage: alvin-bot launchd <install|uninstall|status>");
      console.log("");
      console.log("  install    — Install as a macOS launchd user agent.");
      console.log("               Runs on login, keychain auto-unlocked.");
      console.log("  uninstall  — Unload and remove the LaunchAgent plist.");
      console.log("  status     — Show current launchd state + recent logs.");
      process.exit(1);
    }
    break;
  }
  case "tui":
  case "chat":
    import("../dist/tui/index.js").then(m => m.startTUI()).catch(console.error);
    break;
  case "search": {
    const searchQuery = process.argv.slice(3).join(" ");
    if (!searchQuery) {
      console.log("Usage: alvin-bot search <query>");
      console.log('Example: alvin-bot search "tax document 2024"');
      process.exit(1);
    }
    const { searchSelf, formatSearchResults } = await import("../dist/services/self-search.js");
    const results = await searchSelf(searchQuery);
    console.log(formatSearchResults(results));
    process.exit(0);
  }
  case "audit": {
    const { runAudit, formatAuditReport } = await import("../dist/services/security-audit.js");
    const checks = runAudit();
    console.log(formatAuditReport(checks));
    process.exit(checks.some(c => c.status === "FAIL") ? 1 : 0);
    break;
  }
  case "version":
  case "--version":
  case "-v":
    version();
    break;
  case "status": {
    // CLI `alvin-bot status` — quick, offline-friendly status without
    // requiring a running bot. Prints version, node info, data dir,
    // configured provider, and — on macOS — LaunchAgent state.
    try {
      const pkg = JSON.parse(
        readFileSync(resolve(import.meta.dirname || ".", "../package.json"), "utf-8"),
      );
      console.log(`\n🤖 Alvin Bot v${pkg.version}`);
    } catch {
      console.log("\n🤖 Alvin Bot (version unknown)");
    }
    console.log(`   Node ${process.version} · ${process.platform}/${process.arch}`);
    console.log("");

    // Data dir + .env
    const envPath = join(DATA_DIR, ".env");
    console.log(`📁 Data dir:  ${DATA_DIR}`);
    console.log(`   .env:      ${existsSync(envPath) ? "✅ present" : "❌ missing"}`);

    // Primary provider from .env
    if (existsSync(envPath)) {
      try {
        const env = readFileSync(envPath, "utf-8");
        const match = env.match(/^PRIMARY_PROVIDER=(.+)$/m);
        if (match) console.log(`   Provider:  ${match[1].trim()}`);
      } catch { /* ignore */ }
    }
    console.log("");

    // Runtime state: LaunchAgent (macOS) or pm2 (Linux/Windows)
    if (process.platform === "darwin") {
      const { plistPath, label } = launchdPaths();
      const plistExists = existsSync(plistPath);
      console.log(`🚀 LaunchAgent: ${plistExists ? "installed" : "not installed"}`);
      if (plistExists) {
        try {
          const out = execSync(`launchctl list | grep ${label} || true`, { encoding: "utf-8" });
          if (out.trim()) {
            const parts = out.trim().split(/\s+/);
            const pid = parts[0];
            const isRunning = pid !== "-" && pid !== "0";
            console.log(`   Running:    ${isRunning ? `✅ yes (PID ${pid})` : "❌ no"}`);
          } else {
            console.log(`   Running:    ❌ not loaded`);
          }
        } catch {
          console.log(`   Running:    ❌ unknown`);
        }
      }
    } else {
      // Linux/Windows: check pm2
      try {
        const out = execSync("pm2 jlist 2>/dev/null || echo '[]'", { encoding: "utf-8" });
        const procs = JSON.parse(out);
        const alvin = procs.find?.((p) => p && p.name === "alvin-bot");
        if (alvin) {
          console.log(`🚀 pm2:         ${alvin.pm2_env?.status || "unknown"} (PID ${alvin.pid || "?"})`);
        } else {
          console.log(`🚀 pm2:         alvin-bot not managed`);
        }
      } catch {
        console.log(`🚀 pm2:         not installed`);
      }
    }

    // Try to reach the running web API for live info
    try {
      const apiRes = execSync("curl -fsS -m 2 http://localhost:3100/api/status 2>/dev/null", { encoding: "utf-8" });
      const parsed = JSON.parse(apiRes);
      const uptimeSec = Math.floor(parsed.bot?.uptime || 0);
      const h = Math.floor(uptimeSec / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      console.log(`   Uptime:     ${h}h ${m}m`);
      if (parsed.model?.name) console.log(`   Model:      ${parsed.model.name}`);
    } catch { /* bot not running or web ui off — skip */ }

    console.log("");
    process.exit(0);
  }
  case "browser": {
    // Browser subcommands: wraps cdp-bootstrap so Skills + humans have a
    // stable shell interface that works everywhere the bot is installed.
    const sub = process.argv[3];
    const { dist } = await import("../dist/services/cdp-bootstrap.js").then(
      (m) => ({ dist: m }),
      async () => {
        console.error("❌ dist/services/cdp-bootstrap.js not found. Run: npm run build");
        process.exit(1);
      }
    );
    try {
      switch (sub) {
        case "start": {
          const mode = process.argv[4] === "headful" ? "headful" : "headless";
          const st = await dist.ensureRunning({ mode });
          console.log(`✅ CDP running — PID ${st.pid} — ${st.endpoint}`);
          if (st.binary) console.log(`   Binary: ${st.binary}`);
          break;
        }
        case "stop": {
          await dist.stop();
          console.log("✅ CDP stopped");
          break;
        }
        case "status": {
          const st = await dist.status();
          if (st.running) {
            console.log(`✅ CDP running — PID ${st.pid}`);
          } else {
            console.log(`❌ CDP not running: ${st.reason || "unknown"}`);
          }
          if (st.binary) console.log(`   Binary: ${st.binary}`);
          console.log(`   Endpoint: ${st.endpoint}`);
          break;
        }
        case "doctor": {
          const rep = await dist.doctor();
          console.log("=== Browser Doctor ===\n");
          for (const c of rep.checks) {
            console.log(`${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`);
          }
          console.log(rep.ok ? "\nAll checks passed." : "\nSome checks failed — see above.");
          process.exit(rep.ok ? 0 : 1);
        }
        case "goto":
        case "shot":
        case "screenshot":
        case "tabs":
        case "eval": {
          await dist.ensureRunning({ mode: "headless" });
          const { chromium } = await import("playwright").catch(() => ({ chromium: null }));
          if (!chromium) {
            console.error("❌ playwright not available. Run: npm install");
            process.exit(1);
          }
          const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
          try {
            if (sub === "tabs") {
              const tabs = [];
              for (const ctx of browser.contexts()) {
                for (const page of ctx.pages()) {
                  tabs.push({ title: await page.title(), url: page.url() });
                }
              }
              console.log(JSON.stringify(tabs, null, 2));
              break;
            }
            const url = process.argv[4];
            if (!url) {
              console.error(`Usage: alvin-bot browser ${sub} <url> [args]`);
              process.exit(1);
            }
            const ctx = browser.contexts()[0] || (await browser.newContext());
            const page = await ctx.newPage();
            try {
              await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
              if (sub === "goto") {
                console.log(JSON.stringify({ url: page.url(), title: await page.title() }, null, 2));
              } else if (sub === "shot" || sub === "screenshot") {
                const name = process.argv[5] || `shot_${Date.now()}.png`;
                const { CDP_SCREENSHOTS_DIR } = await import("../dist/paths.js");
                const out = name.startsWith("/") ? name : `${CDP_SCREENSHOTS_DIR}/${name}`;
                await page.screenshot({ path: out, fullPage: true });
                console.log(JSON.stringify({ url: page.url(), title: await page.title(), screenshot: out }, null, 2));
              } else if (sub === "eval") {
                const js = process.argv[5] || "document.title";
                const result = await page.evaluate(new Function(`return (${js})`));
                console.log(JSON.stringify({ url: page.url(), result }, null, 2));
              }
            } finally {
              await page.close();
            }
          } finally {
            await browser.close();
          }
          break;
        }
        default:
          console.log(`alvin-bot browser — bot-managed Chromium (CDP on port 9222)

  start [headful|headless]   Start Chromium with CDP (default: headless)
  stop                        Stop the bot-managed Chromium
  status                      Show PID + binary + endpoint
  doctor                      Diagnose common issues
  goto <url>                  Navigate and print page info as JSON
  shot <url> [filename]       Screenshot to ~/.alvin-bot/browser/screenshots/
  eval <url> <js>             Evaluate JS expression in page context
  tabs                        List all open tabs

Notes:
  • Uses Playwright's bundled Chromium — no conflict with your normal Chrome.
  • Profile persists at ~/.alvin-bot/browser/profile/ (cookies survive restarts).
  • First run needs: npx playwright install chromium
`);
          process.exit(sub ? 1 : 0);
      }
    } catch (err) {
      console.error(`❌ ${err.message || err}`);
      process.exit(1);
    }
    break;
  }
  default:
    console.log(`
${t("cli.title")}

${t("cli.commands")}
  setup     ${t("cli.setup")}
  tui       ${t("cli.tui")}
  chat      ${t("cli.chatAlias")}
  doctor    ${t("cli.doctorDesc")}
  audit     Security health check (permissions, secrets, config)
  search    Search your assets, memories, and skills
  browser   Manage bot-owned Chromium (start/stop/goto/shot/doctor)
  update    ${t("cli.updateDesc")}
  start     ${t("cli.startDesc")} (background via PM2)
  start -f  Start in foreground (for debugging)
  stop      Stop the bot
  status    Show bot version + LaunchAgent/pm2 state (offline)
  launchd   macOS only: install/uninstall/status as launchd user agent
  version   ${t("cli.versionDesc")}

${t("cli.example")}
  alvin-bot setup
  alvin-bot tui
  alvin-bot tui --lang de
`);
}
