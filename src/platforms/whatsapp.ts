/**
 * WhatsApp Platform Adapter
 *
 * Uses whatsapp-web.js (Puppeteer-based) for WhatsApp Web connection.
 * Optional dependency — only loaded if WHATSAPP_ENABLED=true.
 *
 * How it works:
 *   whatsapp-web.js connects as YOUR WhatsApp account (not a separate bot).
 *   Messages you send to yourself ("Note to Self" / Saved Messages) are
 *   treated as prompts to the AI. In group chats, mention @Mr.Levin.
 *   The bot will NOT respond in your private conversations with other people.
 *
 * Setup:
 *   1. Set WHATSAPP_ENABLED=true in .env (or via Web UI → Platforms)
 *   2. Open Web UI → Platforms → scan the QR code with your phone
 *   3. Start chatting in your "Saved Messages" / self-chat
 *
 * Auth data is saved to data/whatsapp-auth/ for session persistence.
 */

import type { PlatformAdapter, IncomingMessage, MessageHandler } from "./types.js";
import fs from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AUTH_DIR = resolve(BOT_ROOT, "data", "whatsapp-auth");

// ── Global WhatsApp State (accessible from Web API) ─────────────────────────

export interface WhatsAppState {
  status: "disconnected" | "qr" | "connecting" | "connected" | "logged_out" | "error";
  qrString: string | null;
  qrTimestamp: number | null;
  connectedAt: number | null;
  error: string | null;
  info: string | null;
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

// ── Chrome/Chromium Discovery ───────────────────────────────────────────────

const CHROME_PATHS = [
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  // Windows (WSL)
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

function findChrome(): string | undefined {
  // Check CHROME_PATH env var first (user override)
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  return CHROME_PATHS.find(p => fs.existsSync(p));
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = "whatsapp";
  private handler: MessageHandler | null = null;
  private client: any = null;

  // Loop prevention: track bot-sent message IDs and text hashes
  private botSentIds = new Set<string>();
  private botSentTexts = new Set<string>();

  async start(): Promise<void> {
    _whatsappState = {
      status: "connecting", qrString: null, qrTimestamp: null,
      connectedAt: null, error: null, info: null,
    };

    // ── Dependency check ──────────────────────────────────────────────────
    let wwjs: any;
    try {
      wwjs = await import("whatsapp-web.js");
    } catch {
      const msg = "whatsapp-web.js not installed. Run: npm install whatsapp-web.js";
      _whatsappState = { ..._whatsappState, status: "error", error: msg };
      console.error(`❌ WhatsApp: ${msg}`);
      throw new Error(msg);
    }

    // Robust import: try direct exports first, then .default (CJS/ESM compat)
    const Client = wwjs.Client || wwjs.default?.Client;
    const LocalAuth = wwjs.LocalAuth || wwjs.default?.LocalAuth;

    if (!Client) {
      const msg = "whatsapp-web.js: Client class not found. Check your version.";
      _whatsappState = { ..._whatsappState, status: "error", error: msg };
      throw new Error(msg);
    }
    if (!LocalAuth) {
      const msg = "whatsapp-web.js: LocalAuth class not found. Check your version.";
      _whatsappState = { ..._whatsappState, status: "error", error: msg };
      throw new Error(msg);
    }

    // ── Chrome check ──────────────────────────────────────────────────────
    const execPath = findChrome();
    if (!execPath) {
      console.warn(
        "⚠️ WhatsApp: No Chrome/Chromium found. Install Google Chrome or set CHROME_PATH env var.\n" +
        "   Trying Puppeteer's bundled Chromium as fallback..."
      );
    }

    // ── Auth directory ────────────────────────────────────────────────────
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    try {
      this.client = new Client({
        authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
        puppeteer: {
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--single-process",
            "--disable-extensions",
          ],
          ...(execPath ? { executablePath: execPath } : {}),
        },
      });

      this.setupEventHandlers();
      await this.client.initialize();
    } catch (err) {
      _whatsappState.status = "error";
      _whatsappState.error = err instanceof Error ? err.message : String(err);
      console.error("❌ WhatsApp adapter failed:", _whatsappState.error);
      throw err;
    }
  }

  // ── Event Handlers ────────────────────────────────────────────────────────

  private setupEventHandlers(): void {
    const client = this.client;

    // QR Code — displayed in Web UI for scanning
    client.on("qr", (qr: string) => {
      _whatsappState.status = "qr";
      _whatsappState.qrString = qr;
      _whatsappState.qrTimestamp = Date.now();
      _whatsappState.error = null;
      console.log("📱 WhatsApp: QR code ready — scan via Web UI → Platforms");
    });

    // Authenticated (QR scanned or session restored)
    client.on("authenticated", () => {
      _whatsappState.status = "connecting";
      _whatsappState.qrString = null;
      console.log("📱 WhatsApp: Authenticated, loading session...");
    });

    // Ready — fully connected
    client.on("ready", async () => {
      _whatsappState.status = "connected";
      _whatsappState.qrString = null;
      _whatsappState.connectedAt = Date.now();
      _whatsappState.error = null;
      const info = client.info;
      _whatsappState.info = info?.pushname || info?.wid?.user || null;
      console.log(`📱 WhatsApp connected (${_whatsappState.info || "unknown"})`);

      // Send welcome ping to self-chat
      try {
        const myId = info?.wid?._serialized;
        if (myId) {
          await this.sendText(myId,
            "🤖 *Mr. Levin ist jetzt auf WhatsApp verbunden!*\n\n" +
            "Schreib hier (Eigene Nachrichten) um mit mir zu chatten.\n" +
            "In Gruppenchats: erwähne mich mit @Mr.Levin"
          );
        }
      } catch {
        // Welcome ping is nice-to-have, not critical
      }
    });

    // Auth failure
    client.on("auth_failure", (msg: string) => {
      _whatsappState.status = "error";
      _whatsappState.error = `Auth failed: ${msg}`;
      _whatsappState.qrString = null;
      console.error("❌ WhatsApp auth failure:", msg);
    });

    // Disconnected
    client.on("disconnected", (reason: string) => {
      _whatsappState.status = "disconnected";
      _whatsappState.qrString = null;
      _whatsappState.error = reason;
      console.log("📱 WhatsApp disconnected:", reason);
    });

    // ── Message handling ──────────────────────────────────────────────────
    // Use message_create (fires for ALL messages including own).
    // The "message" event is unreliable in some whatsapp-web.js versions.
    client.on("message_create", async (msg: any) => {
      try {
        await this.handleIncomingMessage(msg);
      } catch (err) {
        console.error("WhatsApp message handler error:", err instanceof Error ? err.message : err);
      }
    });
  }

  // ── Message Processing ────────────────────────────────────────────────────

  private async handleIncomingMessage(msg: any): Promise<void> {
    if (!this.handler) return;

    const text = msg.body?.trim();
    if (!text) return;

    const msgId = msg.id?._serialized || "";

    // ── Loop prevention ───────────────────────────────────────────────────
    // Skip messages we sent as bot responses (by ID)
    if (this.botSentIds.has(msgId)) {
      this.botSentIds.delete(msgId);
      return;
    }
    // Skip if text matches a recent bot response (backup: catches race conditions)
    if (msg.fromMe && this.botSentTexts.has(text.substring(0, 100))) {
      return;
    }

    const chat = await msg.getChat();
    const isGroup = chat.isGroup;

    // ── Group chats: skip own messages ─────────────────────────────────────
    if (msg.fromMe && isGroup) return;

    // ── Direct chats: only respond in self-chat ───────────────────────────
    // whatsapp-web.js runs as YOUR account (not a separate bot).
    // CRITICAL: Never respond in private chats with other people!
    // - fromMe=true in non-self-chat → you're messaging a friend → ignore
    // - fromMe=false in any chat → someone messaged you → ignore
    // - Only respond in self-chat (Note to Self / Saved Messages)
    if (!isGroup) {
      if (!this.isSelfChat(chat)) return;
    }

    // ── Build incoming message ────────────────────────────────────────────
    const contact = msg.fromMe ? null : await msg.getContact().catch(() => null);
    const userName = msg.fromMe
      ? (this.client?.info?.pushname || "User")
      : (contact?.pushname || contact?.name || contact?.number || "Unknown");

    const incoming: IncomingMessage = {
      platform: "whatsapp",
      messageId: msgId,
      chatId: chat.id._serialized || "",
      userId: msg.fromMe ? "self" : (contact?.id?._serialized || "unknown"),
      userName,
      text,
      isGroup,
      isMention: isGroup && (text.includes("@Mr.Levin") || text.includes("@bot")),
      isReplyToBot: false,
      replyToText: msg.hasQuotedMsg
        ? await msg.getQuotedMessage().then((q: any) => q?.body).catch(() => undefined)
        : undefined,
    };

    // In groups: only respond when mentioned or replied to
    if (isGroup && !incoming.isMention && !incoming.isReplyToBot) return;

    await this.handler(incoming);
  }

  /**
   * Detect self-chat (Note to Self / Saved Messages).
   * WhatsApp uses different ID formats (@lid vs @c.us), so we check multiple signals.
   */
  private isSelfChat(chat: any): boolean {
    // whatsapp-web.js v2+ has a direct flag
    if (chat.isMe) return true;

    // Match by chat name vs own display name
    const chatName = chat.name || "";
    const ownName = this.client?.info?.pushname || "";
    if (chatName && ownName && chatName === ownName) return true;

    // Match by WID (phone-format ID)
    const chatId = chat.id?._serialized || "";
    const myWid = this.client?.info?.wid?._serialized || "";
    if (myWid && chatId === myWid) return true;

    // Match by me property
    const myMe = this.client?.info?.me?._serialized || "";
    if (myMe && chatId === myMe) return true;

    return false;
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.client) return;

    // Pre-register text hash BEFORE sending (message_create may fire synchronously)
    const textHash = text.substring(0, 100);
    this.botSentTexts.add(textHash);
    setTimeout(() => this.botSentTexts.delete(textHash), 30_000);

    const sent = await this.client.sendMessage(chatId, text);

    // Track message ID for loop prevention
    if (sent?.id?._serialized) {
      this.botSentIds.add(sent.id._serialized);
      setTimeout(() => this.botSentIds.delete(sent.id._serialized), 60_000);
    }
  }

  async sendPhoto(chatId: string, photo: Buffer | string, caption?: string): Promise<void> {
    if (!this.client) return;
    const MessageMedia = await this.getMessageMedia();
    if (!MessageMedia) return;

    const media = typeof photo === "string"
      ? MessageMedia.fromFilePath(photo)
      : new MessageMedia("image/png", photo.toString("base64"));
    await this.client.sendMessage(chatId, media, { caption });
  }

  async sendDocument(chatId: string, doc: Buffer | string, fileName: string, caption?: string): Promise<void> {
    if (!this.client) return;
    const MessageMedia = await this.getMessageMedia();
    if (!MessageMedia) return;

    const media = typeof doc === "string"
      ? MessageMedia.fromFilePath(doc)
      : new MessageMedia("application/octet-stream", doc.toString("base64"), fileName);
    await this.client.sendMessage(chatId, media, { caption });
  }

  async sendVoice(chatId: string, audio: Buffer | string): Promise<void> {
    if (!this.client) return;
    const MessageMedia = await this.getMessageMedia();
    if (!MessageMedia) return;

    const media = typeof audio === "string"
      ? MessageMedia.fromFilePath(audio)
      : new MessageMedia("audio/ogg", audio.toString("base64"));
    await this.client.sendMessage(chatId, media, { sendAudioAsVoice: true });
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    // whatsapp-web.js supports reactions via message.react()
    // but requires the Message object — not easily accessible here
  }

  async stop(): Promise<void> {
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
    _whatsappState.status = "disconnected";
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Lazy-load MessageMedia class (avoids re-importing on every send) */
  private _MessageMedia: any = null;
  private async getMessageMedia(): Promise<any> {
    if (this._MessageMedia) return this._MessageMedia;
    try {
      const wwjs = await import("whatsapp-web.js");
      this._MessageMedia = wwjs.MessageMedia || wwjs.default?.MessageMedia;
      return this._MessageMedia;
    } catch {
      console.error("WhatsApp: MessageMedia not available");
      return null;
    }
  }
}
