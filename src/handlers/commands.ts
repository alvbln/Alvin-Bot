import type { Bot } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import fs from "fs";
import path, { resolve } from "path";
import os from "os";
import { getSession, resetSession, type EffortLevel } from "../services/session.js";
import { getRegistry } from "../engine.js";
import { reloadSoul } from "../services/personality.js";
import { parseDuration, createReminder, listReminders, cancelReminder } from "../services/reminders.js";
import { writeSessionSummary, getMemoryStats, appendDailyLog } from "../services/memory.js";
import {
  approveGroup, blockGroup, removeGroup, listGroups,
  getSettings, setForwardingAllowed, setAutoApprove,
} from "../services/access.js";
import { generateImage } from "../services/imagegen.js";
import { searchMemory, reindexMemory, getIndexStats } from "../services/embeddings.js";
import { listProfiles, addUserNote } from "../services/users.js";
import { getLoadedPlugins, getPluginsDir } from "../services/plugins.js";
import { getMCPStatus, getMCPTools, callMCPTool } from "../services/mcp.js";
import { listCustomTools, executeCustomTool, hasCustomTools } from "../services/custom-tools.js";
import { screenshotUrl, extractText, generatePdf, hasPlaywright } from "../services/browser.js";
import { listJobs, createJob, deleteJob, toggleJob, runJobNow, formatNextRun, humanReadableSchedule, type JobType } from "../services/cron.js";
import { storePassword, revokePassword, getSudoStatus, verifyPassword, sudoExec } from "../services/sudo.js";
import { config } from "../config.js";
import { getWebPort } from "../web/server.js";

/** Bot start time for uptime tracking */
const botStartTime = Date.now();

/** Format bytes to human-readable */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low — Quick, concise answers",
  medium: "Medium — Moderate reasoning depth",
  high: "High — Deep reasoning (default)",
  max: "Max — Maximum effort (Opus only)",
};

export function registerCommands(bot: Bot): void {
  bot.command("ping", async (ctx) => {
    const start = Date.now();
    const registry = getRegistry();
    const active = registry.getActive();
    const info = active.getInfo();
    const latency = Date.now() - start;
    await ctx.reply(`🏓 Pong! (${latency}ms)\n${info.name} ${info.status}`);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `🤖 *Alvin Bot — Commands*\n\n` +
      `💬 *Chat*\n` +
      `Just write — I'll respond.\n` +
      `I also understand voice messages & photos.\n\n` +
      `⚙️ *Controls*\n` +
      `/model — Switch AI model\n` +
      `/fallback — Provider order\n` +
      `/effort — Set reasoning depth\n` +
      `/voice — Voice replies on/off\n` +
      `/dir <path> — Working directory\n\n` +
      `🎨 *Extras*\n` +
      `/imagine <prompt> — Generate image\n` +
      `/remind <time> <text> — Set reminder\n` +
      `/export — Export conversation\n\n` +
      `🧠 *Memory*\n` +
      `/recall <query> — Semantic search\n` +
      `/remember <text> — Remember something\n` +
      `/reindex — Re-index memory\n\n` +
      `🌐 *Browser*\n` +
      `/browse <URL> — Screenshot\n` +
      `/browse text <URL> — Extract text\n` +
      `/browse pdf <URL> — Save as PDF\n\n` +
      `🔌 *Extensions*\n` +
      `/plugins — Loaded plugins\n` +
      `/mcp — MCP servers & tools\n` +
      `/users — User profiles\n\n` +
      `🖥️ *Web UI*\n` +
      `/webui — Open Web UI in browser\n\n` +
      `📊 *Session*\n` +
      `/status — Current status\n` +
      `/new — Start new session\n` +
      `/cancel — Cancel running request\n\n` +
      `_Tip: Send me documents, photos, or voice messages!_\n` +
      `_In groups: @mention me or reply to my messages._`,
      { parse_mode: "Markdown" }
    );
  });

  // Register bot commands in Telegram's menu
  bot.api.setMyCommands([
    { command: "help", description: "Show all commands" },
    { command: "model", description: "Switch AI model" },
    { command: "effort", description: "Set reasoning depth" },
    { command: "voice", description: "Voice replies on/off" },
    { command: "status", description: "Current status" },
    { command: "new", description: "Start new session" },
    { command: "dir", description: "Change working directory" },
    { command: "web", description: "Quick web search" },
    { command: "imagine", description: "Generate image (e.g. /imagine A fox)" },
    { command: "remind", description: "Set reminder (e.g. /remind 30m Text)" },
    { command: "export", description: "Export conversation" },
    { command: "recall", description: "Semantic memory search" },
    { command: "remember", description: "Remember something" },
    { command: "cron", description: "Manage scheduled jobs" },
    { command: "webui", description: "Open Web UI in browser" },
    { command: "setup", description: "Configure API keys & platforms" },
    { command: "cancel", description: "Cancel running request" },
  ]).catch(err => console.error("Failed to set bot commands:", err));

  bot.command("start", async (ctx) => {
    const registry = getRegistry();
    const activeInfo = registry.getActive().getInfo();

    await ctx.reply(
      `👋 *Hey! I'm Alvin Bot.*\n\n` +
      `Your autonomous AI assistant on Telegram. Just write me — ` +
      `I understand text, voice messages, photos, and documents.\n\n` +
      `🤖 Model: *${activeInfo.name}*\n` +
      `🧠 Reasoning: High\n\n` +
      `Type /help for all commands.`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("webui", async (ctx) => {
    const port = getWebPort();
    const url = `http://localhost:${port}`;
    await ctx.reply(
      `🌐 *Web UI* is running on port ${port}.\n\n` +
      `Open in your browser:\n${url}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("new", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);

    const hadSession = !!session.sessionId || session.history.length > 0;
    const msgCount = session.messageCount;
    const cost = session.totalCost;

    // Write session summary to daily log before reset
    if (hadSession && msgCount > 0) {
      const registry = getRegistry();
      writeSessionSummary({
        messageCount: msgCount,
        toolUseCount: session.toolUseCount,
        costUsd: cost,
        provider: registry.getActiveKey(),
      });
    }

    resetSession(userId);

    if (hadSession) {
      await ctx.reply(
        `🔄 *New session started.*\n\n` +
        `Previous session: ${msgCount} messages, $${cost.toFixed(4)} cost.\n` +
        `Summary saved to memory.`,
        { parse_mode: "Markdown" }
      );
    } else {
      await ctx.reply("🔄 New session started.");
    }
  });

  bot.command("dir", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    const newDir = ctx.match?.trim();

    if (!newDir) {
      await ctx.reply(`Current directory: ${session.workingDir}`);
      return;
    }

    const resolved = newDir.startsWith("~")
      ? path.join(os.homedir(), newDir.slice(1))
      : path.resolve(newDir);

    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      session.workingDir = resolved;
      await ctx.reply(`Working directory: ${session.workingDir}`);
    } else {
      await ctx.reply(`Directory not found: ${resolved}`);
    }
  });

  bot.command("status", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    const registry = getRegistry();
    const active = registry.getActive();
    const info = active.getInfo();

    // Uptime
    const uptimeMs = Date.now() - botStartTime;
    const uptimeH = Math.floor(uptimeMs / 3_600_000);
    const uptimeM = Math.floor((uptimeMs % 3_600_000) / 60_000);

    // Session duration
    const sessionMs = Date.now() - session.startedAt;
    const sessionM = Math.floor(sessionMs / 60_000);

    // Cost breakdown
    let costLines = "";
    const providers = Object.entries(session.queriesByProvider);
    if (providers.length > 0) {
      costLines = providers.map(([key, queries]) => {
        const cost = session.costByProvider[key] || 0;
        return `  ${key}: ${queries} queries, $${cost.toFixed(4)}`;
      }).join("\n");
    }

    await ctx.reply(
      `🤖 *Alvin Bot Status*\n\n` +
      `*Model:* ${info.name}\n` +
      `*Effort:* ${EFFORT_LABELS[session.effort]}\n` +
      `*Voice:* ${session.voiceReply ? "on" : "off"}\n` +
      `*Directory:* \`${session.workingDir}\`\n\n` +
      `📊 *Session* (${sessionM} min)\n` +
      `*Messages:* ${session.messageCount}\n` +
      `*Tool Calls:* ${session.toolUseCount}\n` +
      `*Cost:* $${session.totalCost.toFixed(4)}\n` +
      (costLines ? `\n📈 *Provider Usage:*\n${costLines}\n` : "") +
      `\n🧠 *Memory:* ${(() => { const m = getMemoryStats(); const idx = getIndexStats(); return `${m.dailyLogs} days, ${m.todayEntries} entries today, ${formatBytes(m.longTermSize)} LTM | 🔍 ${idx.entries} vectors (${formatBytes(idx.sizeBytes)})`; })()}\n` +
      `⏱ *Bot Uptime:* ${uptimeH}h ${uptimeM}m`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("voice", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    session.voiceReply = !session.voiceReply;
    await ctx.reply(
      session.voiceReply
        ? "Voice replies enabled. Responses will also be sent as voice messages."
        : "Voice replies disabled. Text-only responses."
    );
  });

  bot.command("effort", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    const level = ctx.match?.trim().toLowerCase();

    if (!level) {
      const keyboard = new InlineKeyboard();
      for (const [key, label] of Object.entries(EFFORT_LABELS)) {
        const marker = key === session.effort ? "✅ " : "";
        keyboard.text(`${marker}${label}`, `effort:${key}`).row();
      }
      await ctx.reply(
        `🧠 *Choose reasoning depth:*\n\nActive: *${EFFORT_LABELS[session.effort]}*`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      return;
    }

    if (!["low", "medium", "high", "max"].includes(level)) {
      await ctx.reply("Invalid. Use: /effort low | medium | high | max");
      return;
    }

    session.effort = level as EffortLevel;
    await ctx.reply(`✅ Effort: ${EFFORT_LABELS[session.effort]}`);
  });

  // Inline keyboard callback for effort switching
  bot.callbackQuery(/^effort:(.+)$/, async (ctx) => {
    const level = ctx.match![1];
    if (!["low", "medium", "high", "max"].includes(level)) {
      await ctx.answerCallbackQuery("Invalid level");
      return;
    }

    const userId = ctx.from!.id;
    const session = getSession(userId);
    session.effort = level as EffortLevel;

    const keyboard = new InlineKeyboard();
    for (const [key, label] of Object.entries(EFFORT_LABELS)) {
      const marker = key === session.effort ? "✅ " : "";
      keyboard.text(`${marker}${label}`, `effort:${key}`).row();
    }

    await ctx.editMessageText(
      `🧠 *Choose reasoning depth:*\n\nActive: *${EFFORT_LABELS[session.effort]}*`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
    await ctx.answerCallbackQuery(`Effort: ${EFFORT_LABELS[session.effort]}`);
  });

  bot.command("model", async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase();
    const registry = getRegistry();

    if (!arg) {
      // Show inline keyboard with available models
      const providers = await registry.listAll();
      const keyboard = new InlineKeyboard();

      for (const p of providers) {
        const label = p.active ? `✅ ${p.name}` : p.name;
        keyboard.text(label, `model:${p.key}`).row();
      }

      await ctx.reply(
        `🤖 *Choose model:*\n\nActive: *${registry.getActive().getInfo().name}*`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      return;
    }

    if (registry.switchTo(arg)) {
      const provider = registry.get(arg)!;
      const info = provider.getInfo();
      await ctx.reply(`✅ Switched model: ${info.name} (${info.model})`);
    } else {
      await ctx.reply(`Model "${arg}" not found. Use /model to see all options.`);
    }
  });

  // Inline keyboard callback for model switching
  bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
    const key = ctx.match![1];
    const registry = getRegistry();

    if (registry.switchTo(key)) {
      const provider = registry.get(key)!;
      const info = provider.getInfo();

      // Update the keyboard to show new selection
      const providers = await registry.listAll();
      const keyboard = new InlineKeyboard();
      for (const p of providers) {
        const label = p.active ? `✅ ${p.name}` : p.name;
        keyboard.text(label, `model:${p.key}`).row();
      }

      await ctx.editMessageText(
        `🤖 *Choose model:*\n\nActive: *${info.name}*`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      await ctx.answerCallbackQuery(`Switched: ${info.name}`);
    } else {
      await ctx.answerCallbackQuery(`Model "${key}" not found`);
    }
  });

  // ── Fallback Order ────────────────────────────────────────────────────

  bot.command("fallback", async (ctx) => {
    const { getFallbackOrder, setFallbackOrder, formatOrder } = await import("../services/fallback-order.js");
    const { getHealthStatus } = await import("../services/heartbeat.js");
    const registry = getRegistry();

    const arg = ctx.match?.trim();

    if (!arg) {
      // Show current order with inline keyboard
      const order = getFallbackOrder();
      const health = getHealthStatus();
      const healthMap = new Map(health.map(h => [h.key, h]));

      const allKeys = [order.primary, ...order.fallbacks];
      const keyboard = new InlineKeyboard();

      for (let i = 0; i < allKeys.length; i++) {
        const key = allKeys[i];
        const h = healthMap.get(key);
        const status = h ? (h.healthy ? "✅" : "❌") : "❓";
        const label = i === 0 ? `🥇 ${key} ${status}` : `${i + 1}. ${key} ${status}`;

        if (i > 0) keyboard.text("⬆️", `fb:up:${key}`);
        keyboard.text(label, `fb:info:${key}`);
        if (i < allKeys.length - 1) keyboard.text("⬇️", `fb:down:${key}`);
        keyboard.row();
      }

      const text = `🔄 *Fallback Order*\n\n` +
        `Providers are tried in this order.\n` +
        `Use ⬆️/⬇️ to reorder.\n\n` +
        `_Last changed: ${order.updatedBy} (${new Date(order.updatedAt).toLocaleString("en-US")})_`;

      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
      return;
    }

    // Direct text commands: /fallback set groq,openai,nvidia-llama-3.3-70b
    if (arg.startsWith("set ")) {
      const parts = arg.slice(4).split(",").map(s => s.trim()).filter(Boolean);
      if (parts.length < 1) {
        await ctx.reply("Usage: `/fallback set primary,fallback1,fallback2,...`", { parse_mode: "Markdown" });
        return;
      }
      const [primary, ...fallbacks] = parts;
      setFallbackOrder(primary, fallbacks, "telegram");
      await ctx.reply(`✅ New order:\n\n${formatOrder()}`);
      return;
    }

    await ctx.reply(
      `🔄 *Fallback Order*\n\n` +
      `\`/fallback\` — Show & change order\n` +
      `\`/fallback set groq,openai,...\` — Set directly`,
      { parse_mode: "Markdown" }
    );
  });

  // Callback queries for fallback ordering
  bot.callbackQuery(/^fb:up:(.+)$/, async (ctx) => {
    const { moveUp, formatOrder, getFallbackOrder } = await import("../services/fallback-order.js");
    const { getHealthStatus } = await import("../services/heartbeat.js");
    const key = ctx.match![1];

    moveUp(key, "telegram");
    const order = getFallbackOrder();
    const health = getHealthStatus();
    const healthMap = new Map(health.map(h => [h.key, h]));

    const allKeys = [order.primary, ...order.fallbacks];
    const keyboard = new InlineKeyboard();

    for (let i = 0; i < allKeys.length; i++) {
      const k = allKeys[i];
      const h = healthMap.get(k);
      const status = h ? (h.healthy ? "✅" : "❌") : "❓";
      const label = i === 0 ? `🥇 ${k} ${status}` : `${i + 1}. ${k} ${status}`;

      if (i > 0) keyboard.text("⬆️", `fb:up:${k}`);
      keyboard.text(label, `fb:info:${k}`);
      if (i < allKeys.length - 1) keyboard.text("⬇️", `fb:down:${k}`);
      keyboard.row();
    }

    await ctx.editMessageText(
      `🔄 *Fallback-Reihenfolge*\n\n` +
      `Provider werden in dieser Reihenfolge versucht.\n` +
      `Nutze ⬆️/⬇️ zum Umsortieren.\n\n` +
      `_Last changed: telegram (${new Date().toLocaleString("en-US")})_`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
    await ctx.answerCallbackQuery(`${key} moved up`);
  });

  bot.callbackQuery(/^fb:down:(.+)$/, async (ctx) => {
    const { moveDown, getFallbackOrder } = await import("../services/fallback-order.js");
    const { getHealthStatus } = await import("../services/heartbeat.js");
    const key = ctx.match![1];

    moveDown(key, "telegram");
    const order = getFallbackOrder();
    const health = getHealthStatus();
    const healthMap = new Map(health.map(h => [h.key, h]));

    const allKeys = [order.primary, ...order.fallbacks];
    const keyboard = new InlineKeyboard();

    for (let i = 0; i < allKeys.length; i++) {
      const k = allKeys[i];
      const h = healthMap.get(k);
      const status = h ? (h.healthy ? "✅" : "❌") : "❓";
      const label = i === 0 ? `🥇 ${k} ${status}` : `${i + 1}. ${k} ${status}`;

      if (i > 0) keyboard.text("⬆️", `fb:up:${k}`);
      keyboard.text(label, `fb:info:${k}`);
      if (i < allKeys.length - 1) keyboard.text("⬇️", `fb:down:${k}`);
      keyboard.row();
    }

    await ctx.editMessageText(
      `🔄 *Fallback-Reihenfolge*\n\n` +
      `Provider werden in dieser Reihenfolge versucht.\n` +
      `Nutze ⬆️/⬇️ zum Umsortieren.\n\n` +
      `_Last changed: telegram (${new Date().toLocaleString("en-US")})_`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
    await ctx.answerCallbackQuery(`${key} moved down`);
  });

  bot.callbackQuery(/^fb:info:(.+)$/, async (ctx) => {
    const { getHealthStatus } = await import("../services/heartbeat.js");
    const key = ctx.match![1];
    const health = getHealthStatus();
    const h = health.find(p => p.key === key);

    if (h) {
      await ctx.answerCallbackQuery({
        text: `${key}: ${h.healthy ? "✅ Healthy" : "❌ Unhealthy"} | ${h.latencyMs}ms | Errors: ${h.failCount}`,
        show_alert: true,
      });
    } else {
      await ctx.answerCallbackQuery(`${key}: Not checked yet`);
    }
  });

  bot.command("web", async (ctx) => {
    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply("Search: `/web your search query`", { parse_mode: "Markdown" });
      return;
    }

    await ctx.api.sendChatAction(ctx.chat!.id, "typing");

    try {
      // Use DuckDuckGo instant answer API (no key needed)
      const encoded = encodeURIComponent(query);
      const res = await fetch(`https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`);
      const data = await res.json() as {
        AbstractText?: string;
        AbstractSource?: string;
        AbstractURL?: string;
        Answer?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };

      const lines: string[] = [];

      if (data.Answer) {
        lines.push(`💡 *${data.Answer}*\n`);
      }

      if (data.AbstractText) {
        const text = data.AbstractText.length > 500
          ? data.AbstractText.slice(0, 500) + "..."
          : data.AbstractText;
        lines.push(text);
        if (data.AbstractSource && data.AbstractURL) {
          lines.push(`\n_Source: [${data.AbstractSource}](${data.AbstractURL})_`);
        }
      }

      if (lines.length === 0 && data.RelatedTopics && data.RelatedTopics.length > 0) {
        lines.push(`🔍 *Results for "${query}":*\n`);
        for (const topic of data.RelatedTopics.slice(0, 5)) {
          if (topic.Text) {
            const short = topic.Text.length > 150 ? topic.Text.slice(0, 150) + "..." : topic.Text;
            lines.push(`• ${short}`);
          }
        }
      }

      if (lines.length === 0) {
        lines.push(`No results for "${query}". Try it as a regular message — I'll search using the AI model.`);
      }

      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() =>
        ctx.reply(lines.join("\n"))
      );
    } catch (err) {
      await ctx.reply(`Search error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command("imagine", async (ctx) => {
    const prompt = ctx.match?.trim();
    if (!prompt) {
      await ctx.reply("Describe what I should generate:\n`/imagine A fox sitting on the moon`", { parse_mode: "Markdown" });
      return;
    }

    if (!config.apiKeys.google) {
      await ctx.reply("⚠️ Image generation unavailable (GOOGLE_API_KEY missing).");
      return;
    }

    await ctx.api.sendChatAction(ctx.chat!.id, "upload_photo");

    const result = await generateImage(prompt, config.apiKeys.google);

    if (result.success && result.filePath) {
      try {
        const fileData = fs.readFileSync(result.filePath);
        await ctx.replyWithPhoto(new InputFile(fileData, `generated${result.filePath.endsWith(".png") ? ".png" : ".jpg"}`), {
          caption: `🎨 _${prompt}_`,
          parse_mode: "Markdown",
        });
        fs.unlink(result.filePath, () => {});
      } catch (err) {
        await ctx.reply(`Error sending: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      await ctx.reply(`❌ ${result.error || "Image generation failed."}`);
    }
  });

  bot.command("remind", async (ctx) => {
    const userId = ctx.from!.id;
    const chatId = ctx.chat!.id;
    const input = ctx.match?.trim();

    if (!input) {
      // List reminders
      const pending = listReminders(userId);
      if (pending.length === 0) {
        await ctx.reply("No active reminders.\n\nNew: `/remind 30m Call mom`", { parse_mode: "Markdown" });
      } else {
        const lines = pending.map(r => `• *${r.remaining}* — ${r.text} (ID: ${r.id})`);
        await ctx.reply(
          `⏰ *Active Reminders:*\n\n${lines.join("\n")}\n\nCancel: \`/remind cancel <ID>\``,
          { parse_mode: "Markdown" }
        );
      }
      return;
    }

    // Cancel a reminder
    if (input.startsWith("cancel ")) {
      const id = parseInt(input.slice(7).trim());
      if (isNaN(id)) {
        await ctx.reply("Invalid ID. Use: `/remind cancel <ID>`", { parse_mode: "Markdown" });
        return;
      }
      if (cancelReminder(id, userId)) {
        await ctx.reply(`✅ Reminder #${id} cancelled.`);
      } else {
        await ctx.reply(`❌ Reminder #${id} not found.`);
      }
      return;
    }

    // Parse: /remind <duration> <text>
    const spaceIdx = input.indexOf(" ");
    if (spaceIdx === -1) {
      await ctx.reply("Format: `/remind 30m Reminder text`", { parse_mode: "Markdown" });
      return;
    }

    const durationStr = input.slice(0, spaceIdx);
    const text = input.slice(spaceIdx + 1).trim();
    const delayMs = parseDuration(durationStr);

    if (!delayMs) {
      await ctx.reply("Invalid duration. Examples: `30s`, `5m`, `2h`, `1d`", { parse_mode: "Markdown" });
      return;
    }

    if (!text) {
      await ctx.reply("Please provide text: `/remind 30m Call mom`", { parse_mode: "Markdown" });
      return;
    }

    const reminder = createReminder(chatId, userId, text, delayMs, ctx.api);

    // Format trigger time
    const triggerDate = new Date(reminder.triggerAt);
    const timeStr = triggerDate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    await ctx.reply(`✅ Reminder set for *${timeStr}*: ${text}`, { parse_mode: "Markdown" });
  });

  bot.command("export", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);

    if (session.history.length === 0 && !session.sessionId) {
      await ctx.reply("No conversation data to export.");
      return;
    }

    // Build export text
    const lines: string[] = [
      `# Alvin Bot — Conversation Export`,
      `Date: ${new Date().toLocaleString("en-US")}`,
      `Messages: ${session.messageCount}`,
      `Cost: $${session.totalCost.toFixed(4)}`,
      `---\n`,
    ];

    for (const msg of session.history) {
      const role = msg.role === "user" ? "👤 User" : "🤖 Alvin Bot";
      lines.push(`### ${role}\n${msg.content}\n`);
    }

    if (session.history.length === 0) {
      lines.push("(SDK session — history managed internally, no export available)\n");
    }

    const exportText = lines.join("\n");
    const buffer = Buffer.from(exportText, "utf-8");
    const filename = `chat-export-${new Date().toISOString().slice(0, 10)}.md`;

    await ctx.replyWithDocument(new InputFile(buffer, filename), {
      caption: `📄 Export: ${session.history.length} messages`,
    });
  });

  bot.command("lang", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    const arg = ctx.match?.trim().toLowerCase();

    if (!arg) {
      const keyboard = new InlineKeyboard()
        .text(session.language === "de" ? "✅ Deutsch" : "Deutsch", "lang:de")
        .text(session.language === "en" ? "✅ English" : "English", "lang:en")
        .row()
        .text("🔄 Auto-detect", "lang:auto");

      await ctx.reply(`🌐 *Sprache / Language:* ${session.language === "de" ? "Deutsch" : "English"}`, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
      return;
    }

    if (arg === "auto") {
      const { resetToAutoLanguage } = await import("../services/language-detect.js");
      resetToAutoLanguage(userId);
      await ctx.reply("🔄 Auto-detection enabled. I'll adapt to the language you write in.");
    } else if (arg === "de" || arg === "en") {
      session.language = arg;
      const { setExplicitLanguage } = await import("../services/language-detect.js");
      setExplicitLanguage(userId, arg);
      await ctx.reply(arg === "de" ? "✅ Sprache: Deutsch (fixiert)" : "✅ Language: English (fixed)");
    } else {
      await ctx.reply("Use: `/lang de`, `/lang en`, or `/lang auto`", { parse_mode: "Markdown" });
    }
  });

  bot.callbackQuery(/^lang:(de|en|auto)$/, async (ctx) => {
    const choice = ctx.match![1];
    const userId = ctx.from!.id;
    const session = getSession(userId);

    if (choice === "auto") {
      const { resetToAutoLanguage } = await import("../services/language-detect.js");
      resetToAutoLanguage(userId);
      await ctx.answerCallbackQuery({ text: "🔄 Auto-detect enabled" });
      await ctx.editMessageText("🌐 *Language:* Auto-detect 🔄", { parse_mode: "Markdown" });
      return;
    }

    const lang = choice as "de" | "en";
    session.language = lang;
    const { setExplicitLanguage } = await import("../services/language-detect.js");
    setExplicitLanguage(userId, lang);

    const keyboard = new InlineKeyboard()
      .text(lang === "de" ? "✅ Deutsch" : "Deutsch", "lang:de")
      .text(lang === "en" ? "✅ English" : "English", "lang:en");

    await ctx.editMessageText(`🌐 *Sprache / Language:* ${lang === "de" ? "Deutsch" : "English"}`, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery(lang === "de" ? "Deutsch" : "English");
  });

  bot.command("memory", async (ctx) => {
    const stats = getMemoryStats();
    const arg = ctx.match?.trim();

    if (!arg) {
      await ctx.reply(
        `🧠 *Memory*\n\n` +
        `*Long-term memory:* ${formatBytes(stats.longTermSize)}\n` +
        `*Daily logs:* ${stats.dailyLogs} files\n` +
        `*Today:* ${stats.todayEntries} entries\n\n` +
        `_Memory is automatically written on /new._\n` +
        `_Non-SDK providers load memory as context._`,
        { parse_mode: "Markdown" }
      );
      return;
    }
  });

  bot.command("system", async (ctx) => {
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memUsed = memTotal - memFree;
    const memPercent = Math.round((memUsed / memTotal) * 100);

    const uptime = os.uptime();
    const uptimeH = Math.floor(uptime / 3600);
    const uptimeM = Math.floor((uptime % 3600) / 60);

    const cpus = os.cpus();
    const loadAvg = os.loadavg();

    const procMem = process.memoryUsage();

    await ctx.reply(
      `🖥 *System Info*\n\n` +
      `*OS:* ${os.platform()} ${os.arch()} (${os.release()})\n` +
      `*Host:* ${os.hostname()}\n` +
      `*CPUs:* ${cpus.length}x ${cpus[0]?.model?.trim() || "unknown"}\n` +
      `*Load:* ${loadAvg.map(l => l.toFixed(2)).join(", ")}\n` +
      `*RAM:* ${formatBytes(memUsed)} / ${formatBytes(memTotal)} (${memPercent}%)\n` +
      `*System Uptime:* ${uptimeH}h ${uptimeM}m\n\n` +
      `🤖 *Bot Process*\n` +
      `*Node:* ${process.version}\n` +
      `*Heap:* ${formatBytes(procMem.heapUsed)} / ${formatBytes(procMem.heapTotal)}\n` +
      `*RSS:* ${formatBytes(procMem.rss)}\n` +
      `*PID:* ${process.pid}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("reload", async (ctx) => {
    const success = reloadSoul();
    await ctx.reply(success ? "✅ SOUL.md reloaded." : "❌ SOUL.md not found.");
  });

  // ── Access Control ────────────────────────────────

  // Callback for group approval/block
  bot.callbackQuery(/^access:(approve|block):(-?\d+)$/, async (ctx) => {
    const action = ctx.match![1];
    const chatId = parseInt(ctx.match![2]);

    if (action === "approve") {
      approveGroup(chatId);
      await ctx.editMessageText(`✅ Group ${chatId} approved. Alvin Bot will now respond there.`);
      // Notify the group
      try {
        await ctx.api.sendMessage(chatId, "👋 Alvin Bot is now active in this group!\n\n@mention me or reply to my messages.");
      } catch { /* group might not allow bot messages yet */ }
    } else {
      blockGroup(chatId);
      await ctx.editMessageText(`🚫 Group ${chatId} blocked. Alvin Bot will ignore this group.`);
    }
    await ctx.answerCallbackQuery();
  });

  bot.command("groups", async (ctx) => {
    const groups = listGroups();

    if (groups.length === 0) {
      await ctx.reply("No groups registered.");
      return;
    }

    const lines = groups.map(g => {
      const status = g.status === "approved" ? "✅" : g.status === "blocked" ? "🚫" : "⏳";
      return `${status} *${g.title}* (${g.messageCount} msgs)\n   ID: \`${g.chatId}\``;
    });

    const keyboard = new InlineKeyboard();
    for (const g of groups) {
      if (g.status === "approved") {
        keyboard.text(`🚫 Block: ${g.title.slice(0, 20)}`, `access:block:${g.chatId}`).row();
      } else if (g.status === "blocked" || g.status === "pending") {
        keyboard.text(`✅ Approve: ${g.title.slice(0, 20)}`, `access:approve:${g.chatId}`).row();
      }
    }

    const settings = getSettings();
    await ctx.reply(
      `🔐 *Group Management*\n\n` +
      `${lines.join("\n\n")}\n\n` +
      `⚙️ *Settings:*\n` +
      `Forwards: ${settings.allowForwards ? "✅" : "❌"}\n` +
      `Auto-Approve: ${settings.autoApproveGroups ? "⚠️ ON" : "✅ OFF"}`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  });

  bot.command("security", async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase();
    const settings = getSettings();

    if (!arg) {
      await ctx.reply(
        `🔐 *Security Settings*\n\n` +
        `*Forwards:* ${settings.allowForwards ? "✅ allowed" : "❌ blocked"}\n` +
        `*Auto-Approve Groups:* ${settings.autoApproveGroups ? "⚠️ ON (dangerous!)" : "✅ OFF"}\n` +
        `*Group Rate Limit:* ${settings.groupRateLimitPerHour}/h\n\n` +
        `Change:\n` +
        `\`/security forwards on|off\`\n` +
        `\`/security autoapprove on|off\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (arg.startsWith("forwards ")) {
      const val = arg.slice(9).trim();
      setForwardingAllowed(val === "on" || val === "true");
      await ctx.reply(`✅ Forwards: ${val === "on" || val === "true" ? "allowed" : "blocked"}`);
    } else if (arg.startsWith("autoapprove ")) {
      const val = arg.slice(12).trim();
      setAutoApprove(val === "on" || val === "true");
      await ctx.reply(`${val === "on" || val === "true" ? "⚠️" : "✅"} Auto-Approve: ${val === "on" || val === "true" ? "ON" : "OFF"}`);
    } else {
      await ctx.reply("Unknown. Use `/security` for options.", { parse_mode: "Markdown" });
    }
  });

  // ── Browser Automation ─────────────────────────────────

  bot.command("browse", async (ctx) => {
    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply(
        "🌐 *Browser Commands:*\n\n" +
        "`/browse <URL>` — Screenshot a webpage\n" +
        "`/browse text <URL>` — Extract text\n" +
        "`/browse pdf <URL>` — Save as PDF",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (!hasPlaywright()) {
      await ctx.reply(
        "❌ Playwright not installed.\n`npm install playwright && npx playwright install chromium`",
        { parse_mode: "Markdown" }
      );
      return;
    }

    try {
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");

      // /browse text <url>
      if (arg.startsWith("text ")) {
        const url = arg.slice(5).trim();
        const text = await extractText(url);
        const truncated = text.length > 3500 ? text.slice(0, 3500) + "\n\n_[...truncated]_" : text;
        await ctx.reply(`🌐 *Text from ${url}:*\n\n${truncated}`, { parse_mode: "Markdown" });
        return;
      }

      // /browse pdf <url>
      if (arg.startsWith("pdf ")) {
        const url = arg.slice(4).trim();
        await ctx.api.sendChatAction(ctx.chat!.id, "upload_document");
        const pdfPath = await generatePdf(url);
        await ctx.replyWithDocument(new InputFile(fs.readFileSync(pdfPath), "page.pdf"), {
          caption: `📄 PDF from ${url}`,
        });
        fs.unlink(pdfPath, () => {});
        return;
      }

      // Default: screenshot
      const url = arg.startsWith("http") ? arg : `https://${arg}`;
      await ctx.api.sendChatAction(ctx.chat!.id, "upload_photo");
      const screenshotPath = await screenshotUrl(url, { fullPage: false });
      await ctx.replyWithPhoto(new InputFile(fs.readFileSync(screenshotPath), "screenshot.png"), {
        caption: `🌐 ${url}`,
      });
      fs.unlink(screenshotPath, () => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Browser error: ${msg}`);
    }
  });

  // ── Custom Tools ──────────────────────────────────────

  bot.command("tools", async (ctx) => {
    const arg = ctx.match?.toString().trim();

    // /tools run <name> [params json]
    if (arg?.startsWith("run ")) {
      const parts = arg.slice(4).trim().split(/\s+/);
      const toolName = parts[0];
      let params: Record<string, unknown> = {};
      if (parts.length > 1) {
        try { params = JSON.parse(parts.slice(1).join(" ")); } catch {
          await ctx.reply("❌ Invalid JSON for parameters.", { parse_mode: "Markdown" });
          return;
        }
      }

      try {
        await ctx.api.sendChatAction(ctx.chat!.id, "typing");
        const result = await executeCustomTool(toolName, params);
        const truncated = result.length > 3000 ? result.slice(0, 3000) + "\n..." : result;
        await ctx.reply(`🔧 *${toolName}:*\n\`\`\`\n${truncated}\n\`\`\``, { parse_mode: "Markdown" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ Tool error: ${msg}`);
      }
      return;
    }

    // /tools — list all
    const tools = listCustomTools();
    if (tools.length === 0) {
      await ctx.reply(
        "🔧 *Custom Tools*\n\n" +
        "No tools configured.\n" +
        "Create `TOOLS.md` (see `TOOLS.example.md`).",
        { parse_mode: "Markdown" }
      );
      return;
    }

    const lines = tools.map(t => {
      const icon = t.type === "http" ? "🌐" : "⚡";
      return `${icon} \`${t.name}\` — ${t.description}`;
    });

    await ctx.reply(
      `🔧 *Custom Tools (${tools.length}):*\n\n${lines.join("\n")}\n\n` +
      `_Run: \`/tools run <name> {"param":"value"}\`_`,
      { parse_mode: "Markdown" }
    );
  });

  // ── MCP ────────────────────────────────────────────────

  bot.command("mcp", async (ctx) => {
    const arg = ctx.match?.toString().trim();

    // /mcp call <server> <tool> <json-args>
    if (arg?.startsWith("call ")) {
      const parts = arg.slice(5).trim().split(/\s+/);
      if (parts.length < 2) {
        await ctx.reply("Format: `/mcp call <server> <tool> {\"arg\":\"value\"}`", { parse_mode: "Markdown" });
        return;
      }
      const [server, tool, ...rest] = parts;
      let args: Record<string, unknown> = {};
      if (rest.length > 0) {
        try { args = JSON.parse(rest.join(" ")); } catch {
          await ctx.reply("❌ Invalid JSON for tool arguments.");
          return;
        }
      }
      try {
        await ctx.api.sendChatAction(ctx.chat!.id, "typing");
        const result = await callMCPTool(server, tool, args);
        const truncated = result.length > 3000 ? result.slice(0, 3000) + "\n..." : result;
        await ctx.reply(`🔧 *${server}/${tool}:*\n\`\`\`\n${truncated}\n\`\`\``, { parse_mode: "Markdown" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ MCP error: ${msg}`);
      }
      return;
    }

    // Default: show status
    const mcpServers = getMCPStatus();
    const tools = getMCPTools();

    if (mcpServers.length === 0) {
      await ctx.reply(
        `🔌 *MCP (Model Context Protocol)*\n\n` +
        `No servers configured.\n` +
        `Create \`docs/mcp.json\` (see \`docs/mcp.example.json\`).`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const serverLines = mcpServers.map(s => {
      const status = s.connected ? "🟢" : "🔴";
      return `${status} *${s.name}* — ${s.tools} Tools`;
    });

    const toolLines = tools.length > 0
      ? "\n\n*Available Tools:*\n" + tools.map(t => `  🔧 \`${t.server}/${t.name}\` — ${t.description}`).join("\n")
      : "";

    await ctx.reply(
      `🔌 *MCP Server (${mcpServers.length}):*\n\n` +
      serverLines.join("\n") +
      toolLines +
      `\n\n_Use \`/mcp call <server> <tool> {args}\` to execute._`,
      { parse_mode: "Markdown" }
    );
  });

  // ── Plugins ───────────────────────────────────────────

  bot.command("plugins", async (ctx) => {
    const plugins = getLoadedPlugins();

    if (plugins.length === 0) {
      await ctx.reply(
        `🔌 No plugins loaded.\n\n` +
        `Place plugins in \`${getPluginsDir()}/\`.\n` +
        `Each plugin needs a folder with \`index.js\`.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const lines = plugins.map(p => {
      const cmds = p.commands.length > 0 ? `\n   Commands: ${p.commands.join(", ")}` : "";
      const tools = p.tools.length > 0 ? `\n   Tools: ${p.tools.join(", ")}` : "";
      return `🔌 *${p.name}* v${p.version}\n   ${p.description}${cmds}${tools}`;
    });

    await ctx.reply(`🔌 *Loaded Plugins (${plugins.length}):*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
  });

  // ── Skills ─────────────────────────────────────────────

  bot.command("skills", async (ctx) => {
    const { getSkills } = await import("../services/skills.js");
    const skills = getSkills();
    if (skills.length === 0) {
      await ctx.reply("🎯 No skills installed.\n\nAdd SKILL.md files to the `skills/` directory.", { parse_mode: "HTML" });
      return;
    }
    const lines = skills.map(s =>
      `🎯 <b>${s.name}</b> (${s.category})\n   ${s.description || "(no description)"}\n   Triggers: ${s.triggers.slice(0, 5).join(", ")}`
    );
    await ctx.reply(`🎯 <b>Skills (${skills.length}):</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  });

  // ── User Profiles ─────────────────────────────────────

  bot.command("users", async (ctx) => {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      await ctx.reply("No user profiles saved yet.");
      return;
    }

    const lines = profiles.map(p => {
      const lastActive = new Date(p.lastActive).toLocaleDateString("en-US");
      const badge = p.isOwner ? "👑" : "👤";
      return `${badge} *${p.name}*${p.username ? ` (@${p.username})` : ""}\n   ${p.totalMessages} messages, last active: ${lastActive}`;
    });

    await ctx.reply(`👥 *User-Profile (${profiles.length}):*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
  });

  bot.command("note", async (ctx) => {
    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply("📝 Use: `/note @username Note text`\nSaves a note about a user.", { parse_mode: "Markdown" });
      return;
    }

    // Parse @username or userId + note text
    const match = arg.match(/^@?(\S+)\s+(.+)$/s);
    if (!match) {
      await ctx.reply("Format: `/note @username Text`", { parse_mode: "Markdown" });
      return;
    }

    const [, target, noteText] = match;
    const profiles = listProfiles();
    const profile = profiles.find(p =>
      p.username === target || p.userId.toString() === target || p.name.toLowerCase() === target.toLowerCase()
    );

    if (!profile) {
      await ctx.reply(`User "${target}" not found.`);
      return;
    }

    addUserNote(profile.userId, noteText);
    await ctx.reply(`📝 Note saved for ${profile.name}.`);
  });

  // ── Memory Search Commands ───────────────────────────

  bot.command("recall", async (ctx) => {
    const query = ctx.match?.toString().trim();
    if (!query) {
      await ctx.reply("🔍 Use: `/recall <search term>`\nSemantic search through my memory.", { parse_mode: "Markdown" });
      return;
    }

    try {
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      const results = await searchMemory(query, 5, 0.25);

      if (results.length === 0) {
        await ctx.reply(`🔍 No memories found for "${query}".`);
        return;
      }

      const lines = results.map((r, i) => {
        const score = Math.round(r.score * 100);
        const preview = r.text.length > 200 ? r.text.slice(0, 200) + "..." : r.text;
        return `**${i + 1}.** (${score}%) _${r.source}_\n${preview}`;
      });

      await ctx.reply(`🧠 Memories for "${query}":\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Recall error: ${msg}`);
    }
  });

  bot.command("remember", async (ctx) => {
    const text = ctx.match?.toString().trim();
    if (!text) {
      await ctx.reply("💾 Use: `/remember <text>`\nSaves something to my memory.", { parse_mode: "Markdown" });
      return;
    }

    try {
      appendDailyLog(`**Manually remembered:** ${text}`);
      // Trigger reindex so the new entry is searchable
      const stats = await reindexMemory();
      await ctx.reply(`💾 Remembered! (${stats.total} entries in index)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Error saving: ${msg}`);
    }
  });

  bot.command("reindex", async (ctx) => {
    try {
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      const stats = await reindexMemory(true);
      const indexStats = getIndexStats();
      const sizeKB = (indexStats.sizeBytes / 1024).toFixed(1);
      await ctx.reply(
        `🔄 Memory re-indexed!\n\n` +
        `📊 ${stats.indexed} chunks processed\n` +
        `📁 ${indexStats.files} files indexed\n` +
        `🧠 ${stats.total} total entries\n` +
        `💾 Index size: ${sizeKB} KB`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Reindex error: ${msg}`);
    }
  });

  // ── Cron Jobs ──────────────────────────────────────────

  bot.command("cron", async (ctx) => {
    const arg = ctx.match?.toString().trim() || "";
    const userId = ctx.from!.id;
    const chatId = ctx.chat!.id;

    // /cron — list all jobs
    if (!arg) {
      const jobs = listJobs();
      if (jobs.length === 0) {
        await ctx.reply(
          "⏰ <b>Cron Jobs</b>\n\nNo jobs configured.\n\n" +
          "Create:\n" +
          "<code>/cron add 5m reminder Wasser trinken</code>\n" +
          "<code>/cron add \"0 9 * * 1\" shell pm2 status</code>\n" +
          "<code>/cron add 1h http https://api.example.com/health</code>\n\n" +
          "<i>Manage jobs also in the Web UI under ⏰ Cron.</i>",
          { parse_mode: "HTML" }
        );
        return;
      }

      const lines = jobs.map(j => {
        const status = j.enabled ? "🟢" : "⏸️";
        const next = j.enabled ? formatNextRun(j.nextRunAt) : "paused";
        const lastErr = j.lastError ? " ⚠️" : "";
        const readable = humanReadableSchedule(j.schedule);
        const recur = j.oneShot ? "⚡ One-shot" : "🔄 " + readable;
        return `${status} <b>${j.name}</b>\n   📅 ${recur} | Next: ${next}\n   Runs: ${j.runCount}${lastErr} | ID: <code>${j.id}</code>`;
      });

      const keyboard = new InlineKeyboard();
      for (const j of jobs) {
        const label = j.enabled ? `⏸ ${j.name}` : `▶️ ${j.name}`;
        keyboard.text(label, `cron:toggle:${j.id}`);
        keyboard.text(`🗑`, `cron:delete:${j.id}`);
        keyboard.row();
      }

      await ctx.reply(
        `⏰ <b>Cron Jobs (${jobs.length}):</b>\n\n${lines.join("\n\n")}\n\n` +
        `Commands: /cron add · delete · toggle · run · info`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
      return;
    }

    // /cron add <schedule> <type> <payload>
    if (arg.startsWith("add ")) {
      const rest = arg.slice(4).trim();

      // Natural language schedule shortcuts (German + English)
      const naturalSchedules: Record<string, string> = {
        "täglich": "0 8 * * *", "daily": "0 8 * * *",
        "stündlich": "0 * * * *", "hourly": "0 * * * *",
        "wöchentlich": "0 8 * * 1", "weekly": "0 8 * * 1",
        "monatlich": "0 8 1 * *", "monthly": "0 8 1 * *",
        "werktags": "0 8 * * 1-5", "weekdays": "0 8 * * 1-5",
        "wochenende": "0 10 * * 0,6", "weekend": "0 10 * * 0,6",
        "montags": "0 8 * * 1", "dienstags": "0 8 * * 2", "mittwochs": "0 8 * * 3",
        "donnerstags": "0 8 * * 4", "freitags": "0 8 * * 5", "samstags": "0 10 * * 6", "sonntags": "0 10 * * 0",
        "morgens": "0 8 * * *", "mittags": "0 12 * * *", "abends": "0 18 * * *", "nachts": "0 0 * * *",
      };

      // Time-prefixed natural: "8:30 täglich" or "täglich 8:30"
      function resolveNatural(input: string): { schedule: string; rest: string } | null {
        // Try "HH:MM keyword rest" or "keyword HH:MM rest"
        const timeKeyword = input.match(/^(\d{1,2}):(\d{2})\s+(\S+)\s*(.*)/);
        if (timeKeyword) {
          const key = timeKeyword[3].toLowerCase();
          if (naturalSchedules[key]) {
            const base = naturalSchedules[key].split(" ");
            base[0] = String(parseInt(timeKeyword[2]));
            base[1] = String(parseInt(timeKeyword[1]));
            return { schedule: base.join(" "), rest: timeKeyword[4] };
          }
        }
        const keywordTime = input.match(/^(\S+)\s+(\d{1,2}):(\d{2})\s*(.*)/);
        if (keywordTime) {
          const key = keywordTime[1].toLowerCase();
          if (naturalSchedules[key]) {
            const base = naturalSchedules[key].split(" ");
            base[0] = String(parseInt(keywordTime[3]));
            base[1] = String(parseInt(keywordTime[2]));
            return { schedule: base.join(" "), rest: keywordTime[4] };
          }
        }
        // Simple keyword
        const firstWord = input.split(" ")[0].toLowerCase();
        if (naturalSchedules[firstWord]) {
          return { schedule: naturalSchedules[firstWord], rest: input.slice(firstWord.length).trim() };
        }
        return null;
      }

      // Parse: schedule can be "5m", natural keyword, or "0 9 * * 1" (quoted)
      let schedule: string;
      let remainder: string;

      const natural = resolveNatural(rest);
      if (natural) {
        schedule = natural.schedule;
        remainder = natural.rest;
      } else if (rest.startsWith('"')) {
        const endQuote = rest.indexOf('"', 1);
        if (endQuote < 0) { await ctx.reply("❌ Missing closing quote for cron expression."); return; }
        schedule = rest.slice(1, endQuote);
        remainder = rest.slice(endQuote + 1).trim();
      } else {
        const sp = rest.indexOf(" ");
        if (sp < 0) { await ctx.reply("Format: <code>/cron add &lt;schedule&gt; &lt;type&gt; &lt;payload&gt;</code>\n\nSchedule options:\n• <b>Intervals:</b> 5m, 1h, 30s, 2d\n• <b>Natural:</b> daily, weekly, monthly, weekdays, hourly\n• <b>With time:</b> 8:30 daily, weekdays 9:00\n• <b>German:</b> täglich, wöchentlich, morgens, abends\n• <b>Cron:</b> \"0 9 * * 1-5\"", { parse_mode: "HTML" }); return; }
        schedule = rest.slice(0, sp);
        remainder = rest.slice(sp + 1).trim();
      }

      // Parse type + payload
      const typeSp = remainder.indexOf(" ");
      const typeStr = typeSp >= 0 ? remainder.slice(0, typeSp) : remainder;
      const payloadStr = typeSp >= 0 ? remainder.slice(typeSp + 1).trim() : "";

      const validTypes = ["reminder", "shell", "http", "message", "ai-query"];
      if (!validTypes.includes(typeStr)) {
        await ctx.reply(`❌ Invalid type "${typeStr}". Allowed: ${validTypes.join(", ")}`);
        return;
      }

      const payload: Record<string, string> = {};
      switch (typeStr) {
        case "reminder": case "message": payload.text = payloadStr; break;
        case "shell": payload.command = payloadStr; break;
        case "http": payload.url = payloadStr; break;
        case "ai-query": payload.prompt = payloadStr; break;
      }

      const name = `${typeStr}: ${payloadStr.slice(0, 30)}${payloadStr.length > 30 ? "..." : ""}`;

      const job = createJob({
        name,
        type: typeStr as JobType,
        schedule,
        payload,
        target: { platform: "telegram", chatId: String(chatId) },
        createdBy: `telegram:${userId}`,
      });

      const readableSched = humanReadableSchedule(job.schedule);
      await ctx.reply(
        `✅ <b>Cron Job created</b>\n\n` +
        `<b>Name:</b> ${job.name}\n` +
        `📅 <b>${readableSched}</b>\n` +
        `<b>Type:</b> ${job.type}\n` +
        `<b>Next run:</b> ${formatNextRun(job.nextRunAt)}\n` +
        `<b>ID:</b> <code>${job.id}</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // /cron delete <id>
    if (arg.startsWith("delete ")) {
      const id = arg.slice(7).trim();
      if (deleteJob(id)) {
        await ctx.reply(`✅ Job \`${id}\` deleted.`, { parse_mode: "Markdown" });
      } else {
        await ctx.reply(`❌ Job \`${id}\` not found.`, { parse_mode: "Markdown" });
      }
      return;
    }

    // /cron toggle <id>
    if (arg.startsWith("toggle ")) {
      const id = arg.slice(7).trim();
      const job = toggleJob(id);
      if (job) {
        await ctx.reply(`${job.enabled ? "▶️" : "⏸️"} Job "${job.name}" ${job.enabled ? "enabled" : "paused"}.`);
      } else {
        await ctx.reply(`❌ Job not found.`);
      }
      return;
    }

    // /cron run <id>
    if (arg.startsWith("run ")) {
      const id = arg.slice(4).trim();
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      const result = await (runJobNow(id) || Promise.resolve(null));
      if (!result) {
        await ctx.reply(`❌ Job not found.`);
        return;
      }
      const output = result.output ? `\`\`\`\n${result.output.slice(0, 2000)}\n\`\`\`` : "(no output)";
      await ctx.reply(`🔧 Job executed:\n${output}${result.error ? `\n\n❌ ${result.error}` : ""}`, { parse_mode: "Markdown" });
      return;
    }

    await ctx.reply("Unknown cron command. Use /cron for help.");
  });

  // Inline keyboard callbacks for cron
  bot.callbackQuery(/^cron:toggle:(.+)$/, async (ctx) => {
    const id = ctx.match![1];
    const job = toggleJob(id);
    if (job) {
      await ctx.answerCallbackQuery(`${job.enabled ? "Enabled" : "Paused"}: ${job.name}`);
      // Refresh the cron list
      (ctx as any).match = "";
      // Re-render the list message (HTML to avoid Markdown * conflicts with cron expressions)
      const jobs = listJobs();
      const lines = jobs.map(j => {
        const status = j.enabled ? "🟢" : "⏸️";
        const next = j.enabled ? formatNextRun(j.nextRunAt) : "paused";
        const readable = humanReadableSchedule(j.schedule);
        const recur = j.oneShot ? "⚡ One-shot" : "🔄 " + readable;
        return `${status} <b>${j.name}</b>\n   📅 ${recur} | Next: ${next}\n   Runs: ${j.runCount} | ID: <code>${j.id}</code>`;
      });
      const keyboard = new InlineKeyboard();
      for (const j of jobs) {
        keyboard.text(j.enabled ? `⏸ ${j.name}` : `▶️ ${j.name}`, `cron:toggle:${j.id}`);
        keyboard.text(`🗑`, `cron:delete:${j.id}`);
        keyboard.row();
      }
      await ctx.editMessageText(`⏰ <b>Cron Jobs (${jobs.length}):</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", reply_markup: keyboard });
    }
  });

  bot.callbackQuery(/^cron:delete:(.+)$/, async (ctx) => {
    const id = ctx.match![1];
    deleteJob(id);
    await ctx.answerCallbackQuery("Deleted");
    // Refresh (HTML parse mode)
    const jobs = listJobs();
    if (jobs.length === 0) {
      await ctx.editMessageText("⏰ No cron jobs configured.");
    } else {
      const lines = jobs.map(j => {
        const status = j.enabled ? "🟢" : "⏸️";
        const readable = humanReadableSchedule(j.schedule);
        return `${status} <b>${j.name}</b>\n   📅 ${readable} | ID: <code>${j.id}</code>`;
      });
      const keyboard = new InlineKeyboard();
      for (const j of jobs) {
        keyboard.text(j.enabled ? `⏸ ${j.name}` : `▶️ ${j.name}`, `cron:toggle:${j.id}`);
        keyboard.text(`🗑`, `cron:delete:${j.id}`);
        keyboard.row();
      }
      await ctx.editMessageText(`⏰ <b>Cron Jobs (${jobs.length}):</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", reply_markup: keyboard });
    }
  });

  // ── Setup (API Keys & Platforms via Telegram) ─────────

  bot.command("setup", async (ctx) => {
    const arg = ctx.match?.toString().trim() || "";

    if (!arg) {
      const registry = getRegistry();
      const providers = await registry.listAll();
      const activeInfo = registry.getActive().getInfo();

      const keyboard = new InlineKeyboard()
        .text("🔑 Manage API Keys", "setup:keys").row()
        .text("📱 Platforms", "setup:platforms").row()
        .text("🔐 Sudo / Admin Access", "setup:sudo").row()
        .text("🔧 Open Web Dashboard", "setup:web").row();

      await ctx.reply(
        `⚙️ *Alvin Bot Setup*\n\n` +
        `*Active Model:* ${activeInfo.name}\n` +
        `*Providers:* ${providers.length} configured\n` +
        `*Web UI:* http://localhost:${process.env.WEB_PORT || 3100}\n\n` +
        `What would you like to configure?`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      return;
    }

    // /setup sudo [password] — configure sudo access
    if (arg.startsWith("sudo")) {
      const pw = arg.slice(4).trim();

      if (!pw) {
        // Show status
        const status = await getSudoStatus();
        const statusIcon = status.configured ? (status.verified ? "✅" : "⚠️") : "❌";

        const keyboard = new InlineKeyboard();
        if (status.configured) {
          keyboard.text("🧪 Verify", "sudo:verify").row();
          keyboard.text("🔴 Revoke Access", "sudo:revoke").row();
        }

        await ctx.reply(
          `🔐 *Sudo / Admin-Rechte*\n\n` +
          `*Status:* ${statusIcon} ${status.configured ? (status.verified ? "Configured & verified" : "Configured, not verified") : "Not set up"}\n` +
          `*Storage:* ${status.storageMethod}\n` +
          `*System:* ${status.platform} (${status.user})\n` +
          (status.permissions.accessibility !== null ? `*Accessibility:* ${status.permissions.accessibility ? "✅" : "❌"}\n` : "") +
          (status.permissions.fullDiskAccess !== null ? `*Full Disk Access:* ${status.permissions.fullDiskAccess ? "✅" : "❌"}\n` : "") +
          `\n*Setup:*\n\`/setup sudo <your-system-password>\`\n\n` +
          `_The password is securely stored in ${status.storageMethod}. ` +
          `This allows Alvin Bot to run admin commands (install software, change system settings, etc.)._\n\n` +
          `⚠️ _Delete this message after setup! The password is visible in chat history._`,
          { parse_mode: "Markdown", reply_markup: keyboard }
        );
        return;
      }

      // Store the password
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      const result = storePassword(pw);

      if (!result.ok) {
        await ctx.reply(`❌ Error saving: ${result.error}`);
        return;
      }

      // Verify
      const verify = await verifyPassword();
      if (verify.ok) {
        await ctx.reply(
          `✅ *Sudo access configured!*\n\n` +
          `Password stored in: ${result.method}\n` +
          `Verification: ✅ successful\n\n` +
          `Alvin Bot can now run admin commands.\n\n` +
          `⚠️ _Please delete the message with the password from the chat!_`,
          { parse_mode: "Markdown" }
        );
      } else {
        revokePassword(); // Wrong password — clean up
        await ctx.reply(
          `❌ *Wrong password!*\n\n` +
          `The entered password does not work for sudo.\n` +
          `Please try again: \`/setup sudo <correct-password>\``,
          { parse_mode: "Markdown" }
        );
      }

      // Try to delete the user's message containing the password
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, ctx.message!.message_id);
      } catch {
        // Can't delete in private chats sometimes — that's ok
      }
      return;
    }

    // /setup key <provider> <key>
    if (arg.startsWith("key ")) {
      const parts = arg.slice(4).trim().split(/\s+/);
      if (parts.length < 2) {
        await ctx.reply(
          "🔑 *Set API Key:*\n\n" +
          "`/setup key openai sk-...`\n" +
          "`/setup key google AIza...`\n" +
          "`/setup key nvidia nvapi-...`\n" +
          "`/setup key openrouter sk-or-...`\n\n" +
          "_The key will be saved to .env. Restart required._",
          { parse_mode: "Markdown" }
        );
        return;
      }

      const envMap: Record<string, string> = {
        openai: "OPENAI_API_KEY",
        google: "GOOGLE_API_KEY",
        nvidia: "NVIDIA_API_KEY",
        openrouter: "OPENROUTER_API_KEY",
        groq: "GROQ_API_KEY",
      };

      const provider = parts[0].toLowerCase();
      const key = parts.slice(1).join(" ");
      const envKey = envMap[provider];

      if (!envKey) {
        await ctx.reply(`❌ Unknown provider "${provider}". Use: ${Object.keys(envMap).join(", ")}`);
        return;
      }

      // Write to .env
      const envFile = resolve(process.cwd(), ".env");
      let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf-8") : "";
      const regex = new RegExp(`^${envKey}=.*$`, "m");
      if (regex.test(content)) content = content.replace(regex, `${envKey}=${key}`);
      else content = content.trimEnd() + `\n${envKey}=${key}\n`;
      fs.writeFileSync(envFile, content);

      await ctx.reply(`✅ ${envKey} saved! Please restart the bot (/system restart or Web UI).`);
      return;
    }
  });

  bot.callbackQuery(/^sudo:(.+)$/, async (ctx) => {
    const action = ctx.match![1];
    if (action === "verify") {
      const result = await verifyPassword();
      await ctx.answerCallbackQuery(result.ok ? "✅ Sudo funktioniert!" : `❌ ${result.error}`);
    } else if (action === "revoke") {
      revokePassword();
      await ctx.editMessageText("🔴 Sudo access revoked. Password deleted.");
      await ctx.answerCallbackQuery("Access revoked");
    }
  });

  bot.callbackQuery(/^setup:(.+)$/, async (ctx) => {
    const action = ctx.match![1];

    switch (action) {
      case "keys": {
        const envMap = [
          { name: "OpenAI", env: "OPENAI_API_KEY", has: !!config.apiKeys.openai },
          { name: "Google", env: "GOOGLE_API_KEY", has: !!config.apiKeys.google },
          { name: "NVIDIA", env: "NVIDIA_API_KEY", has: !!config.apiKeys.nvidia },
          { name: "OpenRouter", env: "OPENROUTER_API_KEY", has: !!config.apiKeys.openrouter },
          { name: "Groq", env: "GROQ_API_KEY", has: !!config.apiKeys.groq },
        ];

        const lines = envMap.map(e => `${e.has ? "✅" : "❌"} *${e.name}* — \`${e.env}\``);

        await ctx.editMessageText(
          `🔑 *API Keys*\n\n${lines.join("\n")}\n\n` +
          `Set key: \`/setup key <provider> <key>\`\n` +
          `Example: \`/setup key nvidia nvapi-...\`\n\n` +
          `_Restart required after changes._`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      case "platforms": {
        const platforms = [
          { name: "Telegram", icon: "📱", env: "BOT_TOKEN", has: !!process.env.BOT_TOKEN },
          { name: "Discord", icon: "🎮", env: "DISCORD_TOKEN", has: !!process.env.DISCORD_TOKEN },
          { name: "WhatsApp", icon: "💬", env: "WHATSAPP_ENABLED", has: process.env.WHATSAPP_ENABLED === "true" },
          { name: "Signal", icon: "🔒", env: "SIGNAL_API_URL", has: !!process.env.SIGNAL_API_URL },
        ];

        const lines = platforms.map(p => `${p.has ? "✅" : "❌"} ${p.icon} *${p.name}* — \`${p.env}\``);

        await ctx.editMessageText(
          `📱 *Platforms*\n\n${lines.join("\n")}\n\n` +
          `_Set up platforms in Web UI: Models → Platforms_\n` +
          `_There you can enter tokens and install dependencies._`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      case "sudo": {
        const status = await getSudoStatus();
        const statusIcon = status.configured ? (status.verified ? "✅" : "⚠️") : "❌";
        await ctx.editMessageText(
          `🔐 *Sudo / Admin-Rechte*\n\n` +
          `*Status:* ${statusIcon} ${status.configured ? (status.verified ? "Active & verified" : "Configured") : "Not set up"}\n` +
          `*Storage:* ${status.storageMethod}\n\n` +
          `Setup: \`/setup sudo <system-password>\`\n` +
          `Revoke: \`/setup sudo\` → "Revoke" button\n\n` +
          `_The password is securely stored in ${status.storageMethod}._`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      case "web": {
        await ctx.editMessageText(
          `🌐 *Web Dashboard*\n\n` +
          `URL: \`http://localhost:${process.env.WEB_PORT || 3100}\`\n\n` +
          `In the dashboard you can:\n` +
          `• 🤖 Manage models & API keys\n` +
          `• 📱 Set up platforms\n` +
          `• ⏰ Manage cron jobs\n` +
          `• 🧠 Edit memory\n` +
          `• 💻 Use terminal\n` +
          `• 🛠️ Run tools`,
          { parse_mode: "Markdown" }
        );
        break;
      }
    }
    await ctx.answerCallbackQuery();
  });

  bot.command("cancel", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    if (session.isProcessing && session.abortController) {
      session.abortController.abort();
      await ctx.reply("Cancelling request...");
    } else {
      await ctx.reply("No running request.");
    }
  });
}
