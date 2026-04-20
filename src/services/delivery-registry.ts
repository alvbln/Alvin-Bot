/**
 * v4.14 — Delivery registry for non-Telegram platforms.
 *
 * When the async-agent watcher completes a sub-agent and the pending
 * entry has a platform other than "telegram", it needs a way to send
 * the delivery message on that platform. Telegram continues to use the
 * existing grammy-bot pipeline (attachBotApi + subagent-delivery.ts).
 *
 * Slack/Discord/WhatsApp adapters register a minimal `DeliveryAdapter`
 * at startup from their platform module, and the watcher looks up the
 * right one via `getDeliveryAdapter(platform)`.
 *
 * Kept deliberately tiny — just sendText (primary use case) + optional
 * sendDocument (for long outputs, file-upload path). No live-stream
 * mode for non-Telegram platforms yet; the background agent delivery
 * path is the only consumer.
 */
export type DeliveryPlatform = "slack" | "discord" | "whatsapp" | "telegram";

export interface DeliveryAdapter {
  platform: DeliveryPlatform;
  /** Send a plain text message. chatId is a string for slack/discord/
   *  whatsapp (channel ID / recipient); number/string accepted for
   *  Telegram too so the interface is uniform. */
  sendText: (chatId: string | number, text: string) => Promise<void>;
  /** Optional — upload a text file for very long outputs. */
  sendDocument?: (
    chatId: string | number,
    content: Buffer,
    filename: string,
  ) => Promise<void>;
}

const adapters = new Map<DeliveryPlatform, DeliveryAdapter>();

/**
 * Register (or replace) an adapter for a platform. Idempotent —
 * registering the same platform twice replaces the previous entry
 * (handles platform-module reload during dev).
 */
export function registerDeliveryAdapter(adapter: DeliveryAdapter): void {
  adapters.set(adapter.platform, adapter);
}

/** Look up the adapter for a platform. Returns null if not registered. */
export function getDeliveryAdapter(
  platform: string,
): DeliveryAdapter | null {
  return adapters.get(platform as DeliveryPlatform) ?? null;
}

/** List all registered adapters — used for /status and diagnostics. */
export function listDeliveryAdapters(): DeliveryAdapter[] {
  return [...adapters.values()];
}

/** Test-only — reset the registry between tests. */
export function __resetForTest(): void {
  adapters.clear();
}
