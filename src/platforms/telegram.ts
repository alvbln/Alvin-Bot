/**
 * Telegram Platform Adapter
 *
 * Wraps grammy Bot into the PlatformAdapter interface.
 * This is the reference implementation — all other adapters follow this pattern.
 */

import { Bot, InputFile } from "grammy";
import type { PlatformAdapter, IncomingMessage, MessageHandler, SendOptions } from "./types.js";
import { config } from "../config.js";
import { authMiddleware } from "../middleware/auth.js";

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = "telegram";
  private bot: Bot;
  private handler: MessageHandler | null = null;

  constructor() {
    this.bot = new Bot(config.botToken);
  }

  /** Get the underlying grammy Bot instance (for command registration). */
  getBot(): Bot {
    return this.bot;
  }

  async start(): Promise<void> {
    // Auth middleware
    this.bot.use(authMiddleware);

    // Route raw messages to the platform handler
    this.bot.on("message:text", async (ctx) => {
      if (!this.handler) return;
      if (ctx.message?.text?.startsWith("/")) return; // Commands handled separately

      const msg: IncomingMessage = {
        platform: "telegram",
        messageId: String(ctx.message?.message_id),
        chatId: String(ctx.chat?.id),
        userId: String(ctx.from?.id),
        userName: ctx.from?.first_name || "Unknown",
        userHandle: ctx.from?.username,
        text: ctx.message?.text || "",
        isGroup: ctx.chat?.type !== "private",
        isMention: false, // Handled by group middleware
        isReplyToBot: false,
        replyToText: ctx.message?.reply_to_message?.text,
      };

      await this.handler(msg);
    });

    await this.bot.start({
      onStart: () => console.log(`📱 Telegram adapter started`),
    });
  }

  async stop(): Promise<void> {
    this.bot.stop();
  }

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<void> {
    const parseMode = options?.parseMode === "html" ? "HTML"
      : options?.parseMode === "markdown" ? "Markdown"
      : undefined;

    await this.bot.api.sendMessage(Number(chatId), text, {
      parse_mode: parseMode as "Markdown" | "HTML" | undefined,
      reply_parameters: options?.replyTo ? { message_id: Number(options.replyTo) } : undefined,
    });
  }

  async sendPhoto(chatId: string, photo: Buffer | string, caption?: string): Promise<void> {
    const input = typeof photo === "string" ? new InputFile(photo) : new InputFile(photo, "photo.jpg");
    await this.bot.api.sendPhoto(Number(chatId), input, { caption });
  }

  async sendDocument(chatId: string, doc: Buffer | string, fileName: string, caption?: string): Promise<void> {
    const input = typeof doc === "string" ? new InputFile(doc) : new InputFile(doc, fileName);
    await this.bot.api.sendDocument(Number(chatId), input, { caption });
  }

  async sendVoice(chatId: string, audio: Buffer | string): Promise<void> {
    const input = typeof audio === "string" ? new InputFile(audio) : new InputFile(audio, "voice.ogg");
    await this.bot.api.sendVoice(Number(chatId), input);
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.bot.api.setMessageReaction(Number(chatId), Number(messageId), [{ type: "emoji", emoji: emoji as any }]);
    } catch { /* Reactions not supported */ }
  }

  async setTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(Number(chatId), "typing");
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}
