/**
 * Custom Tool Registration — Users define their own tools via config.
 *
 * Configuration via docs/tools.json:
 * {
 *   "tools": [
 *     {
 *       "name": "deploy_app",
 *       "description": "Deploy the application",
 *       "command": "ssh server 'cd /app && git pull && pm2 restart all'",
 *       "timeout": 30000
 *     },
 *     {
 *       "name": "check_server",
 *       "description": "Check server status",
 *       "type": "http",
 *       "url": "https://api.example.com/health",
 *       "method": "GET",
 *       "headers": { "Authorization": "Bearer ..." }
 *     },
 *     {
 *       "name": "quick_note",
 *       "description": "Send a quick Telegram command",
 *       "command": "echo '{{text}}' >> ~/notes.txt",
 *       "parameters": {
 *         "text": { "type": "string", "description": "Note text" }
 *       }
 *     }
 *   ]
 * }
 */

import fs from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS_CONFIG = resolve(BOT_ROOT, "docs", "tools.json");

// ── Types ───────────────────────────────────────────────

interface CustomToolDef {
  /** Tool name */
  name: string;
  /** Description */
  description: string;
  /** For shell-command tools */
  command?: string;
  /** For HTTP tools */
  type?: "shell" | "http";
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Parameter definitions (for template substitution) */
  parameters?: Record<string, { type: string; description: string; required?: boolean }>;
  /** Timeout in ms */
  timeout?: number;
}

interface ToolsConfig {
  tools: CustomToolDef[];
}

// ── Config Loading ──────────────────────────────────────

function loadToolsConfig(): ToolsConfig {
  try {
    const raw = fs.readFileSync(TOOLS_CONFIG, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { tools: [] };
  }
}

// ── Template Substitution ───────────────────────────────

function substituteParams(template: string, params: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
  }
  return result;
}

// ── Execution ───────────────────────────────────────────

async function executeShellTool(tool: CustomToolDef, params: Record<string, unknown>): Promise<string> {
  if (!tool.command) throw new Error("No command defined");
  const cmd = substituteParams(tool.command, params);

  try {
    const result = execSync(cmd, {
      stdio: "pipe",
      timeout: tool.timeout || 30000,
      env: process.env,
    });
    return result.toString().trim() || "(no output)";
  } catch (err: unknown) {
    const error = err as { stderr?: Buffer; message: string };
    throw new Error(error.stderr?.toString()?.trim() || error.message);
  }
}

async function executeHttpTool(tool: CustomToolDef, params: Record<string, unknown>): Promise<string> {
  if (!tool.url) throw new Error("No URL defined");

  const url = substituteParams(tool.url, params);
  const method = tool.method || "GET";
  const headers: Record<string, string> = {};

  if (tool.headers) {
    for (const [key, value] of Object.entries(tool.headers)) {
      headers[key] = substituteParams(value, params);
    }
  }

  const fetchOpts: RequestInit = { method, headers };
  if (tool.body && method !== "GET") {
    fetchOpts.body = substituteParams(tool.body, params);
    if (!headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), tool.timeout || 30000);
  fetchOpts.signal = controller.signal;

  try {
    const response = await fetch(url, fetchOpts);
    clearTimeout(timeoutId);
    const text = await response.text();
    return `HTTP ${response.status}: ${text.slice(0, 2000)}`;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ── Public API ──────────────────────────────────────────

/**
 * Get all custom tools for display/registration.
 */
export function getCustomTools(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  const config = loadToolsConfig();
  return config.tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters || {},
  }));
}

/**
 * Execute a custom tool by name.
 */
export async function executeCustomTool(name: string, params: Record<string, unknown>): Promise<string> {
  const config = loadToolsConfig();
  const tool = config.tools.find(t => t.name === name);
  if (!tool) throw new Error(`Custom tool "${name}" not found`);

  const type = tool.type || (tool.url ? "http" : "shell");

  switch (type) {
    case "http":
      return executeHttpTool(tool, params);
    case "shell":
    default:
      return executeShellTool(tool, params);
  }
}

/**
 * List custom tools for the /tools command.
 */
export function listCustomTools(): Array<{ name: string; description: string; type: string }> {
  const config = loadToolsConfig();
  return config.tools.map(t => ({
    name: t.name,
    description: t.description,
    type: t.type || (t.url ? "http" : "shell"),
  }));
}

/**
 * Check if custom tools config exists.
 */
export function hasCustomTools(): boolean {
  return fs.existsSync(TOOLS_CONFIG);
}
