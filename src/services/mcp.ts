/**
 * MCP (Model Context Protocol) Client — Connect to any MCP-compatible tool server.
 *
 * Supports:
 * - stdio transport (local processes)
 * - HTTP/SSE transport (remote servers)
 *
 * Configuration via docs/mcp.json:
 * {
 *   "servers": {
 *     "filesystem": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
 *       "env": {}
 *     },
 *     "remote-server": {
 *       "url": "https://mcp.example.com/sse",
 *       "headers": { "Authorization": "Bearer ..." }
 *     }
 *   }
 * }
 */

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MCP_CONFIG = resolve(BOT_ROOT, "docs", "mcp.json");

// ── Types ───────────────────────────────────────────────

interface MCPServerConfig {
  /** For stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** For HTTP/SSE transport */
  url?: string;
  headers?: Record<string, string>;
}

interface MCPConfig {
  servers: Record<string, MCPServerConfig>;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface MCPServer {
  name: string;
  config: MCPServerConfig;
  tools: MCPTool[];
  process?: ChildProcess;
  connected: boolean;
  requestId: number;
  pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>;
  buffer: string;
}

// ── MCP Client ──────────────────────────────────────────

const servers = new Map<string, MCPServer>();

/**
 * Load MCP configuration from docs/mcp.json.
 */
function loadConfig(): MCPConfig {
  try {
    const raw = fs.readFileSync(MCP_CONFIG, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { servers: {} };
  }
}

/**
 * Send a JSON-RPC message to a stdio MCP server.
 */
function sendMessage(server: MCPServer, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!server.process?.stdin?.writable) {
      reject(new Error(`Server ${server.name} not connected`));
      return;
    }

    const id = ++server.requestId;
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params || {},
    });

    server.pendingRequests.set(id, { resolve, reject });

    // Timeout after 30s
    setTimeout(() => {
      if (server.pendingRequests.has(id)) {
        server.pendingRequests.delete(id);
        reject(new Error(`Request ${id} timed out`));
      }
    }, 30000);

    server.process.stdin.write(message + "\n");
  });
}

/**
 * Handle incoming JSON-RPC responses from a stdio server.
 */
function handleResponse(server: MCPServer, line: string): void {
  try {
    const msg = JSON.parse(line);
    if (msg.id && server.pendingRequests.has(msg.id)) {
      const pending = server.pendingRequests.get(msg.id)!;
      server.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
    }
  } catch {
    // Not valid JSON — skip
  }
}

/**
 * Connect to a stdio MCP server.
 */
async function connectStdio(name: string, config: MCPServerConfig): Promise<MCPServer> {
  const server: MCPServer = {
    name,
    config,
    tools: [],
    connected: false,
    requestId: 0,
    pendingRequests: new Map(),
    buffer: "",
  };

  return new Promise((resolve, reject) => {
    const proc = spawn(config.command!, config.args || [], {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    server.process = proc;

    proc.stdout!.on("data", (data: Buffer) => {
      server.buffer += data.toString();
      const lines = server.buffer.split("\n");
      server.buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) handleResponse(server, line.trim());
      }
    });

    proc.stderr!.on("data", (data: Buffer) => {
      console.error(`MCP ${name} stderr:`, data.toString().trim());
    });

    proc.on("error", (err) => {
      console.error(`MCP ${name} process error:`, err);
      server.connected = false;
    });

    proc.on("close", (code) => {
      console.log(`MCP ${name} exited with code ${code}`);
      server.connected = false;
    });

    // Initialize the connection
    setTimeout(async () => {
      try {
        // Send initialize
        await sendMessage(server, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "alvin-bot", version: "2.2.0" },
        });

        // Send initialized notification
        server.process!.stdin!.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n");

        // List tools
        const result = await sendMessage(server, "tools/list") as { tools: MCPTool[] };
        server.tools = result?.tools || [];
        server.connected = true;

        console.log(`MCP ${name}: connected, ${server.tools.length} tools`);
        resolve(server);
      } catch (err) {
        reject(err);
      }
    }, 500);
  });
}

// ── Public API ──────────────────────────────────────────

/**
 * Initialize all configured MCP servers.
 */
export async function initMCP(): Promise<{ connected: string[]; errors: Array<{ name: string; error: string }> }> {
  const config = loadConfig();
  const connected: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const [name, serverConfig] of Object.entries(config.servers)) {
    try {
      if (serverConfig.command) {
        const server = await connectStdio(name, serverConfig);
        servers.set(name, server);
        connected.push(name);
      } else if (serverConfig.url) {
        // HTTP/SSE transport — not yet implemented
        errors.push({ name, error: "HTTP/SSE transport not yet supported" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ name, error: msg });
    }
  }

  return { connected, errors };
}

/**
 * Call a tool on an MCP server.
 */
export async function callMCPTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
  const server = servers.get(serverName);
  if (!server) throw new Error(`MCP server "${serverName}" not found`);
  if (!server.connected) throw new Error(`MCP server "${serverName}" not connected`);

  const result = await sendMessage(server, "tools/call", {
    name: toolName,
    arguments: args,
  }) as { content: Array<{ type: string; text?: string }> };

  // Extract text from content array
  const texts = (result?.content || [])
    .filter((c: { type: string }) => c.type === "text")
    .map((c: { text?: string }) => c.text || "");

  return texts.join("\n") || JSON.stringify(result);
}

/**
 * Get all available MCP tools across all servers.
 */
export function getMCPTools(): Array<{ server: string; name: string; description: string }> {
  const tools: Array<{ server: string; name: string; description: string }> = [];
  for (const [serverName, server] of servers) {
    for (const tool of server.tools) {
      tools.push({
        server: serverName,
        name: tool.name,
        description: tool.description,
      });
    }
  }
  return tools;
}

/**
 * Get MCP server status.
 */
export function getMCPStatus(): Array<{ name: string; connected: boolean; tools: number }> {
  const result: Array<{ name: string; connected: boolean; tools: number }> = [];
  for (const [name, server] of servers) {
    result.push({
      name,
      connected: server.connected,
      tools: server.tools.length,
    });
  }
  return result;
}

/**
 * Disconnect all MCP servers.
 */
export async function disconnectMCP(): Promise<void> {
  for (const [name, server] of servers) {
    try {
      if (server.process) {
        server.process.kill();
      }
      console.log(`MCP ${name} disconnected`);
    } catch (err) {
      console.error(`MCP ${name} disconnect error:`, err);
    }
  }
  servers.clear();
}

/**
 * Check if MCP config exists.
 */
export function hasMCPConfig(): boolean {
  return fs.existsSync(MCP_CONFIG);
}
