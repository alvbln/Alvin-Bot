import type { Context } from "grammy";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";

/** React to a message with an emoji. Silently fails if not supported. */
async function react(ctx: Context, emoji: string): Promise<void> {
  try { await ctx.react(emoji as Parameters<typeof ctx.react>[0]); } catch { /* ignore */ }
}
import { config } from "../config.js";
import { getSession, addToHistory } from "../services/session.js";
import { TelegramStreamer } from "../services/telegram.js";
import { getRegistry } from "../engine.js";
import type { QueryOptions } from "../providers/types.js";
import { buildSystemPrompt } from "../services/personality.js";

const TEMP_DIR = path.join(os.tmpdir(), "alvin-bot");

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
    await react(ctx, "👀");
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");

    // Get highest resolution photo
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

    const ext = path.extname(file.file_path || "") || ".jpg";
    const imagePath = path.join(TEMP_DIR, `photo_${Date.now()}${ext}`);
    await downloadFile(fileUrl, imagePath);

    const caption = ctx.message?.caption || "Analysiere dieses Bild.";

    session.messageCount++;

    const registry = getRegistry();
    const activeProvider = registry.getActive();
    const isSDK = activeProvider.config.type === "claude-sdk";

    let queryOpts: QueryOptions & { _sessionState?: { messageCount: number; toolUseCount: number } };

    if (isSDK) {
      // SDK: pass image path in prompt — SDK's Read tool handles it natively
      queryOpts = {
        prompt: `Analysiere dieses Bild: ${imagePath}\n\n${caption}`,
        systemPrompt: buildSystemPrompt(true),
        workingDir: session.workingDir,
        effort: session.effort,
        abortSignal: session.abortController.signal,
        sessionId: session.sessionId,
        _sessionState: {
          messageCount: session.messageCount,
          toolUseCount: session.toolUseCount,
        },
      };
    } else {
      // Non-SDK: encode image as base64 for vision API
      let imageContent: string;
      if (activeProvider.config.supportsVision) {
        const imageBuffer = fs.readFileSync(imagePath);
        imageContent = imageBuffer.toString("base64");
      } else {
        // No vision support — tell the user
        imageContent = "";
      }

      if (!activeProvider.config.supportsVision) {
        await ctx.reply(`⚠️ Das aktuelle Modell (${activeProvider.config.name}) unterstützt keine Bildanalyse. Wechsle mit /model zu einem Vision-Modell.`);
        return;
      }

      addToHistory(userId, {
        role: "user",
        content: caption,
        images: [imageContent],
      });

      queryOpts = {
        prompt: caption,
        systemPrompt: buildSystemPrompt(false),
        workingDir: session.workingDir,
        effort: session.effort,
        abortSignal: session.abortController.signal,
        history: session.history,
      };
    }

    for await (const chunk of registry.queryWithFallback(queryOpts)) {
      switch (chunk.type) {
        case "text":
          finalText = chunk.text || "";
          await streamer.update(finalText);
          break;
        case "tool_use":
          if (chunk.toolName) session.toolUseCount++;
          break;
        case "done":
          if (chunk.sessionId) session.sessionId = chunk.sessionId;
          if (chunk.costUsd) session.totalCost += chunk.costUsd;
          session.lastActivity = Date.now();
          break;
        case "error":
          await ctx.reply(`Fehler: ${chunk.error}`);
          break;
      }
    }

    await streamer.finalize(finalText);
    await react(ctx, "👍");

    if (!isSDK && finalText) {
      addToHistory(userId, { role: "assistant", content: finalText });
    }

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
