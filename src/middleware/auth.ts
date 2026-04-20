import fs from "fs";
import type { Context, NextFunction } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { APPROVED_USERS_FILE } from "../paths.js";
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
 * - DMs: controlled by AUTH_MODE env var
 *   - "allowlist" (default): only ALLOWED_USERS can interact
 *   - "pairing": unknown users get a 6-digit code, admin must approve
 *   - "open": all DMs allowed
 * - Groups: must be approved by admin + only respond to @mentions/replies
 * - New groups: sends approval request to admin, stays silent until approved
 * - Blocked groups: completely ignored
 * - Forwarded messages: can be disabled globally
 */

// ── Approved Users (persistent, for pairing mode) ──────────────────

function loadApprovedUsers(): number[] {
  try {
    const raw = fs.readFileSync(APPROVED_USERS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveApprovedUsers(ids: number[]): void {
  fs.writeFileSync(APPROVED_USERS_FILE, JSON.stringify(ids, null, 2));
}

export function addApprovedUser(userId: number): void {
  const current = loadApprovedUsers();
  if (!current.includes(userId)) {
    current.push(userId);
    saveApprovedUsers(current);
  }
}

export function isApprovedUser(userId: number): boolean {
  return loadApprovedUsers().includes(userId);
}

// ── Pending Pairings (in-memory) ────────────────────────────────────

interface PendingPairing {
  userId: number;
  username?: string;
  code: string;
  expiresAt: number;
}

const MAX_PENDING = 3;
const pendingPairings = new Map<string, PendingPairing>(); // code → pairing

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function cleanExpired(): void {
  const now = Date.now();
  for (const [code, pairing] of pendingPairings.entries()) {
    if (pairing.expiresAt <= now) {
      pendingPairings.delete(code);
    }
  }
}

/** Get a pending pairing by code. Returns undefined if not found or expired. */
export function getPendingPairing(code: string): PendingPairing | undefined {
  const pairing = pendingPairings.get(code);
  if (!pairing) return undefined;
  if (pairing.expiresAt <= Date.now()) {
    pendingPairings.delete(code);
    return undefined;
  }
  return pairing;
}

/** Remove a pending pairing by code. */
export function removePendingPairing(code: string): PendingPairing | undefined {
  const pairing = pendingPairings.get(code);
  pendingPairings.delete(code);
  return pairing;
}

// ── Middleware ───────────────────────────────────────────────────────

export async function authMiddleware(
  ctx: Context,
  next: NextFunction
): Promise<void> {
  const userId = ctx.from?.id;
  const chatType = ctx.chat?.type;
  const isGroup = chatType === "group" || chatType === "supergroup";

  // ── DM Auth ─────────────────────────────────────
  if (chatType === "private") {
    // "open" mode: allow everyone
    if (config.authMode === "open") {
      await next();
      return;
    }

    // Always allow configured users
    if (userId && config.allowedUsers.includes(userId)) {
      await next();
      return;
    }

    // "pairing" mode: unknown users go through code-based approval
    if (config.authMode === "pairing" && userId) {
      // Already approved via pairing?
      if (isApprovedUser(userId)) {
        await next();
        return;
      }

      // Check if user already has a pending pairing (avoid duplicate codes)
      cleanExpired();
      const existingEntry = [...pendingPairings.values()].find(p => p.userId === userId);
      if (existingEntry) {
        await ctx.reply(
          `Your approval request is still pending.\n\nYour code: \`${existingEntry.code}\`\n\nAsk the bot admin to approve it.`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      // Enforce max pending limit
      if (pendingPairings.size >= MAX_PENDING) {
        await ctx.reply("The approval queue is currently full. Please try again later.");
        return;
      }

      // Generate pairing code
      const code = generateCode();
      const pairing: PendingPairing = {
        userId,
        username: ctx.from?.username,
        code,
        expiresAt: Date.now() + 3_600_000, // 1 hour
      };
      pendingPairings.set(code, pairing);

      // Tell user their code
      await ctx.reply(
        `Hi! I need admin approval before we can chat.\n\nSend this code to the bot admin: \`${code}\``,
        { parse_mode: "Markdown" }
      );

      // Notify admin with approve/deny inline keyboard
      const adminId = config.allowedUsers[0];
      if (adminId) {
        const keyboard = new InlineKeyboard()
          .text("✅ Approve", `pair:approve:${code}`)
          .text("❌ Deny", `pair:deny:${code}`);

        const userTag = pairing.username ? `@${pairing.username}` : `ID ${userId}`;
        try {
          await ctx.api.sendMessage(
            adminId,
            `🔔 *New DM Pairing Request*\n\n` +
            `*User:* ${userTag}\n` +
            `*User ID:* \`${userId}\`\n` +
            `*Code:* \`${code}\`\n\n` +
            `Approve this user to chat with the bot?`,
            { parse_mode: "Markdown", reply_markup: keyboard }
          );
        } catch (err) {
          console.error("Failed to send pairing approval request:", err);
        }
      }

      return;
    }

    // Default "allowlist" mode (or pairing mode but no userId)
    console.log(`Unauthorized DM attempt from user ID: ${userId || "unknown"} (username: ${ctx.from?.username || "none"})`);
    await ctx.reply(
      `Hi! I'm not set up to chat with you yet.\n\nAsk my admin to add your user ID: ${userId || "unknown"}`
    );
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
            `🔔 *New group request*\n\n` +
            `*Gruppe:* ${chatTitle}\n` +
            `*Chat-ID:* \`${chatId}\`\n` +
            `*Added by:* ${userId}\n\n` +
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
