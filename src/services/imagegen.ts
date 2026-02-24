/**
 * Image Generation Service — Generate images via Gemini (Nano Banana Pro).
 *
 * Uses Google's generativelanguage API with responseModalities: IMAGE.
 * Requires GOOGLE_API_KEY in .env.
 */

import fs from "fs";
import path from "path";
import os from "os";

const TEMP_DIR = path.join(os.tmpdir(), "alvin-bot");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const MODEL = "gemini-2.0-flash-exp"; // Free tier image gen model
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export interface ImageGenResult {
  success: boolean;
  filePath?: string;
  error?: string;
  mimeType?: string;
}

/**
 * Generate an image from a text prompt using Gemini.
 */
export async function generateImage(prompt: string, apiKey: string): Promise<ImageGenResult> {
  if (!apiKey) {
    return { success: false, error: "GOOGLE_API_KEY not configured" };
  }

  try {
    const url = `${API_URL}/${MODEL}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: `Generate an image: ${prompt}` }],
        }],
        generationConfig: {
          responseModalities: ["IMAGE", "TEXT"],
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "Unknown error");
      return { success: false, error: `Gemini API error (${response.status}): ${errText}` };
    }

    const data = await response.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            inlineData?: { mimeType: string; data: string };
          }>;
        };
      }>;
    };

    // Extract image from response
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) {
      return { success: false, error: "No response from Gemini" };
    }

    for (const part of parts) {
      if (part.inlineData?.data) {
        const ext = part.inlineData.mimeType === "image/png" ? ".png" : ".jpg";
        const filePath = path.join(TEMP_DIR, `gen_${Date.now()}${ext}`);
        const buffer = Buffer.from(part.inlineData.data, "base64");
        fs.writeFileSync(filePath, buffer);
        return {
          success: true,
          filePath,
          mimeType: part.inlineData.mimeType,
        };
      }
    }

    // Check if there's a text response explaining why no image was generated
    const textPart = parts.find(p => p.text);
    return {
      success: false,
      error: textPart?.text || "No image generated",
    };
  } catch (err) {
    return {
      success: false,
      error: `Image generation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
