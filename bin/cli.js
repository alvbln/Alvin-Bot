#!/usr/bin/env node

/**
 * Alvin Bot CLI — Setup, manage, and chat with your AI agent.
 *
 * Usage:
 *   alvin-bot setup    — Interactive setup wizard
 *   alvin-bot tui      — Terminal chat UI
 *   alvin-bot doctor   — Check configuration
 *   alvin-bot update   — Pull latest & rebuild
 *   alvin-bot start    — Start the bot
 *
 * Flags:
 *   --lang en|de       — Language (default: en, auto-detects from LANG env)
 */

import { createInterface } from "readline";
import { existsSync, writeFileSync, readFileSync, mkdirSync, copyFileSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { initI18n, t, getLocale } from "../dist/i18n.js";

// Data directory — same logic as src/paths.ts
const DATA_DIR = process.env.ALVIN_DATA_DIR || join(homedir(), ".alvin-bot");

// Init i18n early
initI18n();

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

const LOGO = `
  ╔══════════════════════════════════════╗
  ║  🤖 Alvin Bot — Setup Wizard v3.0  ║
  ║  Your Personal AI Agent             ║
  ╚══════════════════════════════════════╝
`;

// ── Provider Definitions ────────────────────────────────────────────────────

const PROVIDERS = [
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
    key: "nvidia-llama-3.3-70b",
    name: "NVIDIA NIM (Llama 3.3 70B)",
    desc: () => t("provider.nvidia.desc"),
    free: true,
    envKey: "NVIDIA_API_KEY",
    signup: "https://build.nvidia.com",
    model: "meta/llama-3.3-70b-instruct",
    needsCLI: false,
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

// ── Setup Wizard ────────────────────────────────────────────────────────────

async function setup() {
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
    rl.close();
    return;
  }

  // ── Step 1: Telegram Bot
  console.log(`\n━━━ ${t("setup.step1")} ━━━`);
  console.log(t("setup.step1.intro") + "\n");
  const botToken = (await ask(t("setup.botToken"))).trim();

  if (!botToken) {
    console.log(`❌ ${t("setup.botTokenRequired")}`);
    rl.close();
    return;
  }

  // Validate bot token format (123456:ABC-DEF...)
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
    console.log(`\n  ⚠️  That doesn't look like a valid bot token.`);
    console.log(`  Expected format: 123456789:ABCdefGHI-jklMNO`);
    console.log(`  Get one from @BotFather on Telegram.\n`);
    const proceed = (await ask(`  Continue anyway? (y/n): `)).trim().toLowerCase();
    if (proceed !== "y" && proceed !== "yes" && proceed !== "j" && proceed !== "ja") {
      rl.close();
      return;
    }
  }

  // ── Step 2: User ID
  console.log(`\n━━━ ${t("setup.step2")} ━━━`);
  console.log(t("setup.step2.intro") + "\n");
  const userId = (await ask(t("setup.userId"))).trim();

  if (!userId) {
    console.log(`❌ ${t("setup.userIdRequired")}`);
    rl.close();
    return;
  }

  // Validate user ID is numeric
  const userIds = userId.split(",").map(s => s.trim());
  const invalidIds = userIds.filter(id => !/^\d+$/.test(id));
  if (invalidIds.length > 0) {
    console.log(`\n  ⚠️  User IDs must be numbers, got: ${invalidIds.join(", ")}`);
    console.log(`  Send /start to @userinfobot on Telegram to get your numeric ID.\n`);
    const proceed = (await ask(`  Continue anyway? (y/n): `)).trim().toLowerCase();
    if (proceed !== "y" && proceed !== "yes" && proceed !== "j" && proceed !== "ja") {
      rl.close();
      return;
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

  // Check Claude CLI if needed
  let hasClaude = false;
  if (provider.needsCLI) {
    try {
      execSync("claude --version", { encoding: "utf-8", stdio: "pipe" });
      hasClaude = true;
      console.log("  ✅ Claude CLI ✓");
    } catch {
      console.log(`  ⚠️  ${t("setup.claudeNotFound")}`);
      console.log("");
      const yesChars = getLocale() === "de" ? ["j", "ja"] : ["y", "yes"];
      const installClaude = (await ask(`  ${t("setup.installClaude")}`)).trim().toLowerCase();
      if (yesChars.includes(installClaude)) {
        console.log(`\n  ${t("setup.installingClaude")}`);
        try {
          execSync("npm install -g @anthropic-ai/claude-code", { stdio: "inherit" });
          console.log(`  ✅ ${t("setup.claudeInstalled")}`);
          console.log(`\n  ${t("setup.claudeLogin")}\n`);
          try {
            execSync("claude login", { stdio: "inherit", timeout: 120_000 });
            hasClaude = true;
            console.log(`  ✅ ${t("setup.claudeLoginOk")}`);
          } catch {
            console.log(`  ⚠️  ${t("setup.claudeLoginFailed")}`);
          }
        } catch {
          console.log(`  ❌ ${t("setup.claudeInstallFailed")}`);
        }
      } else {
        console.log(`  ℹ️  ${t("setup.claudeSkipped")}`);
      }
    }
  }

  // Get API key if needed
  let providerApiKey = "";
  if (provider.envKey) {
    console.log(`\n${t("setup.apiKeyPrompt")} ${provider.name}:`);
    console.log(`   ${t("setup.signupFree")} ${provider.signup}`);
    console.log(`   ${t("setup.noCreditCard")}\n`);
    providerApiKey = (await ask(`${provider.envKey}: `)).trim();

    if (!providerApiKey) {
      console.log(`\n  ❌  No API key provided for ${provider.name}.`);
      console.log(`  The bot CANNOT work without an API key for your chosen provider.`);
      console.log(`  Get one free at: ${provider.signup}\n`);
      const retry = (await ask(`  Enter API key (or press Enter to switch to Groq): `)).trim();
      if (retry) {
        providerApiKey = retry;
      } else if (provider.key !== "groq") {
        console.log(`  ℹ️  Switching to Groq (free) as primary provider.`);
        provider = PROVIDERS[0]; // Switch to Groq
        console.log(`  Get a free Groq key at: https://console.groq.com\n`);
        providerApiKey = (await ask(`  GROQ_API_KEY: `)).trim();
        if (!providerApiKey) {
          console.log(`\n  ❌  Cannot continue without at least one API key.`);
          rl.close();
          return;
        }
      } else {
        console.log(`\n  ❌  Cannot continue without at least one API key.`);
        rl.close();
        return;
      }
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

  const envLines = [
    "# === Telegram ===",
    `BOT_TOKEN=${botToken}`,
    `ALLOWED_USERS=${userId}`,
    "",
    "# === AI Provider ===",
    `PRIMARY_PROVIDER=${provider.key}`,
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
  envLines.push("WORKING_DIR=~");
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
      rl.close();
      return;
    }
  }

  // ── Summary
  const providerInfo = provider.needsCLI && !hasClaude
    ? `\n  ⚠️  ${t("setup.claudeMissing")}\n`
    : "";

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

  rl.close();
}

// ── Doctor ──────────────────────────────────────────────────────────────────

async function doctor() {
  console.log(`${t("doctor.title")}\n`);

  try {
    const v = execSync("node --version", { encoding: "utf-8" }).trim();
    console.log(`  ✅ Node.js ${v}`);
  } catch {
    console.log("  ❌ Node.js not found");
  }

  try {
    execSync("claude --version", { encoding: "utf-8", stdio: "pipe" });
    console.log(`  ✅ ${t("doctor.claudeCli")}`);
  } catch {
    console.log(`  ⚠️  ${t("doctor.claudeCliMissing")}`);
  }

  // Check .env — prefer ~/.alvin-bot/.env, fallback to cwd
  const dataEnvPath = resolve(DATA_DIR, ".env");
  const cwdEnvPath = resolve(process.cwd(), ".env");
  const envPath = existsSync(dataEnvPath) ? dataEnvPath : existsSync(cwdEnvPath) ? cwdEnvPath : null;

  if (envPath) {
    console.log(`  ✅ .env found: ${envPath}`);
    const env = readFileSync(envPath, "utf-8");
    const check = (key) => env.includes(`${key}=`) && !env.match(new RegExp(`${key}=\\s*$`, 'm'));

    // Validate BOT_TOKEN format
    const tokenMatch = env.match(/BOT_TOKEN=(.+)/);
    const token = tokenMatch?.[1]?.trim();
    if (!token) {
      console.log(`  ❌ BOT_TOKEN is missing`);
    } else if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
      console.log(`  ⚠️  BOT_TOKEN format looks wrong (expected: 123456:ABCdef...)`);
    } else {
      console.log(`  ✅ BOT_TOKEN`);
    }

    // Validate ALLOWED_USERS
    const usersMatch = env.match(/ALLOWED_USERS=(.+)/);
    const usersRaw = usersMatch?.[1]?.trim();
    if (!usersRaw) {
      console.log(`  ❌ ALLOWED_USERS is missing`);
    } else {
      const ids = usersRaw.split(",").map(s => s.trim());
      const invalid = ids.filter(id => !/^\d+$/.test(id));
      if (invalid.length > 0) {
        console.log(`  ⚠️  ALLOWED_USERS has non-numeric values: ${invalid.join(", ")}`);
      } else {
        console.log(`  ✅ ALLOWED_USERS (${ids.length} user${ids.length > 1 ? "s" : ""})`);
      }
    }

    console.log(`  ${check("PRIMARY_PROVIDER") ? "✅" : "⚠️ "} PRIMARY_PROVIDER`);

    const keys = ["GROQ_API_KEY", "NVIDIA_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
    const setKeys = keys.filter(k => check(k));
    if (setKeys.length > 0) {
      console.log(`  ✅ API Keys: ${setKeys.map(k => k.replace("_API_KEY", "")).join(", ")}`);
    } else {
      const primary = env.match(/PRIMARY_PROVIDER=(.+)/)?.[1]?.trim();
      if (primary === "claude-sdk") {
        console.log(`  ℹ️  ${t("doctor.claudeSdkNote")}`);
      } else {
        console.log(`  ⚠️  ${t("doctor.noApiKeys")}`);
      }
    }
  } else {
    console.log(`  ❌ No .env found (checked ${dataEnvPath} and ${cwdEnvPath})`);
    console.log(`     Run 'alvin-bot setup' to create one.`);
  }

  // Check build — in BOT_ROOT (npm global) or cwd (dev)
  const distPaths = [
    resolve(process.cwd(), "dist/index.js"),
    resolve(import.meta.dirname || ".", "../dist/index.js"),
  ];
  if (distPaths.some(p => existsSync(p))) {
    console.log(`  ✅ ${t("doctor.buildPresent")}`);
  } else {
    console.log(`  ❌ ${t("doctor.buildMissing")}`);
  }

  if (existsSync(resolve(DATA_DIR, "soul.md")) || existsSync(resolve(process.cwd(), "SOUL.md"))) {
    console.log(`  ✅ ${t("doctor.soul")}`);
  } else {
    console.log(`  ⚠️  ${t("doctor.soulMissing")}`);
  }

  const pluginsDir = resolve(process.cwd(), "plugins");
  if (existsSync(pluginsDir)) {
    try {
      const { readdirSync, statSync } = await import("fs");
      const plugins = readdirSync(pluginsDir).filter(d => statSync(resolve(pluginsDir, d)).isDirectory());
      console.log(`  ✅ Plugins: ${plugins.length} (${plugins.join(", ")})`);
    } catch {
      console.log("  ⚠️  Plugin directory not readable");
    }
  }

  const envContent = envPath ? readFileSync(envPath, "utf-8") : "";
  if (envContent.includes("WHATSAPP_ENABLED=true")) {
    const chromePaths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome", "/usr/bin/chromium",
    ];
    const hasChrome = chromePaths.some(p => existsSync(p));
    const chromeStatus = hasChrome ? t("doctor.chromeFound") : t("doctor.chromeNotFound");
    console.log(`  ${hasChrome ? "✅" : "⚠️ "} WhatsApp (Chrome: ${chromeStatus})`);
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
  case "start":
    import("../dist/index.js");
    break;
  case "tui":
  case "chat":
    import("../dist/tui/index.js").then(m => m.startTUI()).catch(console.error);
    break;
  case "version":
  case "--version":
  case "-v":
    version();
    break;
  default:
    console.log(`
${t("cli.title")}

${t("cli.commands")}
  setup     ${t("cli.setup")}
  tui       ${t("cli.tui")}
  chat      ${t("cli.chatAlias")}
  doctor    ${t("cli.doctorDesc")}
  update    ${t("cli.updateDesc")}
  start     ${t("cli.startDesc")}
  version   ${t("cli.versionDesc")}

${t("cli.example")}
  alvin-bot setup
  alvin-bot tui
  alvin-bot tui --lang de
`);
}
