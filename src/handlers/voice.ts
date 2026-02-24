import type { Context } from "grammy";
import { InputFile } from "grammy";
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
import { transcribeAudio, textToSpeech } from "../services/voice.js";
import { getRegistry } from "../engine.js";
import type { QueryOptions } from "../providers/types.js";

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

export async function handleVoice(ctx: Context): Promise<void> {
  const voice = ctx.message?.voice;
  if (!voice) return;

  const userId = ctx.from!.id;
  const session = getSession(userId);

  if (session.isProcessing) {
    await ctx.reply("Bitte warten, vorherige Anfrage läuft noch... (/cancel zum Abbrechen)");
    return;
  }

  if (!config.apiKeys.groq) {
    await ctx.reply("Voice nicht konfiguriert (GROQ_API_KEY fehlt).");
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
    await react(ctx, "🎧");
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");

    // 1. Download voice message
    const file = await ctx.api.getFile(voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const audioPath = path.join(TEMP_DIR, `voice_${Date.now()}.ogg`);
    await downloadFile(fileUrl, audioPath);

    // 2. Transcribe with Groq Whisper
    const transcript = await transcribeAudio(audioPath);
    fs.unlink(audioPath, () => {});

    if (!transcript.trim()) {
      await ctx.reply("Konnte die Sprachnachricht nicht verstehen.");
      return;
    }

    // Show what was understood
    await ctx.reply(`"${transcript}"`);

    // 3. Send to AI via provider system
    session.messageCount++;

    const registry = getRegistry();
    const activeProvider = registry.getActive();
    const isSDK = activeProvider.config.type === "claude-sdk";

    const queryOpts: QueryOptions & { _sessionState?: { messageCount: number; toolUseCount: number } } = {
      prompt: transcript,
      systemPrompt: `Du bist ein autonomer AI-Agent, gesteuert über Telegram.
Halte Antworten kurz und prägnant, aber gründlich.
Nutze Markdown-Formatierung kompatibel mit Telegram.
Antworte auf Deutsch, es sei denn der User schreibt auf Englisch.`,
      workingDir: session.workingDir,
      effort: session.effort,
      abortSignal: session.abortController.signal,
      sessionId: isSDK ? session.sessionId : null,
      history: !isSDK ? session.history : undefined,
      _sessionState: isSDK ? {
        messageCount: session.messageCount,
        toolUseCount: session.toolUseCount,
      } : undefined,
    };

    if (!isSDK) {
      addToHistory(userId, { role: "user", content: transcript });
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

    // 4. Send voice reply if enabled
    if (session.voiceReply && finalText.trim()) {
      try {
        await ctx.api.sendChatAction(ctx.chat!.id, "upload_voice");
        const ttsPath = await textToSpeech(finalText);
        await ctx.replyWithVoice(new InputFile(fs.readFileSync(ttsPath), "response.mp3"));
        fs.unlink(ttsPath, () => {});
      } catch (err) {
        console.error("TTS error:", err);
      }
    }
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
