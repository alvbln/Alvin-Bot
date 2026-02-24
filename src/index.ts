import { Bot } from "grammy";
import { config } from "./config.js";
import { authMiddleware } from "./middleware/auth.js";
import { registerCommands } from "./handlers/commands.js";
import { handleMessage } from "./handlers/message.js";
import { handlePhoto } from "./handlers/photo.js";
import { handleVoice } from "./handlers/voice.js";
import { handleDocument } from "./handlers/document.js";
import { initEngine } from "./engine.js";

// Initialize multi-model engine
const registry = initEngine();
console.log(`Engine initialized. Primary: ${registry.getActiveKey()}`);

const bot = new Bot(config.botToken);

// Auth middleware — alle Messages durchlaufen das
bot.use(authMiddleware);

// Commands registrieren
registerCommands(bot);

// Content handlers (Reihenfolge wichtig: spezifisch vor allgemein)
bot.on("message:voice", handleVoice);
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

// Start
await bot.start({
  onStart: () => {
    console.log(`🤖 Mr. Levin v2.2.0 gestartet`);
    console.log(`   Provider: ${registry.getActiveKey()}`);
    console.log(`   Users: ${config.allowedUsers.length} authorized`);
  },
});
