/**
 * Reminder Service — Simple in-memory reminder system.
 *
 * /remind 30m Call mom
 * /remind 2h Check deployment
 * /remind 1d Send invoice
 */

import type { Api } from "grammy";

interface Reminder {
  id: number;
  chatId: number;
  userId: number;
  text: string;
  createdAt: number;
  triggerAt: number;
  timer: ReturnType<typeof setTimeout>;
}

let nextId = 1;
const reminders = new Map<number, Reminder>();

/**
 * Parse a duration string like "30m", "2h", "1d", "90s" into milliseconds.
 */
export function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)s?$/i);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  const multipliers: Record<string, number> = {
    s: 1000, sec: 1000,
    m: 60_000, min: 60_000,
    h: 3_600_000, hr: 3_600_000,
    d: 86_400_000, day: 86_400_000,
  };

  return value * (multipliers[unit] || 60_000);
}

/**
 * Format milliseconds into a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} Min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)} Tage`;
}

/**
 * Create a reminder that fires after a delay.
 */
export function createReminder(
  chatId: number,
  userId: number,
  text: string,
  delayMs: number,
  api: Api,
): Reminder {
  const id = nextId++;
  const now = Date.now();

  const timer = setTimeout(async () => {
    try {
      await api.sendMessage(chatId, `⏰ *Erinnerung:* ${text}`, { parse_mode: "Markdown" });
    } catch (err) {
      console.error(`Failed to send reminder ${id}:`, err);
    }
    reminders.delete(id);
  }, delayMs);

  const reminder: Reminder = {
    id,
    chatId,
    userId,
    text,
    createdAt: now,
    triggerAt: now + delayMs,
    timer,
  };

  reminders.set(id, reminder);
  return reminder;
}

/**
 * List all pending reminders for a user.
 */
export function listReminders(userId: number): Array<{ id: number; text: string; triggerAt: number; remaining: string }> {
  const now = Date.now();
  return Array.from(reminders.values())
    .filter(r => r.userId === userId && r.triggerAt > now)
    .sort((a, b) => a.triggerAt - b.triggerAt)
    .map(r => ({
      id: r.id,
      text: r.text,
      triggerAt: r.triggerAt,
      remaining: formatDuration(r.triggerAt - now),
    }));
}

/**
 * Cancel a reminder by ID.
 */
export function cancelReminder(id: number, userId: number): boolean {
  const r = reminders.get(id);
  if (!r || r.userId !== userId) return false;
  clearTimeout(r.timer);
  reminders.delete(id);
  return true;
}

/**
 * Get count of pending reminders for a user.
 */
export function reminderCount(userId: number): number {
  return Array.from(reminders.values()).filter(r => r.userId === userId).length;
}
