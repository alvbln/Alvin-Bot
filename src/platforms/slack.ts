/**
 * Slack Platform Adapter
 *
 * Uses @slack/bolt (Socket Mode) for real-time messaging.
 * Optional dependency — only loaded if SLACK_BOT_TOKEN + SLACK_APP_TOKEN are set.
 *
 * Socket Mode = no public URL needed. Works behind NAT/firewalls.
 *
 * Setup:
 *   1. Create a Slack App at https://api.slack.com/apps
 *   2. Enable Socket Mode (Settings → Socket Mode → Enable)
 *   3. Generate an App-Level Token with connections:write scope → SLACK_APP_TOKEN (xapp-...)
 *   4. Install to workspace → Bot User OAuth Token → SLACK_BOT_TOKEN (xoxb-...)
 *   5. Add Bot Token Scopes: chat:write, channels:history, groups:history, im:history,
 *      mpim:history, app_mentions:read, files:write, reactions:write
 *   6. Subscribe to events: message.im, message.groups, message.channels, app_mention
 *   7. Set env vars and restart bot
 */

import type { PlatformAdapter, IncomingMessage, MessageHandler, SendOptions } from "./types.js";
import fs from "fs";
import { parseSlackSlashCommand } from "./slack-slash-parser.js";

// ── Global Slack State ─────────────────────────────────────────────────────

export interface SlackState {
  status: "disconnected" | "connecting" | "connected" | "error";
  botName: string | null;
  botId: string | null;
  teamName: string | null;
  connectedAt: number | null;
  error: string | null;
}

let _slackState: SlackState = {
  status: "disconnected",
  botName: null,
  botId: null,
  teamName: null,
  connectedAt: null,
  error: null,
};

export function getSlackState(): SlackState {
  return { ..._slackState };
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class SlackAdapter implements PlatformAdapter {
  readonly platform = "slack";
  private handler: MessageHandler | null = null;
  private app: any = null; // Bolt App instance
  private botUserId: string = "";
  private botToken: string;
  private appToken: string;
  /** v4.12.0 — channelId → channelName cache, refreshed on miss via conversations.info */
  private channelNameCache = new Map<string, string>();

  constructor(botToken: string, appToken: string) {
    this.botToken = botToken;
    this.appToken = appToken;
  }

  async start(): Promise<void> {
    _slackState = {
      status: "connecting", botName: null, botId: null,
      teamName: null, connectedAt: null, error: null,
    };

    let bolt: any;
    try {
      bolt = await import("@slack/bolt");
    } catch {
      const msg = "@slack/bolt not installed. Run: npm install @slack/bolt";
      _slackState = { ..._slackState, status: "error", error: msg };
      console.error(`\u274C Slack: ${msg}`);
      throw new Error(msg);
    }

    const { App } = bolt;

    try {
      this.app = new App({
        token: this.botToken,
        appToken: this.appToken,
        socketMode: true,
        // Suppress Bolt's default logging (we log ourselves)
        logLevel: "ERROR",
      });

      // Get bot identity
      const authResult = await this.app.client.auth.test({ token: this.botToken });
      this.botUserId = authResult.user_id || "";
      _slackState.botName = authResult.user || null;
      _slackState.botId = authResult.user_id || null;
      _slackState.teamName = authResult.team || null;

      // Handle all messages (DMs + channels where bot is mentioned)
      this.app.message(async ({ message, say, client }: any) => {
        await this.handleMessage(message, say, client);
      });

      // Handle @mentions explicitly (app_mention event)
      this.app.event("app_mention", async ({ event, say, client }: any) => {
        await this.handleMention(event, say, client);
      });

      // v4.13.2 — Handle the /alvin slash command.
      //
      // Slack sends slash commands as their own "command" event type
      // (not as regular messages), so without this handler users who
      // type /status see "Not a valid command" from Slack's built-in
      // /status (which sets their user status). We register /alvin as
      // a namespaced parent and parse the subcommand from command.text.
      //
      // CRITICAL: Slack requires ack() within 3 seconds or the user
      // sees "/alvin didn't respond". We ack FIRST, then do the work
      // asynchronously via the normal handler pipeline.
      //
      // Defensive: older/mocked Bolt versions might not expose .command().
      // Skip registration silently rather than crashing start().
      if (typeof this.app.command === "function") {
        this.app.command("/alvin", async ({ command, ack }: any) => {
          await ack();
          try {
            await this.handleSlashCommand(command);
          } catch (err) {
            console.error("[slack] /alvin command failed:", err);
          }
        });
      }

      await this.app.start();

      _slackState.status = "connected";
      _slackState.connectedAt = Date.now();
      console.log(`\uD83D\uDCAC Slack connected (${_slackState.botName} @ ${_slackState.teamName})`);

      // v4.14 — Register this adapter with the delivery registry so the
      // async-agent watcher can deliver background sub-agent results
      // back to Slack. The registry accepts string channel IDs directly.
      try {
        const { registerDeliveryAdapter } = await import(
          "../services/delivery-registry.js"
        );
        registerDeliveryAdapter({
          platform: "slack",
          sendText: async (chatId, text) => {
            await this.sendText(String(chatId), text);
          },
        });
      } catch (err) {
        console.warn("[slack] failed to register delivery adapter:", err);
      }
    } catch (err) {
      _slackState.status = "error";
      _slackState.error = err instanceof Error ? err.message : String(err);
      console.error("\u274C Slack adapter failed:", _slackState.error);
      throw err;
    }
  }

  // ── Message Handling ───────────────────────────────────────────────────────

  private async handleMessage(message: any, _say: any, client: any): Promise<void> {
    if (!this.handler) return;

    // Skip bot messages (including own), message_changed, etc.
    if (message.subtype) return;
    if (message.bot_id) return;
    if (!message.text && !message.files) return;

    const text = (message.text || "").trim();
    const userId = message.user || "";
    const channelId = message.channel || "";
    const messageId = message.ts || "";

    // Determine channel type
    // DMs (im) have channel_type "im", group DMs are "mpim", channels are "channel"/"group"
    const channelType = message.channel_type || "";
    const isDM = channelType === "im";
    const isGroup = !isDM;

    // In channels: only respond to @mentions (handled by app_mention event)
    // But message event also fires for DMs, so we handle DMs here
    if (isGroup) return; // Channel messages handled by app_mention

    // Resolve user name
    let userName = userId;
    try {
      const userInfo = await client.users.info({ user: userId });
      userName = userInfo.user?.real_name || userInfo.user?.name || userId;
    } catch { /* fallback to userId */ }

    // Check for file attachments
    let media: IncomingMessage["media"] = undefined;
    if (message.files && message.files.length > 0) {
      const file = message.files[0];
      media = this.parseSlackFile(file);
    }

    // Check for thread/reply context
    let replyToText: string | undefined;
    if (message.thread_ts && message.thread_ts !== message.ts) {
      try {
        const thread = await client.conversations.replies({
          channel: channelId,
          ts: message.thread_ts,
          limit: 1,
        });
        const parent = thread.messages?.[0];
        if (parent?.text) {
          replyToText = parent.text.length > 500 ? parent.text.slice(0, 500) + "..." : parent.text;
        }
      } catch { /* ignore */ }
    }

    const incoming: IncomingMessage = {
      platform: "slack",
      messageId,
      chatId: channelId,
      userId,
      userName,
      text,
      isGroup: false,
      isMention: false,
      isReplyToBot: false,
      replyToText,
      media,
    };

    await this.handler(incoming);
  }

  /**
   * v4.13.2 — Handle /alvin slash command.
   *
   * Slack delivers these with command.text containing the part after
   * "/alvin " (so "/alvin status" arrives with text="status"). We
   * translate into a platform-agnostic "/<sub>[ args]" string and
   * forward through the normal message handler — handlePlatformCommand
   * picks it up since it starts with "/".
   *
   * The response goes back via the same sendText path as regular
   * messages (chat.postMessage in command.channel_id). Slack allows
   * this in addition to the slash-command-native respond() mechanism,
   * and it keeps the codepath identical to message.im responses.
   */
  private async handleSlashCommand(command: any): Promise<void> {
    if (!this.handler) return;

    const translated = parseSlackSlashCommand(command.text || "");
    const channelId = command.channel_id || "";
    const userId = command.user_id || "";
    const userName = command.user_name || userId;

    const incoming: IncomingMessage = {
      platform: "slack",
      messageId: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId: channelId,
      userId,
      userName,
      text: translated,
      // Slack slash commands are always issued 1:1 in the sense of
      // "one user invoking". isGroup reflects the CHANNEL context
      // (channel_name=directmessage is a DM, otherwise channel/group).
      isGroup: command.channel_name && command.channel_name !== "directmessage",
      isMention: false,
      isReplyToBot: false,
    };

    await this.handler(incoming);
  }

  private async handleMention(event: any, _say: any, client: any): Promise<void> {
    if (!this.handler) return;
    if (event.bot_id) return;

    let text = (event.text || "").trim();
    const userId = event.user || "";
    const channelId = event.channel || "";
    const messageId = event.ts || "";

    // Strip the @mention from text
    text = text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();

    if (!text) return;

    // Resolve user name
    let userName = userId;
    try {
      const userInfo = await client.users.info({ user: userId });
      userName = userInfo.user?.real_name || userInfo.user?.name || userId;
    } catch { /* fallback */ }

    // File attachments
    let media: IncomingMessage["media"] = undefined;
    if (event.files && event.files.length > 0) {
      media = this.parseSlackFile(event.files[0]);
    }

    const incoming: IncomingMessage = {
      platform: "slack",
      messageId,
      chatId: channelId,
      userId,
      userName,
      text,
      isGroup: true,
      isMention: true,
      isReplyToBot: false,
      media,
    };

    await this.handler(incoming);
  }

  private parseSlackFile(file: any): IncomingMessage["media"] | undefined {
    if (!file) return undefined;
    const mime = file.mimetype || "";

    if (mime.startsWith("image/")) {
      return { type: "photo", url: file.url_private, mimeType: mime, fileName: file.name };
    }
    if (mime.startsWith("audio/")) {
      return { type: "voice", url: file.url_private, mimeType: mime, fileName: file.name };
    }
    if (mime.startsWith("video/")) {
      return { type: "video" as any, url: file.url_private, mimeType: mime, fileName: file.name };
    }
    return { type: "document", url: file.url_private, mimeType: mime, fileName: file.name };
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<string | void> {
    if (!this.app) return;

    // Slack block limit is ~3000 chars for text blocks, message limit ~40000
    // But keep it practical — split at 3800 like Telegram
    const chunks = text.length > 3800
      ? text.match(/.{1,3800}/gs) || [text]
      : [text];

    let lastTs: string | undefined;
    for (const chunk of chunks) {
      const result = await this.app.client.chat.postMessage({
        token: this.botToken,
        channel: chatId,
        text: chunk,
        // Thread reply if replyTo is set
        ...(options?.replyTo ? { thread_ts: options.replyTo } : {}),
        // Convert markdown bold/italic to Slack mrkdwn
        mrkdwn: true,
      });
      if (result?.ts) lastTs = result.ts as string;
    }
    return lastTs;
  }

  /** Edit a previously-sent message (for progress tickers on long queries).
   *  Fail-silent: ticker UX shouldn't crash the query. */
  async editMessage(chatId: string, messageId: string, newText: string): Promise<string> {
    if (!this.app) return messageId;
    try {
      const safeText = newText.length > 3800 ? newText.slice(0, 3800) + "..." : newText;
      await this.app.client.chat.update({
        token: this.botToken,
        channel: chatId,
        ts: messageId,
        text: safeText,
        mrkdwn: true,
      });
    } catch {
      // Silent failure — ticker UX shouldn't crash the query
    }
    return messageId;
  }

  async sendPhoto(chatId: string, photo: Buffer | string, caption?: string): Promise<void> {
    if (!this.app) return;

    if (typeof photo === "string") {
      // File path
      await this.app.client.filesUploadV2({
        token: this.botToken,
        channel_id: chatId,
        file: fs.createReadStream(photo),
        filename: "image.png",
        initial_comment: caption,
      });
    } else {
      // Buffer
      await this.app.client.filesUploadV2({
        token: this.botToken,
        channel_id: chatId,
        file_uploads: [{
          file: photo,
          filename: "image.png",
        }],
        initial_comment: caption,
      });
    }
  }

  async sendDocument(chatId: string, doc: Buffer | string, fileName: string, caption?: string): Promise<void> {
    if (!this.app) return;

    if (typeof doc === "string") {
      await this.app.client.filesUploadV2({
        token: this.botToken,
        channel_id: chatId,
        file: fs.createReadStream(doc),
        filename: fileName,
        initial_comment: caption,
      });
    } else {
      await this.app.client.filesUploadV2({
        token: this.botToken,
        channel_id: chatId,
        file_uploads: [{
          file: doc,
          filename: fileName,
        }],
        initial_comment: caption,
      });
    }
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.app) return;
    try {
      // Slack emoji names don't include colons
      const name = emoji.replace(/^:|:$/g, "");
      await this.app.client.reactions.add({
        token: this.botToken,
        channel: chatId,
        timestamp: messageId,
        name,
      });
    } catch { /* ignore — emoji might not exist */ }
  }

  async setTyping(chatId: string): Promise<void> {
    if (!this.app) return;
    // v4.12.0 — Slack's official "is thinking" API for bots is
    // assistant.threads.setStatus which shows "Alvin is thinking…" under
    // the message. Only works in assistant-enabled channels (scope:
    // assistant:write) — silently no-ops in channels where the bot
    // isn't enabled as an assistant.
    try {
      await this.app.client.apiCall("assistant.threads.setStatus", {
        channel_id: chatId,
        status: "is thinking…",
      });
    } catch {
      // Not every channel supports assistant threads — that's fine
    }
  }

  /** v4.12.0 — Look up a Slack channel's name by ID, using a small in-memory
   *  cache. Used by platform-message.ts for workspace resolution. */
  async getChannelName(channelId: string): Promise<string | undefined> {
    if (!this.app) return undefined;
    const cached = this.channelNameCache.get(channelId);
    if (cached) return cached;
    try {
      const result = await this.app.client.conversations.info({
        token: this.botToken,
        channel: channelId,
      });
      const name = result?.channel?.name as string | undefined;
      if (name) {
        this.channelNameCache.set(channelId, name);
        return name;
      }
    } catch {
      // IM channels return channel_not_found here — that's expected
    }
    return undefined;
  }

  async stop(): Promise<void> {
    if (this.app) {
      try { await this.app.stop(); } catch { /* ignore */ }
      this.app = null;
    }
    _slackState.status = "disconnected";
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}
