/**
 * WhatsApp Platform Adapter
 *
 * Uses Baileys (WhiskeySockets) for WhatsApp Web connection.
 * Optional dependency — only loaded if WHATSAPP_ENABLED=true.
 *
 * Setup:
 * 1. npm install @whiskeysockets/baileys
 * 2. Set WHATSAPP_ENABLED=true in .env
 * 3. Scan QR code on first run (shown in Web UI + Terminal logs)
 *
 * Auth data saved to data/whatsapp-auth/
 */

import type { PlatformAdapter, IncomingMessage, MessageHandler, SendOptions } from "./types.js";
import fs from "fs";
import path from "path";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AUTH_DIR = resolve(BOT_ROOT, "data", "whatsapp-auth");

// ── Global WhatsApp State (accessible from Web API) ─────
export interface WhatsAppState {
  status: "disconnected" | "qr" | "connecting" | "connected" | "logged_out" | "error";
  qrString: string | null; // Raw QR string for rendering
  qrTimestamp: number | null; // When QR was generated
  connectedAt: number | null;
  error: string | null;
}

let _whatsappState: WhatsAppState = {
  status: "disconnected",
  qrString: null,
  qrTimestamp: null,
  connectedAt: null,
  error: null,
};

export function getWhatsAppState(): WhatsAppState {
  return { ..._whatsappState };
}

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = "whatsapp";
  private handler: MessageHandler | null = null;
  private sock: any = null;
  private reconnectAttempts = 0;
  private maxReconnects = 10;

  async start(): Promise<void> {
    if (this.reconnectAttempts === 0) {
      _whatsappState = { status: "connecting", qrString: null, qrTimestamp: null, connectedAt: null, error: null };
    }

    try {
      // Dynamic import — baileys is optional
      // @ts-ignore — @whiskeysockets/baileys is an optional dependency
      const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import("@whiskeysockets/baileys");

      // Ensure auth directory exists
      if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

      this.sock = makeWASocket({
        auth: state,
        // printQRInTerminal is deprecated in newer Baileys — we handle QR via connection.update event
        browser: ["Mr. Levin", "Chrome", "1.0.0"],
      });

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("connection.update", (update: any) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          _whatsappState.status = "qr";
          _whatsappState.qrString = qr;
          _whatsappState.qrTimestamp = Date.now();
          _whatsappState.error = null;
          this.reconnectAttempts = 0; // Reset on valid QR
          console.log("📱 WhatsApp: QR code ready — scan via Web UI → Platforms");
        }
        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          if (statusCode === DisconnectReason.loggedOut) {
            _whatsappState.status = "logged_out";
            _whatsappState.qrString = null;
            console.log("WhatsApp logged out. Delete data/whatsapp-auth/ and restart to re-link.");
          } else if (this.reconnectAttempts < this.maxReconnects) {
            this.reconnectAttempts++;
            _whatsappState.status = "connecting";
            const delay = Math.min(this.reconnectAttempts * 2000, 10000);
            console.log(`WhatsApp reconnecting (${this.reconnectAttempts}/${this.maxReconnects}) in ${delay/1000}s...`);
            setTimeout(() => this.start(), delay);
          } else {
            _whatsappState.status = "error";
            _whatsappState.error = "Max reconnect attempts reached. Restart bot to try again.";
            console.log("WhatsApp: max reconnect attempts reached.");
          }
        }
        if (connection === "open") {
          _whatsappState.status = "connected";
          _whatsappState.qrString = null;
          _whatsappState.connectedAt = Date.now();
          _whatsappState.error = null;
          this.reconnectAttempts = 0;
          console.log("📱 WhatsApp adapter connected");
        }
      });

      this.sock.ev.on("messages.upsert", async ({ messages }: any) => {
        if (!this.handler) return;

        for (const msg of messages) {
          if (!msg.message || msg.key.fromMe) continue;

          const text = msg.message.conversation
            || msg.message.extendedTextMessage?.text
            || "";

          if (!text) continue;

          const isGroup = msg.key.remoteJid?.endsWith("@g.us") || false;
          const senderId = isGroup ? msg.key.participant : msg.key.remoteJid;

          const incoming: IncomingMessage = {
            platform: "whatsapp",
            messageId: msg.key.id || "",
            chatId: msg.key.remoteJid || "",
            userId: senderId || "",
            userName: msg.pushName || senderId || "Unknown",
            text,
            isGroup,
            isMention: text.includes("@Mr.Levin") || text.includes("@bot"),
            isReplyToBot: false,
            replyToText: msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation,
          };

          // In groups: only respond to mentions
          if (isGroup && !incoming.isMention) continue;

          await this.handler(incoming);
        }
      });
    } catch (err) {
      console.error("WhatsApp adapter failed:", err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.sock) return;
    await this.sock.sendMessage(chatId, { text });
  }

  async sendPhoto(chatId: string, photo: Buffer | string, caption?: string): Promise<void> {
    if (!this.sock) return;
    const image = typeof photo === "string" ? fs.readFileSync(photo) : photo;
    await this.sock.sendMessage(chatId, { image, caption });
  }

  async sendDocument(chatId: string, doc: Buffer | string, fileName: string, caption?: string): Promise<void> {
    if (!this.sock) return;
    const document = typeof doc === "string" ? fs.readFileSync(doc) : doc;
    await this.sock.sendMessage(chatId, { document, fileName, caption });
  }

  async sendVoice(chatId: string, audio: Buffer | string): Promise<void> {
    if (!this.sock) return;
    const audioBuffer = typeof audio === "string" ? fs.readFileSync(audio) : audio;
    await this.sock.sendMessage(chatId, { audio: audioBuffer, mimetype: "audio/ogg; codecs=opus", ptt: true });
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendMessage(chatId, {
        react: { text: emoji, key: { remoteJid: chatId, id: messageId } },
      });
    } catch { /* ignore */ }
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}
