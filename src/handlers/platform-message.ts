/**
 * Generic Platform Message Handler
 *
 * Processes messages from any platform adapter (WhatsApp, Discord, Signal)
 * through the AI engine and sends the response back.
 *
 * This is the platform-agnostic equivalent of message.ts (which is Telegram-specific).
 */

import fs from "fs";
import { getSession, addToHistory, trackProviderUsage } from "../services/session.js";
import { getRegistry } from "../engine.js";
import { buildSystemPrompt, buildSmartSystemPrompt } from "../services/personality.js";
import { buildSkillContext } from "../services/skills.js";
import { touchProfile } from "../services/users.js";
import { trackAndAdapt } from "../services/language-detect.js";
import { transcribeAudio } from "../services/voice.js";
import { config } from "../config.js";
import type { QueryOptions } from "../providers/types.js";
import type { IncomingMessage, PlatformAdapter } from "../platforms/types.js";

/**
 * Handle an incoming message from any platform adapter.
 * Runs the AI query and sends the response back via the adapter's sendText.
 */
export async function handlePlatformMessage(
  msg: IncomingMessage,
  adapter: PlatformAdapter
): Promise<void> {
  let text = msg.text?.trim();

  // ── Voice message: transcribe first ──────────────────────────────────
  if (msg.media?.type === "voice" && msg.media.path) {
    if (!config.apiKeys.groq) {
      await adapter.sendText(msg.chatId, "⚠️ Voice nicht konfiguriert (GROQ_API_KEY fehlt).");
      return;
    }
    try {
      const transcript = await transcribeAudio(msg.media.path);
      // Clean up temp file
      fs.unlink(msg.media.path, () => {});

      if (!transcript.trim()) {
        await adapter.sendText(msg.chatId, "Konnte die Sprachnachricht nicht verstehen. 🤷");
        return;
      }

      // Show what was understood
      await adapter.sendText(msg.chatId, `🎙️ _"${transcript}"_`);

      // Use transcript as the message text
      text = transcript;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Voice transcription error:", errMsg);
      await adapter.sendText(msg.chatId, `⚠️ Sprachnachricht-Fehler: ${errMsg}`);
      // Clean up temp file on error too
      if (msg.media.path) fs.unlink(msg.media.path, () => {});
      return;
    }
  }

  if (!text) return;

  // Use a numeric hash of the userId for session compatibility
  const userId = hashUserId(msg.userId);
  const session = getSession(userId);

  // Track user profile
  touchProfile(userId, msg.userName, msg.userHandle, msg.platform as any, text);

  // Skip if already processing
  if (session.isProcessing) {
    if (session.messageQueue.length < 3) {
      session.messageQueue.push(text);
    }
    return;
  }

  // Consume queued messages
  let fullText = text;
  if (session.messageQueue.length > 0) {
    const queued = session.messageQueue.splice(0);
    fullText = [...queued, text].join("\n\n");
  }

  // Add reply context
  if (msg.replyToText) {
    const quoted = msg.replyToText.length > 500
      ? msg.replyToText.slice(0, 500) + "..."
      : msg.replyToText;
    fullText = `[Bezug auf: "${quoted}"]\n\n${fullText}`;
  }

  session.isProcessing = true;
  let finalText = "";

  try {
    session.messageCount++;

    // Auto-detect and adapt language
    const adaptedLang = trackAndAdapt(Number(msg.userId) || 0, fullText, session.language);
    if (adaptedLang !== session.language) session.language = adaptedLang;

    const registry = getRegistry();
    const activeProvider = registry.getActive();
    const isSDK = activeProvider.config.type === "claude-sdk";

    const skillContext = buildSkillContext(fullText);
    const systemPrompt = (isSDK
      ? buildSystemPrompt(isSDK, session.language, msg.chatId)
      : await buildSmartSystemPrompt(isSDK, session.language, fullText, msg.chatId)
    ) + skillContext;

    const queryOpts: QueryOptions = {
      prompt: fullText,
      systemPrompt,
      workingDir: session.workingDir,
      effort: session.effort,
      sessionId: isSDK ? session.sessionId : null,
      history: !isSDK ? session.history : undefined,
    };

    // Add user message to history (for non-SDK providers)
    if (!isSDK) {
      addToHistory(userId, { role: "user", content: fullText });
    }

    // Run query (collect full response, no streaming for non-Telegram)
    for await (const chunk of registry.queryWithFallback(queryOpts)) {
      switch (chunk.type) {
        case "text":
          finalText = chunk.text || "";
          break;
        case "done":
          if (chunk.sessionId) session.sessionId = chunk.sessionId;
          if (chunk.costUsd) session.totalCost += chunk.costUsd;
          trackProviderUsage(userId, registry.getActiveKey(), chunk.costUsd || 0);
          session.lastActivity = Date.now();
          break;
        case "error":
          await adapter.sendText(msg.chatId, `⚠️ Fehler: ${chunk.error}`);
          return;
      }
    }

    // Send response
    if (finalText.trim()) {
      // Split long messages (WhatsApp/Discord have limits)
      const maxLen = msg.platform === "discord" ? 2000 : 4096;
      if (finalText.length > maxLen) {
        const chunks = splitMessage(finalText, maxLen);
        for (const chunk of chunks) {
          await adapter.sendText(msg.chatId, chunk);
        }
      } else {
        await adapter.sendText(msg.chatId, finalText);
      }

      // Add to history
      if (!isSDK && finalText) {
        addToHistory(userId, { role: "assistant", content: finalText });
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Platform message error:`, errorMsg);
    await adapter.sendText(msg.chatId, `⚠️ Fehler: ${errorMsg}`);
  } finally {
    session.isProcessing = false;
  }
}

/** Hash a string userId to a numeric ID for session compatibility */
function hashUserId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    const char = id.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit int
  }
  return Math.abs(hash);
}

/** Split a message into chunks at word/newline boundaries */
function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
