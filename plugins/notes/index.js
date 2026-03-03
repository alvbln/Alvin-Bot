/**
 * Notes Plugin — Simple markdown notes with search.
 *
 * Stores notes in docs/notes/ as markdown files.
 * No external dependencies — pure filesystem.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOTES_DIR = path.resolve(PLUGIN_ROOT, "docs", "notes");

// Ensure dir exists
if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[äöüß]/g, c => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" }[c] || c))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function listNotes() {
  try {
    return fs.readdirSync(NOTES_DIR)
      .filter(f => f.endsWith(".md"))
      .map(f => {
        const content = fs.readFileSync(path.resolve(NOTES_DIR, f), "utf-8");
        const title = content.split("\n")[0]?.replace(/^#\s*/, "") || f;
        const stat = fs.statSync(path.resolve(NOTES_DIR, f));
        return { filename: f, title, size: stat.size, modified: stat.mtimeMs };
      })
      .sort((a, b) => b.modified - a.modified);
  } catch { return []; }
}

function searchNotes(query) {
  const q = query.toLowerCase();
  return listNotes().filter(n => {
    const content = fs.readFileSync(path.resolve(NOTES_DIR, n.filename), "utf-8").toLowerCase();
    return content.includes(q) || n.title.toLowerCase().includes(q);
  });
}

export default {
  name: "notes",
  description: "Create, read and search markdown notes",
  version: "1.0.0",
  author: "Alvin Bot",

  commands: [
    {
      command: "notes",
      description: "Manage notes",
      handler: async (ctx, args) => {
        // /notes — list all
        if (!args) {
          const notes = listNotes();
          if (notes.length === 0) {
            await ctx.reply("📝 No notes yet.\nCreate one with `/notes add <Title> | <Content>`", { parse_mode: "Markdown" });
            return;
          }

          const lines = notes.slice(0, 20).map((n, i) => {
            const date = new Date(n.modified).toLocaleDateString("de-DE");
            return `${i + 1}. *${n.title}* (${date})`;
          });

          await ctx.reply(`📝 *Notes (${notes.length}):*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
          return;
        }

        // /notes add <title> | <content>
        if (args.startsWith("add ")) {
          const text = args.slice(4).trim();
          const pipeIdx = text.indexOf("|");
          let title, content;

          if (pipeIdx > 0) {
            title = text.slice(0, pipeIdx).trim();
            content = text.slice(pipeIdx + 1).trim();
          } else {
            title = text.slice(0, 50).trim();
            content = text;
          }

          const slug = slugify(title);
          const filename = `${slug}.md`;
          const filePath = path.resolve(NOTES_DIR, filename);

          const md = `# ${title}\n\n${content}\n\n---\n_Created: ${new Date().toLocaleString("de-DE")}_\n`;
          fs.writeFileSync(filePath, md);

          await ctx.reply(`✅ Note saved: *${title}*`, { parse_mode: "Markdown" });
          return;
        }

        // /notes search <query>
        if (args.startsWith("search ")) {
          const query = args.slice(7).trim();
          if (!query) {
            await ctx.reply("Format: `/notes search <query>`", { parse_mode: "Markdown" });
            return;
          }

          const results = searchNotes(query);
          if (results.length === 0) {
            await ctx.reply(`🔍 No notes found for "${query}".`);
            return;
          }

          const lines = results.slice(0, 10).map((n, i) => `${i + 1}. *${n.title}*`);
          await ctx.reply(`🔍 *${results.length} results for "${query}":*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
          return;
        }

        // /notes view <number or title>
        if (args.startsWith("view ") || args.startsWith("read ")) {
          const query = args.split(" ").slice(1).join(" ").trim();
          const notes = listNotes();
          const idx = parseInt(query) - 1;
          let note;

          if (!isNaN(idx) && idx >= 0 && idx < notes.length) {
            note = notes[idx];
          } else {
            note = notes.find(n => n.title.toLowerCase().includes(query.toLowerCase()));
          }

          if (!note) {
            await ctx.reply(`❌ Note "${query}" not found.`);
            return;
          }

          const content = fs.readFileSync(path.resolve(NOTES_DIR, note.filename), "utf-8");
          const truncated = content.length > 3000 ? content.slice(0, 3000) + "\n\n_[...truncated]_" : content;
          await ctx.reply(truncated, { parse_mode: "Markdown" });
          return;
        }

        // /notes delete <number>
        if (args.startsWith("delete ") || args.startsWith("del ")) {
          const query = args.split(" ").slice(1).join(" ").trim();
          const notes = listNotes();
          const idx = parseInt(query) - 1;
          let note;

          if (!isNaN(idx) && idx >= 0 && idx < notes.length) {
            note = notes[idx];
          } else {
            note = notes.find(n => n.title.toLowerCase().includes(query.toLowerCase()));
          }

          if (!note) {
            await ctx.reply(`❌ Note "${query}" not found.`);
            return;
          }

          fs.unlinkSync(path.resolve(NOTES_DIR, note.filename));
          await ctx.reply(`🗑️ Note deleted: *${note.title}*`, { parse_mode: "Markdown" });
          return;
        }

        await ctx.reply(
          "📝 *Notes commands:*\n\n" +
          "`/notes` — List all\n" +
          "`/notes add Title | Content` — Create\n" +
          "`/notes view 1` — Read (number or title)\n" +
          "`/notes search query` — Search\n" +
          "`/notes delete 1` — Delete",
          { parse_mode: "Markdown" }
        );
      },
    },
  ],

  tools: [
    {
      name: "create_note",
      description: "Create a markdown note",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Note title" },
          content: { type: "string", description: "Note content (markdown)" },
        },
        required: ["title", "content"],
      },
      execute: async (params) => {
        const slug = slugify(params.title);
        const filename = `${slug}.md`;
        const filePath = path.resolve(NOTES_DIR, filename);
        const md = `# ${params.title}\n\n${params.content}\n\n---\n_Created: ${new Date().toLocaleString("de-DE")}_\n`;
        fs.writeFileSync(filePath, md);
        return `Note saved: ${filename}`;
      },
    },
    {
      name: "search_notes",
      description: "Search through notes",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
      execute: async (params) => {
        const results = searchNotes(params.query);
        return JSON.stringify(results.map(r => ({ title: r.title, filename: r.filename })));
      },
    },
    {
      name: "list_notes",
      description: "List all notes",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const notes = listNotes();
        return JSON.stringify(notes.map(n => ({ title: n.title, modified: new Date(n.modified).toISOString() })));
      },
    },
  ],
};
