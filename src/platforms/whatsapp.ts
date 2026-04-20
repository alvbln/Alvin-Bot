/**
 * WhatsApp Platform Adapter — Baileys Edition
 *
 * Uses @whiskeysockets/baileys (pure WebSocket, no Puppeteer/Chrome).
 * Optional dependency — only loaded if WHATSAPP_ENABLED=true.
 *
 * Features:
 *   - Self-chat (Note to Self) as AI notepad
 *   - Group chat with per-group + per-contact whitelist
 *   - Voice/audio transcription, photo/document processing
 *   - Persistent auth via multi-file auth state
 *   - Auto-reconnect with backoff
 *
 * Setup:
 *   1. Set WHATSAPP_ENABLED=true in .env (or via Web UI → Platforms)
 *   2. Open Web UI → Platforms → scan the QR code with your phone
 *   3. Start chatting in your "Saved Messages" / self-chat
 */

import type { PlatformAdapter, IncomingMessage, MessageHandler } from "./types.js";
import fs from "fs";
import { dirname, join } from "path";
import { WHATSAPP_AUTH as AUTH_DIR, WA_GROUPS as GROUP_CONFIG_FILE, WA_MEDIA_DIR } from "../paths.js";
import { makeResilientSaveCreds } from "./whatsapp-auth-helpers.js";

// ── Group Whitelist Config ──────────────────────────────────────────────────

export interface GroupRule {
  groupId: string;
  groupName: string;
  enabled: boolean;
  allowedParticipants: string[];
  participantNames: Record<string, string>;
  requireMention: boolean;
  allowMedia: boolean;
  requireApproval: boolean;
  updatedAt: number;
}

export interface GroupConfig {
  groups: GroupRule[];
}

function loadGroupConfig(): GroupConfig {
  try {
    return JSON.parse(fs.readFileSync(GROUP_CONFIG_FILE, "utf-8"));
  } catch {
    return { groups: [] };
  }
}

function saveGroupConfig(config: GroupConfig): void {
  const dir = dirname(GROUP_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(GROUP_CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getGroupRule(groupId: string): GroupRule | undefined {
  return loadGroupConfig().groups.find(g => g.groupId === groupId);
}

export function getGroupRules(): GroupRule[] {
  return loadGroupConfig().groups;
}

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

let _approvalChannel: string = "telegram";

export function getApprovalChannel(): string {
  return _approvalChannel;
}

export function setApprovalChannel(channel: string): void {
  _approvalChannel = channel;
}

export function matchApprovalResponse(text: string): { id: string; approved: boolean } | null {
  const t = text.trim().toLowerCase();
  const entries = Array.from(_pendingApprovals.entries());
  if (entries.length === 0) return null;

  const approveWords = ["ok", "ja", "yes", "go", "1", "approve"];
  const denyWords = ["nein", "no", "nope", "2", "ablehnen", "deny", "stop"];

  for (const [id] of entries) {
    if (t.includes(id)) {
      const isApprove = approveWords.some(w => t.includes(w));
      return { id, approved: isApprove };
    }
  }

  const [latestId] = entries[entries.length - 1];
  if (approveWords.some(w => t === w || t.startsWith(w + " "))) {
    return { id: latestId, approved: true };
  }
  if (denyWords.some(w => t === w || t.startsWith(w + " "))) {
    return { id: latestId, approved: false };
  }

  return null;
}

function cleanupStaleApprovals(): void {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, p] of _pendingApprovals) {
    if (p.timestamp < cutoff) {
      _pendingApprovals.delete(id);
      if (p.incoming.media?.path) fs.unlink(p.incoming.media.path, () => {});
    }
  }
}

setInterval(cleanupStaleApprovals, 5 * 60_000);

// ── Global WhatsApp State ─────────────────────────────────────────────────

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

// ── JID Helpers & Contact Cache ────────────────────────────────────────────

function normalizeJid(jid: string): string {
  return jid.replace(/:.*@/, "@");
}

/** In-memory contact name cache: JID → display name. Populated from incoming messages. */
const _contactNames = new Map<string, string>();

/** Persist contact cache to disk for survival across restarts */
const CONTACT_CACHE_FILE = join(AUTH_DIR, "contact-names.json");

function loadContactCache(): void {
  try {
    const data = JSON.parse(fs.readFileSync(CONTACT_CACHE_FILE, "utf-8"));
    for (const [k, v] of Object.entries(data)) {
      _contactNames.set(k, v as string);
    }
  } catch { /* first run */ }
}

function saveContactCache(): void {
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(CONTACT_CACHE_FILE, JSON.stringify(Object.fromEntries(_contactNames), null, 2));
  } catch { /* non-critical */ }
}

/** Remember a contact's display name */
function cacheContactName(jid: string, name: string): void {
  if (!name || name === jid) return;
  const normalized = normalizeJid(jid);
  if (_contactNames.get(normalized) !== name) {
    _contactNames.set(normalized, name);
    saveContactCache();
  }
}

/** Get a contact's display name (cached push name > phone number > raw JID) */
export function getContactDisplayName(jid: string): string {
  const normalized = normalizeJid(jid);
  const cached = _contactNames.get(normalized);
  if (cached) return cached;
  // If it's a LID (no phone number embedded), show as-is
  if (jid.includes("@lid")) return jid.replace(/@lid$/, "");
  // Otherwise extract phone number
  const num = jidToNumber(jid);
  return num.startsWith("49") ? `+${num}` : num || jid;
}

// Load cache at module init
loadContactCache();

function jidToNumber(jid: string): string {
  return jid.replace(/@.*$/, "").replace(/:.*$/, "");
}

// ── Adapter ────────────────────────────────────────────────────────────────

let _adapterInstance: WhatsAppAdapter | null = null;
export function getWhatsAppAdapter(): WhatsAppAdapter | null {
  return _adapterInstance;
}

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = "whatsapp";
  private handler: MessageHandler | null = null;
  private sock: any = null;

  // Loop prevention
  private botSentIds = new Set<string>();
  private botSentTexts = new Set<string>();

  // Reconnect state
  private reconnectAttempt = 0;
  private maxReconnectAttempts = 10;

  constructor() {
    _adapterInstance = this;
  }

  async start(): Promise<void> {
    _whatsappState = {
      status: "connecting", qrString: null, qrTimestamp: null,
      connectedAt: null, error: null, info: null,
    };

    await this.connect();

    // v4.14 — Register with the delivery registry so the async-agent
    // watcher can deliver background sub-agent results back to WhatsApp.
    try {
      const { registerDeliveryAdapter } = await import(
        "../services/delivery-registry.js"
      );
      registerDeliveryAdapter({
        platform: "whatsapp",
        sendText: async (chatId, text) => {
          await this.sendText(String(chatId), text);
        },
      });
    } catch (err) {
      console.warn("[whatsapp] failed to register delivery adapter:", err);
    }
  }

  private async connect(): Promise<void> {
    let baileys: any;
    try {
      baileys = await import("@whiskeysockets/baileys");
    } catch {
      const msg = "@whiskeysockets/baileys not installed. Run: npm install @whiskeysockets/baileys";
      _whatsappState = { ..._whatsappState, status: "error", error: msg };
      console.error(`\u274C WhatsApp: ${msg}`);
      throw new Error(msg);
    }

    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      Browsers,
      getContentType,
      downloadMediaMessage,
    } = baileys;

    const P = (await import("pino")).default;
    const { Boom } = await import("@hapi/boom");
    const logger = P({ level: "silent" });

    const authDir = join(AUTH_DIR, "baileys-auth");
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Alvin Bot"),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    this.sock = sock;

    // Save credentials on update. Wrapped so a vanished auth dir (crash
    // mid-init, manual cleanup, etc.) doesn't turn the next creds.update
    // into an unhandled ENOENT rejection.
    const resilientSaveCreds = makeResilientSaveCreds(authDir, saveCreds);
    sock.ev.on("creds.update", resilientSaveCreds);

    // Connection state
    sock.ev.on("connection.update", (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        _whatsappState.status = "qr";
        _whatsappState.qrString = qr;
        _whatsappState.qrTimestamp = Date.now();
        _whatsappState.error = null;
        console.log("\uD83D\uDCF1 WhatsApp: QR code ready \u2014 scan via Web UI \u2192 Platforms");
      }

      if (connection === "open") {
        _whatsappState.status = "connected";
        _whatsappState.qrString = null;
        _whatsappState.connectedAt = Date.now();
        _whatsappState.error = null;
        _whatsappState.info = sock.user?.name || sock.user?.id || null;
        this.reconnectAttempt = 0;
        console.log(`\uD83D\uDCF1 WhatsApp connected (${_whatsappState.info || "unknown"})`);

        // Send welcome to self-chat
        const myJid = sock.user?.id;
        if (myJid) {
          sock.sendMessage(myJid, { text: "\uD83E\uDD16 *Alvin Bot is now connected on WhatsApp!*\n\nSchreib hier (Eigene Nachrichten) um mit mir zu chatten." }).catch(() => {});
        }
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          _whatsappState.status = "logged_out";
          _whatsappState.error = "Logged out. Delete auth and re-scan QR.";
          console.log("\uD83D\uDCF1 WhatsApp: Logged out");
          // Clear auth for fresh start
          fs.rmSync(authDir, { recursive: true, force: true });
        } else if (this.reconnectAttempt < this.maxReconnectAttempts) {
          this.reconnectAttempt++;
          const delay = Math.min(3000 * this.reconnectAttempt, 30000);
          _whatsappState.status = "connecting";
          _whatsappState.error = `Reconnecting (attempt ${this.reconnectAttempt})...`;
          console.log(`\uD83D\uDCF1 WhatsApp: Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempt})`);
          setTimeout(() => this.connect().catch(console.error), delay);
        } else {
          _whatsappState.status = "error";
          _whatsappState.error = "Max reconnect attempts reached";
          console.error("\u274C WhatsApp: Max reconnect attempts reached");
        }
      }
    });

    // Contact cache: learn names from Baileys contact sync
    sock.ev.on("contacts.upsert", (contacts: any[]) => {
      for (const c of contacts) {
        if (c.id && (c.notify || c.name)) {
          cacheContactName(c.id, c.notify || c.name);
        }
      }
    });

    sock.ev.on("contacts.update", (updates: any[]) => {
      for (const c of updates) {
        if (c.id && (c.notify || c.name)) {
          cacheContactName(c.id, c.notify || c.name);
        }
      }
    });

    // Message handler
    sock.ev.on("messages.upsert", async ({ messages, type }: { messages: any[]; type: string }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        // Cache sender push name from every incoming message
        if (msg.pushName && msg.key?.participant) {
          cacheContactName(msg.key.participant, msg.pushName);
        } else if (msg.pushName && msg.key?.remoteJid && !msg.key.remoteJid.endsWith("@g.us")) {
          cacheContactName(msg.key.remoteJid, msg.pushName);
        }

        try {
          await this.handleIncomingMessage(msg, sock, getContentType, downloadMediaMessage);
        } catch (err) {
          console.error("WhatsApp message handler error:", err instanceof Error ? err.message : err);
        }
      }
    });
  }

  // ── Message Processing ──────────────────────────────────────────────────────

  private async handleIncomingMessage(
    msg: any,
    sock: any,
    getContentType: (m: any) => string | undefined,
    downloadMediaMessage: (m: any, type: string, opts?: any, ctx?: any) => Promise<Buffer>,
  ): Promise<void> {
    if (!this.handler) return;
    if (!msg.message) return;

    const jid = msg.key.remoteJid;
    if (!jid) return;

    // Skip newsletters/broadcasts/status
    if (jid.endsWith("@newsletter") || jid.endsWith("@broadcast") || jid === "status@broadcast") return;

    const msgType = getContentType(msg.message);
    if (!msgType) return;

    // Extract text
    const text = (
      msg.message.conversation
      || msg.message.extendedTextMessage?.text
      || msg.message.imageMessage?.caption
      || msg.message.videoMessage?.caption
      || msg.message.documentMessage?.caption
      || ""
    ).trim();

    const isVoice = msgType === "audioMessage" && msg.message.audioMessage?.ptt === true;
    const isAudio = msgType === "audioMessage" && !msg.message.audioMessage?.ptt;
    const isImage = msgType === "imageMessage" || msgType === "stickerMessage";
    const isDocument = msgType === "documentMessage";
    const isVideo = msgType === "videoMessage";
    const hasMedia = isVoice || isAudio || isImage || isDocument || isVideo;

    if (!text && !hasMedia) return;

    // Loop prevention
    const msgId = msg.key.id || "";
    if (this.botSentIds.has(msgId)) {
      this.botSentIds.delete(msgId);
      return;
    }

    const fromMe = msg.key.fromMe === true;
    const isGroup = jid.endsWith("@g.us");
    const isSelf = this.isSelfChat(jid);

    // Skip own messages in groups and DMs (but allow self-chat)
    if (fromMe && !isSelf) return;
    // Loop prevention for self-chat
    if (fromMe && text && this.botSentTexts.has(text.substring(0, 100))) return;

    // ── Access control ─────────────────────────────────────────────
    const selfChatOnly = process.env.WHATSAPP_SELF_CHAT_ONLY === "true";
    const allowGroups = process.env.WHATSAPP_ALLOW_GROUPS === "true";

    if (isSelf) {
      // Self-chat: check approval responses
      if (text && _approvalChannel === "whatsapp" && _pendingApprovals.size > 0) {
        const match = matchApprovalResponse(text);
        if (match) {
          const pending = removePendingApproval(match.id);
          if (pending) {
            if (match.approved) {
              await this.sendText(jid, `\u2705 Approved: ${pending.senderName} in ${pending.groupName}`);
              if (this.handler) await this.handler(pending.incoming);
            } else {
              await this.sendText(jid, `\u274C Abgelehnt: ${pending.senderName}`);
              if (pending.incoming.media?.path) fs.unlink(pending.incoming.media.path, () => {});
            }
            return;
          }
        }
      }
    } else if (isGroup) {
      if (selfChatOnly || !allowGroups) return;

      const rule = getGroupRule(jid);
      if (!rule || !rule.enabled) return;

      // Participant whitelist
      const senderId = msg.key.participant || "";
      if (rule.allowedParticipants.length > 0) {
        const senderNorm = jidToNumber(senderId);
        const allowed = rule.allowedParticipants.some(p => jidToNumber(p) === senderNorm);
        if (!allowed) return;
      }

      // Mention requirement
      if (rule.requireMention) {
        const botName = sock.user?.name || "Alvin Bot";
        const myJid = sock.user?.id || "";
        const mentionedJids: string[] = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const nativeMention = mentionedJids.some((m: string) => normalizeJid(m) === normalizeJid(myJid));
        const textMention = text && (
          text.toLowerCase().includes("@alvin") ||
          text.toLowerCase().includes("@bot") ||
          text.toLowerCase().includes(botName.toLowerCase())
        );
        if (!nativeMention && !textMention && !hasMedia) return;
      }

      if (hasMedia && !rule.allowMedia && !text) return;
    } else {
      // DM
      if (selfChatOnly) return;
      if (process.env.WHATSAPP_ALLOW_DMS !== "true") return;
    }

    // ── Download media ─────────────────────────────────────────────
    let mediaInfo: IncomingMessage["media"] = undefined;

    if (hasMedia) {
      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {}, {
          reuploadRequest: sock.updateMediaMessage,
        });

        if (!fs.existsSync(WA_MEDIA_DIR)) fs.mkdirSync(WA_MEDIA_DIR, { recursive: true });

        if (isVoice || isAudio) {
          const mime = msg.message.audioMessage?.mimetype || "audio/ogg";
          const ext = mime.includes("ogg") ? "ogg" : "mp3";
          const path = join(WA_MEDIA_DIR, `wa_voice_${Date.now()}.${ext}`);
          fs.writeFileSync(path, buffer);
          mediaInfo = { type: "voice", path, mimeType: mime };
        } else if (isImage) {
          const mime = msg.message.imageMessage?.mimetype || msg.message.stickerMessage?.mimetype || "image/jpeg";
          const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
          const path = join(WA_MEDIA_DIR, `wa_photo_${Date.now()}.${ext}`);
          fs.writeFileSync(path, buffer);
          mediaInfo = { type: "photo", path, mimeType: mime };
        } else if (isDocument) {
          const fileName = msg.message.documentMessage?.fileName || `wa_doc_${Date.now()}`;
          const mime = msg.message.documentMessage?.mimetype || "application/octet-stream";
          const path = join(WA_MEDIA_DIR, fileName);
          fs.writeFileSync(path, buffer);
          mediaInfo = { type: "document", path, mimeType: mime, fileName };
        } else if (isVideo) {
          const mime = msg.message.videoMessage?.mimetype || "video/mp4";
          const ext = mime.includes("mp4") ? "mp4" : "webm";
          const path = join(WA_MEDIA_DIR, `wa_video_${Date.now()}.${ext}`);
          fs.writeFileSync(path, buffer);
          mediaInfo = { type: "video" as any, path, mimeType: mime };
        }
      } catch (err) {
        console.error(`WhatsApp: Failed to download ${msgType}:`, err instanceof Error ? err.message : err);
      }
    }

    // ── Build IncomingMessage ──────────────────────────────────────
    const senderName = isSelf
      ? (sock.user?.name || "User")
      : (msg.pushName || jidToNumber(msg.key.participant || jid));

    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || undefined;

    const incoming: IncomingMessage = {
      platform: "whatsapp",
      messageId: msgId,
      chatId: jid,
      userId: isSelf ? "self" : (msg.key.participant || jid),
      userName: senderName,
      text: text || "",
      isGroup,
      isMention: isGroup && !!text && (text.includes("@alvin") || text.includes("@bot")),
      isReplyToBot: false,
      replyToText: quotedText,
      media: mediaInfo,
    };

    // ── Approval gate ─────────────────────────────────────────────
    if (isGroup && !isSelf && !fromMe) {
      const rule = getGroupRule(jid);
      if (rule?.requireApproval && _approvalRequestFn) {
        const approvalId = `wa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        let preview = text || "";
        if (preview.length > 200) preview = preview.slice(0, 200) + "\u2026";
        if (hasMedia && !preview) {
          const labels: Record<string, string> = { audioMessage: "\uD83C\uDFA4 Voice", imageMessage: "\uD83D\uDCF7 Image", documentMessage: "\uD83D\uDCC4 Document", videoMessage: "\uD83C\uDFAC Video", stickerMessage: "\uD83C\uDFF7 Sticker" };
          preview = labels[msgType || ""] || `\uD83D\uDCCE ${msgType}`;
        } else if (hasMedia) {
          preview = `\uD83D\uDCCE +Media: ${preview}`;
        }

        const pending: PendingApproval = {
          id: approvalId,
          incoming,
          groupName: jid, // Will be resolved by caller if needed
          senderName,
          senderNumber: jidToNumber(msg.key.participant || jid),
          preview,
          mediaType: hasMedia ? msgType : undefined,
          timestamp: Date.now(),
        };

        _pendingApprovals.set(approvalId, pending);
        await _approvalRequestFn(pending);
        return;
      }
    }

    await this.handler(incoming);
  }

  private isSelfChat(jid: string): boolean {
    if (!this.sock?.user) return false;
    // Groups are never self-chat regardless of which identity format
    // the group uses.
    if (jid.endsWith("@g.us")) return false;

    // WhatsApp has two identity formats that can appear in self-chat:
    //   1. Traditional phone-number JID: 49176...:22@s.whatsapp.net
    //   2. LID (linked identity): 162805718...@lid — privacy feature
    //      added in 2024 that hides the real phone number in self-chats
    //      and some groups. Baileys exposes this as sock.user.lid.
    //
    // Check both so self-chat detection works regardless of which
    // format WhatsApp chose to tag the chat with today.
    const user = this.sock.user as { id?: string; lid?: string };
    const myId = user.id;
    const myLid = user.lid;

    // Match against phone-number JID (traditional path)
    if (myId) {
      const myNumber = jidToNumber(myId);
      const jidNumber = jidToNumber(jid);
      if (myNumber && jidNumber && myNumber === jidNumber) return true;
    }

    // Match against LID (new privacy format)
    if (myLid && jid.endsWith("@lid")) {
      const myLidNum = jidToNumber(myLid);
      const jidLidNum = jidToNumber(jid);
      if (myLidNum && jidLidNum && myLidNum === jidLidNum) return true;
    }

    return false;
  }

  // ── Public API: Groups ────────────────────────────────────────────────────

  async getGroups(): Promise<Array<{ id: string; name: string; participantCount: number }>> {
    if (!this.sock || _whatsappState.status !== "connected") return [];
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      return Object.values(groups).map((g: any) => ({
        id: g.id,
        name: g.subject || "Unnamed Group",
        participantCount: g.participants?.length || 0,
      })).sort((a: any, b: any) => a.name.localeCompare(b.name));
    } catch (err) {
      console.error("WhatsApp: Failed to fetch groups:", err);
      return [];
    }
  }

  async getGroupParticipants(groupId: string): Promise<Array<{ id: string; name: string; isAdmin: boolean; number: string }>> {
    if (!this.sock || _whatsappState.status !== "connected") return [];
    try {
      const meta = await this.sock.groupMetadata(groupId);
      const myJid = this.sock.user?.id || "";
      return (meta.participants || [])
        .filter((p: any) => normalizeJid(p.id) !== normalizeJid(myJid))
        .map((p: any) => ({
          id: p.id,
          name: getContactDisplayName(p.id),
          isAdmin: p.admin === "admin" || p.admin === "superadmin",
          number: jidToNumber(p.id),
        }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
    } catch (err) {
      console.error("WhatsApp: Failed to fetch participants:", err);
      return [];
    }
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.sock) return;
    const textHash = text.substring(0, 100);
    this.botSentTexts.add(textHash);
    setTimeout(() => this.botSentTexts.delete(textHash), 30_000);

    const sent = await this.sock.sendMessage(chatId, { text });
    if (sent?.key?.id) {
      this.botSentIds.add(sent.key.id);
      setTimeout(() => this.botSentIds.delete(sent.key.id), 60_000);
    }
  }

  async sendPhoto(chatId: string, photo: Buffer | string, caption?: string): Promise<void> {
    if (!this.sock) return;
    const image = typeof photo === "string" ? { url: photo } : photo;
    await this.sock.sendMessage(chatId, { image, caption });
  }

  async sendDocument(chatId: string, doc: Buffer | string, fileName: string, caption?: string): Promise<void> {
    if (!this.sock) return;
    const document = typeof doc === "string" ? { url: doc } : doc;
    await this.sock.sendMessage(chatId, { document, fileName, mimetype: "application/octet-stream", caption });
  }

  async sendVoice(chatId: string, audio: Buffer | string): Promise<void> {
    if (!this.sock) return;
    const audioData = typeof audio === "string" ? { url: audio } : audio;
    await this.sock.sendMessage(chatId, { audio: audioData, mimetype: "audio/ogg; codecs=opus", ptt: true });
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.sock) return;
    await this.sock.sendMessage(chatId, { react: { text: emoji, key: { remoteJid: chatId, id: messageId } } });
  }

  async setTyping(chatId: string): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate("composing", chatId);
    } catch { /* ignore */ }
  }

  getOwnerChatId(): string | null {
    return this.sock?.user?.id || null;
  }

  async processApprovedMessage(incoming: IncomingMessage): Promise<void> {
    if (!this.handler) return;
    await this.handler(incoming);
  }

  async stop(): Promise<void> {
    if (this.sock) {
      try { this.sock.end(undefined); } catch { /* ignore */ }
      this.sock = null;
    }
    _whatsappState.status = "disconnected";
    _adapterInstance = null;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}
