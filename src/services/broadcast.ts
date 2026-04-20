/**
 * In-process Broadcast Bus — Telegram Activity Mirror (v4.5.0+)
 *
 * A tiny typed EventEmitter that lets the Telegram handler announce every
 * user message, every streaming response delta, and every "response done"
 * event. The web server subscribes to the same bus and forwards each event
 * to all connected WebSocket clients as `mirror:*` messages.
 *
 * The TUI (and Web UI) can then show the full Telegram conversation in
 * real time, side-by-side with its own isolated chat session.
 *
 * Design constraints:
 *   - Zero backpressure: events are fire-and-forget, listeners must be fast
 *   - No memory retention: no history is buffered here, just live pub/sub
 *   - Platform-agnostic signature so we can later mirror WhatsApp/Signal too
 *   - Does not touch the Claude Agent SDK or any provider internals — this
 *     is a pure observation layer
 */

import { EventEmitter } from "events";

// ── Event Payload Types ────────────────────────────────────────────────────

export interface BroadcastUserMessage {
  /** The platform the message came from (telegram, whatsapp, etc.) */
  platform: "telegram" | "whatsapp" | "discord" | "signal" | "web";
  /** User id within the platform */
  userId: string | number;
  /** Display name or username if available */
  userName?: string;
  /** Chat/conversation id — same chat can have multiple users (groups) */
  chatId: string | number;
  /** The raw text the user sent */
  text: string;
  /** Absolute timestamp in ms */
  ts: number;
}

export interface BroadcastResponseStart {
  platform: BroadcastUserMessage["platform"];
  chatId: string | number;
  userId: string | number;
  ts: number;
}

export interface BroadcastResponseDelta {
  platform: BroadcastUserMessage["platform"];
  chatId: string | number;
  userId: string | number;
  delta: string;
  ts: number;
}

export interface BroadcastResponseDone {
  platform: BroadcastUserMessage["platform"];
  chatId: string | number;
  userId: string | number;
  finalText: string;
  cost?: number;
  ts: number;
}

// ── The Bus ────────────────────────────────────────────────────────────────

type Events = {
  "user_msg":       [BroadcastUserMessage];
  "response_start": [BroadcastResponseStart];
  "response_delta": [BroadcastResponseDelta];
  "response_done":  [BroadcastResponseDone];
};

class TypedBus extends EventEmitter {
  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    return super.emit(event, ...args);
  }
  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    return super.on(event, listener);
  }
  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    return super.off(event, listener);
  }
}

/**
 * Singleton bus. Import and call methods directly — no need for a factory.
 *
 * EventEmitter default maxListeners is 10; we bump it because a single
 * web server connection may subscribe many listeners (one per connected
 * WS client on a busy day).
 */
export const broadcast = new TypedBus();
broadcast.setMaxListeners(100);

// ── Convenience Emitters ───────────────────────────────────────────────────

export function emitUserMessage(payload: BroadcastUserMessage): void {
  broadcast.emit("user_msg", payload);
}

export function emitResponseStart(payload: BroadcastResponseStart): void {
  broadcast.emit("response_start", payload);
}

export function emitResponseDelta(payload: BroadcastResponseDelta): void {
  broadcast.emit("response_delta", payload);
}

export function emitResponseDone(payload: BroadcastResponseDone): void {
  broadcast.emit("response_done", payload);
}
