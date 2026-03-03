/**
 * Alvin Bot — Internationalization (i18n)
 *
 * Simple key-based translation system.
 * Default: English. Supported: en, de.
 *
 * Detection order:
 *   1. --lang <en|de> CLI flag
 *   2. ALVIN_LANG env var
 *   3. LANG env var (e.g. de_DE.UTF-8 → de)
 *   4. Default: en
 */

export type Locale = "en" | "de";

const strings: Record<string, Record<Locale, string>> = {
  // ── TUI ───────────────────────────────────────────────
  "tui.title": { en: "🤖 Alvin Bot TUI", de: "🤖 Alvin Bot TUI" },
  "tui.connected": { en: "Connected", de: "Verbunden" },
  "tui.disconnected": { en: "Disconnected", de: "Getrennt" },
  "tui.connecting": { en: "Connecting to", de: "Verbinde mit" },
  "tui.connectedTo": { en: "Connected to Alvin Bot", de: "Verbunden mit Alvin Bot" },
  "tui.connectionLost": { en: "Connection lost. Reconnecting in 3s...", de: "Verbindung verloren. Reconnect in 3s..." },
  "tui.notConnected": { en: "Not connected. Waiting for reconnect...", de: "Nicht verbunden. Warte auf Reconnect..." },
  "tui.you": { en: "You", de: "Du" },
  "tui.bye": { en: "Bye! 👋", de: "Tschüss! 👋" },
  "tui.scanning": { en: "Scanning...", de: "Scanne..." },
  "tui.creatingBackup": { en: "Creating backup...", de: "Erstelle Backup..." },
  "tui.restartTriggered": { en: "Restart triggered. Reconnecting in 3s...", de: "Restart ausgelöst. Reconnect in 3s..." },
  "tui.restartFailed": { en: "Could not send restart command", de: "Restart-Befehl konnte nicht gesendet werden" },
  "tui.botRestarting": { en: "Bot is restarting...", de: "Bot wird neugestartet..." },
  "tui.sessionReset": { en: "Session reset", de: "Session zurückgesetzt" },
  "tui.toolsUsed": { en: "tools used", de: "Tools genutzt" },
  "tui.toolUsed": { en: "tool used", de: "Tool genutzt" },
  "tui.switchModel": { en: "Switch model:", de: "Model wechseln:" },
  "tui.active": { en: "active", de: "aktiv" },
  "tui.switchedTo": { en: "Switched model to", de: "Model gewechselt zu" },
  "tui.switchError": { en: "Error switching model", de: "Fehler beim Wechseln" },
  "tui.modelsError": { en: "Could not load models", de: "Konnte Models nicht laden" },
  "tui.statusError": { en: "Status unavailable", de: "Status nicht verfügbar" },
  "tui.cronError": { en: "Cron unavailable", de: "Cron nicht verfügbar" },
  "tui.doctorError": { en: "Doctor unavailable", de: "Doctor nicht verfügbar" },
  "tui.backupCreated": { en: "Backup created", de: "Backup erstellt" },
  "tui.backupFailed": { en: "Backup failed", de: "Backup fehlgeschlagen" },
  "tui.backupError": { en: "Backup error", de: "Backup-Fehler" },
  "tui.noCronJobs": { en: "No cron jobs configured.", de: "Keine Cron-Jobs konfiguriert." },
  "tui.fallback": { en: "Fallback:", de: "Fallback:" },
  "tui.models": { en: "Models", de: "Models" },

  // ── TUI Help ──────────────────────────────────────────
  "help.title": { en: "Commands:", de: "Befehle:" },
  "help.model": { en: "Switch model", de: "Model wechseln" },
  "help.status": { en: "Show bot status", de: "Bot-Status anzeigen" },
  "help.clear": { en: "Clear chat", de: "Chat löschen" },
  "help.cron": { en: "Show cron jobs", de: "Cron-Jobs anzeigen" },
  "help.doctor": { en: "Health check", de: "Health-Check" },
  "help.backup": { en: "Create backup", de: "Backup erstellen" },
  "help.restart": { en: "Restart bot", de: "Bot neustarten" },
  "help.help": { en: "This help", de: "Diese Hilfe" },
  "help.quit": { en: "Quit (or Ctrl+C)", de: "Beenden (oder Ctrl+C)" },
  "help.footer": { en: "Enter = Send · ↑/↓ = History · Ctrl+C = Quit", de: "Enter = Senden · ↑/↓ = History · Ctrl+C = Beenden" },

  // ── TUI Status ────────────────────────────────────────
  "status.title": { en: "Bot Status", de: "Bot Status" },
  "status.model": { en: "Model:", de: "Model:" },
  "status.provider": { en: "Provider:", de: "Provider:" },
  "status.status": { en: "Status:", de: "Status:" },
  "status.version": { en: "Version:", de: "Version:" },
  "status.uptime": { en: "Uptime:", de: "Uptime:" },
  "status.memory": { en: "Memory:", de: "Memory:" },
  "status.embeddings": { en: "Embeddings", de: "Embeddings" },
  "status.plugins": { en: "Plugins:", de: "Plugins:" },
  "status.tools": { en: "Tools:", de: "Tools:" },
  "status.users": { en: "Users:", de: "Users:" },

  // ── CLI ───────────────────────────────────────────────
  "cli.title": { en: "🤖 Alvin Bot CLI", de: "🤖 Alvin Bot CLI" },
  "cli.commands": { en: "Commands:", de: "Befehle:" },
  "cli.setup": { en: "Interactive setup wizard", de: "Interaktiver Setup-Wizard" },
  "cli.tui": { en: "Terminal chat UI  ✨", de: "Terminal Chat UI  ✨" },
  "cli.chatAlias": { en: "Alias for tui", de: "Alias für tui" },
  "cli.doctorDesc": { en: "Check configuration", de: "Konfiguration prüfen" },
  "cli.updateDesc": { en: "Update & rebuild", de: "Aktualisieren & neu bauen" },
  "cli.startDesc": { en: "Start the bot", de: "Bot starten" },
  "cli.versionDesc": { en: "Show version", de: "Version anzeigen" },
  "cli.example": { en: "Example:", de: "Beispiel:" },

  // ── Setup Wizard ──────────────────────────────────────
  "setup.checkingPrereqs": { en: "🔍 Checking prerequisites...\n", de: "🔍 Voraussetzungen prüfen...\n" },
  "setup.nodeRequired": { en: "Node.js ≥ 18 is required. Please install it first.", de: "Node.js ≥ 18 wird benötigt. Bitte zuerst installieren." },
  "setup.nodeNotFound": { en: "Node.js not found — install: https://nodejs.org", de: "Node.js nicht gefunden — installieren: https://nodejs.org" },
  "setup.needVersion": { en: "need ≥18!", de: "brauche ≥18!" },
  "setup.step1": { en: "Step 1: Telegram Bot", de: "Schritt 1: Telegram Bot" },
  "setup.step1.intro": { en: "Create a bot at https://t.me/BotFather\nSend /newbot, follow the steps, copy the token.", de: "Erstelle einen Bot bei https://t.me/BotFather\nSende /newbot, folge den Schritten, kopiere den Token." },
  "setup.botToken": { en: "Bot Token: ", de: "Bot Token: " },
  "setup.botTokenRequired": { en: "Bot Token is required.", de: "Bot Token ist erforderlich." },
  "setup.step2": { en: "Step 2: Your Telegram User ID", de: "Schritt 2: Deine Telegram User ID" },
  "setup.step2.intro": { en: "Get it from https://t.me/userinfobot", de: "Bekomme sie von https://t.me/userinfobot" },
  "setup.userId": { en: "Your User ID: ", de: "Deine User ID: " },
  "setup.userIdRequired": { en: "User ID is required.", de: "User ID ist erforderlich." },
  "setup.step3": { en: "Step 3: Choose AI Provider", de: "Schritt 3: AI Provider wählen" },
  "setup.step3.intro": { en: "Which AI service would you like to use?", de: "Welchen AI-Dienst möchtest du nutzen?" },
  "setup.yourChoice": { en: "Your choice (1-6): ", de: "Deine Wahl (1-6): " },
  "setup.providerSelected": { en: "Provider:", de: "Provider:" },
  "setup.claudeNotFound": { en: "Claude Agent SDK (CLI) not found.", de: "Claude Agent SDK (CLI) nicht gefunden." },
  "setup.installClaude": { en: "Install Claude CLI now? (y/n): ", de: "Claude CLI jetzt installieren? (j/n): " },
  "setup.installingClaude": { en: "📦 Installing @anthropic-ai/claude-code ...", de: "📦 Installiere @anthropic-ai/claude-code ..." },
  "setup.claudeInstalled": { en: "Claude CLI installed!", de: "Claude CLI installiert!" },
  "setup.claudeLogin": { en: "🔐 Logging in — this will open your browser:\n     (Requires a Claude Max subscription at $200/mo)", de: "🔐 Jetzt einloggen — dies öffnet deinen Browser:\n     (Benötigt ein Claude Max Abo für $200/Mo)" },
  "setup.claudeLoginOk": { en: "Claude login successful!", de: "Claude Login erfolgreich!" },
  "setup.claudeLoginFailed": { en: "Login cancelled/failed. Retry later: 'claude login'.", de: "Login abgebrochen/fehlgeschlagen. Später: 'claude login'." },
  "setup.claudeInstallFailed": { en: "Installation failed. Install manually:\n     npm install -g @anthropic-ai/claude-code\n     claude login", de: "Installation fehlgeschlagen. Manuell installieren:\n     npm install -g @anthropic-ai/claude-code\n     claude login" },
  "setup.claudeSkipped": { en: "No problem! Do it later:\n     npm install -g @anthropic-ai/claude-code && claude login\n     The bot starts in text-only mode without Claude CLI.", de: "Kein Problem! Später nachholen:\n     npm install -g @anthropic-ai/claude-code && claude login\n     Der Bot startet im Text-only Mode ohne Claude CLI." },
  "setup.step4": { en: "Step 4: Fallback Providers & Extras", de: "Schritt 4: Fallback-Provider & Extras" },
  "setup.groqFallback": { en: "💡 Groq is free and serves as heartbeat & fallback.\n     Sign up free: https://console.groq.com", de: "💡 Groq ist kostenlos und dient als Heartbeat & Fallback.\n     Gratis registrieren: https://console.groq.com" },
  "setup.groqKeyPrompt": { en: "Groq API Key (recommended, free): ", de: "Groq API Key (empfohlen, kostenlos): " },
  "setup.noGroqKey": { en: "Without Groq key, no auto heartbeat/fallback.\n     Add later via /setup or Web UI.", de: "Ohne Groq-Key kein automatischer Heartbeat/Fallback.\n     Später via /setup oder Web UI nachtragen." },
  "setup.extraKeys": { en: "📋 Additional API keys? (Enter to skip)", de: "📋 Weitere API Keys? (Enter zum Überspringen)" },
  "setup.nvidiaKeyPrompt": { en: "NVIDIA API Key (free @ build.nvidia.com): ", de: "NVIDIA API Key (kostenlos @ build.nvidia.com): " },
  "setup.googleKeyPrompt": { en: "Google API Key (free @ aistudio.google.com): ", de: "Google API Key (kostenlos @ aistudio.google.com): " },
  "setup.openaiKeyPrompt": { en: "OpenAI API Key (optional): ", de: "OpenAI API Key (optional): " },
  "setup.fallbackOrder": { en: "🔄 Fallback order:\n     When your primary provider fails, these are tried in sequence.", de: "🔄 Fallback-Reihenfolge:\n     Wenn dein Provider ausfällt, werden diese der Reihe nach probiert." },
  "setup.defaultOrder": { en: "Default:", de: "Standard:" },
  "setup.customOrder": { en: "Custom order? (comma-separated, Enter = default): ", de: "Andere Reihenfolge? (kommagetrennt, Enter = Standard): " },
  "setup.noFallbacks": { en: "No fallback providers configured.", de: "Keine Fallback-Provider konfiguriert." },
  "setup.webPassword": { en: "Web UI password (empty = no protection): ", de: "Web UI Passwort (leer = kein Schutz): " },
  "setup.apiKeyPrompt": { en: "📋 API Key for", de: "📋 API Key für" },
  "setup.signupFree": { en: "Sign up (free):", de: "Registrieren (kostenlos):" },
  "setup.noCreditCard": { en: "No credit card required!", de: "Keine Kreditkarte nötig!" },
  "setup.noApiKey": { en: "Without API key, this provider cannot be used.", de: "Ohne API Key kann dieser Provider nicht genutzt werden." },
  "setup.groqFallbackNote": { en: "Groq registered as free fallback.", de: "Groq als kostenloser Fallback registriert." },
  "setup.step5": { en: "Step 5: Platforms", de: "Schritt 5: Plattformen" },
  "setup.step5.intro": { en: "Telegram included automatically. Additional platforms?", de: "Telegram ist automatisch dabei. Weitere Plattformen?" },
  "setup.platform.telegramOnly": { en: "Telegram only (default)", de: "Nur Telegram (Standard)" },
  "setup.platform.whatsapp": { en: "+ WhatsApp (requires Chrome/Chromium)", de: "+ WhatsApp (braucht Chrome/Chromium)" },
  "setup.platform.later": { en: "Configure later (via Web UI)", de: "Später konfigurieren (via Web UI)" },
  "setup.platformChoice": { en: "Your choice (1-3): ", de: "Deine Wahl (1-3): " },
  "setup.writingConfig": { en: "📝 Writing configuration...", de: "📝 Konfiguration schreiben..." },
  "setup.backup": { en: "📋 Backup:", de: "📋 Backup:" },
  "setup.envWritten": { en: ".env written", de: ".env geschrieben" },
  "setup.soulCreated": { en: "SOUL.md created (customize personality)", de: "SOUL.md erstellt (Persönlichkeit anpassbar)" },
  "setup.building": { en: "🔨 Building...", de: "🔨 Building..." },
  "setup.buildOk": { en: "Build successful", de: "Build erfolgreich" },
  "setup.buildFailed": { en: "Build failed — see errors above", de: "Build fehlgeschlagen — siehe Fehler oben" },
  "setup.done": { en: "Setup Complete!", de: "Setup Abgeschlossen!" },
  "setup.passwordProtected": { en: "password-protected", de: "passwortgeschützt" },
  "setup.scanQr": { en: "WhatsApp: Scan QR code in Web UI → Platforms", de: "WhatsApp: QR-Code scannen in Web UI → Platforms" },
  "setup.claudeMissing": { en: "Claude CLI missing — install for full agent mode:\n      npm i -g @anthropic-ai/claude-code && claude login", de: "Claude CLI fehlt — für vollen Agent-Modus:\n      npm i -g @anthropic-ai/claude-code && claude login" },
  "setup.haveFun": { en: "Have fun! 🤖", de: "Viel Spaß! 🤖" },

  // ── Doctor ────────────────────────────────────────────
  "doctor.title": { en: "🩺 Alvin Bot — Health Check", de: "🩺 Alvin Bot — Health Check" },
  "doctor.claudeCli": { en: "Claude CLI (Agent SDK available)", de: "Claude CLI (Agent SDK verfügbar)" },
  "doctor.claudeCliMissing": { en: "Claude CLI not installed (optional — agent mode only)", de: "Claude CLI nicht installiert (optional — nur für Agent-Modus)" },
  "doctor.noApiKeys": { en: "No API keys set — configure at least one provider!", de: "Keine API Keys gesetzt — mindestens einen Provider konfigurieren!" },
  "doctor.claudeSdkNote": { en: "Provider: Claude SDK (CLI auth, no API key needed)", de: "Provider: Claude SDK (CLI Auth, kein API Key nötig)" },
  "doctor.noEnv": { en: ".env not found — run: alvin-bot setup", de: ".env nicht gefunden — starte: alvin-bot setup" },
  "doctor.buildPresent": { en: "Build present (dist/)", de: "Build vorhanden (dist/)" },
  "doctor.buildMissing": { en: "Not built — run: npm run build", de: "Nicht gebaut — starte: npm run build" },
  "doctor.soul": { en: "SOUL.md (personality)", de: "SOUL.md (Persönlichkeit)" },
  "doctor.soulMissing": { en: "SOUL.md missing — default personality used", de: "SOUL.md fehlt — Standard-Persönlichkeit wird genutzt" },
  "doctor.chromeFound": { en: "found", de: "gefunden" },
  "doctor.chromeNotFound": { en: "not found", de: "nicht gefunden" },

  // ── Update ────────────────────────────────────────────
  "update.title": { en: "🔄 Updating Alvin Bot...", de: "🔄 Alvin Bot aktualisieren..." },
  "update.pulling": { en: "📥 Pulling latest changes...", de: "📥 Neueste Änderungen laden..." },
  "update.installing": { en: "📦 Installing dependencies...", de: "📦 Abhängigkeiten installieren..." },
  "update.building": { en: "🔨 Building...", de: "🔨 Building..." },
  "update.done": { en: "Update complete!\n  Restart: pm2 restart alvin-bot", de: "Update abgeschlossen!\n  Neustarten: pm2 restart alvin-bot" },
  "update.npm": { en: "📦 Updating via npm...", de: "📦 Update via npm..." },
  "update.failed": { en: "Update failed:", de: "Update fehlgeschlagen:" },

  // ── Default SOUL.md ───────────────────────────────────
  "soul.default": {
    en: `# SOUL.md — Bot Personality

> Edit this file to customize your bot's personality.
> Loaded on startup and injected into every system prompt.

## Who am I?

I'm an autonomous AI assistant. Direct, helpful, with my own character.

## How I communicate

- Direct and honest — no fluff
- With humor — dry wit here and there
- Eye to eye — a competent friend, not a subservient butler
- English by default, matches the user's language

## My principles

- Act first, explain later
- Admit mistakes immediately
- Have and express opinions
- Respect privacy
`,
    de: `# SOUL.md — Bot Persönlichkeit

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
`,
  },
};

// ── Runtime ─────────────────────────────────────────────

let currentLocale: Locale = "en";

/**
 * Detect locale from CLI flags and environment.
 * Only explicit opt-in switches to German:
 *   --lang de | ALVIN_LANG=de
 * System LANG is NOT used (too many false positives on multilingual systems).
 */
export function detectLocale(): Locale {
  const langIdx = process.argv.indexOf("--lang");
  if (langIdx !== -1) {
    const val = process.argv[langIdx + 1]?.toLowerCase();
    if (val === "de" || val === "en") return val;
  }
  const envLang = process.env.ALVIN_LANG?.toLowerCase();
  if (envLang === "de" || envLang === "en") return envLang;
  return "en";
}

/** Initialize i18n. Call once at startup. */
export function initI18n(locale?: Locale): void {
  currentLocale = locale || detectLocale();
}

/** Get the current locale. */
export function getLocale(): Locale {
  return currentLocale;
}

/** Set locale at runtime. */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

/** Translate a key. Returns the key itself if not found. */
export function t(key: string): string {
  return strings[key]?.[currentLocale] || strings[key]?.["en"] || key;
}
