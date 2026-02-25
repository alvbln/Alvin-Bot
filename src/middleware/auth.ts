import type { Context, NextFunction } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../config.js";
import {
  getGroupStatus,
  registerGroup,
  trackGroupMessage,
  isForwardingAllowed,
} from "../services/access.js";

/**
 * Auth + Group Chat + Access Control middleware.
 *
 * Security model:
 * - DMs: only ALLOWED_USERS can interact
 * - Groups: must be approved by admin + only respond to @mentions/replies
 * - New groups: sends approval request to admin, stays silent until approved
 * - Blocked groups: completely ignored
 * - Forwarded messages: can be disabled globally
 */
export async function authMiddleware(
  ctx: Context,
  next: NextFunction
): Promise<void> {
  const userId = ctx.from?.id;
  const chatType = ctx.chat?.type;
  const isGroup = chatType === "group" || chatType === "supergroup";

  // ── DM Auth ─────────────────────────────────────
  if (chatType === "private") {
    if (!userId || !config.allowedUsers.includes(userId)) {
      await ctx.reply("Zugriff verweigert.");
      return;
    }
    await next();
    return;
  }

  // ── Group Access Control ────────────────────────
  if (isGroup) {
    const chatId = ctx.chat!.id;
    const chatTitle = ctx.chat && "title" in ctx.chat ? (ctx.chat as { title?: string }).title || "Unknown" : "Unknown";

    // Check group approval status
    const status = getGroupStatus(chatId);

    if (status === "blocked") {
      return; // Completely ignore blocked groups
    }

    if (status === "new") {
      // Register and request approval from admin
      registerGroup(chatId, chatTitle, userId);

      // Notify the first allowed user (admin) about the new group
      const adminId = config.allowedUsers[0];
      if (adminId) {
        const keyboard = new InlineKeyboard()
          .text("✅ Approve", `access:approve:${chatId}`)
          .text("❌ Block", `access:block:${chatId}`);

        try {
          await ctx.api.sendMessage(
            adminId,
            `🔔 *Neue Gruppenanfrage*\n\n` +
            `*Gruppe:* ${chatTitle}\n` +
            `*Chat-ID:* \`${chatId}\`\n` +
            `*Hinzugefügt von:* ${userId}\n\n` +
            `Soll Alvin Bot in dieser Gruppe antworten?`,
            { parse_mode: "Markdown", reply_markup: keyboard }
          );
        } catch (err) {
          console.error("Failed to send group approval request:", err);
        }
      }
      return; // Don't respond until approved
    }

    if (status === "pending") {
      return; // Still waiting for approval
    }

    // status === "approved" — continue with group logic

    // Only allowed users can trigger the bot in groups
    if (!userId || !config.allowedUsers.includes(userId)) {
      return; // Silently ignore unauthorized users
    }

    trackGroupMessage(chatId);

    const message = ctx.message;
    if (!message) {
      await next(); // callback queries
      return;
    }

    // Commands always go through
    if (message.text?.startsWith("/")) {
      await next();
      return;
    }

    // Check if bot is mentioned
    const botUsername = ctx.me?.username?.toLowerCase();
    const text = message.text || message.caption || "";
    if (botUsername && text.toLowerCase().includes(`@${botUsername}`)) {
      if (message.text) {
        (message as { text: string }).text = message.text.replace(
          new RegExp(`@${botUsername}`, "gi"), ""
        ).trim();
      }
      await next();
      return;
    }

    // Check if replying to a bot message
    if (message.reply_to_message?.from?.id === ctx.me?.id) {
      await next();
      return;
    }

    // Otherwise: ignore in groups
    return;
  }

  // ── Callback queries (inline keyboards) ─────────
  await next();
}
