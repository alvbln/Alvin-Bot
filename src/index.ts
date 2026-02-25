import { Bot } from "grammy";
import { config } from "./config.js";
import { authMiddleware } from "./middleware/auth.js";
import { registerCommands } from "./handlers/commands.js";
import { handleMessage } from "./handlers/message.js";
import { handlePhoto } from "./handlers/photo.js";
import { handleVoice } from "./handlers/voice.js";
import { handleDocument } from "./handlers/document.js";
import { handleVideo } from "./handlers/video.js";
import { initEngine } from "./engine.js";
import { loadPlugins, registerPluginCommands, unloadPlugins } from "./services/plugins.js";
import { initMCP, disconnectMCP, hasMCPConfig } from "./services/mcp.js";
import { startWebServer } from "./web/server.js";
import { startScheduler, stopScheduler, setNotifyCallback } from "./services/cron.js";

import { discoverTools } from "./services/tool-discovery.js";

// Discover available system tools (cached for prompt injection)
discoverTools();

// Initialize multi-model engine
const registry = initEngine();
console.log(`Engine initialized. Primary: ${registry.getActiveKey()}`);

// Load plugins
const pluginResult = await loadPlugins();
if (pluginResult.loaded.length > 0) {
  console.log(`Plugins loaded: ${pluginResult.loaded.join(", ")}`);
}
if (pluginResult.errors.length > 0) {
  for (const err of pluginResult.errors) {
    console.error(`Plugin error (${err.name}): ${err.error}`);
  }
}

// Initialize MCP servers (if configured)
if (hasMCPConfig()) {
  const mcpResult = await initMCP();
  if (mcpResult.connected.length > 0) {
    console.log(`MCP servers: ${mcpResult.connected.join(", ")}`);
  }
  if (mcpResult.errors.length > 0) {
    for (const err of mcpResult.errors) {
      console.error(`MCP error (${err.name}): ${err.error}`);
    }
  }
}

const bot = new Bot(config.botToken);

// Auth middleware — alle Messages durchlaufen das
bot.use(authMiddleware);

// Commands registrieren
registerCommands(bot);
registerPluginCommands(bot);

// Content handlers (Reihenfolge wichtig: spezifisch vor allgemein)
bot.on("message:voice", handleVoice);
bot.on("message:video", handleVideo);
bot.on("message:video_note", handleVideo);
bot.on("message:photo", handlePhoto);
bot.on("message:document", handleDocument);
bot.on("message:text", handleMessage);

// Error handling — log but don't crash
bot.catch((err) => {
  const ctx = err.ctx;
  const e = err.error;
  console.error(`Error handling update ${ctx?.update?.update_id}:`, e);

  // Try to notify the user
  if (ctx?.chat?.id) {
    ctx.reply("⚠️ Ein interner Fehler ist aufgetreten. Bitte versuche es erneut.").catch(() => {});
  }
});

// Graceful shutdown — notify active users
let isShuttingDown = false;
const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log("Graceful shutdown initiated...");

  // Stop scheduler, unload plugins & disconnect MCP
  stopScheduler();
  await unloadPlugins().catch(err => console.error("Plugin unload error:", err));
  await disconnectMCP().catch(err => console.error("MCP disconnect error:", err));

  // Give pending operations 5 seconds to complete
  setTimeout(() => {
    console.log("Forcing exit.");
    process.exit(0);
  }, 5000);

  bot.stop();
  console.log("Bot stopped. Goodbye! 👋");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  // Don't exit on uncaught exceptions — try to keep running
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

// Start optional platform adapters (WhatsApp, Discord, Signal)
async function startOptionalPlatforms() {
  const { handlePlatformMessage } = await import("./handlers/platform-message.js");

  // WhatsApp
  if (process.env.WHATSAPP_ENABLED === "true") {
    try {
      const { WhatsAppAdapter } = await import("./platforms/whatsapp.js");
      const wa = new WhatsAppAdapter();
      wa.onMessage(async (msg) => {
        await handlePlatformMessage(msg, wa);
      });
      await wa.start();
      console.log("📱 WhatsApp platform started");
    } catch (err) {
      console.error("WhatsApp start failed:", err instanceof Error ? err.message : err);
    }
  }

  // Discord
  if (process.env.DISCORD_TOKEN) {
    try {
      const { DiscordAdapter } = await import("./platforms/discord.js");
      const discord = new DiscordAdapter(process.env.DISCORD_TOKEN);
      discord.onMessage(async (msg) => {
        await handlePlatformMessage(msg, discord);
      });
      await discord.start();
      console.log("🎮 Discord platform started");
    } catch (err) {
      console.error("Discord start failed:", err instanceof Error ? err.message : err);
    }
  }

  // Signal
  if (process.env.SIGNAL_API_URL && process.env.SIGNAL_NUMBER) {
    try {
      const { SignalAdapter } = await import("./platforms/signal.js");
      const signal = new SignalAdapter(process.env.SIGNAL_API_URL, process.env.SIGNAL_NUMBER);
      signal.onMessage(async (msg) => {
        await handlePlatformMessage(msg, signal);
      });
      await signal.start();
      console.log("🔒 Signal platform started");
    } catch (err) {
      console.error("Signal start failed:", err instanceof Error ? err.message : err);
    }
  }
}

startOptionalPlatforms().catch(err => console.error("Platform startup error:", err));

// Start Web UI
const webServer = startWebServer();

// Start Cron Scheduler
setNotifyCallback(async (target, text) => {
  if (target.platform === "telegram" && target.chatId) {
    try {
      await bot.api.sendMessage(Number(target.chatId), text, { parse_mode: "Markdown" }).catch(() =>
        bot.api.sendMessage(Number(target.chatId), text) // Fallback without markdown
      );
    } catch (err) {
      console.error("Cron notify error:", err);
    }
  }
  // TODO: Add Discord/WhatsApp/Signal notify when adapters are wired
});
startScheduler();

// Start
import { setTelegramConnected } from "./platforms/telegram.js";

await bot.start({
  onStart: () => {
    const me = bot.botInfo;
    setTelegramConnected(me.first_name, me.username);
    console.log(`🤖 Mr. Levin v3.0.0 gestartet (@${me.username})`);
    console.log(`   Provider: ${registry.getActiveKey()}`);
    console.log(`   Users: ${config.allowedUsers.length} authorized`);
  },
});
