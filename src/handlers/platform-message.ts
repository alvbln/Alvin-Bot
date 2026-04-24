/**
 * Generic Platform Message Handler
 *
 * Processes messages from any platform adapter (WhatsApp, Discord, Signal)
 * through the AI engine and sends the response back.
 *
 * This is the platform-agnostic equivalent of message.ts (which is Telegram-specific).
 */

import fs from "fs";
import { getSession, addToHistory, trackProviderUsage, buildSessionKey, markSessionDirty } from "../services/session.js";
import { resolveWorkspaceOrDefault } from "../services/workspaces.js";
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
        await adapter.sendText(msg.chatId, "Could not understand the voice message. 🤷");
        return;
      }

      await adapter.sendText(msg.chatId, `🎙️ _"${transcript}"_`);
      text = transcript;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Voice transcription error:", errMsg);
      await adapter.sendText(msg.chatId, `⚠️ Voice message error: ${errMsg}`);
      if (msg.media.path) fs.unlink(msg.media.path, () => {});
      return;
    }
  }

  // ── Photo with caption: describe as context ──────────────────────────
  if (msg.media?.type === "photo" && msg.media.path) {
    const caption = text || "Beschreibe dieses Bild.";
    text = `[Image attached: ${msg.media.path}]\n\n${caption}`;
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
      fileHint += `\n\nOpen with python3 (openpyxl for xlsx, python-docx for docx, csv module for csv).`;
    }

    text = `${fileHint}\n\n${caption}`;
  }

  if (!text) return;

  // ── Basic command handling for non-Telegram platforms ──────────────
  const cmdHandled = await handlePlatformCommand(text, msg, adapter);
  if (cmdHandled) return;

  // v4.12.0 — Use buildSessionKey so each channel on Slack/Discord/WhatsApp
  // gets its own session. Before v4.12.0 we hashed just userId, which
  // collapsed every channel from the same user into one session and broke
  // multi-session completely on non-Telegram platforms.
  const sessionKey = buildSessionKey(msg.platform, msg.chatId, msg.userId);
  const session = getSession(sessionKey);
  // touchProfile still uses a stable userId-based numeric hash for the
  // user profile store — profiles are about *people*, not sessions.
  const profileKey = hashUserId(msg.userId);
  touchProfile(profileKey, msg.userName, msg.userHandle, msg.platform as any, text);

  // v4.12.0 — Workspace resolution: channel → workspace → persona + cwd.
  // P1 #2 — If the platform has a getChannelName helper (Slack does), use
  // it to enable channel-name-based workspace matching (e.g. #my-project →
  // workspaces/my-project.md). Cached in the adapter, so no extra API call
  // after the first hit per channel.
  let channelName: string | undefined;
  const getChannelName = (adapter as unknown as {
    getChannelName?: (id: string) => Promise<string | undefined>;
  }).getChannelName;
  if (typeof getChannelName === "function") {
    try {
      channelName = await getChannelName.call(adapter, msg.chatId);
    } catch {
      channelName = undefined;
    }
  }
  const workspace = resolveWorkspaceOrDefault(msg.platform, msg.chatId, channelName);
  // v4.19.1 — Workspace switch detection. If cwd changes as part of the
  // switch, null out session.sessionId so the next SDK turn does not
  // resume a session file that lives in the previous project folder
  // (Claude Agent SDK stores sessions under ~/.claude/projects/<cwd-hash>/).
  // Guard with workspaceName so /dir-initiated custom cwds survive turns
  // where no workspace actually switched.
  if (session.workspaceName !== workspace.name) {
    const cwdChanged = session.workingDir !== workspace.cwd;
    session.workspaceName = workspace.name;
    session.workingDir = workspace.cwd;
    if (cwdChanged) {
      console.log(
        `[session] workspace switch changed cwd (→ ${workspace.cwd}) — ` +
        `invalidating SDK resume anchor to prevent empty-stream loop`,
      );
      session.sessionId = null;
      session.lastSdkHistoryIndex = -1;
      markSessionDirty(sessionKey);
    }
  }

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
    // v4.11.0 P0 #3 — SDK gets semantic recall on first turn (when no resume token yet).
    // v4.12.0 P0 #3 — Workspace persona is forwarded so per-channel personas land
    // in the system prompt for this query.
    const isFirstSDKTurn = isSDK && session.sessionId === null;
    const systemPrompt = (
      await buildSmartSystemPrompt(
        isSDK,
        session.language,
        fullText,
        msg.chatId,
        isFirstSDKTurn,
        workspace.systemPromptOverride,
      )
    ) + skillContext;

    // v4.19.0 — Per-workspace runtime overrides (model/effort/temperature/toolset).
    const { toolsetToAllowedTools } = await import("../services/workspaces.js");
    const wsAllowed = toolsetToAllowedTools(workspace.toolset);

    const queryOpts: QueryOptions = {
      prompt: fullText,
      systemPrompt,
      workingDir: session.workingDir,
      effort: workspace.effort ?? session.effort,
      // v4.15 — Per-workspace model override (optional YAML `model:` field).
      // v4.19 — ditto for temperature and toolset-derived allowedTools.
      ...(workspace.model ? { model: workspace.model } : {}),
      ...(workspace.temperature !== undefined ? { temperature: workspace.temperature } : {}),
      ...(wsAllowed ? { allowedTools: wsAllowed } : {}),
      sessionId: isSDK ? session.sessionId : null,
      history: !isSDK ? session.history : undefined,
      // v4.14 — Expose alvin_dispatch_agent MCP tool on non-Telegram
      // platforms too (Slack/Discord/WhatsApp). The watcher routes the
      // eventual delivery via the platform's registered DeliveryAdapter.
      // Only for SDK provider (where MCP tools are supported).
      alvinDispatchContext: isSDK
        ? {
            chatId: msg.chatId,
            userId: msg.userId,
            sessionKey,
            platform: msg.platform as "slack" | "discord" | "whatsapp",
          }
        : undefined,
    };

    if (!isSDK) {
      addToHistory(sessionKey, { role: "user", content: fullText });
    }

    // v4.19.1 — Track whether the provider requested a session reset during
    // this stream. If it did, the trailing `done` chunk's sessionId MUST be
    // ignored — otherwise it restores the exact sessionId we just cleared
    // and the next turn loops again. Mirror of message.ts.
    let sessionResetInStream = false;
    for await (const chunk of registry.queryWithFallback(queryOpts, workspace.provider)) {
      switch (chunk.type) {
        case "text":
          finalText = chunk.text || "";
          // v4.18.5 — Provider-requested session reset on empty-stream detection.
          // Mirror of the same handling in handlers/message.ts.
          if (chunk.sessionResetRequested) {
            console.warn(`[session] provider requested reset for ${sessionKey} — clearing sessionId + SDK anchor`);
            session.sessionId = null;
            session.lastSdkHistoryIndex = -1;
            sessionResetInStream = true;
            markSessionDirty(sessionKey);
          }
          break;
        case "done":
          // v4.19.1 — Respect in-stream reset: don't let done.sessionId undo
          // the clear from the empty-stream text chunk. See message.ts for
          // full rationale.
          if (chunk.sessionId && !sessionResetInStream) session.sessionId = chunk.sessionId;
          if (chunk.costUsd) session.totalCost += chunk.costUsd;
          trackProviderUsage(sessionKey, registry.getActiveKey(), chunk.costUsd || 0, chunk.inputTokens, chunk.outputTokens);
          session.lastActivity = Date.now();
          break;
        case "error":
          await adapter.sendText(msg.chatId, `⚠️ Error: ${chunk.error}`);
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
        addToHistory(sessionKey, { role: "assistant", content: finalText });
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Platform message error (${msg.platform}):`, errorMsg);
    await adapter.sendText(msg.chatId, `⚠️ Error: ${errorMsg}`);
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
  // v4.12.0 — Same buildSessionKey routing as the main handler so /new and
  // /status etc operate on the per-channel session, not the per-user one.
  const sessionKey = buildSessionKey(msg.platform, msg.chatId, msg.userId);
  const session = getSession(sessionKey);

  switch (cmd) {
    case "/new": {
      const { resetSession } = await import("../services/session.js");
      resetSession(sessionKey);
      await adapter.sendText(msg.chatId, "🔄 New chat started.");
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
        await adapter.sendText(msg.chatId, `🧠 Current: ${session.effort}\nOptions: /effort low|medium|high|max`);
      }
      return true;
    }
    case "/help": {
      await adapter.sendText(msg.chatId,
        "🤖 Alvin Bot — Commands\n\n" +
        "/new — New chat\n" +
        "/status — Session info\n" +
        "/effort <low|medium|high|max> — Thinking depth\n" +
        "/help — This help\n\n" +
        "For all features use the Web Dashboard or Telegram."
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
