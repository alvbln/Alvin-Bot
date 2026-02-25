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
  private botSentMessages = new Set<string>();
  private recentBotTexts = new Set<string>(); // Track recent bot responses to avoid loops

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
      this.client.on("ready", async () => {
        _whatsappState.status = "connected";
        _whatsappState.qrString = null;
        _whatsappState.connectedAt = Date.now();
        _whatsappState.error = null;
        const info = this.client.info;
        _whatsappState.info = info?.pushname || info?.wid?.user || null;
        console.log(`📱 WhatsApp adapter connected (${_whatsappState.info || "unknown"})`);

        // Send welcome ping to own number (via sendText to track it)
        try {
          const myNumber = info?.wid?._serialized;
          if (myNumber) {
            await this.sendText(myNumber,
              "🤖 *Mr. Levin ist jetzt auf WhatsApp verbunden!*\n\n" +
              "Schreib mir eine Nachricht um zu beginnen.\n" +
              "Tipp: In Gruppenchats erwähne mich mit @Mr.Levin"
            );
            console.log("📱 WhatsApp: Welcome ping sent");
          }
        } catch (err) {
          console.log("WhatsApp: Could not send welcome ping:", err instanceof Error ? err.message : err);
        }
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

      // Messages — use message_create (fires for all messages, more reliable than "message")
      this.client.on("message_create", async (msg: any) => {
        if (!this.handler) return;

        const text = msg.body;
        if (!text) return;

        const msgId = msg.id?._serialized || "";

        // Skip messages we sent as bot responses (by ID or by content match)
        if (this.botSentMessages.has(msgId)) {
          this.botSentMessages.delete(msgId);
          return;
        }

        // Skip if this text matches a recent bot response (backup loop prevention)
        const textHash = text.substring(0, 100);
        if (msg.fromMe && this.recentBotTexts.has(textHash)) {
          return;
        }

        const chat = await msg.getChat();
        const isGroup = chat.isGroup;

        // For non-group chats with fromMe: these are messages the user sent from their phone
        // to another chat. We want to respond to "Saved Messages" / "Note to Self" style usage.
        // For group chats: skip fromMe (those are our own replies).
        if (msg.fromMe && isGroup) return;

        // For DMs where fromMe=true: the user is messaging from their phone.
        // Only respond in self-chat (Note to Self / Saved Messages) — don't hijack other conversations!
        if (msg.fromMe) {
          // Self-chat detection: check if chat name matches own name, or if it's a @lid self-chat
          const chatName = chat.name || "";
          const ownName = this.client?.info?.pushname || "";
          const isSelfChat = chat.isMe // whatsapp-web.js v2+ flag
            || (chatName && ownName && chatName === ownName)
            || chat.id._serialized === this.client?.info?.wid?._serialized
            || chat.id._serialized === this.client?.info?.me?._serialized;
          
          if (!isSelfChat) {
            return;
          }
        }

        const contact = msg.fromMe ? null : await msg.getContact().catch(() => null);

        const incoming: IncomingMessage = {
          platform: "whatsapp",
          messageId: msgId,
          chatId: chat.id._serialized || "",
          userId: msg.fromMe ? "self" : (contact?.id?._serialized || "unknown"),
          userName: msg.fromMe ? "Ali" : (contact?.pushname || contact?.name || contact?.number || "Unknown"),
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
    // Pre-register text hash to catch message_create before sendMessage returns
    const textHash = text.substring(0, 100);
    this.recentBotTexts.add(textHash);
    setTimeout(() => this.recentBotTexts.delete(textHash), 30000);

    const sent = await this.client.sendMessage(chatId, text);
    // Track this message ID so we don't process our own responses
    if (sent?.id?._serialized) {
      this.botSentMessages.add(sent.id._serialized);
      setTimeout(() => this.botSentMessages.delete(sent.id._serialized), 60000);
    }
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
