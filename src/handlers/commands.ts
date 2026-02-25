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
import { listJobs, createJob, deleteJob, toggleJob, runJobNow, formatNextRun, type JobType } from "../services/cron.js";
import { storePassword, revokePassword, getSudoStatus, verifyPassword, sudoExec } from "../services/sudo.js";
import { config } from "../config.js";

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
  low: "Low — Schnelle, knappe Antworten",
  medium: "Medium — Moderate Denktiefe",
  high: "High — Tiefes Reasoning (Standard)",
  max: "Max — Maximaler Aufwand (nur Opus)",
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
      `🤖 *Mr. Levin — Befehle*\n\n` +
      `💬 *Chat*\n` +
      `Einfach schreiben — ich antworte.\n` +
      `Sprachnachrichten & Fotos verstehe ich auch.\n\n` +
      `⚙️ *Steuerung*\n` +
      `/model — KI-Modell wechseln\n` +
      `/fallback — Provider-Reihenfolge\n` +
      `/effort — Denktiefe einstellen\n` +
      `/voice — Sprachantworten an/aus\n` +
      `/dir <pfad> — Arbeitsverzeichnis\n\n` +
      `🎨 *Extras*\n` +
      `/imagine <prompt> — Bild generieren\n` +
      `/remind <zeit> <text> — Erinnerung setzen\n` +
      `/export — Gesprächsverlauf exportieren\n\n` +
      `🧠 *Gedächtnis*\n` +
      `/recall <query> — Semantische Suche\n` +
      `/remember <text> — Etwas merken\n` +
      `/reindex — Gedächtnis neu indexieren\n\n` +
      `🌐 *Browser*\n` +
      `/browse <URL> — Screenshot\n` +
      `/browse text <URL> — Text extrahieren\n` +
      `/browse pdf <URL> — Als PDF\n\n` +
      `🔌 *Erweiterungen*\n` +
      `/plugins — Geladene Plugins\n` +
      `/mcp — MCP Server & Tools\n` +
      `/users — User-Profile\n\n` +
      `📊 *Session*\n` +
      `/status — Aktueller Status\n` +
      `/new — Neue Session starten\n` +
      `/cancel — Laufende Anfrage abbrechen\n\n` +
      `_Tipp: Schick mir Dokumente, Fotos oder Sprachnachrichten!_\n` +
      `_In Gruppen: @mention oder auf meine Nachricht antworten._`,
      { parse_mode: "Markdown" }
    );
  });

  // Register bot commands in Telegram's menu
  bot.api.setMyCommands([
    { command: "help", description: "Alle Befehle anzeigen" },
    { command: "model", description: "KI-Modell wechseln" },
    { command: "effort", description: "Denktiefe einstellen" },
    { command: "voice", description: "Sprachantworten an/aus" },
    { command: "status", description: "Aktueller Status" },
    { command: "new", description: "Neue Session starten" },
    { command: "dir", description: "Arbeitsverzeichnis wechseln" },
    { command: "web", description: "Schnelle Websuche" },
    { command: "imagine", description: "Bild generieren (z.B. /imagine Ein Fuchs)" },
    { command: "remind", description: "Erinnerung setzen (z.B. /remind 30m Text)" },
    { command: "export", description: "Gesprächsverlauf exportieren" },
    { command: "recall", description: "Semantische Gedächtnis-Suche" },
    { command: "remember", description: "Etwas merken" },
    { command: "cron", description: "Geplante Jobs verwalten" },
    { command: "setup", description: "API Keys & Plattformen einrichten" },
    { command: "cancel", description: "Laufende Anfrage abbrechen" },
  ]).catch(err => console.error("Failed to set bot commands:", err));

  bot.command("start", async (ctx) => {
    const registry = getRegistry();
    const activeInfo = registry.getActive().getInfo();

    await ctx.reply(
      `👋 *Hey! Ich bin Mr. Levin.*\n\n` +
      `Dein autonomer KI-Assistent auf Telegram. Schreib mir einfach — ` +
      `ich verstehe Text, Sprachnachrichten, Fotos und Dokumente.\n\n` +
      `🤖 Modell: *${activeInfo.name}*\n` +
      `🧠 Denktiefe: High\n\n` +
      `Tippe /help für alle Befehle.`,
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
        `🔄 *Neue Session gestartet.*\n\n` +
        `Vorherige Session: ${msgCount} Nachrichten, $${cost.toFixed(4)} Kosten.\n` +
        `Zusammenfassung in Memory gespeichert.`,
        { parse_mode: "Markdown" }
      );
    } else {
      await ctx.reply("🔄 Neue Session gestartet.");
    }
  });

  bot.command("dir", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    const newDir = ctx.match?.trim();

    if (!newDir) {
      await ctx.reply(`Aktuelles Verzeichnis: ${session.workingDir}`);
      return;
    }

    const resolved = newDir.startsWith("~")
      ? path.join(os.homedir(), newDir.slice(1))
      : path.resolve(newDir);

    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      session.workingDir = resolved;
      await ctx.reply(`Arbeitsverzeichnis: ${session.workingDir}`);
    } else {
      await ctx.reply(`Verzeichnis nicht gefunden: ${resolved}`);
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
      `🤖 *Mr. Levin Status*\n\n` +
      `*Modell:* ${info.name}\n` +
      `*Effort:* ${EFFORT_LABELS[session.effort]}\n` +
      `*Voice:* ${session.voiceReply ? "an" : "aus"}\n` +
      `*Verzeichnis:* \`${session.workingDir}\`\n\n` +
      `📊 *Session* (${sessionM} Min)\n` +
      `*Nachrichten:* ${session.messageCount}\n` +
      `*Tool-Calls:* ${session.toolUseCount}\n` +
      `*Kosten:* $${session.totalCost.toFixed(4)}\n` +
      (costLines ? `\n📈 *Provider-Nutzung:*\n${costLines}\n` : "") +
      `\n🧠 *Memory:* ${(() => { const m = getMemoryStats(); const idx = getIndexStats(); return `${m.dailyLogs} Tage, ${m.todayEntries} Einträge heute, ${formatBytes(m.longTermSize)} LTM | 🔍 ${idx.entries} Vektoren (${formatBytes(idx.sizeBytes)})`; })()}\n` +
      `⏱ *Bot-Uptime:* ${uptimeH}h ${uptimeM}m`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("voice", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    session.voiceReply = !session.voiceReply;
    await ctx.reply(
      session.voiceReply
        ? "Voice-Antworten aktiviert. Antworten kommen jetzt auch als Sprachnachricht."
        : "Voice-Antworten deaktiviert. Nur noch Text-Antworten."
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
        `🧠 *Denktiefe wählen:*\n\nAktiv: *${EFFORT_LABELS[session.effort]}*`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      return;
    }

    if (!["low", "medium", "high", "max"].includes(level)) {
      await ctx.reply("Ungültig. Nutze: /effort low | medium | high | max");
      return;
    }

    session.effort = level as EffortLevel;
    await ctx.reply(`✅ Effort: ${EFFORT_LABELS[session.effort]}`);
  });

  // Inline keyboard callback for effort switching
  bot.callbackQuery(/^effort:(.+)$/, async (ctx) => {
    const level = ctx.match![1];
    if (!["low", "medium", "high", "max"].includes(level)) {
      await ctx.answerCallbackQuery("Ungültiges Level");
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
      `🧠 *Denktiefe wählen:*\n\nAktiv: *${EFFORT_LABELS[session.effort]}*`,
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
        `🤖 *Modell wählen:*\n\nAktiv: *${registry.getActive().getInfo().name}*`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      return;
    }

    if (registry.switchTo(arg)) {
      const provider = registry.get(arg)!;
      const info = provider.getInfo();
      await ctx.reply(`✅ Modell gewechselt: ${info.name} (${info.model})`);
    } else {
      await ctx.reply(`Modell "${arg}" nicht gefunden. /model für alle Optionen.`);
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
        `🤖 *Modell wählen:*\n\nAktiv: *${info.name}*`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      await ctx.answerCallbackQuery(`Gewechselt: ${info.name}`);
    } else {
      await ctx.answerCallbackQuery(`Modell "${key}" nicht gefunden`);
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

      const text = `🔄 *Fallback-Reihenfolge*\n\n` +
        `Provider werden in dieser Reihenfolge versucht.\n` +
        `Nutze ⬆️/⬇️ zum Umsortieren.\n\n` +
        `_Zuletzt geändert: ${order.updatedBy} (${new Date(order.updatedAt).toLocaleString("de-DE")})_`;

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
      await ctx.reply(`✅ Neue Reihenfolge:\n\n${formatOrder()}`);
      return;
    }

    await ctx.reply(
      `🔄 *Fallback-Reihenfolge*\n\n` +
      `\`/fallback\` — Reihenfolge anzeigen & ändern\n` +
      `\`/fallback set groq,openai,...\` — Direkt setzen`,
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
      `_Zuletzt geändert: telegram (${new Date().toLocaleString("de-DE")})_`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
    await ctx.answerCallbackQuery(`${key} nach oben verschoben`);
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
      `_Zuletzt geändert: telegram (${new Date().toLocaleString("de-DE")})_`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
    await ctx.answerCallbackQuery(`${key} nach unten verschoben`);
  });

  bot.callbackQuery(/^fb:info:(.+)$/, async (ctx) => {
    const { getHealthStatus } = await import("../services/heartbeat.js");
    const key = ctx.match![1];
    const health = getHealthStatus();
    const h = health.find(p => p.key === key);

    if (h) {
      await ctx.answerCallbackQuery({
        text: `${key}: ${h.healthy ? "✅ Healthy" : "❌ Unhealthy"} | ${h.latencyMs}ms | Fehler: ${h.failCount}`,
        show_alert: true,
      });
    } else {
      await ctx.answerCallbackQuery(`${key}: Noch nicht geprüft`);
    }
  });

  bot.command("web", async (ctx) => {
    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply("Suche: `/web Deine Suchanfrage`", { parse_mode: "Markdown" });
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
          lines.push(`\n_Quelle: [${data.AbstractSource}](${data.AbstractURL})_`);
        }
      }

      if (lines.length === 0 && data.RelatedTopics && data.RelatedTopics.length > 0) {
        lines.push(`🔍 *Ergebnisse für "${query}":*\n`);
        for (const topic of data.RelatedTopics.slice(0, 5)) {
          if (topic.Text) {
            const short = topic.Text.length > 150 ? topic.Text.slice(0, 150) + "..." : topic.Text;
            lines.push(`• ${short}`);
          }
        }
      }

      if (lines.length === 0) {
        lines.push(`Keine Ergebnisse für "${query}". Probier es als normale Nachricht — ich suche dann mit dem AI-Modell.`);
      }

      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() =>
        ctx.reply(lines.join("\n"))
      );
    } catch (err) {
      await ctx.reply(`Suchfehler: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command("imagine", async (ctx) => {
    const prompt = ctx.match?.trim();
    if (!prompt) {
      await ctx.reply("Beschreibe was ich generieren soll:\n`/imagine Ein Fuchs der auf dem Mond sitzt`", { parse_mode: "Markdown" });
      return;
    }

    if (!config.apiKeys.google) {
      await ctx.reply("⚠️ Bildgenerierung nicht verfügbar (GOOGLE_API_KEY fehlt).");
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
        await ctx.reply(`Fehler beim Senden: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      await ctx.reply(`❌ ${result.error || "Bildgenerierung fehlgeschlagen."}`);
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
        await ctx.reply("Keine aktiven Erinnerungen.\n\nNeu: `/remind 30m Mama anrufen`", { parse_mode: "Markdown" });
      } else {
        const lines = pending.map(r => `• *${r.remaining}* — ${r.text} (ID: ${r.id})`);
        await ctx.reply(
          `⏰ *Aktive Erinnerungen:*\n\n${lines.join("\n")}\n\nLöschen: \`/remind cancel <ID>\``,
          { parse_mode: "Markdown" }
        );
      }
      return;
    }

    // Cancel a reminder
    if (input.startsWith("cancel ")) {
      const id = parseInt(input.slice(7).trim());
      if (isNaN(id)) {
        await ctx.reply("Ungültige ID. Nutze: `/remind cancel <ID>`", { parse_mode: "Markdown" });
        return;
      }
      if (cancelReminder(id, userId)) {
        await ctx.reply(`✅ Erinnerung #${id} gelöscht.`);
      } else {
        await ctx.reply(`❌ Erinnerung #${id} nicht gefunden.`);
      }
      return;
    }

    // Parse: /remind <duration> <text>
    const spaceIdx = input.indexOf(" ");
    if (spaceIdx === -1) {
      await ctx.reply("Format: `/remind 30m Text der Erinnerung`", { parse_mode: "Markdown" });
      return;
    }

    const durationStr = input.slice(0, spaceIdx);
    const text = input.slice(spaceIdx + 1).trim();
    const delayMs = parseDuration(durationStr);

    if (!delayMs) {
      await ctx.reply("Ungültige Dauer. Beispiele: `30s`, `5m`, `2h`, `1d`", { parse_mode: "Markdown" });
      return;
    }

    if (!text) {
      await ctx.reply("Bitte einen Text angeben: `/remind 30m Mama anrufen`", { parse_mode: "Markdown" });
      return;
    }

    const reminder = createReminder(chatId, userId, text, delayMs, ctx.api);

    // Format trigger time
    const triggerDate = new Date(reminder.triggerAt);
    const timeStr = triggerDate.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

    await ctx.reply(`✅ Erinnerung gesetzt für *${timeStr}*: ${text}`, { parse_mode: "Markdown" });
  });

  bot.command("export", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);

    if (session.history.length === 0 && !session.sessionId) {
      await ctx.reply("Keine Gesprächsdaten zum Exportieren.");
      return;
    }

    // Build export text
    const lines: string[] = [
      `# Mr. Levin — Gesprächsexport`,
      `Datum: ${new Date().toLocaleString("de-DE")}`,
      `Nachrichten: ${session.messageCount}`,
      `Kosten: $${session.totalCost.toFixed(4)}`,
      `---\n`,
    ];

    for (const msg of session.history) {
      const role = msg.role === "user" ? "👤 User" : "🤖 Mr. Levin";
      lines.push(`### ${role}\n${msg.content}\n`);
    }

    if (session.history.length === 0) {
      lines.push("(SDK-Session — Verlauf wird intern verwaltet, kein Export möglich)\n");
    }

    const exportText = lines.join("\n");
    const buffer = Buffer.from(exportText, "utf-8");
    const filename = `chat-export-${new Date().toISOString().slice(0, 10)}.md`;

    await ctx.replyWithDocument(new InputFile(buffer, filename), {
      caption: `📄 Export: ${session.history.length} Nachrichten`,
    });
  });

  bot.command("lang", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    const arg = ctx.match?.trim().toLowerCase();

    if (!arg) {
      const keyboard = new InlineKeyboard()
        .text(session.language === "de" ? "✅ Deutsch" : "Deutsch", "lang:de")
        .text(session.language === "en" ? "✅ English" : "English", "lang:en");

      await ctx.reply(`🌐 *Sprache / Language:* ${session.language === "de" ? "Deutsch" : "English"}`, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
      return;
    }

    if (arg === "de" || arg === "en") {
      session.language = arg;
      await ctx.reply(arg === "de" ? "✅ Sprache: Deutsch" : "✅ Language: English");
    } else {
      await ctx.reply("Nutze: `/lang de` oder `/lang en`", { parse_mode: "Markdown" });
    }
  });

  bot.callbackQuery(/^lang:(de|en)$/, async (ctx) => {
    const lang = ctx.match![1] as "de" | "en";
    const userId = ctx.from!.id;
    const session = getSession(userId);
    session.language = lang;

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
        `*Langzeitgedächtnis:* ${formatBytes(stats.longTermSize)}\n` +
        `*Tägliche Logs:* ${stats.dailyLogs} Dateien\n` +
        `*Heute:* ${stats.todayEntries} Einträge\n\n` +
        `_Memory wird automatisch geschrieben bei /new._\n` +
        `_Non-SDK Provider laden Memory als Kontext._`,
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
    await ctx.reply(success ? "✅ SOUL.md neu geladen." : "❌ SOUL.md nicht gefunden.");
  });

  // ── Access Control ────────────────────────────────

  // Callback for group approval/block
  bot.callbackQuery(/^access:(approve|block):(-?\d+)$/, async (ctx) => {
    const action = ctx.match![1];
    const chatId = parseInt(ctx.match![2]);

    if (action === "approve") {
      approveGroup(chatId);
      await ctx.editMessageText(`✅ Gruppe ${chatId} genehmigt. Mr. Levin antwortet jetzt dort.`);
      // Notify the group
      try {
        await ctx.api.sendMessage(chatId, "👋 Mr. Levin ist jetzt aktiv in dieser Gruppe!\n\nMentioned mich mit @-mention oder antwortet auf meine Nachrichten.");
      } catch { /* group might not allow bot messages yet */ }
    } else {
      blockGroup(chatId);
      await ctx.editMessageText(`🚫 Gruppe ${chatId} blockiert. Mr. Levin ignoriert diese Gruppe.`);
    }
    await ctx.answerCallbackQuery();
  });

  bot.command("groups", async (ctx) => {
    const groups = listGroups();

    if (groups.length === 0) {
      await ctx.reply("Keine Gruppen registriert.");
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
      `🔐 *Gruppen-Verwaltung*\n\n` +
      `${lines.join("\n\n")}\n\n` +
      `⚙️ *Settings:*\n` +
      `Forwards: ${settings.allowForwards ? "✅" : "❌"}\n` +
      `Auto-Approve: ${settings.autoApproveGroups ? "⚠️ AN" : "✅ AUS"}`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  });

  bot.command("security", async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase();
    const settings = getSettings();

    if (!arg) {
      await ctx.reply(
        `🔐 *Sicherheitseinstellungen*\n\n` +
        `*Forwards:* ${settings.allowForwards ? "✅ erlaubt" : "❌ blockiert"}\n` +
        `*Auto-Approve Gruppen:* ${settings.autoApproveGroups ? "⚠️ AN (gefährlich!)" : "✅ AUS"}\n` +
        `*Gruppen-Rate-Limit:* ${settings.groupRateLimitPerHour}/h\n\n` +
        `Ändern:\n` +
        `\`/security forwards on|off\`\n` +
        `\`/security autoapprove on|off\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (arg.startsWith("forwards ")) {
      const val = arg.slice(9).trim();
      setForwardingAllowed(val === "on" || val === "true");
      await ctx.reply(`✅ Forwards: ${val === "on" || val === "true" ? "erlaubt" : "blockiert"}`);
    } else if (arg.startsWith("autoapprove ")) {
      const val = arg.slice(12).trim();
      setAutoApprove(val === "on" || val === "true");
      await ctx.reply(`${val === "on" || val === "true" ? "⚠️" : "✅"} Auto-Approve: ${val === "on" || val === "true" ? "AN" : "AUS"}`);
    } else {
      await ctx.reply("Unbekannt. Nutze `/security` für Optionen.", { parse_mode: "Markdown" });
    }
  });

  // ── Browser Automation ─────────────────────────────────

  bot.command("browse", async (ctx) => {
    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply(
        "🌐 *Browser-Befehle:*\n\n" +
        "`/browse <URL>` — Screenshot einer Webseite\n" +
        "`/browse text <URL>` — Text extrahieren\n" +
        "`/browse pdf <URL>` — Seite als PDF speichern",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (!hasPlaywright()) {
      await ctx.reply(
        "❌ Playwright nicht installiert.\n`npm install playwright && npx playwright install chromium`",
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
        const truncated = text.length > 3500 ? text.slice(0, 3500) + "\n\n_[...gekürzt]_" : text;
        await ctx.reply(`🌐 *Text von ${url}:*\n\n${truncated}`, { parse_mode: "Markdown" });
        return;
      }

      // /browse pdf <url>
      if (arg.startsWith("pdf ")) {
        const url = arg.slice(4).trim();
        await ctx.api.sendChatAction(ctx.chat!.id, "upload_document");
        const pdfPath = await generatePdf(url);
        await ctx.replyWithDocument(new InputFile(fs.readFileSync(pdfPath), "page.pdf"), {
          caption: `📄 PDF von ${url}`,
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
      await ctx.reply(`❌ Browser-Fehler: ${msg}`);
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
          await ctx.reply("❌ Ungültiges JSON für Parameter.", { parse_mode: "Markdown" });
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
        await ctx.reply(`❌ Tool-Fehler: ${msg}`);
      }
      return;
    }

    // /tools — list all
    const tools = listCustomTools();
    if (tools.length === 0) {
      await ctx.reply(
        "🔧 *Custom Tools*\n\n" +
        "Keine Tools konfiguriert.\n" +
        "Erstelle `docs/tools.json` (siehe `docs/tools.example.json`).",
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
      `_Ausführen: \`/tools run <name> {"param":"value"}\`_`,
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
          await ctx.reply("❌ Ungültiges JSON für Tool-Argumente.");
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
        await ctx.reply(`❌ MCP-Fehler: ${msg}`);
      }
      return;
    }

    // Default: show status
    const mcpServers = getMCPStatus();
    const tools = getMCPTools();

    if (mcpServers.length === 0) {
      await ctx.reply(
        `🔌 *MCP (Model Context Protocol)*\n\n` +
        `Keine Server konfiguriert.\n` +
        `Erstelle \`docs/mcp.json\` (siehe \`docs/mcp.example.json\`).`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const serverLines = mcpServers.map(s => {
      const status = s.connected ? "🟢" : "🔴";
      return `${status} *${s.name}* — ${s.tools} Tools`;
    });

    const toolLines = tools.length > 0
      ? "\n\n*Verfügbare Tools:*\n" + tools.map(t => `  🔧 \`${t.server}/${t.name}\` — ${t.description}`).join("\n")
      : "";

    await ctx.reply(
      `🔌 *MCP Server (${mcpServers.length}):*\n\n` +
      serverLines.join("\n") +
      toolLines +
      `\n\n_Nutze \`/mcp call <server> <tool> {args}\` zum Ausführen._`,
      { parse_mode: "Markdown" }
    );
  });

  // ── Plugins ───────────────────────────────────────────

  bot.command("plugins", async (ctx) => {
    const plugins = getLoadedPlugins();

    if (plugins.length === 0) {
      await ctx.reply(
        `🔌 Keine Plugins geladen.\n\n` +
        `Plugins in \`${getPluginsDir()}/\` ablegen.\n` +
        `Jedes Plugin braucht einen Ordner mit \`index.js\`.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const lines = plugins.map(p => {
      const cmds = p.commands.length > 0 ? `\n   Commands: ${p.commands.join(", ")}` : "";
      const tools = p.tools.length > 0 ? `\n   Tools: ${p.tools.join(", ")}` : "";
      return `🔌 *${p.name}* v${p.version}\n   ${p.description}${cmds}${tools}`;
    });

    await ctx.reply(`🔌 *Geladene Plugins (${plugins.length}):*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
  });

  // ── User Profiles ─────────────────────────────────────

  bot.command("users", async (ctx) => {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      await ctx.reply("Noch keine User-Profile gespeichert.");
      return;
    }

    const lines = profiles.map(p => {
      const lastActive = new Date(p.lastActive).toLocaleDateString("de-DE");
      const badge = p.isOwner ? "👑" : "👤";
      return `${badge} *${p.name}*${p.username ? ` (@${p.username})` : ""}\n   ${p.totalMessages} Nachrichten, zuletzt: ${lastActive}`;
    });

    await ctx.reply(`👥 *User-Profile (${profiles.length}):*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
  });

  bot.command("note", async (ctx) => {
    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply("📝 Nutze: `/note @username Notiz-Text`\nSpeichert eine Notiz über einen User.", { parse_mode: "Markdown" });
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
      await ctx.reply(`User "${target}" nicht gefunden.`);
      return;
    }

    addUserNote(profile.userId, noteText);
    await ctx.reply(`📝 Notiz für ${profile.name} gespeichert.`);
  });

  // ── Memory Search Commands ───────────────────────────

  bot.command("recall", async (ctx) => {
    const query = ctx.match?.toString().trim();
    if (!query) {
      await ctx.reply("🔍 Nutze: `/recall <Suchbegriff>`\nSucht semantisch in meinem Gedächtnis.", { parse_mode: "Markdown" });
      return;
    }

    try {
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      const results = await searchMemory(query, 5, 0.25);

      if (results.length === 0) {
        await ctx.reply(`🔍 Keine Erinnerungen zu "${query}" gefunden.`);
        return;
      }

      const lines = results.map((r, i) => {
        const score = Math.round(r.score * 100);
        const preview = r.text.length > 200 ? r.text.slice(0, 200) + "..." : r.text;
        return `**${i + 1}.** (${score}%) _${r.source}_\n${preview}`;
      });

      await ctx.reply(`🧠 Erinnerungen zu "${query}":\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Recall-Fehler: ${msg}`);
    }
  });

  bot.command("remember", async (ctx) => {
    const text = ctx.match?.toString().trim();
    if (!text) {
      await ctx.reply("💾 Nutze: `/remember <Text>`\nSpeichert etwas in meinem Gedächtnis.", { parse_mode: "Markdown" });
      return;
    }

    try {
      appendDailyLog(`**Manuell gemerkt:** ${text}`);
      // Trigger reindex so the new entry is searchable
      const stats = await reindexMemory();
      await ctx.reply(`💾 Gemerkt! (${stats.total} Einträge im Index)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Fehler beim Speichern: ${msg}`);
    }
  });

  bot.command("reindex", async (ctx) => {
    try {
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      const stats = await reindexMemory(true);
      const indexStats = getIndexStats();
      const sizeKB = (indexStats.sizeBytes / 1024).toFixed(1);
      await ctx.reply(
        `🔄 Gedächtnis neu indexiert!\n\n` +
        `📊 ${stats.indexed} Chunks verarbeitet\n` +
        `📁 ${indexStats.files} Dateien indexiert\n` +
        `🧠 ${stats.total} Einträge gesamt\n` +
        `💾 Index-Größe: ${sizeKB} KB`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Reindex-Fehler: ${msg}`);
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
          "⏰ *Cron Jobs*\n\nKeine Jobs konfiguriert.\n\n" +
          "Erstellen:\n" +
          "`/cron add 5m reminder Wasser trinken`\n" +
          "`/cron add \"0 9 * * 1\" shell pm2 status`\n" +
          "`/cron add 1h http https://api.example.com/health`\n\n" +
          "_Verwalte Jobs auch im Web UI unter ⏰ Cron._",
          { parse_mode: "Markdown" }
        );
        return;
      }

      const lines = jobs.map(j => {
        const status = j.enabled ? "🟢" : "⏸️";
        const next = j.enabled ? formatNextRun(j.nextRunAt) : "pausiert";
        const lastErr = j.lastError ? " ⚠️" : "";
        const sched = j.schedule.replace(/\*/g, "✱");
        const recur = j.oneShot ? "⚡einmalig" : "🔄";
        return `${status} <b>${j.name}</b> (${sched}) ${recur}\n   Typ: ${j.type} | Nächst: ${next} | Runs: ${j.runCount}${lastErr}\n   ID: <code>${j.id}</code>`;
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
        `Befehle: /cron add · delete · toggle · run · info`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
      return;
    }

    // /cron add <schedule> <type> <payload>
    if (arg.startsWith("add ")) {
      const rest = arg.slice(4).trim();

      // Parse: schedule can be "5m" or "0 9 * * 1" (quoted)
      let schedule: string;
      let remainder: string;

      if (rest.startsWith('"')) {
        const endQuote = rest.indexOf('"', 1);
        if (endQuote < 0) { await ctx.reply("❌ Fehlende schließende Anführungszeichen für Cron-Ausdruck."); return; }
        schedule = rest.slice(1, endQuote);
        remainder = rest.slice(endQuote + 1).trim();
      } else {
        const sp = rest.indexOf(" ");
        if (sp < 0) { await ctx.reply("Format: `/cron add <schedule> <type> <payload>`", { parse_mode: "Markdown" }); return; }
        schedule = rest.slice(0, sp);
        remainder = rest.slice(sp + 1).trim();
      }

      // Parse type + payload
      const typeSp = remainder.indexOf(" ");
      const typeStr = typeSp >= 0 ? remainder.slice(0, typeSp) : remainder;
      const payloadStr = typeSp >= 0 ? remainder.slice(typeSp + 1).trim() : "";

      const validTypes = ["reminder", "shell", "http", "message", "ai-query"];
      if (!validTypes.includes(typeStr)) {
        await ctx.reply(`❌ Ungültiger Typ "${typeStr}". Erlaubt: ${validTypes.join(", ")}`);
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

      await ctx.reply(
        `✅ *Cron Job erstellt*\n\n` +
        `*Name:* ${job.name}\n` +
        `*Schedule:* ${job.schedule}\n` +
        `*Typ:* ${job.type}\n` +
        `*Nächster Lauf:* ${formatNextRun(job.nextRunAt)}\n` +
        `*ID:* \`${job.id}\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // /cron delete <id>
    if (arg.startsWith("delete ")) {
      const id = arg.slice(7).trim();
      if (deleteJob(id)) {
        await ctx.reply(`✅ Job \`${id}\` gelöscht.`, { parse_mode: "Markdown" });
      } else {
        await ctx.reply(`❌ Job \`${id}\` nicht gefunden.`, { parse_mode: "Markdown" });
      }
      return;
    }

    // /cron toggle <id>
    if (arg.startsWith("toggle ")) {
      const id = arg.slice(7).trim();
      const job = toggleJob(id);
      if (job) {
        await ctx.reply(`${job.enabled ? "▶️" : "⏸️"} Job "${job.name}" ${job.enabled ? "aktiviert" : "pausiert"}.`);
      } else {
        await ctx.reply(`❌ Job nicht gefunden.`);
      }
      return;
    }

    // /cron run <id>
    if (arg.startsWith("run ")) {
      const id = arg.slice(4).trim();
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      const result = await (runJobNow(id) || Promise.resolve(null));
      if (!result) {
        await ctx.reply(`❌ Job nicht gefunden.`);
        return;
      }
      const output = result.output ? `\`\`\`\n${result.output.slice(0, 2000)}\n\`\`\`` : "(kein Output)";
      await ctx.reply(`🔧 Job ausgeführt:\n${output}${result.error ? `\n\n❌ ${result.error}` : ""}`, { parse_mode: "Markdown" });
      return;
    }

    await ctx.reply("Unbekannter Cron-Befehl. Nutze `/cron` für Hilfe.", { parse_mode: "Markdown" });
  });

  // Inline keyboard callbacks for cron
  bot.callbackQuery(/^cron:toggle:(.+)$/, async (ctx) => {
    const id = ctx.match![1];
    const job = toggleJob(id);
    if (job) {
      await ctx.answerCallbackQuery(`${job.enabled ? "Aktiviert" : "Pausiert"}: ${job.name}`);
      // Refresh the cron list
      (ctx as any).match = "";
      // Re-render the list message
      const jobs = listJobs();
      const lines = jobs.map(j => {
        const status = j.enabled ? "🟢" : "⏸️";
        const next = j.enabled ? formatNextRun(j.nextRunAt) : "pausiert";
        return `${status} *${j.name}* (${j.schedule})\n   Typ: ${j.type} | Nächst: ${next} | Runs: ${j.runCount}\n   ID: \`${j.id}\``;
      });
      const keyboard = new InlineKeyboard();
      for (const j of jobs) {
        keyboard.text(j.enabled ? `⏸ ${j.name}` : `▶️ ${j.name}`, `cron:toggle:${j.id}`);
        keyboard.text(`🗑`, `cron:delete:${j.id}`);
        keyboard.row();
      }
      await ctx.editMessageText(`⏰ *Cron Jobs (${jobs.length}):*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown", reply_markup: keyboard });
    }
  });

  bot.callbackQuery(/^cron:delete:(.+)$/, async (ctx) => {
    const id = ctx.match![1];
    deleteJob(id);
    await ctx.answerCallbackQuery("Gelöscht");
    // Refresh
    const jobs = listJobs();
    if (jobs.length === 0) {
      await ctx.editMessageText("⏰ Keine Cron Jobs vorhanden.");
    } else {
      const lines = jobs.map(j => {
        const status = j.enabled ? "🟢" : "⏸️";
        return `${status} *${j.name}* (${j.schedule})\n   ID: \`${j.id}\``;
      });
      const keyboard = new InlineKeyboard();
      for (const j of jobs) {
        keyboard.text(j.enabled ? `⏸ ${j.name}` : `▶️ ${j.name}`, `cron:toggle:${j.id}`);
        keyboard.text(`🗑`, `cron:delete:${j.id}`);
        keyboard.row();
      }
      await ctx.editMessageText(`⏰ *Cron Jobs (${jobs.length}):*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown", reply_markup: keyboard });
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
        .text("🔑 API Keys verwalten", "setup:keys").row()
        .text("📱 Plattformen", "setup:platforms").row()
        .text("🔐 Sudo / Admin-Rechte", "setup:sudo").row()
        .text("🔧 Web Dashboard öffnen", "setup:web").row();

      await ctx.reply(
        `⚙️ *Mr. Levin Setup*\n\n` +
        `*Aktives Modell:* ${activeInfo.name}\n` +
        `*Provider:* ${providers.length} konfiguriert\n` +
        `*Web UI:* http://localhost:${process.env.WEB_PORT || 3100}\n\n` +
        `Was möchtest du einrichten?`,
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
          keyboard.text("🧪 Verifizieren", "sudo:verify").row();
          keyboard.text("🔴 Zugriff widerrufen", "sudo:revoke").row();
        }

        await ctx.reply(
          `🔐 *Sudo / Admin-Rechte*\n\n` +
          `*Status:* ${statusIcon} ${status.configured ? (status.verified ? "Konfiguriert & verifiziert" : "Konfiguriert, nicht verifiziert") : "Nicht eingerichtet"}\n` +
          `*Speicher:* ${status.storageMethod}\n` +
          `*System:* ${status.platform} (${status.user})\n` +
          (status.permissions.accessibility !== null ? `*Accessibility:* ${status.permissions.accessibility ? "✅" : "❌"}\n` : "") +
          (status.permissions.fullDiskAccess !== null ? `*Full Disk Access:* ${status.permissions.fullDiskAccess ? "✅" : "❌"}\n` : "") +
          `\n*Einrichten:*\n\`/setup sudo <dein-system-passwort>\`\n\n` +
          `_Das Passwort wird sicher im ${status.storageMethod} gespeichert. ` +
          `Damit kann Mr. Levin Befehle mit Admin-Rechten ausführen (Software installieren, Systemeinstellungen ändern, etc.)._\n\n` +
          `⚠️ _Lösche diese Nachricht nach dem Einrichten! Das Passwort ist im Chatverlauf sichtbar._`,
          { parse_mode: "Markdown", reply_markup: keyboard }
        );
        return;
      }

      // Store the password
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      const result = storePassword(pw);

      if (!result.ok) {
        await ctx.reply(`❌ Fehler beim Speichern: ${result.error}`);
        return;
      }

      // Verify
      const verify = await verifyPassword();
      if (verify.ok) {
        await ctx.reply(
          `✅ *Sudo-Zugriff eingerichtet!*\n\n` +
          `Passwort gespeichert in: ${result.method}\n` +
          `Verifizierung: ✅ erfolgreich\n\n` +
          `Mr. Levin kann jetzt Admin-Befehle ausführen.\n\n` +
          `⚠️ _Bitte lösche die Nachricht mit dem Passwort aus dem Chat!_`,
          { parse_mode: "Markdown" }
        );
      } else {
        revokePassword(); // Wrong password — clean up
        await ctx.reply(
          `❌ *Passwort falsch!*\n\n` +
          `Das eingegebene Passwort funktioniert nicht für sudo.\n` +
          `Bitte versuche es erneut: \`/setup sudo <richtiges-passwort>\``,
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
          "🔑 *API Key setzen:*\n\n" +
          "`/setup key openai sk-...`\n" +
          "`/setup key google AIza...`\n" +
          "`/setup key nvidia nvapi-...`\n" +
          "`/setup key openrouter sk-or-...`\n\n" +
          "_Der Key wird in .env gespeichert. Neustart nötig._",
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
        await ctx.reply(`❌ Unbekannter Provider "${provider}". Nutze: ${Object.keys(envMap).join(", ")}`);
        return;
      }

      // Write to .env
      const envFile = resolve(process.cwd(), ".env");
      let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf-8") : "";
      const regex = new RegExp(`^${envKey}=.*$`, "m");
      if (regex.test(content)) content = content.replace(regex, `${envKey}=${key}`);
      else content = content.trimEnd() + `\n${envKey}=${key}\n`;
      fs.writeFileSync(envFile, content);

      await ctx.reply(`✅ ${envKey} gespeichert! Bitte Bot neustarten (/system restart oder Web UI).`);
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
      await ctx.editMessageText("🔴 Sudo-Zugriff widerrufen. Passwort gelöscht.");
      await ctx.answerCallbackQuery("Zugriff widerrufen");
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
          `Key setzen: \`/setup key <provider> <key>\`\n` +
          `Beispiel: \`/setup key nvidia nvapi-...\`\n\n` +
          `_Neustart nötig nach Änderungen._`,
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
          `📱 *Plattformen*\n\n${lines.join("\n")}\n\n` +
          `_Plattformen im Web UI einrichten: Models → Platforms_\n` +
          `_Dort kannst du Token eingeben und Dependencies installieren._`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      case "sudo": {
        const status = await getSudoStatus();
        const statusIcon = status.configured ? (status.verified ? "✅" : "⚠️") : "❌";
        await ctx.editMessageText(
          `🔐 *Sudo / Admin-Rechte*\n\n` +
          `*Status:* ${statusIcon} ${status.configured ? (status.verified ? "Aktiv & verifiziert" : "Konfiguriert") : "Nicht eingerichtet"}\n` +
          `*Speicher:* ${status.storageMethod}\n\n` +
          `Einrichten: \`/setup sudo <system-passwort>\`\n` +
          `Widerrufen: \`/setup sudo\` → Button "Widerrufen"\n\n` +
          `_Das Passwort wird sicher im ${status.storageMethod} gespeichert._`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      case "web": {
        await ctx.editMessageText(
          `🌐 *Web Dashboard*\n\n` +
          `URL: \`http://localhost:${process.env.WEB_PORT || 3100}\`\n\n` +
          `Im Dashboard kannst du:\n` +
          `• 🤖 Modelle & API Keys verwalten\n` +
          `• 📱 Plattformen einrichten\n` +
          `• ⏰ Cron Jobs verwalten\n` +
          `• 🧠 Memory editieren\n` +
          `• 💻 Terminal nutzen\n` +
          `• 🛠️ Tools ausführen`,
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
      await ctx.reply("Anfrage wird abgebrochen...");
    } else {
      await ctx.reply("Keine laufende Anfrage.");
    }
  });
}
