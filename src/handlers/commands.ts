import type { Bot } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import fs from "fs";
import path from "path";
import os from "os";
import { getSession, resetSession, type EffortLevel } from "../services/session.js";
import { getRegistry } from "../engine.js";
import { reloadSoul } from "../services/personality.js";
import { parseDuration, createReminder, listReminders, cancelReminder } from "../services/reminders.js";
import { generateImage } from "../services/imagegen.js";
import { config } from "../config.js";

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low — Schnelle, knappe Antworten",
  medium: "Medium — Moderate Denktiefe",
  high: "High — Tiefes Reasoning (Standard)",
  max: "Max — Maximaler Aufwand (nur Opus)",
};

export function registerCommands(bot: Bot): void {
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
    { command: "imagine", description: "Bild generieren (z.B. /imagine Ein Fuchs)" },
    { command: "remind", description: "Erinnerung setzen (z.B. /remind 30m Text)" },
    { command: "export", description: "Gesprächsverlauf exportieren" },
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

    resetSession(userId);

    if (hadSession) {
      await ctx.reply(
        `🔄 *Neue Session gestartet.*\n\n` +
        `Vorherige Session: ${msgCount} Nachrichten, $${cost.toFixed(4)} Kosten.\n` +
        `Kontext wurde zurückgesetzt.`,
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

    await ctx.reply(
      `🤖 *Mr. Levin Status*\n\n` +
      `*Modell:* ${info.name} (${info.model})\n` +
      `*Effort:* ${EFFORT_LABELS[session.effort]}\n` +
      `*Voice:* ${session.voiceReply ? "an" : "aus"}\n` +
      `*Verzeichnis:* \`${session.workingDir}\`\n` +
      `*Session:* ${session.sessionId ? "aktiv" : "keine"}\n` +
      `*History:* ${session.history.length} Nachrichten\n` +
      `*Kosten:* $${session.totalCost.toFixed(4)}`,
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

  bot.command("reload", async (ctx) => {
    const success = reloadSoul();
    await ctx.reply(success ? "✅ SOUL.md neu geladen." : "❌ SOUL.md nicht gefunden.");
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
