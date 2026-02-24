import type { Context } from "grammy";
import { InputFile } from "grammy";
import fs from "fs";
import { getSession, addToHistory, trackProviderUsage } from "../services/session.js";
import { TelegramStreamer } from "../services/telegram.js";
import { getRegistry } from "../engine.js";
import { textToSpeech } from "../services/voice.js";
import type { QueryOptions } from "../providers/types.js";
import { buildSystemPrompt } from "../services/personality.js";
import { isForwardingAllowed } from "../services/access.js";

/** React to a message with an emoji. Silently fails if reactions aren't supported. */
async function react(ctx: Context, emoji: string): Promise<void> {
  try {
    await ctx.react(emoji as Parameters<typeof ctx.react>[0]);
  } catch {
    // Reactions not supported in this chat — silently ignore
  }
}

export async function handleMessage(ctx: Context): Promise<void> {
  const rawText = ctx.message?.text;
  if (!rawText || rawText.startsWith("/")) return;

  // Build prompt with context
  let text = rawText;

  // Forwarded message — add forward context (if allowed)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgAny = ctx.message as any;
  if (msgAny?.forward_origin || msgAny?.forward_date) {
    if (!isForwardingAllowed()) {
      await ctx.reply("⚠️ Weitergeleitete Nachrichten sind deaktiviert. Aktiviere mit `/security forwards on`", { parse_mode: "Markdown" });
      return;
    }
    const forwardFrom = msgAny.forward_sender_name || "unbekannt";
    text = `[Weitergeleitete Nachricht von ${forwardFrom}]\n\n${rawText}`;
  }

  // Reply context — include quoted message
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo?.text) {
    const quotedText = replyTo.text.length > 500
      ? replyTo.text.slice(0, 500) + "..."
      : replyTo.text;
    text = `[Bezug auf vorherige Nachricht: "${quotedText}"]\n\n${text}`;
  }

  const userId = ctx.from!.id;
  const session = getSession(userId);

  if (session.isProcessing) {
    await ctx.reply("Bitte warten, vorherige Anfrage läuft noch... (/cancel zum Abbrechen)");
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
    // React with 🤔 to show we're thinking
    await react(ctx, "🤔");
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");
    session.messageCount++;

    const registry = getRegistry();
    const activeProvider = registry.getActive();
    const isSDK = activeProvider.config.type === "claude-sdk";

    // Build query options
    const queryOpts: QueryOptions & { _sessionState?: { messageCount: number; toolUseCount: number } } = {
      prompt: text,
      systemPrompt: buildSystemPrompt(isSDK, session.language),
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
          trackProviderUsage(userId, registry.getActiveKey(), chunk.costUsd || 0);
          session.lastActivity = Date.now();
          break;

        case "fallback":
          await ctx.reply(
            `⚡ _${chunk.failedProvider} nicht verfügbar — wechsle zu ${chunk.providerName}_`,
            { parse_mode: "Markdown" }
          );
          break;

        case "error":
          await ctx.reply(`Fehler: ${chunk.error}`);
          break;
      }
    }

    await streamer.finalize(finalText);

    // Clear thinking reaction (replace with nothing — message was answered)
    await react(ctx, "👍");

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
