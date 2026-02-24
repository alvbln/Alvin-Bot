import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import fs from "fs";
import path from "path";
import os from "os";
import { getSession, resetSession, type EffortLevel } from "../services/session.js";
import { getRegistry } from "../engine.js";

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
      `📊 *Session*\n` +
      `/status — Aktueller Status\n` +
      `/new — Neue Session starten\n` +
      `/cancel — Laufende Anfrage abbrechen\n\n` +
      `_Tipp: Schick mir Dokumente (PDF, Excel, Word) — ich kann sie lesen._`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("start", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    await ctx.reply(
      `Claude Agent Bot aktiv.\n\n` +
      `User-ID: ${userId}\n` +
      `Arbeitsverzeichnis: ${session.workingDir}\n` +
      `Session: ${session.sessionId ? "aktiv" : "keine"}\n` +
      `Kosten: $${session.totalCost.toFixed(4)}\n\n` +
      `Effort: ${EFFORT_LABELS[session.effort]}\n` +
      `Voice: ${session.voiceReply ? "an" : "aus"}\n\n` +
      `Befehle:\n` +
      `/new — Neue Session\n` +
      `/dir <pfad> — Verzeichnis wechseln\n` +
      `/effort <low|medium|high|max> — Denktiefe einstellen\n` +
      `/voice — Sprachantworten an/aus\n` +
      `/status — Status anzeigen\n` +
      `/cancel — Laufende Anfrage abbrechen`
    );
  });

  bot.command("new", async (ctx) => {
    const userId = ctx.from!.id;
    resetSession(userId);
    await ctx.reply("Neue Session gestartet.");
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
