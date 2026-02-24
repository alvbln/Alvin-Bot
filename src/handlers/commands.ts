import type { Bot } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import fs from "fs";
import path from "path";
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
