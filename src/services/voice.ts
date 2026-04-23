import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { EdgeTTS } from "node-edge-tts";
import { config } from "../config.js";

const TEMP_DIR = path.join(os.tmpdir(), "alvin-bot");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ── Speech-to-Text (Groq Whisper) ──────────────────────

export async function transcribeAudio(audioPath: string): Promise<string> {
  const fileBuffer = fs.readFileSync(audioPath);
  const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);

  const fileName = path.basename(audioPath);
  let body = "";
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`;
  body += `Content-Type: audio/ogg\r\n\r\n`;

  const bodyStart = Buffer.from(body, "utf-8");
  const bodyEnd = Buffer.from(
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `whisper-large-v3-turbo\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="language"\r\n\r\n` +
    `de\r\n` +
    `--${boundary}--\r\n`,
    "utf-8"
  );

  const fullBody = Buffer.concat([bodyStart, fileBuffer, bodyEnd]);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.groq.com",
        path: "/openai/v1/audio/transcriptions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKeys.groq}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": fullBody.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json.text || "");
          } catch {
            reject(new Error(`Groq STT error: ${data}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(fullBody);
    req.end();
  });
}

// ── Text-to-Speech (Edge TTS via node-edge-tts) ────────

/**
 * Convert text to speech and return path to the MP3 file.
 *
 * @param text   The text to synthesize.
 * @param voice  Optional voice ID / name override (v4.19.0 — per-workspace).
 *               For ElevenLabs this is the Voice ID, for Edge TTS the Voice Name
 *               (e.g. "de-DE-ConradNeural", "en-US-JennyNeural"). When undefined,
 *               the config default is used.
 */
export async function textToSpeech(text: string, voice?: string): Promise<string> {
  // Strip markdown formatting for cleaner TTS
  let cleanText = text
    .replace(/```[\s\S]*?```/g, " Code block skipped. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/#{1,6}\s/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .trim();

  if (!cleanText) {
    throw new Error("No text available for TTS");
  }

  if (cleanText.length > 3000) {
    cleanText = cleanText.slice(0, 3000) + "... Text truncated.";
  }

  // Try ElevenLabs if configured
  if (config.ttsProvider === "elevenlabs" && config.elevenlabs.apiKey) {
    try {
      const { elevenLabsTTS } = await import("./elevenlabs.js");
      // v4.19.0 — per-workspace voice override. When unset, elevenLabsTTS falls
      // back to config.elevenlabs.voiceId.
      return await elevenLabsTTS(cleanText, voice);
    } catch (err) {
      console.warn("ElevenLabs TTS failed, falling back to Edge TTS:", err instanceof Error ? err.message : err);
    }
  }

  // Edge TTS (default / fallback)
  const outputPath = path.join(TEMP_DIR, `tts_${Date.now()}.mp3`);

  const tts = new EdgeTTS({
    // v4.19.0 — allow workspace override; default German male.
    voice: voice || "de-DE-ConradNeural",
    lang: voice && voice.match(/^[a-z]{2}-[A-Z]{2}/) ? voice.slice(0, 5) : "de-DE",
    outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  });

  await tts.ttsPromise(cleanText, outputPath);
  return outputPath;
}
