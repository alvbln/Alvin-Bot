// ── Bootstrap: ensure ~/.alvin-bot/ exists + migrate legacy data ────
import { ensureDataDirs, seedDefaults } from "./init-data-dir.js";
import { hasLegacyData, migrateFromLegacy } from "./migrate.js";
import { installConsoleFormatter } from "./util/console-formatter.js";
import { isHarmlessTelegramError } from "./util/telegram-error-filter.js";

// 0. Install timestamp + noise-filter formatters on console.* so every
//    line in out.log / err.log carries an ISO timestamp and libsignal's
//    SessionEntry dumps stop burying the signal.
installConsoleFormatter();

// 1. Create directory structure (no files yet)
ensureDataDirs();

// 2. Migrate legacy data BEFORE seeding defaults (so real data wins over templates)
if (hasLegacyData()) {
  console.log("📦 Legacy data detected in repo — migrating to ~/.alvin-bot/ ...");
  const result = migrateFromLegacy();
  if (result.copied.length > 0) {
    console.log(`   Copied: ${result.copied.join(", ")}`);
  }
  console.log("   Migration done. Old files left in place (clean up manually).");
}

// 3. Seed defaults for any files that don't exist yet (fresh install)
seedDefaults();

// 3a. v4.12.2 — Audit + repair permissions on sensitive files. On multi-user
//     systems, files written pre-v4.12.2 may have 0o644 / 0o666 mode — i.e.
//     readable by other users on the same machine. This routine chmod-repairs
//     them to 0o600 (owner read/write only) at every startup. Idempotent for
//     already-secure files; silent no-op for missing files.
import { auditSensitiveFiles } from "./services/file-permissions.js";
import { ENV_FILE as SEC_ENV, SESSIONS_STATE_FILE, MEMORY_FILE, CRON_FILE as SEC_CRON } from "./paths.js";
import { readdirSync } from "fs";
import { resolve as pathResolve } from "path";
import { MEMORY_DIR as SEC_MEM_DIR, DATA_DIR as SEC_DATA_DIR } from "./paths.js";

{
  const sensitivePaths: string[] = [SEC_ENV, SESSIONS_STATE_FILE, MEMORY_FILE, SEC_CRON];
  // Also audit every daily-log markdown file — they contain full conversation history
  try {
    if (readdirSync.length !== undefined) {
      for (const entry of readdirSync(SEC_MEM_DIR)) {
        if (entry.endsWith(".md") && !entry.startsWith(".")) {
          sensitivePaths.push(pathResolve(SEC_MEM_DIR, entry));
        }
      }
    }
  } catch {
    // memory dir missing — fine
  }
  // Also include async-agents state, delivery queue, and sudo credentials
  const optionalPaths = [
    pathResolve(SEC_DATA_DIR, "state", "async-agents.json"),
    pathResolve(SEC_DATA_DIR, "delivery-queue.json"),
    pathResolve(SEC_DATA_DIR, "data", ".sudo-enc"),
    pathResolve(SEC_DATA_DIR, "data", ".sudo-key"),
    pathResolve(SEC_DATA_DIR, "data", "access.json"),
    pathResolve(SEC_DATA_DIR, "data", "approved-users.json"),
  ];
  sensitivePaths.push(...optionalPaths);

  const auditResults = auditSensitiveFiles(sensitivePaths);
  const repaired = auditResults.filter(r => r.status === "repaired");
  if (repaired.length > 0) {
    console.log(`🔒 file-permissions: repaired ${repaired.length} sensitive file(s) to 0o600`);
    for (const r of repaired) {
      console.log(`   ${r.path} (was 0o${r.previousMode})`);
    }
  }
  const errors = auditResults.filter(r => r.status === "error");
  if (errors.length > 0) {
    console.warn(`⚠️  file-permissions: ${errors.length} file(s) could not be repaired:`);
    for (const r of errors) {
      console.warn(`   ${r.path}: ${r.error}`);
    }
  }
}

// 4. Crash-loop brake check — if we've crashed N times in a short window,
//    refuse to start, write an alert file, and unload our LaunchAgent so
//    launchd stops retrying. Runs BEFORE any expensive init so a broken
//    state file doesn't tank the whole CPU.
checkCrashLoopBrake();

// ── Normal imports (safe now — DATA_DIR is ready) ──────────────────
import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";

// ── Pre-flight config validation (warnings, not fatal) ──────────────
const hasTelegram = !!config.botToken;
let hasProvider = true;

if (!hasTelegram) {
  console.warn("⚠️  BOT_TOKEN not set — Telegram disabled. WebUI + Cron still active.");
  console.warn("   Run 'alvin-bot setup' or set BOT_TOKEN in ~/.alvin-bot/.env");
}

// v4.12.2 — ALLOWED_USERS startup gate. Refuses to start when Telegram is
// configured but no user allowlist is set, because that would leave the bot
// open to any Telegram user with full shell/filesystem access via prompt
// injection. See src/services/allowed-users-gate.ts for the pure decision
// function + tests.
{
  const { checkAllowedUsersGate } = await import("./services/allowed-users-gate.js");
  const gate = checkAllowedUsersGate({
    hasTelegram,
    allowedUsersCount: config.allowedUsers.length,
    authMode: config.authMode,
    insecureAcknowledged: process.env.ALVIN_INSECURE_ACKNOWLEDGED === "1",
  });
  if (!gate.allowed) {
    console.error("");
    console.error("❌ CRITICAL: Alvin Bot refusing to start.");
    console.error("");
    console.error("   " + gate.reason);
    console.error("");
    process.exit(1);
  }
  if (gate.warning) {
    console.warn("⚠️  " + gate.warning);
  }
}

// Check if the chosen provider has a corresponding API key.
// Keys here MUST match the registry keys from src/providers/registry.ts
// (createRegistry). Providers that authenticate differently (claude-sdk
// via OAuth, codex-cli/ollama via local binary) are deliberately absent.
// Custom providers from docs/custom-models.json handle their own apiKeyEnv.
const providerKeyMap: Record<string, string> = {
  google: "GOOGLE_API_KEY",
  // Legacy custom-model aliases kept so older configs don't break their
  // pre-flight warning — if users have these as primary they're coming
  // from docs/custom-models.json.
  groq: "GROQ_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "nvidia-llama-3.3-70b": "NVIDIA_API_KEY",
  "nvidia-kimi-k2.5": "NVIDIA_API_KEY",
  "gpt-4o": "OPENAI_API_KEY",
};
const requiredKey = providerKeyMap[config.primaryProvider];
if (requiredKey) {
  const keyName = requiredKey.replace("_API_KEY", "").toLowerCase() as keyof typeof config.apiKeys;
  if (!config.apiKeys[keyName]) {
    hasProvider = false;
    console.warn(`⚠️  ${requiredKey} is missing — AI chat won't work until configured.`);
    console.warn(`   Your provider "${config.primaryProvider}" needs this key.`);
    console.warn(`   Run 'alvin-bot setup' or edit ~/.alvin-bot/.env`);
  }
}
import { authMiddleware, addApprovedUser, removePendingPairing } from "./middleware/auth.js";
import { registerCommands } from "./handlers/commands.js";
import { handleMessage } from "./handlers/message.js";
import { handlePhoto } from "./handlers/photo.js";
import { handleVoice } from "./handlers/voice.js";
import { handleDocument } from "./handlers/document.js";
import { handleVideo } from "./handlers/video.js";
import { initEngine } from "./engine.js";
import { loadPlugins, registerPluginCommands, unloadPlugins } from "./services/plugins.js";
import { initMCP, disconnectMCP, hasMCPConfig } from "./services/mcp.js";
import { startWebServer, stopWebServer } from "./web/server.js";
import { startScheduler, stopScheduler, setNotifyCallback } from "./services/cron.js";
import { startWatcher as startAsyncAgentWatcher, stopWatcher as stopAsyncAgentWatcher } from "./services/async-agent-watcher.js";
import { startSessionCleanup, stopSessionCleanup, attachPersistHook } from "./services/session.js";
import {
  loadPersistedSessions,
  flushSessions,
  schedulePersist,
} from "./services/session-persistence.js";
import { processQueue, cleanupQueue, setSenders, enqueue } from "./services/delivery-queue.js";

import { discoverTools } from "./services/tool-discovery.js";
import { startHeartbeat, stopHeartbeat } from "./services/heartbeat.js";
import { stopAutoUpdateLoop } from "./services/updater.js";
import { startCleanupLoop, stopCleanupLoop } from "./services/disk-cleanup.js";
import { flushProfiles } from "./services/users.js";
import { initEmbeddings } from "./services/embeddings.js";
import { loadSkills } from "./services/skills.js";
import { loadHooks } from "./services/hooks.js";
import { registerShutdownHandler } from "./services/restart.js";
import { cancelAllSubAgents } from "./services/subagents.js";
import { startWatchdog, stopWatchdog, checkCrashLoopBrake } from "./services/watchdog.js";
import { getRegistry } from "./engine.js";
import { scanAssets } from "./services/asset-index.js";

// Scan asset directory and generate INDEX.json + INDEX.md
const assetScanResult = scanAssets();
if (assetScanResult.assets.length > 0) {
  console.log(`📂 Assets: ${assetScanResult.assets.length} files indexed`);
}

// Discover available system tools (cached for prompt injection)
discoverTools();

// Load skill files
loadSkills();

// v4.12.0 — Workspace registry: load per-channel configs and start the
// hot-reload watcher. Safe no-op if no workspaces are configured.
import { initWorkspaces, stopWorkspaceWatcher } from "./services/workspaces.js";
initWorkspaces();

// Load user-defined lifecycle hooks from ~/.alvin-bot/hooks/
const hookCount = loadHooks();
if (hookCount > 0) console.log(`Hooks: ${hookCount} loaded`);

// Initialize multi-model engine (skip if no provider key)
let registry: ReturnType<typeof initEngine> | null = null;
if (hasProvider) {
  registry = initEngine();
  console.log(`Engine initialized. Primary: ${registry.getActiveKey()}`);
} else {
  console.warn("⚠️  Engine not initialized — no AI provider configured.");
}

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

// Telegram bot instance (null if no BOT_TOKEN)
let bot: Bot | null = null;

if (hasTelegram) {
  bot = new Bot(config.botToken);

  // Wire the sub-agent delivery router so async agent finals can reach
  // Telegram (cron-spawned agents, user-spawned async finals, shutdown
  // cancellation notifications). Lazy-import avoids a top-level cycle.
  const { attachBotApi } = await import("./services/subagent-delivery.js");
  const botRef = bot;
  attachBotApi({
    sendMessage: (chatId, text, opts) =>
      botRef.api.sendMessage(
        chatId,
        text,
        opts as Parameters<typeof botRef.api.sendMessage>[2],
      ),
    sendDocument: (chatId, doc, opts) =>
      botRef.api.sendDocument(
        chatId,
        doc as Parameters<typeof botRef.api.sendDocument>[1],
        opts as Parameters<typeof botRef.api.sendDocument>[2],
      ),
    editMessageText: (chatId, messageId, text, opts) =>
      botRef.api.editMessageText(
        chatId,
        messageId,
        text,
        opts as Parameters<typeof botRef.api.editMessageText>[3],
      ),
  });

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

    await ctx.answerCallbackQuery("✅ Approved");
    await ctx.editMessageText(
      ctx.msg?.text + `\n\n✅ Approved`,
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

  // ── DM Pairing Approval Callbacks ───────────────────────────────────────────

  bot.callbackQuery(/^pair:(approve|deny):(\d+)$/, async (ctx) => {
    const action = ctx.match![1];
    const code = ctx.match![2];
    const pairing = removePendingPairing(code);

    if (!pairing) {
      await ctx.answerCallbackQuery("⏰ Request expired or already handled");
      await ctx.editMessageText((ctx.msg?.text || "") + "\n\n⏰ _Expired_", { parse_mode: "Markdown" }).catch(() => {});
      return;
    }

    if (action === "approve") {
      addApprovedUser(pairing.userId);
      await ctx.answerCallbackQuery("✅ User approved");
      const userTag = pairing.username ? `@${pairing.username}` : `ID ${pairing.userId}`;
      await ctx.editMessageText(
        (ctx.msg?.text || "") + `\n\n✅ Approved — ${userTag} can now chat with the bot.`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      // Notify the user they've been approved
      try {
        await ctx.api.sendMessage(pairing.userId, "✅ You've been approved! You can now chat with the bot.");
      } catch { /* user may have blocked the bot */ }
    } else {
      await ctx.answerCallbackQuery("❌ User denied");
      const userTag = pairing.username ? `@${pairing.username}` : `ID ${pairing.userId}`;
      await ctx.editMessageText(
        (ctx.msg?.text || "") + `\n\n❌ Denied — ${userTag} will not be able to chat.`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      // Notify the user they've been denied
      try {
        await ctx.api.sendMessage(pairing.userId, "❌ Your access request was denied by the admin.");
      } catch { /* user may have blocked the bot */ }
    }
  });

  // Content handlers (Reihenfolge wichtig: spezifisch vor allgemein)
  bot.on("message:voice", handleVoice);
  bot.on("message:video", handleVideo);
  bot.on("message:video_note", handleVideo);
  bot.on("message:photo", handlePhoto);
  bot.on("message:document", handleDocument);
  bot.on("message:text", handleMessage);

  // Error handling — log but don't crash.
  bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;

    // Swallow the well-known harmless grammy races (message is not
    // modified, query too old, message to edit not found …) silently.
    // See src/util/telegram-error-filter.ts for the exhaustive list.
    if (isHarmlessTelegramError(e)) return;

    console.error(`Error handling update ${ctx?.update?.update_id}:`, e);

    // Try to notify the user
    if (ctx?.chat?.id) {
      ctx.reply("⚠️ An internal error occurred. Please try again.").catch(() => {});
    }
  });
}

// Delivery queue intervals (started later, cleared on shutdown)
let queueInterval: ReturnType<typeof setInterval> | null = null;
let queueCleanupInterval: ReturnType<typeof setInterval> | null = null;

// Graceful shutdown
let isShuttingDown = false;
const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log("Graceful shutdown initiated...");

  // E2: shutdown-notification — await the async cancellation so running
  // agents can post a cancellation message to Telegram before the bot
  // stops. Capped at 5s internally so a hang can't block shutdown.
  await cancelAllSubAgents(true);
  stopWatchdog();
  stopScheduler();
  stopAsyncAgentWatcher();
  stopSessionCleanup();
  stopWorkspaceWatcher();
  stopHeartbeat();
  stopAutoUpdateLoop();
  stopCleanupLoop();
  // v4.11.0 — Final immediate flush of in-memory sessions to disk before exit.
  // The debounced timer might be pending; flushSessions() cancels it and writes
  // synchronously so the next boot can rehydrate the latest state.
  await flushSessions().catch((err) =>
    console.warn("[shutdown] flushSessions failed:", err),
  );
  try { flushProfiles(); } catch (err) { console.warn("[shutdown] flushProfiles failed:", err); }
  if (queueInterval) clearInterval(queueInterval);
  if (queueCleanupInterval) clearInterval(queueCleanupInterval);
  // Await grammy's stop so the Telegram update-offset gets committed BEFORE
  // we tear down the rest. Without this, the next boot could re-process
  // the last batch of messages. See src/services/restart.ts for context.
  if (bot) {
    await bot.stop().catch((err) => console.warn("[shutdown] bot.stop failed:", err));
  }
  // Release :3100 so the next launchd boot doesn't hit EADDRINUSE.
  // Must happen before exit — see src/web/server.ts stopWebServer() comment.
  await stopWebServer().catch((err) =>
    console.warn("[shutdown] stopWebServer failed:", err),
  );
  await unloadPlugins().catch(() => {});
  await disconnectMCP().catch(() => {});
  // Tear down any bot-managed local runners (Ollama, LM Studio, …) so VRAM
  // is freed and no daemon outlives the bot as a zombie. Iterates generically
  // over every registered provider that exposes a lifecycle.
  try {
    const registry = getRegistry();
    const providers = await registry.listAll();
    for (const p of providers) {
      const provider = registry.get(p.key);
      if (provider?.lifecycle?.isBotManaged()) {
        console.log(`Tearing down bot-managed ${p.key}...`);
        await provider.lifecycle.ensureStopped().catch((err) => {
          console.warn(`${p.key} shutdown teardown failed:`, err);
        });
      }
    }
  } catch (err) {
    console.warn("lifecycle teardown failed:", err);
  }

  console.log("Goodbye! 👋");
  process.exit(0);
};

// Register for graceful self-restart (used by tool-executor when AI triggers restart)
registerShutdownHandler(shutdown);

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
    if (loaded.includes("whatsapp") && bot) {
      const { setApprovalRequestFn, setApprovalChannel, getWhatsAppAdapter } = await import("./platforms/whatsapp.js");
      const telegramBot = bot; // capture for closure

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
              `<b>Message:</b>${mediaTag}\n` +
              `<blockquote>${pending.preview || "(no text)"}</blockquote>`;

            const keyboard = new InlineKeyboard()
              .text("✅ Approve", `wa:approve:${pending.id}`)
              .text("❌ Ablehnen", `wa:deny:${pending.id}`);

            await telegramBot.api.sendMessage(ownerChatId, msgText, {
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
                `*Message:*${mediaTag}\n` +
                `> ${pending.preview || "(no text)"}\n\n` +
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
              await discord.sendText("owner", `🔐 WhatsApp Approval\n\nGroup: ${pending.groupName}\nFrom: ${pending.senderName} (+${pending.senderNumber})\nMessage:${mediaTag}\n> ${pending.preview || "(no text)"}\n\nReact with ✅ or ❌`);
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
              await signal.sendText("owner", `🔐 WhatsApp Approval\n\nGroup: ${pending.groupName}\nFrom: ${pending.senderName}\nMessage: ${pending.preview || "(no text)"}\n\nReply ok or no`);
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

// Start Web UI (ALWAYS — regardless of Telegram/AI config).
// startWebServer is now non-blocking and will never throw: if port 3100
// is busy (foreign process, TIME_WAIT, another bot instance), it climbs
// the port ladder up to 3119 and then enters a background retry loop
// at 3100 every 30s. The Telegram bot runs independently — Web UI is a
// feature, not core. See src/web/bind-strategy.ts for the retry rules.
startWebServer();

// Start Cron Scheduler — route notifications through delivery queue for reliability
setNotifyCallback(async (target, text) => {
  if (target.platform === "web") {
    // Web notifications are handled by the WebSocket clients polling cron status
    return;
  }
  enqueue(target.platform, String(target.chatId), text);
});
startScheduler();

// Start the async-agent watcher (Fix #17 Stage 2). Polls outputFiles
// of background sub-agents Claude launched with run_in_background and
// delivers their completed reports as separate Telegram messages.
// Loads any persisted pending agents from disk on boot.
startAsyncAgentWatcher();

// Session memory hygiene: purge sessions idle > 7 days (configurable via
// ALVIN_SESSION_TTL_DAYS). Never touches active sessions — see session.ts.
startSessionCleanup();

// Session persistence (v4.11.0): wire the debounced persist hook BEFORE we
// load the snapshot, then rehydrate the in-memory Map from disk so users'
// Claude SDK session_id, conversation history, language and effort all
// survive bot restarts. Without this, every launchctl restart turns the
// bot into a goldfish for every active conversation.
attachPersistHook(schedulePersist);
loadPersistedSessions();

// Wire delivery queue senders
setSenders({
  telegram: async (chatId, content) => {
    if (!bot) throw new Error("Telegram bot not initialized");
    await bot.api.sendMessage(Number(chatId), content, { parse_mode: "Markdown" }).catch(() =>
      bot!.api.sendMessage(Number(chatId), content)
    );
  },
  whatsapp: async (chatId, content) => {
    const { getAdapter } = await import("./platforms/index.js");
    const adapter = getAdapter("whatsapp");
    if (adapter) {
      await adapter.sendText(chatId, content);
    } else {
      throw new Error("WhatsApp adapter not loaded");
    }
  },
  discord: async (chatId, content) => {
    const { getAdapter } = await import("./platforms/index.js");
    const adapter = getAdapter("discord");
    if (adapter) {
      await adapter.sendText(chatId, content);
    } else {
      throw new Error("Discord adapter not loaded");
    }
  },
  slack: async (chatId, content) => {
    const { getAdapter } = await import("./platforms/index.js");
    const adapter = getAdapter("slack");
    if (adapter) {
      await adapter.sendText(chatId, content);
    } else {
      throw new Error("Slack adapter not loaded");
    }
  },
  signal: async (chatId, content) => {
    const { getAdapter } = await import("./platforms/index.js");
    const adapter = getAdapter("signal");
    if (adapter) {
      await adapter.sendText(chatId, content);
    } else {
      throw new Error("Signal adapter not loaded");
    }
  },
});

// Start delivery queue processor (30s interval)
queueInterval = setInterval(async () => {
  try { await processQueue(); }
  catch (err) { console.error("Delivery queue error:", err); }
}, 30000);
// Cleanup old entries every hour
queueCleanupInterval = setInterval(() => {
  try { cleanupQueue(); }
  catch (err) { console.error("Queue cleanup error:", err); }
}, 3600000);

// Start Telegram polling (if configured)
import { setTelegramConnected } from "./platforms/telegram.js";

if (bot) {
  await bot.start({
    drop_pending_updates: true,
    onStart: () => {
      const me = bot!.botInfo;
      setTelegramConnected(me.first_name, me.username);
      console.log(`🤖 Alvin Bot started (@${me.username})`);
      console.log(`   Provider: ${registry?.getActiveKey() || "none"}`);
      console.log(`   Users: ${config.allowedUsers.length} authorized`);

      // Start heartbeat monitor
      startHeartbeat();

      // Start internal watchdog (crash-loop brake + liveness beacon)
      startWatchdog();

      // Index memory vectors in background (non-blocking)
      initEmbeddings().catch(() => {});
    },
  });
} else {
  console.log(`🤖 Alvin Bot started (WebUI-only mode)`);
  console.log(`   Provider: ${registry?.getActiveKey() || "none"}`);
  console.log(`   WebUI: http://localhost:${process.env.WEB_PORT || 3100}`);

  // Start heartbeat monitor even without Telegram
  startHeartbeat();
  startWatchdog();
  startCleanupLoop();
  initEmbeddings().catch(() => {});
}
