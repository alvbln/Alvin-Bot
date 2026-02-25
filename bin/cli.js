#!/usr/bin/env node

/**
 * Mr. Levin CLI — Setup, manage, and chat with your AI agent.
 *
 * Usage:
 *   npx mr-levin setup    — Interactive setup wizard
 *   npx mr-levin tui      — Terminal chat UI
 *   npx mr-levin doctor   — Check configuration
 *   npx mr-levin update   — Pull latest & rebuild
 *   npx mr-levin start    — Start the bot
 */

import { createInterface } from "readline";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

const LOGO = `
  ╔══════════════════════════════════════╗
  ║  🤖 Mr. Levin — Setup Wizard v3.0  ║
  ║  Your Personal AI Agent             ║
  ╚══════════════════════════════════════╝
`;

// ── Provider Definitions ────────────────────────────────────────────────────

const PROVIDERS = [
  {
    key: "groq",
    name: "Groq (Llama 3.3 70B)",
    desc: "Extrem schnell, kostenlos, guter Allrounder",
    free: true,
    envKey: "GROQ_API_KEY",
    signup: "https://console.groq.com",
    model: "llama-3.3-70b-versatile",
    needsCLI: false,
  },
  {
    key: "nvidia-llama-3.3-70b",
    name: "NVIDIA NIM (Llama 3.3 70B)",
    desc: "Kostenlos, schnell, gehostet bei NVIDIA",
    free: true,
    envKey: "NVIDIA_API_KEY",
    signup: "https://build.nvidia.com",
    model: "meta/llama-3.3-70b-instruct",
    needsCLI: false,
  },
  {
    key: "google",
    name: "Google Gemini",
    desc: "Gemini 2.5 Flash/Pro, kostenloser Tier verfügbar",
    free: true,
    envKey: "GOOGLE_API_KEY",
    signup: "https://aistudio.google.com",
    model: "gemini-2.5-flash",
    needsCLI: false,
  },
  {
    key: "openai",
    name: "OpenAI (GPT-4o)",
    desc: "GPT-4o, kostenpflichtig (pay-per-use)",
    free: false,
    envKey: "OPENAI_API_KEY",
    signup: "https://platform.openai.com",
    model: "gpt-4o",
    needsCLI: false,
  },
  {
    key: "openrouter",
    name: "OpenRouter (100+ Modelle)",
    desc: "Zugang zu Claude, GPT-4, Llama, Mistral und mehr",
    free: false,
    envKey: "OPENROUTER_API_KEY",
    signup: "https://openrouter.ai",
    model: "anthropic/claude-sonnet-4",
    needsCLI: false,
  },
  {
    key: "claude-sdk",
    name: "Claude Agent SDK (Premium)",
    desc: "Voller Agent mit Tool Use (Bash, Dateien, Web) — braucht Claude Max ($200/Mo)",
    free: false,
    envKey: null, // Uses CLI auth
    signup: "https://claude.ai",
    model: "claude-sonnet-4-20250514",
    needsCLI: true,
  },
];

// ── Setup Wizard ────────────────────────────────────────────────────────────

async function setup() {
  console.log(LOGO);

  // ── Prerequisites ──────────────────────────────────────────────────────
  console.log("🔍 Voraussetzungen prüfen...\n");

  let hasNode = false;
  try {
    const nodeVersion = execSync("node --version", { encoding: "utf-8" }).trim();
    const major = parseInt(nodeVersion.slice(1));
    hasNode = major >= 18;
    console.log(`  ${hasNode ? "✅" : "❌"} Node.js ${nodeVersion}${major < 18 ? " (brauche ≥18!)" : ""}`);
  } catch {
    console.log("  ❌ Node.js nicht gefunden — installieren: https://nodejs.org");
  }

  if (!hasNode) {
    console.log("\n❌ Node.js ≥ 18 wird benötigt. Bitte zuerst installieren.");
    rl.close();
    return;
  }

  // ── Step 1: Telegram Bot ──────────────────────────────────────────────
  console.log("\n━━━ Schritt 1: Telegram Bot ━━━");
  console.log("Erstelle einen Bot bei https://t.me/BotFather");
  console.log("Sende /newbot, folge den Schritten, kopiere den Token.\n");
  const botToken = (await ask("Bot Token: ")).trim();

  if (!botToken) {
    console.log("❌ Bot Token ist erforderlich.");
    rl.close();
    return;
  }

  // ── Step 2: User ID ───────────────────────────────────────────────────
  console.log("\n━━━ Schritt 2: Deine Telegram User ID ━━━");
  console.log("Bekomme sie von https://t.me/userinfobot\n");
  const userId = (await ask("Deine User ID: ")).trim();

  if (!userId) {
    console.log("❌ User ID ist erforderlich.");
    rl.close();
    return;
  }

  // ── Step 3: AI Provider ───────────────────────────────────────────────
  console.log("\n━━━ Schritt 3: AI Provider wählen ━━━");
  console.log("Welchen AI-Dienst möchtest du nutzen?\n");

  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[i];
    const badge = p.free ? "🆓" : "💰";
    const premium = p.needsCLI ? " ⭐" : "";
    console.log(`  ${i + 1}. ${badge} ${p.name}${premium}`);
    console.log(`     ${p.desc}`);
    if (p.signup) console.log(`     → ${p.signup}`);
    console.log("");
  }

  const providerChoice = parseInt((await ask("Deine Wahl (1-6): ")).trim()) || 1;
  const provider = PROVIDERS[Math.max(0, Math.min(providerChoice - 1, PROVIDERS.length - 1))];

  console.log(`\n✅ Provider: ${provider.name}`);

  // Check Claude CLI if needed
  let hasClaude = false;
  if (provider.needsCLI) {
    try {
      execSync("claude --version", { encoding: "utf-8", stdio: "pipe" });
      hasClaude = true;
      console.log("  ✅ Claude CLI installiert");
    } catch {
      console.log("  ⚠️  Claude CLI nicht gefunden!");
      console.log("     Installieren: npm i -g @anthropic-ai/claude-code");
      console.log("     Dann: claude login");
      console.log("     Du kannst den Bot trotzdem starten — er nutzt dann Text-only Mode.");
    }
  }

  // Get API key if needed
  let providerApiKey = "";
  if (provider.envKey) {
    console.log(`\n📋 API Key für ${provider.name}:`);
    console.log(`   Kostenlos registrieren: ${provider.signup}\n`);
    providerApiKey = (await ask(`${provider.envKey}: `)).trim();

    if (!providerApiKey) {
      console.log("  ⚠️  Ohne API Key kann dieser Provider nicht genutzt werden.");
    }
  }

  // ── Step 4: Optional extras ───────────────────────────────────────────
  console.log("\n━━━ Schritt 4: Extras (optional, Enter zum Überspringen) ━━━\n");

  let groqKey = "";
  if (provider.key !== "groq") {
    groqKey = (await ask("Groq API Key (für Spracheingabe, kostenlos @ console.groq.com): ")).trim();
  } else {
    groqKey = providerApiKey; // Already have it
  }

  const webPassword = (await ask("Web UI Passwort (leer = kein Schutz): ")).trim();

  // ── Step 5: Platform choice ───────────────────────────────────────────
  console.log("\n━━━ Schritt 5: Plattformen ━━━");
  console.log("Telegram ist automatisch dabei. Weitere Plattformen?\n");
  console.log("  1. Nur Telegram (Standard)");
  console.log("  2. + WhatsApp (braucht Chrome/Chromium)");
  console.log("  3. Später konfigurieren (via Web UI)\n");

  const platformChoice = parseInt((await ask("Deine Wahl (1-3): ")).trim()) || 1;
  const enableWhatsApp = platformChoice === 2;

  // ── Write .env ────────────────────────────────────────────────────────
  console.log("\n📝 Konfiguration schreiben...");

  const envLines = [
    "# === Telegram ===",
    `BOT_TOKEN=${botToken}`,
    `ALLOWED_USERS=${userId}`,
    "",
    "# === AI Provider ===",
    `PRIMARY_PROVIDER=${provider.key}`,
  ];

  // Provider-specific keys
  if (provider.envKey && providerApiKey) {
    envLines.push(`${provider.envKey}=${providerApiKey}`);
  }

  // Fallback providers (add free ones the user didn't pick)
  const fallbacks = [];
  if (provider.key !== "groq" && groqKey) {
    envLines.push(`GROQ_API_KEY=${groqKey}`);
    fallbacks.push("groq");
  }
  if (provider.key === "groq" && groqKey) {
    // groqKey already set as provider key
  }
  if (fallbacks.length > 0) {
    envLines.push(`FALLBACK_PROVIDERS=${fallbacks.join(",")}`);
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

  // Backup existing .env
  if (existsSync(envPath)) {
    const backup = `${envPath}.backup-${Date.now()}`;
    writeFileSync(backup, readFileSync(envPath));
    console.log(`  📋 Backup: ${backup}`);
  }

  writeFileSync(envPath, envContent);
  console.log(`  ✅ .env geschrieben`);

  // Create SOUL.md if not exists
  const soulPath = resolve(process.cwd(), "SOUL.md");
  if (!existsSync(soulPath)) {
    writeFileSync(soulPath, `# SOUL.md — Bot Persönlichkeit

> Editiere diese Datei um die Persönlichkeit deines Bots anzupassen.
> Wird beim Start geladen und in jeden System-Prompt injiziert.

## Wer bin ich?

Ich bin ein autonomer KI-Assistent. Direkt, hilfreich, mit eigenem Charakter.

## Wie ich kommuniziere

- Direkt und ehrlich — kein Gelaber
- Mit Humor — trockener Witz hier und da
- Auf Augenhöhe — kompetenter Freund, nicht unterwürfiger Butler
- Deutsch ist Standard, Englisch wenn der User Englisch schreibt

## Meine Prinzipien

- Erst machen, dann erklären
- Fehler sofort zugeben
- Meinungen haben und äußern
- Privatsphäre respektieren
`);
    console.log("  ✅ SOUL.md erstellt (Persönlichkeit anpassbar)");
  }

  // Create docs directory
  const docsDir = resolve(process.cwd(), "docs");
  const memoryDir = resolve(docsDir, "memory");
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  // ── Build ─────────────────────────────────────────────────────────────
  console.log("\n🔨 Building...");
  try {
    execSync("npm run build", { stdio: "inherit" });
    console.log("  ✅ Build erfolgreich");
  } catch {
    console.log("  ❌ Build fehlgeschlagen — siehe Fehler oben");
  }

  // ── Summary ───────────────────────────────────────────────────────────
  const providerInfo = provider.needsCLI && !hasClaude
    ? `\n  ⚠️  Claude CLI fehlt — installiere sie für vollen Agent-Modus:\n      npm i -g @anthropic-ai/claude-code && claude login\n`
    : "";

  console.log(`
━━━ Setup Abgeschlossen! ━━━

  🤖 Provider: ${provider.name}
  💬 Telegram: @... (prüfe bei @BotFather)
  🌐 Web UI: http://localhost:3100${webPassword ? " (passwortgeschützt)" : ""}
${enableWhatsApp ? "  📱 WhatsApp: Scan QR code in Web UI → Platforms\n" : ""}${providerInfo}
Starten:
  npm run dev                       (Entwicklung, Hot Reload)
  npm start                         (Produktion)
  pm2 start ecosystem.config.cjs    (Produktion mit Auto-Restart)

Befehle im Bot:
  /help     — Alle Befehle anzeigen
  /model    — AI-Modell wechseln
  /effort   — Denktiefe einstellen
  /imagine  — Bilder generieren
  /web      — Web-Suche
  /cron     — Geplante Aufgaben

Viel Spaß! 🤖
`);

  rl.close();
}

// ── Doctor ──────────────────────────────────────────────────────────────────

async function doctor() {
  console.log("🩺 Mr. Levin — Health Check\n");

  // Node
  try {
    const v = execSync("node --version", { encoding: "utf-8" }).trim();
    console.log(`  ✅ Node.js ${v}`);
  } catch {
    console.log("  ❌ Node.js nicht gefunden");
  }

  // Claude CLI (optional)
  try {
    execSync("claude --version", { encoding: "utf-8", stdio: "pipe" });
    console.log("  ✅ Claude CLI (Agent SDK verfügbar)");
  } catch {
    console.log("  ⚠️  Claude CLI nicht installiert (optional — nur für Agent-Modus)");
  }

  // .env
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const env = readFileSync(envPath, "utf-8");
    const check = (key) => env.includes(`${key}=`) && !env.match(new RegExp(`${key}=\\s*$`, 'm'));
    console.log(`  ${check("BOT_TOKEN") ? "✅" : "❌"} BOT_TOKEN`);
    console.log(`  ${check("ALLOWED_USERS") ? "✅" : "❌"} ALLOWED_USERS`);
    console.log(`  ${check("PRIMARY_PROVIDER") ? "✅" : "⚠️ "} PRIMARY_PROVIDER`);

    // Check which provider keys are set
    const keys = ["GROQ_API_KEY", "NVIDIA_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
    const setKeys = keys.filter(k => check(k));
    if (setKeys.length > 0) {
      console.log(`  ✅ API Keys: ${setKeys.map(k => k.replace("_API_KEY", "")).join(", ")}`);
    } else {
      // Check if claude-sdk is primary (doesn't need key)
      const primary = env.match(/PRIMARY_PROVIDER=(.+)/)?.[1]?.trim();
      if (primary === "claude-sdk") {
        console.log("  ℹ️  Provider: Claude SDK (nutzt CLI Auth, kein API Key nötig)");
      } else {
        console.log("  ⚠️  Keine API Keys gesetzt — mindestens einen Provider konfigurieren!");
      }
    }
  } else {
    console.log("  ❌ .env nicht gefunden — starte: node bin/cli.js setup");
  }

  // Build
  if (existsSync(resolve(process.cwd(), "dist/index.js"))) {
    console.log("  ✅ Build vorhanden (dist/)");
  } else {
    console.log("  ❌ Nicht gebaut — starte: npm run build");
  }

  // SOUL.md
  if (existsSync(resolve(process.cwd(), "SOUL.md"))) {
    console.log("  ✅ SOUL.md (Persönlichkeit)");
  } else {
    console.log("  ⚠️  SOUL.md fehlt — Standard-Persönlichkeit wird genutzt");
  }

  // Plugins
  const pluginsDir = resolve(process.cwd(), "plugins");
  if (existsSync(pluginsDir)) {
    try {
      const { readdirSync, statSync } = await import("fs");
      const plugins = readdirSync(pluginsDir).filter(d => statSync(resolve(pluginsDir, d)).isDirectory());
      console.log(`  ✅ Plugins: ${plugins.length} (${plugins.join(", ")})`);
    } catch {
      console.log("  ⚠️  Plugin-Verzeichnis nicht lesbar");
    }
  }

  // WhatsApp
  const envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  if (envContent.includes("WHATSAPP_ENABLED=true")) {
    const chromePaths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome", "/usr/bin/chromium",
    ];
    const hasChrome = chromePaths.some(p => existsSync(p));
    console.log(`  ${hasChrome ? "✅" : "⚠️ "} WhatsApp (Chrome: ${hasChrome ? "gefunden" : "nicht gefunden"})`);
  }

  console.log("");
}

// ── Update ──────────────────────────────────────────────────────────────────

async function update() {
  console.log("🔄 Mr. Levin aktualisieren...\n");

  try {
    const isGit = existsSync(resolve(process.cwd(), ".git"));

    if (isGit) {
      console.log("  📥 Neueste Änderungen laden...");
      execSync("git pull", { stdio: "inherit" });
      console.log("\n  📦 Abhängigkeiten installieren...");
      execSync("npm install", { stdio: "inherit" });
      console.log("\n  🔨 Building...");
      execSync("npm run build", { stdio: "inherit" });
      console.log("\n  ✅ Update abgeschlossen!");
      console.log("  Neustarten mit: pm2 restart alvin-bot");
    } else {
      console.log("  📦 Update via npm...");
      execSync("npm update mr-levin", { stdio: "inherit" });
      console.log("\n  ✅ Update abgeschlossen!");
    }
  } catch (err) {
    console.error(`\n  ❌ Update fehlgeschlagen: ${err.message}`);
  }
}

// ── Version ─────────────────────────────────────────────────────────────────

async function version() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname || ".", "../package.json"), "utf-8"));
    console.log(`Mr. Levin v${pkg.version}`);
  } catch {
    console.log("Mr. Levin (version unknown)");
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
🤖 Mr. Levin CLI

Befehle:
  setup     Interaktiver Setup-Wizard
  tui       Terminal Chat UI  ✨
  chat      Alias für tui
  doctor    Konfiguration prüfen
  update    Aktualisieren & neu bauen
  start     Bot starten
  version   Version anzeigen

Beispiel:
  node bin/cli.js setup
  node bin/cli.js tui
`);
}
