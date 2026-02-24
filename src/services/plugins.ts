/**
 * Plugin System — Drop-in extensible capabilities.
 *
 * Plugins are loaded from the `plugins/` directory.
 * Each plugin is a directory with an `index.js` (or `index.ts` compiled) file
 * that exports a PluginDefinition.
 *
 * Plugin structure:
 *   plugins/
 *     weather/
 *       index.js          — Plugin entry (exports PluginDefinition)
 *       package.json      — Optional: dependencies
 *     finance/
 *       index.js
 *
 * Plugin API:
 *   - name: unique identifier
 *   - description: what the plugin does
 *   - version: semver
 *   - commands: Telegram commands the plugin registers
 *   - tools: Functions the AI can call
 *   - onMessage: Optional hook for every message
 *   - onInit/onDestroy: Lifecycle hooks
 */

import fs from "fs";
import path from "path";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Bot, Context } from "grammy";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGINS_DIR = resolve(BOT_ROOT, "plugins");

// ── Types ───────────────────────────────────────────────

export interface PluginCommand {
  /** Command name (without /) */
  command: string;
  /** Description for /help */
  description: string;
  /** Handler function */
  handler: (ctx: Context, args: string) => Promise<void>;
}

export interface PluginTool {
  /** Tool name (for AI function calling) */
  name: string;
  /** Tool description */
  description: string;
  /** JSON Schema for parameters */
  parameters: Record<string, unknown>;
  /** Tool execution function */
  execute: (params: Record<string, unknown>) => Promise<string>;
}

export interface PluginDefinition {
  /** Unique plugin name */
  name: string;
  /** Description */
  description: string;
  /** Semver version */
  version: string;
  /** Author (optional) */
  author?: string;
  /** Telegram commands this plugin provides */
  commands?: PluginCommand[];
  /** AI-callable tools this plugin provides */
  tools?: PluginTool[];
  /** Called when plugin is loaded */
  onInit?: () => Promise<void> | void;
  /** Called when plugin is unloaded */
  onDestroy?: () => Promise<void> | void;
  /** Hook: called for every incoming message (return true to stop propagation) */
  onMessage?: (ctx: Context, text: string) => Promise<boolean | void>;
}

// ── Plugin Registry ─────────────────────────────────────

const loadedPlugins = new Map<string, PluginDefinition>();

/**
 * Load all plugins from the plugins/ directory.
 */
export async function loadPlugins(): Promise<{ loaded: string[]; errors: Array<{ name: string; error: string }> }> {
  const loaded: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    return { loaded, errors };
  }

  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

    const pluginDir = resolve(PLUGINS_DIR, entry.name);
    const indexFile = resolve(pluginDir, "index.js");

    if (!fs.existsSync(indexFile)) {
      errors.push({ name: entry.name, error: "Missing index.js" });
      continue;
    }

    try {
      // Dynamic import
      const module = await import(`file://${indexFile}`);
      const definition: PluginDefinition = module.default || module;

      if (!definition.name) {
        errors.push({ name: entry.name, error: "Plugin has no name" });
        continue;
      }

      // Run init hook
      if (definition.onInit) {
        await definition.onInit();
      }

      loadedPlugins.set(definition.name, definition);
      loaded.push(definition.name);
      console.log(`✅ Plugin loaded: ${definition.name} v${definition.version}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ name: entry.name, error: msg });
      console.error(`❌ Plugin failed: ${entry.name} — ${msg}`);
    }
  }

  return { loaded, errors };
}

/**
 * Register all plugin commands with the bot.
 */
export function registerPluginCommands(bot: Bot): void {
  for (const [, plugin] of loadedPlugins) {
    if (!plugin.commands) continue;
    for (const cmd of plugin.commands) {
      bot.command(cmd.command, async (ctx) => {
        const args = ctx.match?.toString().trim() || "";
        await cmd.handler(ctx, args);
      });
    }
  }
}

/**
 * Run plugin message hooks.
 * Returns true if any plugin handled the message (stops propagation).
 */
export async function runPluginMessageHooks(ctx: Context, text: string): Promise<boolean> {
  for (const [, plugin] of loadedPlugins) {
    if (plugin.onMessage) {
      try {
        const handled = await plugin.onMessage(ctx, text);
        if (handled === true) return true;
      } catch (err) {
        console.error(`Plugin ${plugin.name} onMessage error:`, err);
      }
    }
  }
  return false;
}

/**
 * Get all registered plugin tools (for AI function calling).
 */
export function getPluginTools(): PluginTool[] {
  const tools: PluginTool[] = [];
  for (const [, plugin] of loadedPlugins) {
    if (plugin.tools) {
      tools.push(...plugin.tools);
    }
  }
  return tools;
}

/**
 * Execute a plugin tool by name.
 */
export async function executePluginTool(name: string, params: Record<string, unknown>): Promise<string> {
  for (const [, plugin] of loadedPlugins) {
    const tool = plugin.tools?.find(t => t.name === name);
    if (tool) {
      return tool.execute(params);
    }
  }
  throw new Error(`Plugin tool "${name}" not found`);
}

/**
 * Get loaded plugin info for /plugins command.
 */
export function getLoadedPlugins(): Array<{ name: string; description: string; version: string; commands: string[]; tools: string[] }> {
  const result: Array<{ name: string; description: string; version: string; commands: string[]; tools: string[] }> = [];
  for (const [, plugin] of loadedPlugins) {
    result.push({
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      commands: plugin.commands?.map(c => `/${c.command}`) || [],
      tools: plugin.tools?.map(t => t.name) || [],
    });
  }
  return result;
}

/**
 * Unload all plugins (for graceful shutdown).
 */
export async function unloadPlugins(): Promise<void> {
  for (const [name, plugin] of loadedPlugins) {
    try {
      if (plugin.onDestroy) await plugin.onDestroy();
      console.log(`Plugin unloaded: ${name}`);
    } catch (err) {
      console.error(`Plugin ${name} destroy error:`, err);
    }
  }
  loadedPlugins.clear();
}

/**
 * Get the plugins directory path (for documentation).
 */
export function getPluginsDir(): string {
  return PLUGINS_DIR;
}
