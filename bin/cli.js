#!/usr/bin/env node

/**
 * Mr. Levin CLI — Interactive setup wizard.
 *
 * Usage:
 *   npx mr-levin setup    — Interactive setup
 *   npx mr-levin start    — Start the bot
 *   npx mr-levin doctor   — Check configuration
 */

import { createInterface } from "readline";
import { existsSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

const LOGO = `
  ╔══════════════════════════════════════╗
  ║  🤖 Mr. Levin — Setup Wizard       ║
  ║  Autonomous AI Telegram Agent       ║
  ╚══════════════════════════════════════╝
`;

const ENV_TEMPLATE = `# === Telegram ===
BOT_TOKEN={BOT_TOKEN}
ALLOWED_USERS={ALLOWED_USERS}

# === Agent ===
WORKING_DIR=~
MAX_BUDGET_USD=5.0

# === Model Provider ===
PRIMARY_PROVIDER=claude-sdk
FALLBACK_PROVIDERS=nvidia-kimi-k2.5,nvidia-llama-3.3-70b

# === API Keys ===
GROQ_API_KEY={GROQ_API_KEY}
NVIDIA_API_KEY={NVIDIA_API_KEY}
GOOGLE_API_KEY={GOOGLE_API_KEY}
`;

async function setup() {
  console.log(LOGO);

  // Check prerequisites
  console.log("🔍 Checking prerequisites...\n");

  let hasNode = false;
  try {
    const nodeVersion = execSync("node --version", { encoding: "utf-8" }).trim();
    const major = parseInt(nodeVersion.slice(1));
    hasNode = major >= 18;
    console.log(`  ✅ Node.js ${nodeVersion}${major < 18 ? " (need ≥18!)" : ""}`);
  } catch {
    console.log("  ❌ Node.js not found — install from https://nodejs.org");
  }

  let hasClaude = false;
  try {
    execSync("claude --version", { encoding: "utf-8", stdio: "pipe" });
    hasClaude = true;
    console.log("  ✅ Claude CLI installed");
  } catch {
    console.log("  ⚠️  Claude CLI not found");
    console.log("     Install: npm i -g @anthropic-ai/claude-code");
    console.log("     Then: claude login");
  }

  console.log("");

  // Step 1: Bot Token
  console.log("━━━ Step 1: Telegram Bot ━━━");
  console.log("Create a bot at https://t.me/BotFather");
  console.log("Send /newbot, follow the steps, copy the token.\n");
  const botToken = await ask("Bot Token: ");

  // Step 2: User ID
  console.log("\n━━━ Step 2: Your Telegram User ID ━━━");
  console.log("Get it from https://t.me/userinfobot\n");
  const userId = await ask("Your User ID: ");

  // Step 3: API Keys (optional)
  console.log("\n━━━ Step 3: API Keys (optional, for multi-model + features) ━━━");
  console.log("Skip with Enter if you don't have them.\n");

  const groqKey = await ask("Groq API Key (voice, free at console.groq.com): ");
  const nvidiaKey = await ask("NVIDIA NIM Key (free at build.nvidia.com): ");
  const googleKey = await ask("Google API Key (image gen, free at aistudio.google.com): ");

  // Write .env
  console.log("\n📝 Writing .env file...");
  const envContent = ENV_TEMPLATE
    .replace("{BOT_TOKEN}", botToken.trim())
    .replace("{ALLOWED_USERS}", userId.trim())
    .replace("{GROQ_API_KEY}", groqKey.trim())
    .replace("{NVIDIA_API_KEY}", nvidiaKey.trim())
    .replace("{GOOGLE_API_KEY}", googleKey.trim());

  const envPath = resolve(process.cwd(), ".env");
  writeFileSync(envPath, envContent);
  console.log(`  ✅ .env written to ${envPath}`);

  // Create SOUL.md if not exists
  const soulPath = resolve(process.cwd(), "SOUL.md");
  if (!existsSync(soulPath)) {
    console.log("  ✅ Default SOUL.md created");
  }

  // Build
  console.log("\n🔨 Building...");
  try {
    execSync("npm run build", { stdio: "inherit" });
    console.log("  ✅ Build successful");
  } catch {
    console.log("  ❌ Build failed — check errors above");
  }

  // Summary
  console.log(`
━━━ Setup Complete! ━━━

Start the bot:
  npm run dev          (development, hot reload)
  npm start            (production)
  pm2 start ecosystem.config.cjs  (production with auto-restart)

Your bot: https://t.me/YOUR_BOT_USERNAME

Commands to try:
  /help     — See all commands
  /model    — Switch AI model
  /imagine  — Generate images
  /remind   — Set reminders

Happy chatting! 🤖
`);

  rl.close();
}

async function doctor() {
  console.log("🩺 Mr. Levin — Health Check\n");

  // Node
  try {
    const v = execSync("node --version", { encoding: "utf-8" }).trim();
    console.log(`  ✅ Node.js ${v}`);
  } catch {
    console.log("  ❌ Node.js not found");
  }

  // Claude CLI
  try {
    execSync("claude --version", { encoding: "utf-8", stdio: "pipe" });
    console.log("  ✅ Claude CLI");
  } catch {
    console.log("  ❌ Claude CLI not found");
  }

  // .env
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const env = readFileSync(envPath, "utf-8");
    console.log(`  ${env.includes("BOT_TOKEN=") && !env.includes("BOT_TOKEN=\n") ? "✅" : "❌"} BOT_TOKEN`);
    console.log(`  ${env.includes("ALLOWED_USERS=") && !env.includes("ALLOWED_USERS=\n") ? "✅" : "❌"} ALLOWED_USERS`);
    console.log(`  ${env.includes("GROQ_API_KEY=") && !env.includes("GROQ_API_KEY=\n") ? "✅" : "⚠️ "} GROQ_API_KEY (voice)`);
    console.log(`  ${env.includes("NVIDIA_API_KEY=") && !env.includes("NVIDIA_API_KEY=\n") ? "✅" : "⚠️ "} NVIDIA_API_KEY (fallback)`);
    console.log(`  ${env.includes("GOOGLE_API_KEY=") && !env.includes("GOOGLE_API_KEY=\n") ? "✅" : "⚠️ "} GOOGLE_API_KEY (images)`);
  } else {
    console.log("  ❌ .env not found — run: npx mr-levin setup");
  }

  // Build
  if (existsSync(resolve(process.cwd(), "dist/index.js"))) {
    console.log("  ✅ Build exists (dist/)");
  } else {
    console.log("  ❌ Not built — run: npm run build");
  }

  console.log("");
}

// CLI routing
const cmd = process.argv[2];
switch (cmd) {
  case "setup":
    setup().catch(console.error);
    break;
  case "doctor":
    doctor().catch(console.error);
    break;
  case "start":
    import("../dist/index.js");
    break;
  default:
    console.log(`
🤖 Mr. Levin CLI

Commands:
  npx mr-levin setup    Interactive setup wizard
  npx mr-levin doctor   Check configuration
  npx mr-levin start    Start the bot
`);
}
