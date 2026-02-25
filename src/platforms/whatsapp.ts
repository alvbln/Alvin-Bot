/**
 * WhatsApp Platform Adapter
 *
 * Uses whatsapp-web.js (Puppeteer-based) for WhatsApp Web connection.
 * Optional dependency — only loaded if WHATSAPP_ENABLED=true.
 *
 * Features:
 *   - Self-chat (Note to Self) as AI notepad
 *   - Group chat with per-group + per-contact whitelist
 *   - Voice/audio transcription, photo/document processing
 *   - Persistent auth via LocalAuth
 *
 * Setup:
 *   1. Set WHATSAPP_ENABLED=true in .env (or via Web UI → Platforms)
 *   2. Open Web UI → Platforms → scan the QR code with your phone
 *   3. Start chatting in your "Saved Messages" / self-chat
 */

import type { PlatformAdapter, IncomingMessage, MessageHandler } from "./types.js";
import fs from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AUTH_DIR = resolve(BOT_ROOT, "data", "whatsapp-auth");
const GROUP_CONFIG_FILE = resolve(BOT_ROOT, "docs", "whatsapp-groups.json");

// ── Group Whitelist Config ──────────────────────────────────────────────────

export interface GroupRule {
  /** WhatsApp group JID (e.g., 120363314394291236@g.us) */
  groupId: string;
  /** Display name (cached for UI) */
  groupName: string;
  /** Is the bot enabled in this group? */
  enabled: boolean;
  /** Whitelisted participant JIDs — empty = all participants allowed */
  allowedParticipants: string[];
  /** Cached participant names for UI display */
  participantNames: Record<string, string>;
  /** Must the bot be @mentioned or does any message trigger it? */
  requireMention: boolean;
  /** Process media (photos, documents, audio) from this group? */
  allowMedia: boolean;
  /** Require owner approval via Telegram before processing? */
  requireApproval: boolean;
  /** Timestamp of last config update */
  updatedAt: number;
}

export interface GroupConfig {
  groups: GroupRule[];
}

function loadGroupConfig(): GroupConfig {
  try {
    const data = JSON.parse(fs.readFileSync(GROUP_CONFIG_FILE, "utf-8"));
    return data;
  } catch {
    return { groups: [] };
  }
}

function saveGroupConfig(config: GroupConfig): void {
  const dir = resolve(BOT_ROOT, "docs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(GROUP_CONFIG_FILE, JSON.stringify(config, null, 2));
}

/** Get a group rule by ID (or undefined if not configured) */
export function getGroupRule(groupId: string): GroupRule | undefined {
  return loadGroupConfig().groups.find(g => g.groupId === groupId);
}

/** Get all group rules */
export function getGroupRules(): GroupRule[] {
  return loadGroupConfig().groups;
}

/** Create or update a group rule */
export function upsertGroupRule(rule: Partial<GroupRule> & { groupId: string }): GroupRule {
  const config = loadGroupConfig();
  const existing = config.groups.find(g => g.groupId === rule.groupId);
  if (existing) {
    Object.assign(existing, rule, { updatedAt: Date.now() });
    saveGroupConfig(config);
    return existing;
  }
  const newRule: GroupRule = {
    groupId: rule.groupId,
    groupName: rule.groupName || "Unknown Group",
    enabled: rule.enabled ?? false,
    allowedParticipants: rule.allowedParticipants || [],
    participantNames: rule.participantNames || {},
    requireMention: rule.requireMention ?? true,
    allowMedia: rule.allowMedia ?? true,
    requireApproval: rule.requireApproval ?? true,
    updatedAt: Date.now(),
  };
  config.groups.push(newRule);
  saveGroupConfig(config);
  return newRule;
}

/** Delete a group rule */
export function deleteGroupRule(groupId: string): boolean {
  const config = loadGroupConfig();
  const before = config.groups.length;
  config.groups = config.groups.filter(g => g.groupId !== groupId);
  if (config.groups.length < before) {
    saveGroupConfig(config);
    return true;
  }
  return false;
}

// ── Approval Queue ──────────────────────────────────────────────────────────

export interface PendingApproval {
  id: string;
  incoming: IncomingMessage;
  groupName: string;
  senderName: string;
  senderNumber: string;
  preview: string;
  mediaType?: string;
  timestamp: number;
}

const _pendingApprovals = new Map<string, PendingApproval>();

/** Approval callback — set by index.ts to send Telegram messages */
type ApprovalRequestFn = (pending: PendingApproval) => Promise<void>;
let _approvalRequestFn: ApprovalRequestFn | null = null;

export function setApprovalRequestFn(fn: ApprovalRequestFn): void {
  _approvalRequestFn = fn;
}

export function getPendingApproval(id: string): PendingApproval | undefined {
  return _pendingApprovals.get(id);
}

export function removePendingApproval(id: string): PendingApproval | undefined {
  const p = _pendingApprovals.get(id);
  _pendingApprovals.delete(id);
  return p;
}

export function getPendingApprovals(): PendingApproval[] {
  return Array.from(_pendingApprovals.values());
}

/** Track which channel is handling approvals: "telegram" | "whatsapp" | "discord" | "signal" */
let _approvalChannel: string = "telegram";

export function getApprovalChannel(): string {
  return _approvalChannel;
}

export function setApprovalChannel(channel: string): void {
  _approvalChannel = channel;
}

/**
 * Check if a self-chat message is an approval response.
 * Returns the approval ID if matched, null otherwise.
 */
export function matchApprovalResponse(text: string): { id: string; approved: boolean } | null {
  const t = text.trim().toLowerCase();
  // Find the most recent pending approval
  const entries = Array.from(_pendingApprovals.entries());
  if (entries.length === 0) return null;

  // Support: "ok", "ja", "yes", "go", "1", "✅" → approve
  // Support: "nein", "no", "nope", "2", "❌" → deny
  const approveWords = ["ok", "ja", "yes", "go", "1", "✅", "freigeben", "approve"];
  const denyWords = ["nein", "no", "nope", "2", "❌", "ablehnen", "deny", "stop"];

  // Check if response references a specific ID (e.g., "ok wa_abc123")
  for (const [id] of entries) {
    if (t.includes(id)) {
      const isApprove = approveWords.some(w => t.includes(w));
      return { id, approved: isApprove };
    }
  }

  // No specific ID → apply to the most recent pending approval
  const [latestId] = entries[entries.length - 1];
  if (approveWords.some(w => t === w || t.startsWith(w + " "))) {
    return { id: latestId, approved: true };
  }
  if (denyWords.some(w => t === w || t.startsWith(w + " "))) {
    return { id: latestId, approved: false };
  }

  return null;
}

/** Clean up stale approvals older than 30 minutes */
function cleanupStaleApprovals(): void {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, p] of _pendingApprovals) {
    if (p.timestamp < cutoff) {
      _pendingApprovals.delete(id);
      if (p.incoming.media?.path) {
        fs.unlink(p.incoming.media.path, () => {});
      }
    }
  }
}

setInterval(cleanupStaleApprovals, 5 * 60_000);

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
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  return CHROME_PATHS.find(p => fs.existsSync(p));
}

// ── Adapter ─────────────────────────────────────────────────────────────────

/** Singleton reference for API access */
let _adapterInstance: WhatsAppAdapter | null = null;
export function getWhatsAppAdapter(): WhatsAppAdapter | null {
  return _adapterInstance;
}

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = "whatsapp";
  private handler: MessageHandler | null = null;
  private client: any = null;

  // Loop prevention
  private botSentIds = new Set<string>();
  private botSentTexts = new Set<string>();

  constructor() {
    _adapterInstance = this;
  }

  async start(): Promise<void> {
    _whatsappState = {
      status: "connecting", qrString: null, qrTimestamp: null,
      connectedAt: null, error: null, info: null,
    };

    let wwjs: any;
    try {
      wwjs = await import("whatsapp-web.js");
    } catch {
      const msg = "whatsapp-web.js not installed. Run: npm install whatsapp-web.js";
      _whatsappState = { ..._whatsappState, status: "error", error: msg };
      console.error(`❌ WhatsApp: ${msg}`);
      throw new Error(msg);
    }

    const Client = wwjs.Client || wwjs.default?.Client;
    const LocalAuth = wwjs.LocalAuth || wwjs.default?.LocalAuth;

    if (!Client) throw new Error("whatsapp-web.js: Client class not found.");
    if (!LocalAuth) throw new Error("whatsapp-web.js: LocalAuth class not found.");

    const execPath = findChrome();
    if (!execPath) {
      console.warn("⚠️ WhatsApp: No Chrome found. Trying Puppeteer bundled Chromium...");
    }

    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    try {
      this.client = new Client({
        authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
        puppeteer: {
          headless: true,
          args: [
            "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
            "--disable-gpu", "--single-process", "--disable-extensions",
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

    client.on("qr", (qr: string) => {
      _whatsappState.status = "qr";
      _whatsappState.qrString = qr;
      _whatsappState.qrTimestamp = Date.now();
      _whatsappState.error = null;
      console.log("📱 WhatsApp: QR code ready — scan via Web UI → Platforms");
    });

    client.on("authenticated", () => {
      _whatsappState.status = "connecting";
      _whatsappState.qrString = null;
      console.log("📱 WhatsApp: Authenticated, loading session...");
    });

    client.on("ready", async () => {
      _whatsappState.status = "connected";
      _whatsappState.qrString = null;
      _whatsappState.connectedAt = Date.now();
      _whatsappState.error = null;
      const info = client.info;
      _whatsappState.info = info?.pushname || info?.wid?.user || null;
      console.log(`📱 WhatsApp connected (${_whatsappState.info || "unknown"})`);

      try {
        const myId = info?.wid?._serialized;
        if (myId) {
          await this.sendText(myId,
            "🤖 *Mr. Levin ist jetzt auf WhatsApp verbunden!*\n\n" +
            "Schreib hier (Eigene Nachrichten) um mit mir zu chatten.\n" +
            "In Gruppenchats: aktiviere Gruppen im Web UI."
          );
        }
      } catch { /* nice-to-have */ }
    });

    client.on("auth_failure", (msg: string) => {
      _whatsappState.status = "error";
      _whatsappState.error = `Auth failed: ${msg}`;
      _whatsappState.qrString = null;
      console.error("❌ WhatsApp auth failure:", msg);
    });

    client.on("disconnected", (reason: string) => {
      _whatsappState.status = "disconnected";
      _whatsappState.qrString = null;
      _whatsappState.error = reason;
      console.log("📱 WhatsApp disconnected:", reason);
    });

    client.on("message_create", async (msg: any) => {
      try {
        await this.handleIncomingMessage(msg);
      } catch (err) {
        console.error("WhatsApp message handler error:", err instanceof Error ? err.stack || err.message : err);
      }
    });
  }

  // ── Message Processing ────────────────────────────────────────────────────

  private async handleIncomingMessage(msg: any): Promise<void> {
    if (!this.handler) return;

    // Skip channel/newsletter messages (whatsapp-web.js Channel constructor crashes on missing channelMetadata)
    if (msg.isChannel || msg.from?.endsWith("@newsletter") || msg.from?.endsWith("@broadcast")) return;

    const text = msg.body?.trim();
    const msgType = msg.type; // "chat", "ptt", "audio", "image", "video", "document", etc.
    const isVoice = msgType === "ptt" || msgType === "audio";
    const isImage = msgType === "image" || msgType === "sticker";
    const isDocument = msgType === "document";
    const isVideo = msgType === "video";
    const hasMedia = isVoice || isImage || isDocument || isVideo;

    // Must have text or media
    if (!text && !hasMedia) return;

    const msgId = msg.id?._serialized || "";

    // ── Loop prevention ──────────────────────────────────────────────────
    if (this.botSentIds.has(msgId)) {
      this.botSentIds.delete(msgId);
      return;
    }
    if (text && msg.fromMe && this.botSentTexts.has(text.substring(0, 100))) {
      return;
    }

    const chat = await msg.getChat();
    const isGroup = chat.isGroup;
    const isSelf = this.isSelfChat(chat);

    // ── Global access toggles ─────────────────────────────────────────
    const selfChatOnly = process.env.WHATSAPP_SELF_CHAT_ONLY === "true";
    const allowGroups = process.env.WHATSAPP_ALLOW_GROUPS === "true";

    // ── Access control ───────────────────────────────────────────────────
    if (isSelf) {
      // Self-chat: check if this is an approval response (when WhatsApp is approval channel)
      if (text && _approvalChannel === "whatsapp" && _pendingApprovals.size > 0) {
        const match = matchApprovalResponse(text);
        if (match) {
          const pending = removePendingApproval(match.id);
          if (pending) {
            if (match.approved) {
              await this.sendText(chat.id._serialized, `✅ Freigegeben: ${pending.senderName} in ${pending.groupName}`);
              if (this.handler) await this.handler(pending.incoming);
            } else {
              await this.sendText(chat.id._serialized, `❌ Abgelehnt: ${pending.senderName}`);
              if (pending.incoming.media?.path) fs.unlink(pending.incoming.media.path, () => {});
            }
            return; // Don't process as normal message
          }
        }
      }
      // Normal self-chat: proceed to AI
    } else if (isGroup) {
      // Global toggle: groups must be explicitly allowed
      if (selfChatOnly || !allowGroups) return;

      // Group: check whitelist
      if (msg.fromMe) return; // Skip own messages in groups

      const groupId = chat.id._serialized || "";
      const rule = getGroupRule(groupId);

      // No rule or not enabled → ignore
      if (!rule || !rule.enabled) return;

      // Check participant whitelist (empty = allow all)
      const senderId = msg.author || msg.from || "";
      if (rule.allowedParticipants.length > 0) {
        // Resolve contact to get phone number (senderId may be @lid format which differs from @c.us phone)
        const senderContact = await msg.getContact().catch(() => null);
        const senderPhone = senderContact?.number || "";
        const senderNorm = senderId.replace(/@.*$/, "");
        const allowed = rule.allowedParticipants.some(p => {
          const pNorm = p.replace(/@.*$/, "");
          return pNorm === senderNorm || (senderPhone && pNorm === senderPhone);
        });
        if (!allowed) {
          console.log(`📱 WA Group: participant ${senderNorm} (phone: ${senderPhone}) not in whitelist for ${rule.groupName}`);
          return;
        }
      }

      // Check mention requirement
      if (rule.requireMention) {
        const botName = this.client?.info?.pushname || "Mr. Levin";
        const myWid = this.client?.info?.wid?._serialized || "";
        const myLid = this.client?.info?.me?._serialized || "";
        // Check text-based mentions
        const textMention = text && (
          text.includes("@Mr.Levin") ||
          text.includes("@bot") ||
          text.includes("@mr.levin") ||
          text.toLowerCase().includes(botName.toLowerCase()) ||
          text.toLowerCase().includes("mr. levin") ||
          text.toLowerCase().includes("mr.levin")
        );
        // Check WhatsApp native mentions (mentionedIds array)
        const mentionedIds: string[] = msg.mentionedIds?.map((m: any) => m?._serialized || String(m)) || [];
        const nativeMention = mentionedIds.some((mid: string) => mid === myWid || mid === myLid);
        const mentioned = textMention || nativeMention;
        // Voice/media in whitelisted groups: allow without mention
        if (!mentioned && !hasMedia) return;
      }

      // Check media permission
      if (hasMedia && !rule.allowMedia) {
        if (!text) return; // Pure media without text → skip
      }
    } else {
      // DM from someone else
      if (selfChatOnly) return;
      const allowDMs = process.env.WHATSAPP_ALLOW_DMS === "true";
      if (!allowDMs) return;
      if (msg.fromMe) return;
    }

    // ── Download media ───────────────────────────────────────────────────
    let mediaInfo: IncomingMessage["media"] = undefined;

    if (hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media?.data) {
          // Store in project data dir (persistent) instead of OS temp (volatile)
          const tmpDir = resolve(BOT_ROOT, "data", "wa-media");
          if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

          if (isVoice) {
            const ext = media.mimetype?.includes("ogg") ? "ogg" : "mp3";
            const audioPath = join(tmpDir, `wa_voice_${Date.now()}.${ext}`);
            fs.writeFileSync(audioPath, Buffer.from(media.data, "base64"));
            mediaInfo = { type: "voice", path: audioPath, mimeType: media.mimetype || "audio/ogg" };
          } else if (isImage) {
            const ext = media.mimetype?.includes("png") ? "png" : media.mimetype?.includes("webp") ? "webp" : "jpg";
            const imgPath = join(tmpDir, `wa_photo_${Date.now()}.${ext}`);
            fs.writeFileSync(imgPath, Buffer.from(media.data, "base64"));
            mediaInfo = { type: "photo", path: imgPath, mimeType: media.mimetype || "image/jpeg" };
          } else if (isDocument) {
            const fileName = media.filename || `wa_doc_${Date.now()}`;
            const docPath = join(tmpDir, fileName);
            fs.writeFileSync(docPath, Buffer.from(media.data, "base64"));
            mediaInfo = { type: "document", path: docPath, mimeType: media.mimetype || "application/octet-stream", fileName };
          } else if (isVideo) {
            const ext = media.mimetype?.includes("mp4") ? "mp4" : "webm";
            const vidPath = join(tmpDir, `wa_video_${Date.now()}.${ext}`);
            fs.writeFileSync(vidPath, Buffer.from(media.data, "base64"));
            mediaInfo = { type: "video" as any, path: vidPath, mimeType: media.mimetype || "video/mp4" };
          }
        }
      } catch (err) {
        console.error(`WhatsApp: Failed to download ${msgType}:`, err instanceof Error ? err.message : err);
      }
    }

    // ── Build incoming message ────────────────────────────────────────────
    const contact = isSelf ? null : await msg.getContact().catch(() => null);
    const userName = isSelf
      ? (this.client?.info?.pushname || "User")
      : (contact?.pushname || contact?.name || contact?.number || "Unknown");

    const incoming: IncomingMessage = {
      platform: "whatsapp",
      messageId: msgId,
      chatId: chat.id._serialized || "",
      userId: isSelf ? "self" : (contact?.id?._serialized || msg.author || "unknown"),
      userName,
      text: text || "",
      isGroup,
      isMention: isGroup && !!text && (text.includes("@Mr.Levin") || text.includes("@bot")),
      isReplyToBot: false,
      replyToText: msg.hasQuotedMsg
        ? await msg.getQuotedMessage().then((q: any) => q?.body).catch(() => undefined)
        : undefined,
      media: mediaInfo,
    };

    // ── Approval gate for group messages from non-owner ──────────────────
    if (isGroup && !isSelf && !msg.fromMe) {
      const groupId = chat.id._serialized || "";
      const rule = getGroupRule(groupId);

      if (rule?.requireApproval && _approvalRequestFn) {
        const approvalId = `wa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const senderNumber = (contact?.number || msg.author || "").replace(/@.*$/, "");

        // Build preview (truncate long text)
        let preview = text || "";
        if (preview.length > 200) preview = preview.slice(0, 200) + "…";
        if (hasMedia && !preview) {
          const mediaLabels: Record<string, string> = { ptt: "🎤 Sprachnachricht", audio: "🎵 Audio", image: "📷 Bild", document: "📄 Dokument", video: "🎬 Video", sticker: "🏷 Sticker" };
          preview = mediaLabels[msgType] || `📎 ${msgType}`;
        } else if (hasMedia) {
          preview = `📎 +Medien: ${preview}`;
        }

        const pending: PendingApproval = {
          id: approvalId,
          incoming,
          groupName: chat.name || "Gruppe",
          senderName: userName,
          senderNumber,
          preview,
          mediaType: hasMedia ? msgType : undefined,
          timestamp: Date.now(),
        };

        _pendingApprovals.set(approvalId, pending);
        await _approvalRequestFn(pending);
        return; // Don't process yet — wait for approval
      }
    }

    await this.handler(incoming);
  }

  private isSelfChat(chat: any): boolean {
    if (chat.isMe) return true;
    const chatName = chat.name || "";
    const ownName = this.client?.info?.pushname || "";
    if (chatName && ownName && chatName === ownName) return true;
    const chatId = chat.id?._serialized || "";
    const myWid = this.client?.info?.wid?._serialized || "";
    if (myWid && chatId === myWid) return true;
    const myMe = this.client?.info?.me?._serialized || "";
    if (myMe && chatId === myMe) return true;
    return false;
  }

  // ── Public API: Fetch groups + participants ───────────────────────────────

  /** Get all WhatsApp groups the user is in */
  async getGroups(): Promise<Array<{ id: string; name: string; participantCount: number }>> {
    if (!this.client || _whatsappState.status !== "connected") return [];
    try {
      const chats = await this.client.getChats();
      return chats
        .filter((c: any) => c.isGroup)
        .map((c: any) => ({
          id: c.id._serialized,
          name: c.name || "Unnamed Group",
          participantCount: c.participants?.length || 0,
        }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
    } catch (err) {
      console.error("WhatsApp: Failed to fetch groups:", err);
      return [];
    }
  }

  /** Get participants of a specific group */
  async getGroupParticipants(groupId: string): Promise<Array<{ id: string; name: string; isAdmin: boolean; number: string }>> {
    if (!this.client || _whatsappState.status !== "connected") return [];
    try {
      const chat = await this.client.getChatById(groupId);
      if (!chat?.isGroup) return [];

      const participants: Array<{ id: string; name: string; isAdmin: boolean; number: string }> = [];
      for (const p of chat.participants || []) {
        const pid = p.id?._serialized || "";
        let name = pid;
        let number = pid.replace(/@.*$/, "");
        try {
          const contact = await this.client.getContactById(pid);
          name = contact?.pushname || contact?.name || contact?.number || pid;
          number = contact?.number || number;
        } catch { /* use pid */ }

        participants.push({
          id: pid,
          name,
          isAdmin: p.isAdmin || p.isSuperAdmin || false,
          number,
        });
      }
      return participants.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.error("WhatsApp: Failed to fetch participants:", err);
      return [];
    }
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.client) return;
    const textHash = text.substring(0, 100);
    this.botSentTexts.add(textHash);
    setTimeout(() => this.botSentTexts.delete(textHash), 30_000);

    const sent = await this.client.sendMessage(chatId, text);
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

  /** Get the owner's self-chat ID (for DM fallback) */
  getOwnerChatId(): string | null {
    return this.client?.info?.wid?._serialized || null;
  }

  /** Process an approved message from the pending queue */
  async processApprovedMessage(incoming: IncomingMessage): Promise<void> {
    if (!this.handler) return;
    await this.handler(incoming);
  }

  async setTyping(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      const chat = await this.client.getChatById(chatId);
      if (chat) await chat.sendStateTyping();
    } catch { /* ignore */ }
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    // whatsapp-web.js reactions require the Message object
  }

  async stop(): Promise<void> {
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
    _whatsappState.status = "disconnected";
    _adapterInstance = null;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

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
