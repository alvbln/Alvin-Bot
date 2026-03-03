/**
 * Custom Tool Registration — Users define their own tools via Markdown.
 *
 * Configuration via TOOLS.md (Markdown format):
 *
 * ## tool_name
 * Tool description (first line after heading)
 * ```
 * shell command here
 * ```
 * **Type:** http (optional, default: shell)
 * **URL:** https://example.com/api (for HTTP tools)
 * **Method:** GET|POST|PUT|DELETE (default: GET)
 * **Headers:** Key: Value (one per line)
 * **Body:** request body
 * **Timeout:** 30s, 5m, or milliseconds
 * **Parameters:**
 * - `name` (type, required): description
 *
 * Legacy: Also supports docs/tools.json as fallback.
 */

import fs from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { isSelfRestartCommand, scheduleGracefulRestart } from "./restart.js";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS_MD = resolve(BOT_ROOT, "TOOLS.md");
const TOOLS_MD_EXAMPLE = resolve(BOT_ROOT, "TOOLS.example.md");
const TOOLS_JSON = resolve(BOT_ROOT, "docs", "tools.json");
const TOOLS_JSON_EXAMPLE = resolve(BOT_ROOT, "docs", "tools.example.json");

// Auto-initialize TOOLS.md from example if missing (prefer MD over JSON)
if (!fs.existsSync(TOOLS_MD) && fs.existsSync(TOOLS_MD_EXAMPLE)) {
  fs.copyFileSync(TOOLS_MD_EXAMPLE, TOOLS_MD);
}
// Legacy fallback: also init tools.json if someone depends on it
if (!fs.existsSync(TOOLS_JSON) && fs.existsSync(TOOLS_JSON_EXAMPLE)) {
  fs.copyFileSync(TOOLS_JSON_EXAMPLE, TOOLS_JSON);
}

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

// ── Markdown Parser ─────────────────────────────────────

function parseTimeout(value: string): number {
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!match) return 30000;
  const num = parseFloat(match[1]);
  switch (match[2]) {
    case "h": return num * 3600000;
    case "m": return num * 60000;
    case "s": return num * 1000;
    case "ms": return num;
    default: return num > 1000 ? num : num * 1000; // bare number: assume seconds if small
  }
}

function parseToolsMd(content: string): CustomToolDef[] {
  const tools: CustomToolDef[] = [];
  // Split by ## headings (tool boundaries)
  const sections = content.split(/^## /m).slice(1); // skip preamble before first ##

  for (const section of sections) {
    const lines = section.split("\n");
    const name = lines[0].trim().replace(/\s+/g, "_").toLowerCase();
    if (!name) continue;

    const tool: CustomToolDef = { name, description: "" };

    // First non-empty line after heading = description
    let i = 1;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i < lines.length && !lines[i].startsWith("```") && !lines[i].startsWith("**")) {
      tool.description = lines[i].trim();
      i++;
    }

    // Parse remaining lines
    let inCodeBlock = false;
    let codeLines: string[] = [];
    let inHeaders = false;
    const headerLines: string[] = [];
    let inParams = false;
    const paramEntries: Array<{ name: string; type: string; description: string; required: boolean }> = [];

    for (; i < lines.length; i++) {
      const line = lines[i];

      // Code block (command)
      if (line.startsWith("```")) {
        if (inCodeBlock) {
          tool.command = codeLines.join("\n").trim();
          inCodeBlock = false;
          codeLines = [];
        } else {
          inCodeBlock = true;
        }
        continue;
      }
      if (inCodeBlock) {
        codeLines.push(line);
        continue;
      }

      // Bold-key fields: **Key:** value
      const boldMatch = line.match(/^\*\*(\w[\w\s]*):\*\*\s*(.*)/);
      if (boldMatch) {
        const key = boldMatch[1].trim().toLowerCase();
        const value = boldMatch[2].trim();

        // End previous multi-line sections
        if (key !== "headers") inHeaders = false;
        if (key !== "parameters") inParams = false;

        switch (key) {
          case "type":
            tool.type = value.toLowerCase() as "shell" | "http";
            break;
          case "url":
            tool.url = value;
            break;
          case "method":
            tool.method = value.toUpperCase();
            break;
          case "headers":
            inHeaders = true;
            if (value) headerLines.push(value);
            break;
          case "body":
            tool.body = value;
            break;
          case "timeout":
            tool.timeout = parseTimeout(value);
            break;
          case "parameters":
            inParams = true;
            break;
        }
        continue;
      }

      // Header continuation lines (Key: Value)
      if (inHeaders && line.match(/^\s*-?\s*\S+:\s/)) {
        headerLines.push(line.replace(/^\s*-?\s*/, "").trim());
        continue;
      } else if (inHeaders && line.trim()) {
        inHeaders = false;
      }

      // Parameter entries: - `name` (type, required): description
      if (inParams && line.match(/^\s*-\s*`/)) {
        const paramMatch = line.match(/^\s*-\s*`(\w+)`\s*\(([^)]+)\)\s*:?\s*(.*)/);
        if (paramMatch) {
          const pName = paramMatch[1];
          const pMeta = paramMatch[2];
          const pDesc = paramMatch[3].trim();
          const parts = pMeta.split(",").map(s => s.trim().toLowerCase());
          const pType = parts.find(p => ["string", "number", "boolean", "integer"].includes(p)) || "string";
          const pRequired = parts.includes("required");
          paramEntries.push({ name: pName, type: pType, description: pDesc, required: pRequired });
        }
        continue;
      } else if (inParams && line.trim() && !line.startsWith(" ")) {
        inParams = false;
      }
    }

    // Assemble headers
    if (headerLines.length > 0) {
      tool.headers = {};
      for (const h of headerLines) {
        const colonIdx = h.indexOf(":");
        if (colonIdx > 0) {
          tool.headers[h.slice(0, colonIdx).trim()] = h.slice(colonIdx + 1).trim();
        }
      }
    }

    // Assemble parameters
    if (paramEntries.length > 0) {
      tool.parameters = {};
      for (const p of paramEntries) {
        tool.parameters[p.name] = { type: p.type, description: p.description, required: p.required };
      }
    }

    tools.push(tool);
  }

  return tools;
}

// ── Config Loading ──────────────────────────────────────

function loadToolsConfig(): ToolsConfig {
  // Prefer TOOLS.md (Markdown format)
  if (fs.existsSync(TOOLS_MD)) {
    try {
      const content = fs.readFileSync(TOOLS_MD, "utf-8");
      const tools = parseToolsMd(content);
      return { tools };
    } catch {
      // Fall through to JSON
    }
  }

  // Legacy fallback: docs/tools.json
  if (fs.existsSync(TOOLS_JSON)) {
    try {
      const raw = fs.readFileSync(TOOLS_JSON, "utf-8");
      return JSON.parse(raw);
    } catch {
      // ignore
    }
  }

  return { tools: [] };
}

/**
 * Get the path of the active tools config file.
 */
export function getToolsConfigPath(): string {
  if (fs.existsSync(TOOLS_MD)) return TOOLS_MD;
  return TOOLS_JSON;
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

  // Intercept self-restart: use graceful internal restart instead of pm2 kill
  if (isSelfRestartCommand(cmd)) {
    scheduleGracefulRestart();
    return "Bot restart scheduled. Grammy will commit the Telegram offset before exiting.";
  }

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
  return fs.existsSync(TOOLS_MD) || fs.existsSync(TOOLS_JSON);
}
