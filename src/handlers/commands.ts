import type { Bot, Context } from "grammy";
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
      const lines = Object.entries(EFFORT_LABELS).map(
        ([key, label]) => `${key === session.effort ? "→" : "  "} /effort ${key} — ${label}`
      );
      await ctx.reply(`Aktuell: ${session.effort}\n\n${lines.join("\n")}`);
      return;
    }

    if (!["low", "medium", "high", "max"].includes(level)) {
      await ctx.reply("Ungültig. Nutze: /effort low | medium | high | max");
      return;
    }

    session.effort = level as EffortLevel;
    await ctx.reply(`Effort: ${EFFORT_LABELS[session.effort]}`);
  });

  bot.command("model", async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase();
    const registry = getRegistry();

    if (!arg) {
      // Show available models
      const providers = await registry.listAll();
      const lines = providers.map(p => {
        const marker = p.active ? "→" : "  ";
        return `${marker} \`${p.key}\` — ${p.name}`;
      });
      await ctx.reply(
        `Aktuelles Modell: \`${registry.getActiveKey()}\`\n\n` +
        `Verfügbare Modelle:\n${lines.join("\n")}\n\n` +
        `Wechseln: /model <key>`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (registry.switchTo(arg)) {
      const provider = registry.get(arg)!;
      const info = provider.getInfo();
      await ctx.reply(`Modell gewechselt: ${info.name} (${info.model})`);
    } else {
      await ctx.reply(`Modell "${arg}" nicht gefunden. /model für alle Optionen.`);
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
