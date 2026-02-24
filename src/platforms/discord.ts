/**
 * Discord Platform Adapter
 *
 * Uses discord.js to connect to Discord.
 * Optional dependency — only loaded if DISCORD_TOKEN is set.
 *
 * Setup:
 * 1. Create a bot at https://discord.com/developers/applications
 * 2. Enable Message Content Intent
 * 3. Set DISCORD_TOKEN in .env
 * 4. Invite bot to server with messages.read + messages.write permissions
 */

import type { PlatformAdapter, IncomingMessage, MessageHandler, SendOptions } from "./types.js";

export class DiscordAdapter implements PlatformAdapter {
  readonly platform = "discord";
  private handler: MessageHandler | null = null;
  private client: any = null; // discord.js Client (dynamic import)
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async start(): Promise<void> {
    try {
      // Dynamic import — discord.js is optional
      // @ts-ignore — discord.js is an optional dependency
      const { Client, GatewayIntentBits } = await import("discord.js");

      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
      });

      this.client.on("messageCreate", async (msg: any) => {
        if (msg.author.bot) return;
        if (!this.handler) return;

        const isMention = msg.mentions.has(this.client.user);
        const isReplyToBot = msg.reference?.messageId
          ? (await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null))?.author?.id === this.client.user.id
          : false;

        const incoming: IncomingMessage = {
          platform: "discord",
          messageId: msg.id,
          chatId: msg.channel.id,
          userId: msg.author.id,
          userName: msg.author.displayName || msg.author.username,
          userHandle: msg.author.username,
          text: msg.content,
          isGroup: msg.guild !== null,
          isMention,
          isReplyToBot,
          replyToText: undefined,
        };

        // In servers: only respond to mentions or replies
        if (msg.guild && !isMention && !isReplyToBot) return;

        // Strip mention from text
        if (isMention) {
          incoming.text = incoming.text.replace(/<@!?\d+>/g, "").trim();
        }

        await this.handler(incoming);
      });

      await this.client.login(this.token);
      console.log(`🎮 Discord adapter started (${this.client.user?.tag})`);
    } catch (err) {
      console.error("Discord adapter failed to start:", err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
    }
  }

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<void> {
    if (!this.client) return;
    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased()) return;

    // Discord max message length is 2000
    if (text.length > 2000) {
      // Split into chunks
      const chunks = text.match(/.{1,1990}/gs) || [text];
      for (const chunk of chunks) {
        await channel.send({
          content: chunk,
          reply: options?.replyTo ? { messageReference: options.replyTo } : undefined,
        });
      }
    } else {
      await channel.send({
        content: text,
        reply: options?.replyTo ? { messageReference: options.replyTo } : undefined,
      });
    }
  }

  async sendPhoto(chatId: string, photo: Buffer | string, caption?: string): Promise<void> {
    if (!this.client) return;
    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased()) return;

    // @ts-ignore — discord.js is an optional dependency
    const { AttachmentBuilder } = await import("discord.js");
    const attachment = typeof photo === "string"
      ? new AttachmentBuilder(photo)
      : new AttachmentBuilder(photo, { name: "image.png" });

    await channel.send({ content: caption, files: [attachment] });
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (!channel?.isTextBased()) return;
      const msg = await channel.messages.fetch(messageId);
      await msg.react(emoji);
    } catch { /* ignore */ }
  }

  async setTyping(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel?.isTextBased()) await channel.sendTyping();
    } catch { /* ignore */ }
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}
