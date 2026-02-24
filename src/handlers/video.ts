/**
 * Video Message Handler — Process video messages and video notes (round videos).
 *
 * Capabilities:
 * - Receive video messages → extract key frames → describe/analyze
 * - Receive video notes (round videos) → same processing
 * - Extract audio from video → transcribe (if voice content)
 * - Support for video files sent as documents (handled by document handler)
 */

import type { Context } from "grammy";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { execSync } from "child_process";
import { config } from "../config.js";
import { getSession, addToHistory } from "../services/session.js";
import { TelegramStreamer } from "../services/telegram.js";
import { getRegistry } from "../engine.js";
import { transcribeAudio } from "../services/voice.js";
import type { QueryOptions } from "../providers/types.js";
import { buildSystemPrompt } from "../services/personality.js";

const TEMP_DIR = path.join(os.tmpdir(), "alvin-bot", "video");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

/** React helper */
async function react(ctx: Context, emoji: string): Promise<void> {
  try { await ctx.react(emoji as Parameters<typeof ctx.react>[0]); } catch { /* ignore */ }
}

/** Download a Telegram file */
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

/** Check if ffmpeg is available */
function hasFFmpeg(): boolean {
  try {
    execSync("which ffmpeg", { stdio: "pipe" });
    return true;
  } catch { return false; }
}

/** Extract key frames from a video (up to 4 frames, evenly spaced) */
function extractFrames(videoPath: string, outputDir: string, maxFrames = 4): string[] {
  // Get video duration
  let duration = 10;
  try {
    const probe = execSync(
      `ffprobe -v error -show_entries format=duration -of csv="p=0" "${videoPath}"`,
      { stdio: "pipe" }
    ).toString().trim();
    duration = parseFloat(probe) || 10;
  } catch { /* default duration */ }

  const interval = Math.max(duration / (maxFrames + 1), 0.5);
  const frames: string[] = [];

  for (let i = 1; i <= maxFrames; i++) {
    const timestamp = Math.min(interval * i, duration - 0.1);
    const framePath = path.join(outputDir, `frame_${i}.jpg`);

    try {
      execSync(
        `ffmpeg -ss ${timestamp.toFixed(2)} -i "${videoPath}" -vframes 1 -q:v 3 -y "${framePath}" 2>/dev/null`,
        { stdio: "pipe", timeout: 10000 }
      );

      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 0) {
        frames.push(framePath);
      }
    } catch { /* skip this frame */ }
  }

  return frames;
}

/** Extract audio track from video */
function extractAudio(videoPath: string): string | null {
  const audioPath = videoPath.replace(/\.\w+$/, ".ogg");
  try {
    execSync(
      `ffmpeg -i "${videoPath}" -vn -acodec libopus -y "${audioPath}" 2>/dev/null`,
      { stdio: "pipe", timeout: 30000 }
    );
    if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
      return audioPath;
    }
  } catch { /* no audio track or extraction failed */ }
  return null;
}

export async function handleVideo(ctx: Context): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const video = (ctx.message as any)?.video || (ctx.message as any)?.video_note;
  if (!video) return;

  const userId = ctx.from!.id;
  const session = getSession(userId);

  if (session.isProcessing) {
    if (session.messageQueue.length < 3) {
      session.messageQueue.push("[Video-Nachricht empfangen]");
      await react(ctx, "📝");
    }
    return;
  }

  if (!hasFFmpeg()) {
    await ctx.reply("❌ Video-Verarbeitung benötigt ffmpeg. Installiere mit: `brew install ffmpeg`", { parse_mode: "Markdown" });
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
    await react(ctx, "👀");
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");

    // 1. Download video
    const file = await ctx.api.getFile(video.file_id);
    const ext = file.file_path?.split(".").pop() || "mp4";
    const videoPath = path.join(TEMP_DIR, `video_${Date.now()}.${ext}`);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    await downloadFile(fileUrl, videoPath);

    // 2. Extract key frames
    const frameDir = path.join(TEMP_DIR, `frames_${Date.now()}`);
    fs.mkdirSync(frameDir, { recursive: true });
    const frames = extractFrames(videoPath, frameDir);

    // 3. Extract and transcribe audio (if available)
    let transcript = "";
    if (config.apiKeys.groq) {
      const audioPath = extractAudio(videoPath);
      if (audioPath) {
        try {
          transcript = await transcribeAudio(audioPath);
          fs.unlink(audioPath, () => {});
        } catch { /* no transcription */ }
      }
    }

    // 4. Build prompt with video context
    const caption = ctx.message?.caption || "";
    const duration = video.duration || 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isVideoNote = !!(ctx.message as any)?.video_note;

    let prompt = `[Video empfangen: ${duration}s`;
    if (isVideoNote) prompt += ", runde Videonachricht";
    if (video.width && video.height) prompt += `, ${video.width}x${video.height}`;
    prompt += "]";

    if (transcript) {
      prompt += `\n\n[Audio-Transkription]: "${transcript}"`;
    }
    if (caption) {
      prompt += `\n\n[Bildunterschrift]: "${caption}"`;
    }
    if (frames.length > 0) {
      prompt += `\n\n[${frames.length} Schlüsselbilder aus dem Video extrahiert]`;
      prompt += "\n\nBitte beschreibe was im Video zu sehen ist und beantworte eventuelle Fragen.";
    } else {
      prompt += "\n\nIch konnte keine Frames extrahieren. Basiere deine Antwort auf der Audio-Transkription.";
    }

    // Show what we extracted
    const infoLines = [];
    if (frames.length > 0) infoLines.push(`🎞️ ${frames.length} Frames extrahiert`);
    if (transcript) infoLines.push(`🎙️ "${transcript.slice(0, 100)}${transcript.length > 100 ? "..." : ""}"`);
    if (infoLines.length > 0) {
      await ctx.reply(infoLines.join("\n"));
    }

    // 5. Send to AI
    session.messageCount++;
    const registry = getRegistry();
    const activeProvider = registry.getActive();
    const isSDK = activeProvider.config.type === "claude-sdk";

    const queryOpts: QueryOptions = {
      prompt,
      systemPrompt: buildSystemPrompt(isSDK, session.language),
      workingDir: session.workingDir,
      effort: session.effort,
      abortSignal: session.abortController!.signal,
      sessionId: isSDK ? session.sessionId : null,
      history: !isSDK ? session.history : undefined,
    };

    if (!isSDK) {
      addToHistory(userId, { role: "user", content: prompt });
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

    // Cleanup
    frames.forEach(f => fs.unlink(f, () => {}));
    fs.rm(frameDir, { recursive: true }, () => {});
    fs.unlink(videoPath, () => {});

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
