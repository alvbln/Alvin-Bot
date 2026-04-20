import https from "https";
import fs from "fs";
import path from "path";
import os from "os";
import { config } from "../config.js";

const TEMP_DIR = path.join(os.tmpdir(), "alvin-bot");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

/**
 * Generate speech via ElevenLabs API.
 * Returns path to the mp3 file.
 */
export async function elevenLabsTTS(text: string, voiceId?: string, modelId?: string): Promise<string> {
  const voice = voiceId || config.elevenlabs.voiceId;
  const model = modelId || config.elevenlabs.modelId;
  const apiKey = config.elevenlabs.apiKey;

  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const outputPath = path.join(TEMP_DIR, `tts_el_${Date.now()}.mp3`);

  const body = JSON.stringify({
    text,
    model_id: model,
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
    },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${voice}`,
      method: "POST",
      headers: {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => reject(new Error(`ElevenLabs API error ${res.statusCode}: ${data}`)));
        return;
      }

      const file = fs.createWriteStream(outputPath);
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve(outputPath);
      });
      file.on("error", reject);
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
