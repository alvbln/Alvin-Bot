/**
 * Signal Platform Adapter
 *
 * Uses signal-cli (REST API mode) for Signal messaging.
 * Optional — only loaded if SIGNAL_API_URL is set.
 *
 * Setup:
 * 1. Run signal-cli in REST API mode:
 *    docker run -p 8080:8080 bbernhard/signal-cli-rest-api
 * 2. Register/link a phone number via signal-cli
 * 3. Set SIGNAL_API_URL=http://localhost:8080 and SIGNAL_NUMBER=+49... in .env
 */

import fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PlatformAdapter, IncomingMessage, MessageHandler, SendOptions } from "./types.js";

// ── Global Signal State ─────────────────────────────────
export interface SignalState {
  status: "disconnected" | "connecting" | "connected" | "error";
  apiVersion: string | null;
  number: string | null;
  connectedAt: number | null;
  error: string | null;
}

let _signalState: SignalState = {
  status: "disconnected",
  apiVersion: null,
  number: null,
  connectedAt: null,
  error: null,
};

export function getSignalState(): SignalState {
  return { ..._signalState };
}

export class SignalAdapter implements PlatformAdapter {
  readonly platform = "signal";
  private handler: MessageHandler | null = null;
  private apiUrl: string;
  private number: string;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(apiUrl: string, number: string) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.number = number;
  }

  async start(): Promise<void> {
    _signalState.status = "connecting";
    _signalState.number = this.number;

    // Verify connection
    try {
      const res = await fetch(`${this.apiUrl}/v1/about`);
      if (!res.ok) throw new Error(`Signal API not reachable: ${res.status}`);
      const about = await res.json().catch(() => ({})) as any;
      _signalState.status = "connected";
      _signalState.apiVersion = about.version || about.versions?.[0] || null;
      _signalState.connectedAt = Date.now();
      console.log("📱 Signal adapter connected");
    } catch (err) {
      _signalState.status = "error";
      _signalState.error = err instanceof Error ? err.message : String(err);
      console.error("Signal adapter failed:", err);
      throw err;
    }

    // Poll for new messages every 2 seconds
    this.pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${this.apiUrl}/v1/receive/${encodeURIComponent(this.number)}`);
        if (!res.ok) return;

        const messages = await res.json() as any[];
        for (const msg of messages) {
          const data = msg.envelope?.dataMessage;
          if (!data) continue;
          if (!this.handler) continue;

          const hasText = !!data.message;
          const hasVoice = data.attachments?.some((a: any) =>
            a.contentType?.startsWith("audio/") || a.voiceNote
          );

          // Must have text or a voice attachment
          if (!hasText && !hasVoice) continue;

          const isGroup = !!data.groupInfo;

          // Download voice attachment if present
          let mediaInfo: IncomingMessage["media"] = undefined;
          if (hasVoice) {
            try {
              const voiceAtt = data.attachments.find((a: any) =>
                a.contentType?.startsWith("audio/") || a.voiceNote
              );
              if (voiceAtt?.id) {
                const attRes = await fetch(
                  `${this.apiUrl}/v1/attachments/${voiceAtt.id}`,
                  { headers: { "Content-Type": "application/json" } }
                );
                if (attRes.ok) {
                  const tmpDir = join(tmpdir(), "alvin-bot");
                  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                  const ext = voiceAtt.contentType?.includes("ogg") ? "ogg" : "mp3";
                  const audioPath = join(tmpDir, `signal_voice_${Date.now()}.${ext}`);
                  fs.writeFileSync(audioPath, Buffer.from(await attRes.arrayBuffer()));
                  mediaInfo = { type: "voice", path: audioPath, mimeType: voiceAtt.contentType || "audio/ogg" };
                }
              }
            } catch (err) {
              console.error("Signal: Failed to download voice:", err);
            }
          }

          const incoming: IncomingMessage = {
            platform: "signal",
            messageId: msg.envelope.timestamp?.toString() || "",
            chatId: isGroup ? data.groupInfo.groupId : msg.envelope.sourceNumber,
            userId: msg.envelope.sourceNumber || "",
            userName: msg.envelope.sourceName || msg.envelope.sourceNumber || "Unknown",
            text: data.message || "",
            isGroup,
            isMention: !!(data.message && (data.message.includes("@bot") || data.message.includes("Mr. Levin"))),
            isReplyToBot: false,
            replyToText: data.quote?.text,
            media: mediaInfo,
          };

          // In groups: only respond to mentions (voice in groups always allowed)
          if (isGroup && !incoming.isMention && !hasVoice) continue;

          await this.handler(incoming);
        }
      } catch { /* poll error — retry next interval */ }
    }, 2000);
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    // Determine if chatId is a group or direct message
    const isGroup = chatId.length > 20; // Signal group IDs are long base64 strings

    const body: any = {
      message: text,
      number: this.number,
      recipients: isGroup ? undefined : [chatId],
    };

    if (isGroup) {
      // Send to group
      await fetch(`${this.apiUrl}/v2/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          recipients: [chatId],
        }),
      });
    } else {
      await fetch(`${this.apiUrl}/v2/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
  }

  async sendPhoto(chatId: string, photo: Buffer | string, caption?: string): Promise<void> {
    // Signal sends attachments as base64 in the message body
    const base64 = typeof photo === "string"
      ? fs.readFileSync(photo).toString("base64")
      : photo.toString("base64");

    await fetch(`${this.apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: caption || "",
        number: this.number,
        recipients: [chatId],
        base64_attachments: [`data:image/png;base64,${base64}`],
      }),
    });
  }

  async sendDocument(chatId: string, doc: Buffer | string, fileName: string, caption?: string): Promise<void> {
    const base64 = typeof doc === "string"
      ? fs.readFileSync(doc).toString("base64")
      : doc.toString("base64");

    await fetch(`${this.apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: caption || fileName,
        number: this.number,
        recipients: [chatId],
        base64_attachments: [`data:application/octet-stream;filename=${fileName};base64,${base64}`],
      }),
    });
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/v1/reactions/${encodeURIComponent(this.number)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: chatId,
          reaction: emoji,
          target_author: chatId,
          timestamp: parseInt(messageId),
        }),
      });
    } catch { /* ignore */ }
  }

  async setTyping(chatId: string): Promise<void> {
    // Signal doesn't have a native typing indicator via REST API
    // No-op to satisfy the interface
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}
