import type { Context } from "grammy";
import { InputFile } from "grammy";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { config } from "../config.js";
import { getSession } from "../services/session.js";
import { TelegramStreamer } from "../services/telegram.js";
import { transcribeAudio, textToSpeech } from "../services/voice.js";
import { runClaudeAgent } from "../claude.js";

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

  if (!config.groqApiKey) {
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

    // 3. Send to Claude
    session.messageCount++;

    await runClaudeAgent({
      prompt: transcript,
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

    // 4. Send voice reply if enabled
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
