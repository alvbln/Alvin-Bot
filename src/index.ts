import { Bot, InlineKeyboard } from "grammy";
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
import { startHeartbeat } from "./services/heartbeat.js";
import { loadSkills } from "./services/skills.js";

// Discover available system tools (cached for prompt injection)
discoverTools();

// Load skill files
loadSkills();

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

// ── WhatsApp Approval Callbacks ──────────────────────────────────────────────

bot.callbackQuery(/^wa:approve:(.+)$/, async (ctx) => {
  const approvalId = ctx.match![1];
  const { removePendingApproval, getWhatsAppAdapter } = await import("./platforms/whatsapp.js");
  const pending = removePendingApproval(approvalId);
  if (!pending) {
    await ctx.answerCallbackQuery("⏰ Anfrage abgelaufen");
    await ctx.editMessageText(ctx.msg?.text + "\n\n⏰ _Abgelaufen_", { parse_mode: "Markdown" }).catch(() => {});
    return;
  }

  await ctx.answerCallbackQuery("✅ Freigegeben");
  await ctx.editMessageText(
    ctx.msg?.text + `\n\n✅ Freigegeben`,
    { parse_mode: "HTML" }
  ).catch(() => {});

  // Process the message through the platform handler
  const adapter = getWhatsAppAdapter();
  if (adapter) {
    adapter.processApprovedMessage(pending.incoming).catch(err =>
      console.error("WhatsApp approved message processing error:", err)
    );
  }
});

bot.callbackQuery(/^wa:deny:(.+)$/, async (ctx) => {
  const approvalId = ctx.match![1];
  const { removePendingApproval } = await import("./platforms/whatsapp.js");
  const pending = removePendingApproval(approvalId);

  await ctx.answerCallbackQuery("❌ Abgelehnt");
  await ctx.editMessageText(
    (ctx.msg?.text || "") + `\n\n❌ Abgelehnt`,
    { parse_mode: "HTML" }
  ).catch(() => {});

  // Clean up temp media files
  if (pending?.incoming.media?.path) {
    const fs = await import("fs");
    fs.unlink(pending.incoming.media.path, () => {});
  }
});

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

// Start optional platform adapters via Platform Manager
async function startOptionalPlatforms() {
  const { handlePlatformMessage } = await import("./handlers/platform-message.js");
  const { autoLoadPlatforms, startAllAdapters, getAllAdapters } = await import("./platforms/index.js");

  const loaded = await autoLoadPlatforms();
  if (loaded.length > 0) {
    await startAllAdapters(async (msg) => {
      const adapter = getAllAdapters().find(a => a.platform === msg.platform);
      if (adapter) await handlePlatformMessage(msg, adapter);
    });
    const icons: Record<string, string> = { whatsapp: "📱", discord: "🎮", signal: "🔒" };
    for (const p of loaded) {
      console.log(`${icons[p] || "📡"} ${p.charAt(0).toUpperCase() + p.slice(1)} platform started`);
    }

    // Wire WhatsApp approval flow — routes to best available channel
    if (loaded.includes("whatsapp")) {
      const { setApprovalRequestFn, setApprovalChannel, getWhatsAppAdapter } = await import("./platforms/whatsapp.js");

      setApprovalRequestFn(async (pending) => {
        const mediaTag = pending.mediaType ? ` [${pending.mediaType}]` : "";

        // ── Strategy: Try Telegram first → fallback to WhatsApp DM → Discord → Signal
        let sent = false;

        // 1. Telegram (preferred — has inline keyboards)
        if (!sent && config.botToken && config.allowedUsers.length > 0) {
          try {
            const ownerChatId = config.allowedUsers[0];
            const msgText =
              `💬 <b>WhatsApp Approval</b>\n\n` +
              `<b>Gruppe:</b> ${pending.groupName}\n` +
              `<b>Von:</b> ${pending.senderName} (+${pending.senderNumber})\n` +
              `<b>Nachricht:</b>${mediaTag}\n` +
              `<blockquote>${pending.preview || "(kein Text)"}</blockquote>`;

            const keyboard = new InlineKeyboard()
              .text("✅ Freigeben", `wa:approve:${pending.id}`)
              .text("❌ Ablehnen", `wa:deny:${pending.id}`);

            await bot.api.sendMessage(ownerChatId, msgText, {
              parse_mode: "HTML",
              reply_markup: keyboard,
            });
            setApprovalChannel("telegram");
            sent = true;
          } catch (err) {
            console.warn("Approval via Telegram failed, trying fallback:", err instanceof Error ? err.message : err);
          }
        }

        // 2. WhatsApp DM (self-chat) — text-based approval
        if (!sent) {
          try {
            const adapter = getWhatsAppAdapter();
            const ownerWaId = adapter?.getOwnerChatId();
            if (adapter && ownerWaId) {
              const plainText =
                `🔐 *WhatsApp Approval*\n\n` +
                `*Gruppe:* ${pending.groupName}\n` +
                `*Von:* ${pending.senderName} (+${pending.senderNumber})\n` +
                `*Nachricht:*${mediaTag}\n` +
                `> ${pending.preview || "(kein Text)"}\n\n` +
                `Antworte *ok* oder *nein*`;

              await adapter.sendText(ownerWaId, plainText);
              setApprovalChannel("whatsapp");
              sent = true;
            }
          } catch (err) {
            console.warn("Approval via WhatsApp DM failed, trying fallback:", err instanceof Error ? err.message : err);
          }
        }

        // 3. Discord DM
        if (!sent) {
          try {
            const { getAdapter } = await import("./platforms/index.js");
            const discord = getAdapter("discord");
            if (discord) {
              await discord.sendText("owner", `🔐 WhatsApp Approval\n\nGruppe: ${pending.groupName}\nVon: ${pending.senderName} (+${pending.senderNumber})\nNachricht:${mediaTag}\n> ${pending.preview || "(kein Text)"}\n\nReagiere mit ✅ oder ❌`);
              setApprovalChannel("discord");
              sent = true;
            }
          } catch { /* Discord not available */ }
        }

        // 4. Signal
        if (!sent) {
          try {
            const { getAdapter } = await import("./platforms/index.js");
            const signal = getAdapter("signal");
            if (signal) {
              await signal.sendText("owner", `🔐 WhatsApp Approval\n\nGruppe: ${pending.groupName}\nVon: ${pending.senderName}\nNachricht: ${pending.preview || "(kein Text)"}\n\nAntworte ok oder nein`);
              setApprovalChannel("signal");
              sent = true;
            }
          } catch { /* Signal not available */ }
        }

        if (!sent) {
          console.error("❌ No channel available for WhatsApp approval! Auto-denying.");
        }
      });
    }
  }
}

startOptionalPlatforms().catch(err => console.error("Platform startup error:", err));

// Start Web UI
const webServer = startWebServer();

// Start Cron Scheduler
setNotifyCallback(async (target, text) => {
  try {
    if (target.platform === "telegram" && target.chatId) {
      await bot.api.sendMessage(Number(target.chatId), text, { parse_mode: "Markdown" }).catch(() =>
        bot.api.sendMessage(Number(target.chatId), text)
      );
    } else if (["whatsapp", "discord", "signal"].includes(target.platform) && target.chatId) {
      // Route through platform adapters
      const { getAdapter } = await import("./platforms/index.js");
      const adapter = getAdapter(target.platform);
      if (adapter) {
        await adapter.sendText(target.chatId, text);
      } else {
        console.warn(`Cron notify: ${target.platform} adapter not loaded, falling back to Telegram`);
        // Fallback: send to first allowed Telegram user
        if (config.allowedUsers.length > 0) {
          await bot.api.sendMessage(config.allowedUsers[0], `[${target.platform}] ${text}`).catch(() => {});
        }
      }
    } else if (target.platform === "web") {
      // Web notifications are handled by the WebSocket clients polling cron status
      // Nothing to do here
    }
  } catch (err) {
    console.error(`Cron notify error (${target.platform}):`, err);
  }
});
startScheduler();

// Start
import { setTelegramConnected } from "./platforms/telegram.js";

await bot.start({
  onStart: () => {
    const me = bot.botInfo;
    setTelegramConnected(me.first_name, me.username);
    console.log(`🤖 Alvin Bot v3.0.0 gestartet (@${me.username})`);
    console.log(`   Provider: ${registry.getActiveKey()}`);
    console.log(`   Users: ${config.allowedUsers.length} authorized`);

    // Start heartbeat monitor
    startHeartbeat();
  },
});
