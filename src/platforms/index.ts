/**
 * Platform Manager — Load and manage multiple platform adapters.
 *
 * Automatically detects which platforms are configured (based on env vars)
 * and starts the appropriate adapters.
 *
 * Env vars:
 * - BOT_TOKEN → Telegram (always active if set)
 * - DISCORD_TOKEN → Discord
 * - WHATSAPP_ENABLED=true → WhatsApp (QR code scan required)
 * - SIGNAL_API_URL + SIGNAL_NUMBER → Signal
 */

import type { PlatformAdapter, IncomingMessage, MessageHandler } from "./types.js";

export type { PlatformAdapter, IncomingMessage, MessageHandler, SendOptions } from "./types.js";

const adapters = new Map<string, PlatformAdapter>();

/**
 * Register a platform adapter.
 */
export function registerAdapter(adapter: PlatformAdapter): void {
  adapters.set(adapter.platform, adapter);
}

/**
 * Get a specific adapter by platform name.
 */
export function getAdapter(platform: string): PlatformAdapter | undefined {
  return adapters.get(platform);
}

/**
 * Get all registered adapters.
 */
export function getAllAdapters(): PlatformAdapter[] {
  return Array.from(adapters.values());
}

/**
 * Get platform status for dashboard.
 */
export function getPlatformStatus(): Array<{ platform: string; active: boolean }> {
  return Array.from(adapters.entries()).map(([name, _]) => ({
    platform: name,
    active: true,
  }));
}

/**
 * Auto-detect and load platform adapters based on env vars.
 * Returns list of loaded platforms.
 */
export async function autoLoadPlatforms(): Promise<string[]> {
  const loaded: string[] = [];

  // Discord
  const discordToken = process.env.DISCORD_TOKEN;
  if (discordToken) {
    try {
      const { DiscordAdapter } = await import("./discord.js");
      const adapter = new DiscordAdapter(discordToken);
      registerAdapter(adapter);
      loaded.push("discord");
    } catch (err) {
      console.error("Discord adapter failed to load:", err);
    }
  }

  // WhatsApp
  if (process.env.WHATSAPP_ENABLED === "true") {
    try {
      const { WhatsAppAdapter } = await import("./whatsapp.js");
      const adapter = new WhatsAppAdapter();
      registerAdapter(adapter);
      loaded.push("whatsapp");
    } catch (err) {
      console.error("WhatsApp adapter failed to load:", err);
    }
  }

  // Signal
  const signalUrl = process.env.SIGNAL_API_URL;
  const signalNumber = process.env.SIGNAL_NUMBER;
  if (signalUrl && signalNumber) {
    try {
      const { SignalAdapter } = await import("./signal.js");
      const adapter = new SignalAdapter(signalUrl, signalNumber);
      registerAdapter(adapter);
      loaded.push("signal");
    } catch (err) {
      console.error("Signal adapter failed to load:", err);
    }
  }

  return loaded;
}

/**
 * Start all registered adapters.
 */
export async function startAllAdapters(messageHandler: MessageHandler): Promise<void> {
  for (const [name, adapter] of adapters) {
    try {
      adapter.onMessage(messageHandler);
      await adapter.start();
    } catch (err) {
      console.error(`Failed to start ${name} adapter:`, err);
    }
  }
}

/**
 * Stop all adapters.
 */
export async function stopAllAdapters(): Promise<void> {
  for (const [name, adapter] of adapters) {
    try {
      await adapter.stop();
      console.log(`${name} adapter stopped`);
    } catch (err) {
      console.error(`Failed to stop ${name}:`, err);
    }
  }
}
