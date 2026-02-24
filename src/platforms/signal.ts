/**
 * Signal Platform Adapter
 *
 * Uses signal-cli (REST API mode) for Signal messaging.
 * Optional — only loaded if SIGNAL_API_URL is set.
 *
 * Setup:
 * 1. Run signal-cli in REST API mode:
 *    docker run -p 8080:8080 bbernhard/signal-cli-rest-api
 * 2. Register/link a phone number via signal-cli
 * 3. Set SIGNAL_API_URL=http://localhost:8080 and SIGNAL_NUMBER=+49... in .env
 */

import type { PlatformAdapter, IncomingMessage, MessageHandler, SendOptions } from "./types.js";

export class SignalAdapter implements PlatformAdapter {
  readonly platform = "signal";
  private handler: MessageHandler | null = null;
  private apiUrl: string;
  private number: string;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(apiUrl: string, number: string) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.number = number;
  }

  async start(): Promise<void> {
    // Verify connection
    try {
      const res = await fetch(`${this.apiUrl}/v1/about`);
      if (!res.ok) throw new Error(`Signal API not reachable: ${res.status}`);
      console.log("📱 Signal adapter connected");
    } catch (err) {
      console.error("Signal adapter failed:", err);
      throw err;
    }

    // Poll for new messages every 2 seconds
    this.pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${this.apiUrl}/v1/receive/${encodeURIComponent(this.number)}`);
        if (!res.ok) return;

        const messages = await res.json() as any[];
        for (const msg of messages) {
          if (!msg.envelope?.dataMessage?.message) continue;
          if (!this.handler) continue;

          const data = msg.envelope.dataMessage;
          const isGroup = !!data.groupInfo;

          const incoming: IncomingMessage = {
            platform: "signal",
            messageId: msg.envelope.timestamp?.toString() || "",
            chatId: isGroup ? data.groupInfo.groupId : msg.envelope.sourceNumber,
            userId: msg.envelope.sourceNumber || "",
            userName: msg.envelope.sourceName || msg.envelope.sourceNumber || "Unknown",
            text: data.message,
            isGroup,
            isMention: data.message.includes("@bot") || data.message.includes("Mr. Levin"),
            isReplyToBot: false,
            replyToText: data.quote?.text,
          };

          // In groups: only respond to mentions
          if (isGroup && !incoming.isMention) continue;

          await this.handler(incoming);
        }
      } catch { /* poll error — retry next interval */ }
    }, 2000);
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    // Determine if chatId is a group or direct message
    const isGroup = chatId.length > 20; // Signal group IDs are long base64 strings

    const body: any = {
      message: text,
      number: this.number,
      recipients: isGroup ? undefined : [chatId],
    };

    if (isGroup) {
      // Send to group
      await fetch(`${this.apiUrl}/v2/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          recipients: [chatId],
        }),
      });
    } else {
      await fetch(`${this.apiUrl}/v2/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/v1/reactions/${encodeURIComponent(this.number)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: chatId,
          reaction: emoji,
          target_author: chatId,
          timestamp: parseInt(messageId),
        }),
      });
    } catch { /* ignore */ }
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}
