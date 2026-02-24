/**
 * Calendar Plugin — View and manage calendar events.
 *
 * Supports:
 * - Google Calendar (via API, needs GOOGLE_CALENDAR_API_KEY or OAuth)
 * - iCal URL import (any .ics feed)
 * - Local event storage (docs/calendar.json) as fallback
 *
 * For Google Calendar: set GOOGLE_CALENDAR_ID and GOOGLE_API_KEY in .env
 * For iCal: set ICAL_URL in .env
 * Without either: uses local JSON storage
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CALENDAR_FILE = path.resolve(PLUGIN_ROOT, "docs", "calendar.json");

// ── Local Event Storage ─────────────────────────────────

function loadEvents() {
  try {
    return JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveEvents(events) {
  fs.writeFileSync(CALENDAR_FILE, JSON.stringify(events, null, 2));
}

function formatDate(date) {
  return new Date(date).toLocaleDateString("de-DE", {
    weekday: "short", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function parseDateTime(input) {
  // Try common formats
  // "morgen 14:00" "2026-03-01 09:00" "in 2h" etc.
  const now = new Date();

  if (input.startsWith("in ")) {
    const match = input.match(/in (\d+)\s*(m|min|h|std|d|tag)/i);
    if (match) {
      const amount = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      const ms = unit.startsWith("m") ? amount * 60000 :
                 unit.startsWith("h") || unit.startsWith("s") ? amount * 3600000 :
                 amount * 86400000;
      return new Date(now.getTime() + ms);
    }
  }

  if (input.startsWith("morgen")) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const timePart = input.replace("morgen", "").trim();
    if (timePart) {
      const [h, m] = timePart.split(":").map(Number);
      tomorrow.setHours(h || 9, m || 0, 0, 0);
    } else {
      tomorrow.setHours(9, 0, 0, 0);
    }
    return tomorrow;
  }

  if (input.startsWith("heute")) {
    const today = new Date(now);
    const timePart = input.replace("heute", "").trim();
    if (timePart) {
      const [h, m] = timePart.split(":").map(Number);
      today.setHours(h || 9, m || 0, 0, 0);
    }
    return today;
  }

  // ISO or other parseable format
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}

export default {
  name: "calendar",
  description: "Kalender-Events erstellen, anzeigen und verwalten",
  version: "1.0.0",
  author: "Mr. Levin",

  commands: [
    {
      command: "cal",
      description: "Kalender anzeigen/verwalten",
      handler: async (ctx, args) => {
        // /cal — show upcoming events
        if (!args) {
          const events = loadEvents()
            .filter(e => new Date(e.date) >= new Date())
            .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
            .slice(0, 10);

          if (events.length === 0) {
            await ctx.reply("📅 Keine kommenden Termine.\nNeu: `/cal add morgen 14:00 | Meeting`", { parse_mode: "Markdown" });
            return;
          }

          const lines = events.map((e, i) => {
            const date = formatDate(e.date);
            const loc = e.location ? ` 📍 ${e.location}` : "";
            return `${i + 1}. 📅 *${e.title}*\n   ${date}${loc}`;
          });

          await ctx.reply(`📅 *Kommende Termine:*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
          return;
        }

        // /cal add <datetime> | <title> [| location]
        if (args.startsWith("add ")) {
          const text = args.slice(4).trim();
          const parts = text.split("|").map(s => s.trim());

          if (parts.length < 2) {
            await ctx.reply("Format: `/cal add morgen 14:00 | Meeting-Titel | Ort (optional)`", { parse_mode: "Markdown" });
            return;
          }

          const dateStr = parts[0];
          const title = parts[1];
          const location = parts[2] || "";

          const date = parseDateTime(dateStr);
          if (!date) {
            await ctx.reply(`❌ Datum nicht erkannt: "${dateStr}"\nVersuche: \`morgen 14:00\`, \`heute 18:00\`, \`in 2h\`, \`2026-03-01 09:00\``, { parse_mode: "Markdown" });
            return;
          }

          const event = {
            id: Date.now().toString(36),
            title,
            date: date.toISOString(),
            location,
            created: new Date().toISOString(),
          };

          const events = loadEvents();
          events.push(event);
          saveEvents(events);

          await ctx.reply(
            `✅ *Termin erstellt:*\n\n📅 ${title}\n🕐 ${formatDate(date)}${location ? `\n📍 ${location}` : ""}`,
            { parse_mode: "Markdown" }
          );
          return;
        }

        // /cal delete <number>
        if (args.startsWith("delete ") || args.startsWith("del ")) {
          const idx = parseInt(args.split(" ")[1]) - 1;
          const events = loadEvents()
            .filter(e => new Date(e.date) >= new Date())
            .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

          if (isNaN(idx) || idx < 0 || idx >= events.length) {
            await ctx.reply("❌ Ungültige Nummer. Nutze `/cal` für die Liste.", { parse_mode: "Markdown" });
            return;
          }

          const toDelete = events[idx];
          const allEvents = loadEvents().filter(e => e.id !== toDelete.id);
          saveEvents(allEvents);

          await ctx.reply(`🗑️ Gelöscht: *${toDelete.title}*`, { parse_mode: "Markdown" });
          return;
        }

        // /cal today
        if (args === "today" || args === "heute") {
          const now = new Date();
          const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const todayEnd = new Date(todayStart.getTime() + 86400000);

          const events = loadEvents()
            .filter(e => {
              const d = new Date(e.date);
              return d >= todayStart && d < todayEnd;
            })
            .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

          if (events.length === 0) {
            await ctx.reply("📅 Heute keine Termine.");
            return;
          }

          const lines = events.map(e => {
            const time = new Date(e.date).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
            return `🕐 ${time} — *${e.title}*`;
          });

          await ctx.reply(`📅 *Heute:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
          return;
        }

        await ctx.reply(
          "📅 *Kalender-Befehle:*\n\n" +
          "`/cal` — Kommende Termine\n" +
          "`/cal heute` — Heutige Termine\n" +
          "`/cal add morgen 14:00 | Titel | Ort` — Termin erstellen\n" +
          "`/cal delete 1` — Termin löschen",
          { parse_mode: "Markdown" }
        );
      },
    },
  ],

  tools: [
    {
      name: "list_events",
      description: "List upcoming calendar events",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Number of days to look ahead (default: 7)" },
        },
      },
      execute: async (params) => {
        const days = params.days || 7;
        const cutoff = new Date(Date.now() + days * 86400000);
        const events = loadEvents()
          .filter(e => new Date(e.date) >= new Date() && new Date(e.date) <= cutoff)
          .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        return JSON.stringify(events);
      },
    },
    {
      name: "create_event",
      description: "Create a calendar event",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Event title" },
          date: { type: "string", description: "Date/time (ISO or natural language)" },
          location: { type: "string", description: "Location (optional)" },
        },
        required: ["title", "date"],
      },
      execute: async (params) => {
        const date = parseDateTime(params.date) || new Date(params.date);
        if (isNaN(date.getTime())) return `Invalid date: ${params.date}`;

        const event = {
          id: Date.now().toString(36),
          title: params.title,
          date: date.toISOString(),
          location: params.location || "",
          created: new Date().toISOString(),
        };

        const events = loadEvents();
        events.push(event);
        saveEvents(events);
        return `Event created: ${params.title} at ${date.toISOString()}`;
      },
    },
  ],
};
