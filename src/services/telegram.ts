import type { Api } from "grammy";
import { config } from "../config.js";
import { sanitizeTelegramMarkdown } from "./markdown.js";

export class TelegramStreamer {
  private messageId: number | null = null;
  private chatId: number;
  private api: Api;
  private replyTo: number | undefined;
  private lastEditTime = 0;
  private pendingText: string | null = null;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentText = "";

  constructor(chatId: number, api: Api, replyToMessageId?: number) {
    this.chatId = chatId;
    this.api = api;
    this.replyTo = replyToMessageId;
  }

  async update(fullText: string): Promise<void> {
    const displayText = sanitizeTelegramMarkdown(this.truncate(fullText) || "...");

    if (!this.messageId) {
      const opts: Record<string, unknown> = { parse_mode: "Markdown" };
      if (this.replyTo) opts.reply_to_message_id = this.replyTo;

      const msg = await this.api.sendMessage(this.chatId, displayText, opts as Parameters<Api["sendMessage"]>[2]).catch(() =>
        this.api.sendMessage(this.chatId, displayText, this.replyTo ? { reply_to_message_id: this.replyTo } as Parameters<Api["sendMessage"]>[2] : undefined)
      );
      this.messageId = msg.message_id;
      this.lastSentText = displayText;
      this.lastEditTime = Date.now();
      return;
    }

    if (displayText === this.lastSentText) return;

    this.pendingText = displayText;
    if (!this.editTimer) {
      const elapsed = Date.now() - this.lastEditTime;
      const delay = Math.max(0, config.streamThrottleMs - elapsed);
      this.editTimer = setTimeout(() => this.flush(), delay);
    }
  }

  private async flush(): Promise<void> {
    this.editTimer = null;
    if (this.pendingText && this.messageId && this.pendingText !== this.lastSentText) {
      try {
        await this.api.editMessageText(this.chatId, this.messageId, this.pendingText, {
          parse_mode: "Markdown",
        }).catch(() =>
          this.api.editMessageText(this.chatId, this.messageId!, this.pendingText!)
        );
        this.lastSentText = this.pendingText;
        this.lastEditTime = Date.now();
      } catch {
        // Ignore edit failures (message unchanged, etc.)
      }
      this.pendingText = null;
    }
  }

  async finalize(fullText: string): Promise<void> {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }

    if (!fullText || fullText.trim().length === 0) {
      if (!this.messageId) {
        await this.api.sendMessage(this.chatId, "(Keine Antwort)");
      }
      return;
    }

    // Sanitize final text
    const safeText = sanitizeTelegramMarkdown(fullText);

    // If text fits in one message, just update the existing one
    if (safeText.length <= config.telegramMaxLength && this.messageId) {
      if (safeText !== this.lastSentText) {
        await this.api.editMessageText(this.chatId, this.messageId, safeText, {
          parse_mode: "Markdown",
        }).catch(() =>
          this.api.editMessageText(this.chatId, this.messageId!, safeText)
        );
      }
      return;
    }

    // Long text: delete streaming message and send chunked
    if (this.messageId) {
      await this.api.deleteMessage(this.chatId, this.messageId).catch(() => {});
    }

    const chunks = this.splitText(safeText);
    for (const chunk of chunks) {
      await this.api.sendMessage(this.chatId, chunk, {
        parse_mode: "Markdown",
      }).catch(() =>
        this.api.sendMessage(this.chatId, chunk)
      );
    }
  }

  private truncate(text: string): string {
    if (text.length <= config.telegramMaxLength) return text;
    return "...\n" + text.slice(-(config.telegramMaxLength - 10));
  }

  private splitText(text: string): string[] {
    const chunks: string[] = [];
    let remaining = text;
    const maxLen = config.telegramMaxLength;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      let splitAt = remaining.lastIndexOf("\n", maxLen);
      if (splitAt < maxLen * 0.5) {
        splitAt = remaining.lastIndexOf(" ", maxLen);
      }
      if (splitAt < maxLen * 0.3) {
        splitAt = maxLen;
      }

      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trimStart();
    }

    return chunks;
  }
}
