import type { Context } from "grammy";
import { InputFile } from "grammy";
import fs from "fs";
import { getSession, addToHistory, trackProviderUsage } from "../services/session.js";
import { TelegramStreamer } from "../services/telegram.js";
import { getRegistry } from "../engine.js";
import { textToSpeech } from "../services/voice.js";
import type { QueryOptions } from "../providers/types.js";
import { buildSystemPrompt, buildSmartSystemPrompt } from "../services/personality.js";
import { buildSkillContext } from "../services/skills.js";
import { isForwardingAllowed } from "../services/access.js";
import { touchProfile } from "../services/users.js";
import { trackAndAdapt } from "../services/language-detect.js";

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

  // Track user profile
  touchProfile(userId, ctx.from?.first_name, ctx.from?.username, "telegram", text);

  // Sync session language from persistent profile (on first message)
  if (session.messageCount === 0) {
    const { loadProfile } = await import("../services/users.js");
    const profile = loadProfile(userId);
    if (profile?.language) session.language = profile.language;
  }

  if (session.isProcessing) {
    // Queue the message instead of rejecting it (max 3)
    if (session.messageQueue.length < 3) {
      session.messageQueue.push(text);
      await react(ctx, "📝");
    } else {
      await ctx.reply("⏳ Warteschlange voll (3 Nachrichten). Bitte warten oder /cancel.");
    }
    return;
  }

  // Consume queued messages (sent while previous query was processing)
  if (session.messageQueue.length > 0) {
    const queued = session.messageQueue.splice(0);
    text = [...queued, text].join("\n\n");
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

    // Auto-detect and adapt language from user's message
    const userId = ctx.from!.id;
    const adaptedLang = trackAndAdapt(userId, text, session.language);
    if (adaptedLang !== session.language) {
      session.language = adaptedLang;
    }

    const registry = getRegistry();
    const activeProvider = registry.getActive();
    const isSDK = activeProvider.config.type === "claude-sdk";

    // Build query options (with semantic memory search for non-SDK + skill injection)
    const chatIdStr = String(ctx.chat!.id);
    const skillContext = buildSkillContext(text);
    const systemPrompt = (isSDK
      ? buildSystemPrompt(isSDK, session.language, chatIdStr)
      : await buildSmartSystemPrompt(isSDK, session.language, text, chatIdStr)
    ) + skillContext;

    const queryOpts: QueryOptions & { _sessionState?: { messageCount: number; toolUseCount: number } } = {
      prompt: text,
      systemPrompt,
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
          trackProviderUsage(userId, registry.getActiveKey(), chunk.costUsd || 0, chunk.inputTokens, chunk.outputTokens);
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

    // Check for queued messages — they'll be prepended to the next real message
    // Queue stays in session and gets consumed on next handleMessage call
  }
}
