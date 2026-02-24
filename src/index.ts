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

// Error handling
bot.catch((err) => {
  console.error("Bot error:", err);
});

// Graceful shutdown
const shutdown = () => {
  console.log("Shutting down...");
  bot.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// Start
await bot.start({
  onStart: () => console.log("Claude Agent Telegram Bot gestartet..."),
});
