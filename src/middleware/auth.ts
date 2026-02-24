import type { Context, NextFunction } from "grammy";
import { config } from "../config.js";

/**
 * Auth + Group Chat middleware.
 *
 * - DMs: only allowed users can interact
 * - Groups: allowed users can interact, but bot only responds when:
 *   - Mentioned (@botname)
 *   - Replied to (user replies to a bot message)
 *   - Command (starts with /)
 */
export async function authMiddleware(
  ctx: Context,
  next: NextFunction
): Promise<void> {
  const userId = ctx.from?.id;

  // Auth check: only allowed users
  if (!userId || !config.allowedUsers.includes(userId)) {
    // In groups: silently ignore unauthorized users
    if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") return;
    await ctx.reply("Zugriff verweigert.");
    return;
  }

  // In DMs: always process
  if (ctx.chat?.type === "private") {
    await next();
    return;
  }

  // In groups: check if bot should respond
  const message = ctx.message;
  if (!message) {
    await next(); // callback queries, etc.
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
    // Strip the @mention from the text for cleaner processing
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

  // Otherwise: ignore in groups (don't respond to every message)
}
