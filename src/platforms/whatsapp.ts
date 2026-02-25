/**
 * WhatsApp Platform Adapter
 *
 * Uses whatsapp-web.js (Puppeteer-based) for WhatsApp Web connection.
 * Optional dependency — only loaded if WHATSAPP_ENABLED=true.
 *
 * Setup:
 * 1. npm install whatsapp-web.js (with PUPPETEER_SKIP_DOWNLOAD=true)
 * 2. Set WHATSAPP_ENABLED=true in .env
 * 3. Scan QR code shown in Web UI or terminal logs
 *
 * Auth data saved to data/whatsapp-auth/
 */

import type { PlatformAdapter, IncomingMessage, MessageHandler, SendOptions } from "./types.js";
import fs from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AUTH_DIR = resolve(BOT_ROOT, "data", "whatsapp-auth");

// ── Global WhatsApp State (accessible from Web API) ─────
export interface WhatsAppState {
  status: "disconnected" | "qr" | "connecting" | "connected" | "logged_out" | "error";
  qrString: string | null;
  qrTimestamp: number | null;
  connectedAt: number | null;
  error: string | null;
  info: string | null; // e.g. phone number or name
}

let _whatsappState: WhatsAppState = {
  status: "disconnected",
  qrString: null,
  qrTimestamp: null,
  connectedAt: null,
  error: null,
  info: null,
};

export function getWhatsAppState(): WhatsAppState {
  return { ..._whatsappState };
}

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = "whatsapp";
  private handler: MessageHandler | null = null;
  private client: any = null;

  async start(): Promise<void> {
    _whatsappState = { status: "connecting", qrString: null, qrTimestamp: null, connectedAt: null, error: null, info: null };

    try {
      // Dynamic import — whatsapp-web.js is optional
      // @ts-ignore — whatsapp-web.js is an optional dependency
      const wwjs = await import("whatsapp-web.js");
      const Client = wwjs.Client || wwjs.default?.Client;
      const LocalAuth = wwjs.default?.LocalAuth;

      // Ensure auth directory exists
      if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

      // Find Chrome/Chromium executable
      const chromePaths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
      ];
      const execPath = chromePaths.find(p => fs.existsSync(p));

      this.client = new Client({
        authStrategy: new LocalAuth({
          dataPath: AUTH_DIR,
        }),
        puppeteer: {
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--single-process",
          ],
          ...(execPath ? { executablePath: execPath } : {}),
        },
      });

      // QR Code event
      this.client.on("qr", (qr: string) => {
        _whatsappState.status = "qr";
        _whatsappState.qrString = qr;
        _whatsappState.qrTimestamp = Date.now();
        _whatsappState.error = null;
        console.log("📱 WhatsApp: QR code ready — scan via Web UI → Platforms");
      });

      // Authenticated
      this.client.on("authenticated", () => {
        _whatsappState.status = "connecting";
        _whatsappState.qrString = null;
        console.log("📱 WhatsApp: Authenticated, loading session...");
      });

      // Ready
      this.client.on("ready", () => {
        _whatsappState.status = "connected";
        _whatsappState.qrString = null;
        _whatsappState.connectedAt = Date.now();
        _whatsappState.error = null;
        const info = this.client.info;
        _whatsappState.info = info?.pushname || info?.wid?.user || null;
        console.log(`📱 WhatsApp adapter connected (${_whatsappState.info || "unknown"})`);
      });

      // Auth failure
      this.client.on("auth_failure", (msg: string) => {
        _whatsappState.status = "error";
        _whatsappState.error = `Auth failed: ${msg}`;
        _whatsappState.qrString = null;
        console.error("WhatsApp auth failure:", msg);
      });

      // Disconnected
      this.client.on("disconnected", (reason: string) => {
        _whatsappState.status = "disconnected";
        _whatsappState.qrString = null;
        _whatsappState.error = reason;
        console.log("WhatsApp disconnected:", reason);
      });

      // Messages
      this.client.on("message", async (msg: any) => {
        if (!this.handler) return;
        if (msg.fromMe) return;

        const text = msg.body;
        if (!text) return;

        const chat = await msg.getChat();
        const contact = await msg.getContact();
        const isGroup = chat.isGroup;

        const incoming: IncomingMessage = {
          platform: "whatsapp",
          messageId: msg.id._serialized || "",
          chatId: chat.id._serialized || "",
          userId: contact.id._serialized || "",
          userName: contact.pushname || contact.name || contact.number || "Unknown",
          text,
          isGroup,
          isMention: text.includes("@Mr.Levin") || text.includes("@bot"),
          isReplyToBot: false,
          replyToText: msg.hasQuotedMsg ? (await msg.getQuotedMessage())?.body : undefined,
        };

        // In groups: only respond to mentions
        if (isGroup && !incoming.isMention) return;

        await this.handler(incoming);
      });

      // Initialize
      await this.client.initialize();
    } catch (err) {
      _whatsappState.status = "error";
      _whatsappState.error = err instanceof Error ? err.message : String(err);
      console.error("WhatsApp adapter failed:", err instanceof Error ? err.message : err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch { /* ignore */ }
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.client) return;
    await this.client.sendMessage(chatId, text);
  }

  async sendPhoto(chatId: string, photo: Buffer | string, caption?: string): Promise<void> {
    if (!this.client) return;
    // @ts-ignore
    const _ww = await import("whatsapp-web.js"); const MessageMedia = _ww.default?.MessageMedia || _ww.MessageMedia;
    let media: any;
    if (typeof photo === "string") {
      media = MessageMedia.fromFilePath(photo);
    } else {
      media = new MessageMedia("image/png", photo.toString("base64"));
    }
    await this.client.sendMessage(chatId, media, { caption });
  }

  async sendDocument(chatId: string, doc: Buffer | string, fileName: string, caption?: string): Promise<void> {
    if (!this.client) return;
    // @ts-ignore
    const _ww = await import("whatsapp-web.js"); const MessageMedia = _ww.default?.MessageMedia || _ww.MessageMedia;
    let media: any;
    if (typeof doc === "string") {
      media = MessageMedia.fromFilePath(doc);
    } else {
      media = new MessageMedia("application/octet-stream", doc.toString("base64"), fileName);
    }
    await this.client.sendMessage(chatId, media, { caption });
  }

  async sendVoice(chatId: string, audio: Buffer | string): Promise<void> {
    if (!this.client) return;
    // @ts-ignore
    const _ww = await import("whatsapp-web.js"); const MessageMedia = _ww.default?.MessageMedia || _ww.MessageMedia;
    let media: any;
    if (typeof audio === "string") {
      media = MessageMedia.fromFilePath(audio);
    } else {
      media = new MessageMedia("audio/ogg", audio.toString("base64"));
    }
    await this.client.sendMessage(chatId, media, { sendAudioAsVoice: true });
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    // whatsapp-web.js supports reactions via message.react()
    // but needs the message object — skip for now
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}
