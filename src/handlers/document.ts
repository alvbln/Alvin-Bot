import type { Context } from "grammy";
import { InputFile } from "grammy";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { config } from "../config.js";
import { getSession, addToHistory } from "../services/session.js";
import { TelegramStreamer } from "../services/telegram.js";
import { getRegistry } from "../engine.js";
import { textToSpeech } from "../services/voice.js";
import type { QueryOptions } from "../providers/types.js";
import { buildSystemPrompt } from "../services/personality.js";

const TEMP_DIR = path.join(os.tmpdir(), "alvin-bot");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

/** React to a message with an emoji. Silently fails if not supported. */
async function react(ctx: Context, emoji: string): Promise<void> {
  try { await ctx.react(emoji as Parameters<typeof ctx.react>[0]); } catch { /* ignore */ }
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

// File types we can handle
const SUPPORTED_EXTENSIONS = new Set([
  ".pdf", ".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm",
  ".doc", ".docx", ".xls", ".xlsx", ".pptx",
  ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".c", ".cpp", ".h",
  ".rs", ".go", ".rb", ".php", ".sh", ".bash", ".zsh",
  ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg",
  ".log", ".sql", ".env", ".gitignore", ".dockerfile",
]);

function isSupportedFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

export async function handleDocument(ctx: Context): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc) return;

  const userId = ctx.from!.id;
  const session = getSession(userId);

  if (session.isProcessing) {
    await ctx.reply("Bitte warten, vorherige Anfrage läuft noch... (/cancel zum Abbrechen)");
    return;
  }

  const filename = doc.file_name || "unknown";
  const ext = path.extname(filename).toLowerCase();

  // Check file size (Telegram max is 20MB for bots)
  if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
    await ctx.reply("⚠️ Datei zu groß (max 20 MB).");
    return;
  }

  session.isProcessing = true;
  session.abortController = new AbortController();

  const streamer = new TelegramStreamer(ctx.chat!.id, ctx.api, ctx.message?.message_id);
  let finalText = "";

  const typingInterval = setInterval(() => {
    ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => {});
  }, 4000);

  try {
    await react(ctx, "📄");
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");

    // Download the file
    const file = await ctx.api.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const localPath = path.join(TEMP_DIR, `doc_${Date.now()}_${filename}`);
    await downloadFile(fileUrl, localPath);

    const caption = ctx.message?.caption || "";
    const userInstruction = caption || `Analysiere diese Datei: ${filename}`;

    session.messageCount++;

    const registry = getRegistry();
    const activeProvider = registry.getActive();
    const isSDK = activeProvider.config.type === "claude-sdk";

    let queryOpts: QueryOptions & { _sessionState?: { messageCount: number; toolUseCount: number } };

    if (isSDK) {
      // SDK provider: pass file path — Claude can read files natively
      queryOpts = {
        prompt: `Der User hat eine Datei gesendet: ${localPath}\nDateiname: ${filename}\n\nLies die Datei mit dem Read-Tool und bearbeite folgende Anfrage:\n${userInstruction}`,
        systemPrompt: buildSystemPrompt(true, session.language),
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
      // Non-SDK: try to extract text content and include in prompt
      let fileContent = "";

      if ([".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm",
           ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".c", ".cpp", ".h",
           ".rs", ".go", ".rb", ".php", ".sh", ".bash", ".zsh",
           ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg",
           ".log", ".sql", ".env", ".gitignore", ".dockerfile"].includes(ext)) {
        // Plain text files — read directly
        fileContent = fs.readFileSync(localPath, "utf-8");
        // Truncate very large files
        if (fileContent.length > 50000) {
          fileContent = fileContent.slice(0, 50000) + "\n\n[... Datei gekürzt, insgesamt " + fileContent.length + " Zeichen]";
        }
      } else {
        fileContent = `[Binärdatei: ${filename}, ${doc.file_size ? Math.round(doc.file_size / 1024) + " KB" : "unbekannte Größe"}. Kann nur mit dem SDK-Provider (Claude) analysiert werden.]`;
      }

      const fullPrompt = `Datei: ${filename}\n\n\`\`\`\n${fileContent}\n\`\`\`\n\n${userInstruction}`;

      addToHistory(userId, { role: "user", content: fullPrompt });

      queryOpts = {
        prompt: fullPrompt,
        systemPrompt: buildSystemPrompt(false, session.language),
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

    // Voice reply if enabled
    if (session.voiceReply && finalText.trim()) {
      try {
        await ctx.api.sendChatAction(ctx.chat!.id, "upload_voice");
        const audioPath = await textToSpeech(finalText);
        await ctx.replyWithVoice(new InputFile(fs.readFileSync(audioPath), "response.mp3"));
        fs.unlink(audioPath, () => {});
      } catch (err) {
        console.error("TTS error:", err);
      }
    }

    // Clean up temp file after a delay (SDK might still need it)
    setTimeout(() => fs.unlink(localPath, () => {}), 60000);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await react(ctx, "👎");
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
