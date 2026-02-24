import type { Context } from "grammy";
import { InputFile } from "grammy";
import fs from "fs";
import { getSession, addToHistory } from "../services/session.js";
import { TelegramStreamer } from "../services/telegram.js";
import { getRegistry } from "../engine.js";
import { textToSpeech } from "../services/voice.js";
import type { QueryOptions } from "../providers/types.js";

/** Build system prompt based on provider type */
function buildSystemPrompt(isSDK: boolean): string {
  const base = `Du bist ein autonomer AI-Agent, gesteuert über Telegram.
Halte Antworten kurz und prägnant, aber gründlich.
Nutze Markdown-Formatierung kompatibel mit Telegram (fett, kursiv, Code-Blöcke).
Antworte auf Deutsch, es sei denn der User schreibt auf Englisch.`;

  if (isSDK) {
    // SDK provider gets tool instructions (CLAUDE.md is injected separately)
    return `${base}\nWenn du Commands ausführst oder Dateien bearbeitest, erkläre kurz was du getan hast.`;
  }

  return base;
}

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

    const registry = getRegistry();
    const activeProvider = registry.getActive();
    const isSDK = activeProvider.config.type === "claude-sdk";

    // Build query options
    const queryOpts: QueryOptions & { _sessionState?: { messageCount: number; toolUseCount: number } } = {
      prompt: text,
      systemPrompt: buildSystemPrompt(isSDK),
      workingDir: session.workingDir,
      effort: session.effort,
      abortSignal: session.abortController.signal,
      // SDK-specific
      sessionId: isSDK ? session.sessionId : null,
      // Non-SDK: include conversation history
      history: !isSDK ? session.history : undefined,
      // SDK checkpoint tracking
      _sessionState: isSDK ? {
        messageCount: session.messageCount,
        toolUseCount: session.toolUseCount,
      } : undefined,
    };

    // Add user message to history (for non-SDK providers)
    if (!isSDK) {
      addToHistory(userId, { role: "user", content: text });
    }

    // Stream response from provider (with fallback)
    for await (const chunk of registry.queryWithFallback(queryOpts)) {
      switch (chunk.type) {
        case "text":
          finalText = chunk.text || "";
          await streamer.update(finalText);
          break;

        case "tool_use":
          // Could show tool activity indicator
          if (chunk.toolName) {
            session.toolUseCount++;
          }
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

    // Add assistant response to history (for non-SDK providers)
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
