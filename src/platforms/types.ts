/**
 * Platform Abstraction — Unified interface for all messaging platforms.
 *
 * Every platform adapter implements PlatformAdapter.
 * The bot logic talks to adapters through this interface,
 * making it platform-agnostic.
 */

// ── Incoming Message ────────────────────────────────────

export interface IncomingMessage {
  /** Platform identifier */
  platform: "telegram" | "discord" | "whatsapp" | "signal" | "web";
  /** Unique message ID (platform-specific) */
  messageId: string;
  /** Chat/channel ID */
  chatId: string;
  /** User ID (platform-specific) */
  userId: string;
  /** User display name */
  userName: string;
  /** Username (without @) */
  userHandle?: string;
  /** Message text */
  text: string;
  /** Is this a group chat? */
  isGroup: boolean;
  /** Was the bot mentioned? (for group chats) */
  isMention: boolean;
  /** Is this a reply to the bot? */
  isReplyToBot: boolean;
  /** Quoted/reply-to text */
  replyToText?: string;
  /** Attached media */
  media?: {
    type: "photo" | "video" | "voice" | "document";
    url?: string;
    path?: string;
    mimeType?: string;
    fileName?: string;
  };
}

// ── Outgoing Actions ────────────────────────────────────

export interface PlatformAdapter {
  /** Platform identifier */
  readonly platform: string;

  /** Start the adapter (connect, login, etc.) */
  start(): Promise<void>;

  /** Stop the adapter */
  stop(): Promise<void>;

  /** Send a text message */
  sendText(chatId: string, text: string, options?: SendOptions): Promise<void>;

  /** Send a photo/image */
  sendPhoto?(chatId: string, photo: Buffer | string, caption?: string): Promise<void>;

  /** Send a document/file */
  sendDocument?(chatId: string, doc: Buffer | string, fileName: string, caption?: string): Promise<void>;

  /** Send a voice message */
  sendVoice?(chatId: string, audio: Buffer | string): Promise<void>;

  /** React to a message with an emoji */
  react?(chatId: string, messageId: string, emoji: string): Promise<void>;

  /** Set typing indicator */
  setTyping?(chatId: string): Promise<void>;

  /** Register the message handler */
  onMessage(handler: MessageHandler): void;
}

export interface SendOptions {
  /** Reply to a specific message */
  replyTo?: string;
  /** Parse mode (markdown, html, plain) */
  parseMode?: "markdown" | "html" | "plain";
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;
