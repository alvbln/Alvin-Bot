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
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import { initI18n, t, getLocale } from "../dist/i18n.js";

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

  // ── Step 2: User ID
  console.log(`\n━━━ ${t("setup.step2")} ━━━`);
  console.log(t("setup.step2.intro") + "\n");
  const userId = (await ask(t("setup.userId"))).trim();

  if (!userId) {
    console.log(`❌ ${t("setup.userIdRequired")}`);
    rl.close();
    return;
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
  const provider = PROVIDERS[Math.max(0, Math.min(providerChoice - 1, PROVIDERS.length - 1))];

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
      console.log(`  ⚠️  ${t("setup.noApiKey")}`);
      if (provider.key !== "groq") {
        console.log(`  ℹ️  ${t("setup.groqFallbackNote")}`);
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
  const envPath = resolve(process.cwd(), ".env");

  if (existsSync(envPath)) {
    const backup = `${envPath}.backup-${Date.now()}`;
    writeFileSync(backup, readFileSync(envPath));
    console.log(`  ${t("setup.backup")} ${backup}`);
  }

  writeFileSync(envPath, envContent);
  console.log(`  ✅ ${t("setup.envWritten")}`);

  // Create SOUL.md if not exists
  const soulPath = resolve(process.cwd(), "SOUL.md");
  if (!existsSync(soulPath)) {
    writeFileSync(soulPath, t("soul.default"));
    console.log(`  ✅ ${t("setup.soulCreated")}`);
  }

  // Create docs directory
  const docsDir = resolve(process.cwd(), "docs");
  const memoryDir = resolve(docsDir, "memory");
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  // ── Build
  console.log(`\n${t("setup.building")}`);
  try {
    execSync("npm run build", { stdio: "inherit" });
    console.log(`  ✅ ${t("setup.buildOk")}`);
  } catch {
    console.log(`  ❌ ${t("setup.buildFailed")}`);
  }

  // ── Summary
  const providerInfo = provider.needsCLI && !hasClaude
    ? `\n  ⚠️  ${t("setup.claudeMissing")}\n`
    : "";

  console.log(`
━━━ ${t("setup.done")} ━━━

  🤖 Provider: ${provider.name}
  💬 Telegram: @... (check @BotFather)
  🌐 Web UI: http://localhost:3100${webPassword ? ` (${t("setup.passwordProtected")})` : ""}
${enableWhatsApp ? `  📱 ${t("setup.scanQr")}\n` : ""}${providerInfo}
Start:
  npm run dev                       (development, hot reload)
  npm start                         (production)
  pm2 start ecosystem.config.cjs    (production, auto-restart)

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

  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const env = readFileSync(envPath, "utf-8");
    const check = (key) => env.includes(`${key}=`) && !env.match(new RegExp(`${key}=\\s*$`, 'm'));
    console.log(`  ${check("BOT_TOKEN") ? "✅" : "❌"} BOT_TOKEN`);
    console.log(`  ${check("ALLOWED_USERS") ? "✅" : "❌"} ALLOWED_USERS`);
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
    console.log(`  ❌ ${t("doctor.noEnv")}`);
  }

  if (existsSync(resolve(process.cwd(), "dist/index.js"))) {
    console.log(`  ✅ ${t("doctor.buildPresent")}`);
  } else {
    console.log(`  ❌ ${t("doctor.buildMissing")}`);
  }

  if (existsSync(resolve(process.cwd(), "SOUL.md"))) {
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

  const envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
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
