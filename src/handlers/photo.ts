import type { Context } from "grammy";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { config } from "../config.js";
import { getSession } from "../services/session.js";
import { TelegramStreamer } from "../services/telegram.js";
import { runClaudeAgent } from "../claude.js";

const TEMP_DIR = path.join(os.tmpdir(), "alvin-bot");

// Ensure temp dir exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      response.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    }).on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

export async function handlePhoto(ctx: Context): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return;

  const userId = ctx.from!.id;
  const session = getSession(userId);

  if (session.isProcessing) {
    await ctx.reply("Bitte warten, vorherige Anfrage läuft noch... (/cancel zum Abbrechen)");
    return;
  }

  session.isProcessing = true;
  session.abortController = new AbortController();

  const streamer = new TelegramStreamer(ctx.chat!.id, ctx.api);
  let finalText = "";

  const typingInterval = setInterval(() => {
    ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => {});
  }, 4000);

  try {
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");

    // Get highest resolution photo
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

    const ext = path.extname(file.file_path || "") || ".jpg";
    const imagePath = path.join(TEMP_DIR, `photo_${Date.now()}${ext}`);
    await downloadFile(fileUrl, imagePath);

    const caption = ctx.message?.caption || "";
    const prompt = `Analysiere dieses Bild: ${imagePath}\n\n${caption}`;

    session.messageCount++;

    await runClaudeAgent({
      prompt,
      sessionId: session.sessionId,
      workingDir: session.workingDir,
      effort: session.effort,
      abortController: session.abortController,
      messageCount: session.messageCount,
      toolUseCount: session.toolUseCount,
      onText: async (fullText) => {
        finalText = fullText;
        await streamer.update(fullText);
      },
      onToolUseCount: (count) => {
        session.toolUseCount += count;
      },
      onComplete: ({ sessionId, cost }) => {
        session.sessionId = sessionId;
        session.totalCost += cost;
        session.lastActivity = Date.now();
      },
    });

    await streamer.finalize(finalText);

    // Clean up temp file
    fs.unlink(imagePath, () => {});
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes("abort")) {
      await ctx.reply("Anfrage abgebrochen.");
    } else {
      await ctx.reply(`Fehler: ${errorMsg}`);
    }
  } finally {
    clearInterval(typingInterval);
    session.isProcessing = false;
    session.abortController = null;
  }
}
