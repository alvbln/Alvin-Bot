import type { Context } from "grammy";
import { InputFile } from "grammy";
import fs from "fs";
import { getSession } from "../services/session.js";
import { TelegramStreamer } from "../services/telegram.js";
import { runClaudeAgent } from "../claude.js";
import { textToSpeech } from "../services/voice.js";

export async function handleMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text || text.startsWith("/")) return;

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

    session.messageCount++;

    await runClaudeAgent({
      prompt: text,
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
      onToolUse: async (toolName) => {
        // Could show tool activity, keeping it silent for now
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
