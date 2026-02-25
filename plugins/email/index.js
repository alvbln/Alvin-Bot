/**
 * Email Plugin — Read and send emails via IMAP/SMTP.
 *
 * Lightweight implementation using raw IMAP/SMTP commands.
 * For full email support, configure in .env:
 *   EMAIL_IMAP_HOST=imap.mail.me.com
 *   EMAIL_IMAP_PORT=993
 *   EMAIL_SMTP_HOST=smtp.mail.me.com
 *   EMAIL_SMTP_PORT=587
 *   EMAIL_USER=user@icloud.com
 *   EMAIL_PASS=app-specific-password
 *
 * Alternative: Uses `himalaya` CLI if installed (more reliable).
 */

import { execSync } from "child_process";

function hasHimalaya() {
  try {
    execSync("which himalaya", { stdio: "pipe" });
    return true;
  } catch { return false; }
}

function runHimalaya(args, timeout = 15000) {
  try {
    const result = execSync(`himalaya ${args}`, {
      stdio: "pipe",
      timeout,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return result.toString().trim();
  } catch (err) {
    throw new Error(err.stderr?.toString()?.trim() || err.message);
  }
}

function parseEmailList(output) {
  // himalaya list outputs a table — parse it
  const lines = output.split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  // Skip header line
  return lines.slice(1).map(line => {
    // Format: ID | FLAGS | FROM | SUBJECT | DATE
    const parts = line.split("|").map(s => s.trim());
    if (parts.length >= 4) {
      return {
        id: parts[0],
        flags: parts[1],
        from: parts[2],
        subject: parts[3],
        date: parts[4] || "",
      };
    }
    return null;
  }).filter(Boolean);
}

export default {
  name: "email",
  description: "E-Mails lesen und senden (via himalaya CLI oder IMAP/SMTP)",
  version: "1.0.0",
  author: "Alvin Bot",

  onInit: () => {
    if (!hasHimalaya()) {
      console.warn("Email plugin: himalaya CLI not found. Install with: brew install himalaya");
    }
  },

  commands: [
    {
      command: "email",
      description: "E-Mails verwalten",
      handler: async (ctx, args) => {
        if (!hasHimalaya()) {
          await ctx.reply(
            "📧 *Email Plugin*\n\n" +
            "`himalaya` CLI nicht installiert.\n" +
            "Installiere mit: `brew install himalaya`\n" +
            "Konfiguriere mit: `himalaya account configure`",
            { parse_mode: "Markdown" }
          );
          return;
        }

        // /email — list inbox
        if (!args || args === "inbox") {
          try {
            await ctx.api.sendChatAction(ctx.chat.id, "typing");
            const output = runHimalaya("list -s 10");
            const emails = parseEmailList(output);

            if (emails.length === 0) {
              await ctx.reply("📭 Keine E-Mails im Posteingang.");
              return;
            }

            const lines = emails.map((e, i) => {
              const unread = e.flags?.includes("Seen") ? "" : "🆕 ";
              return `${unread}*${i + 1}.* ${e.from}\n   ${e.subject}`;
            });

            await ctx.reply(`📧 *Posteingang (${emails.length}):*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
          } catch (err) {
            await ctx.reply(`❌ Fehler: ${err.message}`);
          }
          return;
        }

        // /email read <id>
        if (args.startsWith("read ")) {
          const id = args.slice(5).trim();
          try {
            await ctx.api.sendChatAction(ctx.chat.id, "typing");
            const output = runHimalaya(`read ${id}`);
            const truncated = output.length > 3500 ? output.slice(0, 3500) + "\n\n_[...gekürzt]_" : output;
            await ctx.reply(`📧 *E-Mail #${id}:*\n\n${truncated}`, { parse_mode: "Markdown" });
          } catch (err) {
            await ctx.reply(`❌ ${err.message}`);
          }
          return;
        }

        // /email send <to> | <subject> | <body>
        if (args.startsWith("send ")) {
          const text = args.slice(5).trim();
          const parts = text.split("|").map(s => s.trim());

          if (parts.length < 3) {
            await ctx.reply("Format: `/email send to@example.com | Betreff | Text`", { parse_mode: "Markdown" });
            return;
          }

          const [to, subject, ...bodyParts] = parts;
          const body = bodyParts.join("|");

          try {
            await ctx.api.sendChatAction(ctx.chat.id, "typing");
            // Use himalaya write + send
            const mml = `From: \nTo: ${to}\nSubject: ${subject}\n\n${body}`;
            execSync(`echo '${mml.replace(/'/g, "'\\''")}' | himalaya send`, {
              stdio: "pipe",
              timeout: 30000,
            });
            await ctx.reply(`✅ E-Mail gesendet an ${to}`, { parse_mode: "Markdown" });
          } catch (err) {
            await ctx.reply(`❌ Senden fehlgeschlagen: ${err.message}`);
          }
          return;
        }

        // /email search <query>
        if (args.startsWith("search ")) {
          const query = args.slice(7).trim();
          try {
            await ctx.api.sendChatAction(ctx.chat.id, "typing");
            const output = runHimalaya(`search "${query}"`, 30000);
            const truncated = output.length > 3000 ? output.slice(0, 3000) + "\n..." : output;
            await ctx.reply(`🔍 *Suche: "${query}"*\n\n${truncated}`, { parse_mode: "Markdown" });
          } catch (err) {
            await ctx.reply(`❌ ${err.message}`);
          }
          return;
        }

        await ctx.reply(
          "📧 *Email-Befehle:*\n\n" +
          "`/email` — Posteingang (letzte 10)\n" +
          "`/email read 123` — E-Mail lesen\n" +
          "`/email send to@x.com | Betreff | Text` — Senden\n" +
          "`/email search Suchbegriff` — Suchen",
          { parse_mode: "Markdown" }
        );
      },
    },
  ],

  tools: [
    {
      name: "list_emails",
      description: "List recent emails from inbox",
      parameters: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of emails (default: 10)" },
        },
      },
      execute: async (params) => {
        if (!hasHimalaya()) return "himalaya CLI not installed";
        const count = params.count || 10;
        return runHimalaya(`list -s ${count}`);
      },
    },
    {
      name: "read_email",
      description: "Read a specific email by ID",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Email ID" },
        },
        required: ["id"],
      },
      execute: async (params) => {
        if (!hasHimalaya()) return "himalaya CLI not installed";
        return runHimalaya(`read ${params.id}`);
      },
    },
    {
      name: "send_email",
      description: "Send an email",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email" },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Email body text" },
        },
        required: ["to", "subject", "body"],
      },
      execute: async (params) => {
        if (!hasHimalaya()) return "himalaya CLI not installed";
        const mml = `From: \nTo: ${params.to}\nSubject: ${params.subject}\n\n${params.body}`;
        execSync(`echo '${mml.replace(/'/g, "'\\''")}' | himalaya send`, { stdio: "pipe", timeout: 30000 });
        return `Email sent to ${params.to}`;
      },
    },
  ],
};
