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

/** Platform-specific message length limits */
const PLATFORM_LIMITS: Record<string, number> = {
  discord: 2000,
  telegram: 4096,
  whatsapp: 4096,
  signal: 6000,
  web: 100_000,
};

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
      fs.unlink(msg.media.path, () => {});

      if (!transcript.trim()) {
        await adapter.sendText(msg.chatId, "Konnte die Sprachnachricht nicht verstehen. 🤷");
        return;
      }

      await adapter.sendText(msg.chatId, `🎙️ _"${transcript}"_`);
      text = transcript;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Voice transcription error:", errMsg);
      await adapter.sendText(msg.chatId, `⚠️ Sprachnachricht-Fehler: ${errMsg}`);
      if (msg.media.path) fs.unlink(msg.media.path, () => {});
      return;
    }
  }

  // ── Photo with caption: describe as context ──────────────────────────
  if (msg.media?.type === "photo" && msg.media.path) {
    const caption = text || "Beschreibe dieses Bild.";
    text = `[Bild angehängt: ${msg.media.path}]\n\n${caption}`;
  }

  // ── Document: provide path + filename + instructions ──────────────────
  if (msg.media?.type === "document" && msg.media.path) {
    const fname = msg.media.fileName || "Dokument";
    const fpath = msg.media.path;
    const ext = fname.split(".").pop()?.toLowerCase() || "";
    const caption = text || `Analysiere dieses Dokument: ${fname}`;

    // Give the AI concrete instructions based on file type
    const isArchive = ["zip", "tar", "gz", "tgz", "7z", "rar"].includes(ext);
    const isPdf = ext === "pdf";
    const isOffice = ["xlsx", "xls", "docx", "doc", "pptx", "csv"].includes(ext);

    let fileHint = `[Datei empfangen: ${fpath}]\nDateiname: ${fname}\nTyp: ${msg.media.mimeType || "unbekannt"}`;
    if (isArchive) {
      fileHint += `\n\nDiese Datei ist ein Archiv. Entpacke sie mit: unzip "${fpath}" -d "${fpath.replace(/\.[^.]+$/, "")}" oder tar xf "${fpath}" und arbeite dann mit dem Inhalt.`;
    } else if (isPdf) {
      fileHint += `\n\nLies den Inhalt mit: pdftotext "${fpath}" - oder python3 mit PyPDF2/pdfplumber.`;
    } else if (isOffice) {
      fileHint += `\n\nÖffne mit python3 (openpyxl für xlsx, python-docx für docx, csv-Modul für csv).`;
    }

    text = `${fileHint}\n\n${caption}`;
  }

  if (!text) return;

  // ── Basic command handling for non-Telegram platforms ──────────────
  const cmdHandled = await handlePlatformCommand(text, msg, adapter);
  if (cmdHandled) return;

  const userId = hashUserId(msg.userId);
  const session = getSession(userId);

  touchProfile(userId, msg.userName, msg.userHandle, msg.platform as any, text);

  // Skip if already processing (queue up to 3)
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

  // Show typing indicator
  if (adapter.setTyping) {
    adapter.setTyping(msg.chatId).catch(() => {});
  }

  // Keep typing indicator alive during long requests (refresh every 4s)
  const typingInterval = adapter.setTyping
    ? setInterval(() => adapter.setTyping!(msg.chatId).catch(() => {}), 4000)
    : null;

  try {
    session.messageCount++;

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

    if (!isSDK) {
      addToHistory(userId, { role: "user", content: fullText });
    }

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
      const maxLen = PLATFORM_LIMITS[msg.platform] || 4096;
      if (finalText.length > maxLen) {
        const chunks = splitMessage(finalText, maxLen);
        for (const chunk of chunks) {
          await adapter.sendText(msg.chatId, chunk);
        }
      } else {
        await adapter.sendText(msg.chatId, finalText);
      }

      if (!isSDK && finalText) {
        addToHistory(userId, { role: "assistant", content: finalText });
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Platform message error (${msg.platform}):`, errorMsg);
    await adapter.sendText(msg.chatId, `⚠️ Fehler: ${errorMsg}`);
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    session.isProcessing = false;
  }
}

/**
 * Handle basic slash commands on non-Telegram platforms.
 * Returns true if the message was a command and was handled.
 */
async function handlePlatformCommand(
  text: string,
  msg: IncomingMessage,
  adapter: PlatformAdapter
): Promise<boolean> {
  if (!text.startsWith("/")) return false;

  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const userId = hashUserId(msg.userId);
  const session = getSession(userId);

  switch (cmd) {
    case "/new": {
      const { resetSession } = await import("../services/session.js");
      resetSession(userId);
      await adapter.sendText(msg.chatId, "🔄 Neuer Chat gestartet.");
      return true;
    }
    case "/status": {
      const { getRegistry } = await import("../engine.js");
      const registry = getRegistry();
      const provider = registry.getActiveKey();
      const msgs = session.messageCount;
      const cost = session.totalCost.toFixed(4);
      await adapter.sendText(msg.chatId,
        `📊 Status\n` +
        `Provider: ${provider}\n` +
        `Messages: ${msgs}\n` +
        `Cost: $${cost}\n` +
        `Effort: ${session.effort}\n` +
        `Platform: ${msg.platform}`
      );
      return true;
    }
    case "/effort": {
      const level = parts[1]?.toLowerCase();
      if (["low", "medium", "high", "max"].includes(level)) {
        session.effort = level as any;
        await adapter.sendText(msg.chatId, `🧠 Effort: ${level}`);
      } else {
        await adapter.sendText(msg.chatId, `🧠 Aktuell: ${session.effort}\nOptionen: /effort low|medium|high|max`);
      }
      return true;
    }
    case "/help": {
      await adapter.sendText(msg.chatId,
        "🤖 Alvin Bot — Befehle\n\n" +
        "/new — Neuer Chat\n" +
        "/status — Session-Info\n" +
        "/effort <low|medium|high|max> — Denktiefe\n" +
        "/help — Diese Hilfe\n\n" +
        "Für alle Features nutze das Web Dashboard oder Telegram."
      );
      return true;
    }
    default:
      // Unknown command → treat as normal message
      return false;
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
