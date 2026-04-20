/**
 * Delivery Queue — Reliable message delivery with retry + exponential backoff.
 *
 * Instead of fire-and-forget sends, messages are enqueued and processed
 * on a 30s interval. Failed deliveries are retried with exponential backoff
 * (10s, 30s, 90s, 270s, 810s). Persisted to ~/.alvin-bot/delivery-queue.json.
 */

import fs from "fs";
import crypto from "crypto";
import { DELIVERY_QUEUE_FILE } from "../paths.js";

// ── Types ───────────────────────────────────────────────

export interface QueueEntry {
  id: string;           // UUID
  channel: string;      // "telegram" | "whatsapp" | "discord" | "signal"
  chatId: string;       // Target chat ID (as string)
  content: string;      // Message text
  mediaPath?: string;   // Optional media attachment
  createdAt: number;    // timestamp
  attempts: number;     // delivery attempts so far
  lastAttempt: number;  // timestamp of last attempt
  maxAttempts: number;  // default 5
  status: "pending" | "delivered" | "failed";
  error?: string;       // last error message
}

type SenderFn = (chatId: string, content: string, mediaPath?: string) => Promise<void>;

// ── State ───────────────────────────────────────────────

let senders: Record<string, SenderFn> = {};

// ── File I/O ────────────────────────────────────────────

function readQueue(): QueueEntry[] {
  try {
    const raw = fs.readFileSync(DELIVERY_QUEUE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (fs.existsSync(DELIVERY_QUEUE_FILE)) {
      console.error("Delivery queue: failed to parse queue file, starting fresh:", err);
    }
    return [];
  }
}

function writeQueue(entries: QueueEntry[]): void {
  const tmp = DELIVERY_QUEUE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, DELIVERY_QUEUE_FILE);
}

// ── Backoff ─────────────────────────────────────────────

function getBackoffMs(attempts: number): number {
  return Math.min(10000 * Math.pow(3, attempts), 810000);
}

// ── Public API ──────────────────────────────────────────

/**
 * Register send functions for each platform.
 * Must be called before processQueue() can deliver anything.
 */
export function setSenders(newSenders: Record<string, SenderFn>): void {
  senders = { ...senders, ...newSenders };
}

/**
 * Enqueue a message for reliable delivery.
 * Writes immediately to disk and returns the entry ID.
 */
export function enqueue(
  channel: string,
  chatId: string,
  content: string,
  options?: { mediaPath?: string; maxAttempts?: number }
): string {
  const id = crypto.randomUUID();
  const entry: QueueEntry = {
    id,
    channel,
    chatId,
    content,
    mediaPath: options?.mediaPath,
    createdAt: Date.now(),
    attempts: 0,
    lastAttempt: 0,
    maxAttempts: options?.maxAttempts ?? 5,
    status: "pending",
  };

  const queue = readQueue();
  queue.push(entry);
  writeQueue(queue);

  return id;
}

/**
 * Process all pending entries in the queue.
 * Respects exponential backoff and max attempts.
 * Returns counts of delivered, failed, and still-pending entries.
 */
export async function processQueue(): Promise<{ delivered: number; failed: number; pending: number }> {
  const queue = readQueue();
  const now = Date.now();
  let delivered = 0;
  let failed = 0;
  let pending = 0;
  let modified = false;

  for (const entry of queue) {
    if (entry.status !== "pending") continue;

    // Check backoff — skip if too soon since last attempt
    if (entry.attempts > 0) {
      const backoff = getBackoffMs(entry.attempts);
      if (now - entry.lastAttempt < backoff) {
        pending++;
        continue;
      }
    }

    // Check if we have a sender for this channel
    const sender = senders[entry.channel];
    if (!sender) {
      // No sender registered — leave pending, don't count as attempt
      pending++;
      continue;
    }

    // Attempt delivery
    try {
      await sender(entry.chatId, entry.content, entry.mediaPath);
      entry.status = "delivered";
      entry.attempts++;
      entry.lastAttempt = now;
      delivered++;
      modified = true;
    } catch (err) {
      entry.attempts++;
      entry.lastAttempt = now;
      entry.error = err instanceof Error ? err.message : String(err);
      modified = true;

      if (entry.attempts >= entry.maxAttempts) {
        entry.status = "failed";
        failed++;
        console.error(`Delivery failed permanently [${entry.channel}:${entry.chatId}]: ${entry.error} (${entry.attempts} attempts)`);
      } else {
        pending++;
        const nextBackoff = getBackoffMs(entry.attempts);
        console.warn(`Delivery retry scheduled [${entry.channel}:${entry.chatId}]: attempt ${entry.attempts}/${entry.maxAttempts}, next in ${Math.round(nextBackoff / 1000)}s`);
      }
    }
  }

  if (modified) {
    writeQueue(queue);
  }

  return { delivered, failed, pending };
}

/**
 * Get counts by status for monitoring.
 */
export function getQueueStatus(): { pending: number; delivered: number; failed: number; total: number } {
  const queue = readQueue();
  const pending = queue.filter(e => e.status === "pending").length;
  const delivered = queue.filter(e => e.status === "delivered").length;
  const failed = queue.filter(e => e.status === "failed").length;
  return { pending, delivered, failed, total: queue.length };
}

/**
 * Remove old entries: delivered > 24h, failed > 7d.
 */
export function cleanupQueue(): void {
  const queue = readQueue();
  const now = Date.now();
  const DAY = 86400000;

  const cleaned = queue.filter(entry => {
    if (entry.status === "delivered" && now - entry.lastAttempt > DAY) return false;
    if (entry.status === "failed" && now - entry.lastAttempt > 7 * DAY) return false;
    return true;
  });

  if (cleaned.length !== queue.length) {
    writeQueue(cleaned);
  }
}
