/**
 * Web Server — Local dashboard for Alvin Bot.
 *
 * Provides:
 * - Static file serving (web/public/)
 * - WebSocket for real-time chat + streaming
 * - REST API for settings, memory, sessions, etc.
 * - Simple password auth (WEB_PASSWORD env var)
 */

import http from "http";
import fs from "fs";
import path from "path";
import { resolve } from "path";
import { execSync } from "child_process";
import { WebSocketServer, WebSocket } from "ws";
import { getRegistry } from "../engine.js";
import { getSession, resetSession, getAllSessions } from "../services/session.js";
import { getMemoryStats, loadLongTermMemory, loadDailyLog, appendDailyLog } from "../services/memory.js";
import { getIndexStats } from "../services/embeddings.js";
import { getLoadedPlugins } from "../services/plugins.js";
import { getMCPStatus } from "../services/mcp.js";
import { listProfiles } from "../services/users.js";
import { listCustomTools, getCustomTools, executeCustomTool } from "../services/custom-tools.js";
import { buildSystemPrompt, reloadSoul, getSoulContent } from "../services/personality.js";
import { config } from "../config.js";
import type { QueryOptions, StreamChunk } from "../providers/types.js";
import { handleSetupAPI } from "./setup-api.js";
import { handleDoctorAPI } from "./doctor-api.js";
import { handleOpenAICompat } from "./openai-compat.js";
import { addCanvasClient } from "./canvas.js";
import { BOT_ROOT, ENV_FILE, PUBLIC_DIR, MEMORY_DIR, MEMORY_FILE, SOUL_FILE, DATA_DIR, MCP_CONFIG, SKILLS_DIR } from "../paths.js";
import { writeSecure } from "../services/file-permissions.js";
import { timingSafeBearerMatch } from "../services/timing-safe-bearer.js";
import { broadcast } from "../services/broadcast.js";
import { BOT_VERSION } from "../version.js";
import { decideNextBindAction } from "./bind-strategy.js";

const WEB_PORT = parseInt(process.env.WEB_PORT || "3100");

/** Tuning for the bind loop. Walk the port ladder `MAX_PORT_TRIES` times
 *  then fall back to a `BACKGROUND_RETRY_MS` idle loop — the bot keeps
 *  running on Telegram either way; see bind-strategy.ts for the pure
 *  decision logic. */
const MAX_PORT_TRIES = 20;
const BACKGROUND_RETRY_MS = 30_000;

/** Current live http.Server, if one has successfully bound. */
let currentServer: http.Server | null = null;

/** Current live WebSocketServer attached to currentServer. */
let wsServerRef: WebSocketServer | null = null;

/** Background-retry timer handle — set when the bind loop is in its
 *  idle wait between cycles, cleared when stopWebServer() cancels. */
let bindRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** Flag flipped by stopWebServer(). Every bind-loop callback checks
 *  this and exits silently if set, so stop is truly terminal. */
let stopRequested = false;
const WEB_PASSWORD = process.env.WEB_PASSWORD || "";

/** The actual port the Web UI is running on (may differ from WEB_PORT if busy). */
let actualWebPort = WEB_PORT;

// ── MIME Types ──────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── Auth ────────────────────────────────────────────────

const activeSessions = new Set<string>();

function generateToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

function checkAuth(req: http.IncomingMessage): boolean {
  if (!WEB_PASSWORD) return true; // No password = open access
  const cookie = req.headers.cookie || "";
  const token = cookie.match(/alvinbot_token=([a-f0-9]+)/)?.[1];
  return token ? activeSessions.has(token) : false;
}

// ── REST API ────────────────────────────────────────────

async function handleAPI(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string, body: string): Promise<void> {
  res.setHeader("Content-Type", "application/json");

  // POST /api/login
  if (urlPath === "/api/login" && req.method === "POST") {
    try {
      const { password } = JSON.parse(body);
      if (!WEB_PASSWORD || password === WEB_PASSWORD) {
        const token = generateToken();
        activeSessions.add(token);
        res.setHeader("Set-Cookie", `alvinbot_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "Wrong password" }));
      }
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return;
  }

  // POST /api/webhook — external trigger endpoint with bearer auth (no cookie auth needed)
  if (urlPath === "/api/webhook" && req.method === "POST") {
    if (!config.webhookEnabled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Webhooks disabled" }));
      return;
    }

    // v4.12.2 — timing-safe bearer token comparison. Previously used
    // naive !== which leaks comparison position via timing side-channel.
    if (!timingSafeBearerMatch(req.headers.authorization, config.webhookToken ?? "")) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      const payload = JSON.parse(body);
      if (!payload.message) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing message field" }));
        return;
      }

      const channel = payload.channel || "telegram";
      const chatId = payload.chatId || String(config.allowedUsers[0] || "");

      const { enqueue } = await import("../services/delivery-queue.js");
      const id = enqueue(channel, chatId, `[Webhook: ${payload.event || "unknown"}] ${payload.message}`);

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, queued: id }));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
    }
    return;
  }

  // Auth check for all other API routes
  if (!checkAuth(req)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "Not authenticated" }));
    return;
  }

  // ── Setup APIs (platforms + models) ─────────────────
  const handled = await handleSetupAPI(req, res, urlPath, body);
  if (handled) return;

  // ── Doctor & Backup APIs ──────────────────────────
  const doctorHandled = await handleDoctorAPI(req, res, urlPath, body);
  if (doctorHandled) return;

  // GET /api/setup-check — is the bot fully configured?
  if (urlPath === "/api/setup-check") {
    const envPath = ENV_FILE;
    let env: Record<string, string> = {};
    try {
      const lines = fs.readFileSync(envPath, "utf-8").split("\n");
      for (const line of lines) {
        if (line.startsWith("#") || !line.includes("=")) continue;
        const idx = line.indexOf("=");
        env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    } catch {}

    const hasBotToken = !!(env.BOT_TOKEN || process.env.BOT_TOKEN);
    const hasAllowedUsers = !!(env.ALLOWED_USERS || process.env.ALLOWED_USERS);
    const hasPrimaryProvider = !!(env.PRIMARY_PROVIDER || process.env.PRIMARY_PROVIDER);

    // Check which providers have keys
    const providerKeys: Record<string, boolean> = {
      groq: !!(env.GROQ_API_KEY || process.env.GROQ_API_KEY),
      openai: !!(env.OPENAI_API_KEY || process.env.OPENAI_API_KEY),
      google: !!(env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY),
      nvidia: !!(env.NVIDIA_API_KEY || process.env.NVIDIA_API_KEY),
      anthropic: !!(env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY),
      openrouter: !!(env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY),
    };
    const hasAnyProvider = hasPrimaryProvider || Object.values(providerKeys).some(Boolean);

    // Check Claude CLI
    let claudeCliInstalled = false;
    try {
      const { execSync } = await import("child_process");
      execSync("claude --version", { timeout: 5000, stdio: "pipe" });
      claudeCliInstalled = true;
    } catch {}

    const isComplete = hasBotToken && hasAllowedUsers && hasAnyProvider;
    res.end(JSON.stringify({
      isComplete,
      steps: {
        telegram: { done: hasBotToken && hasAllowedUsers, botToken: hasBotToken, allowedUsers: hasAllowedUsers },
        provider: { done: hasAnyProvider, primary: env.PRIMARY_PROVIDER || process.env.PRIMARY_PROVIDER || "", keys: providerKeys, claudeCli: claudeCliInstalled },
      },
    }));
    return;
  }

  // POST /api/setup-wizard — save all setup data at once (first-run wizard)
  if (urlPath === "/api/setup-wizard" && req.method === "POST") {
    try {
      const data = JSON.parse(body);
      const envPath = ENV_FILE;
      let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";

      const setEnv = (key: string, value: string) => {
        const regex = new RegExp(`^${key}=.*$`, "m");
        if (regex.test(content)) { content = content.replace(regex, `${key}=${value}`); }
        else { content = content.trimEnd() + `\n${key}=${value}\n`; }
        process.env[key] = value;
      };

      // Step 1: Telegram
      if (data.botToken) setEnv("BOT_TOKEN", data.botToken);
      if (data.allowedUsers) setEnv("ALLOWED_USERS", data.allowedUsers);

      // Step 2: Provider
      if (data.primaryProvider) setEnv("PRIMARY_PROVIDER", data.primaryProvider);
      if (data.apiKey && data.apiKeyEnv) setEnv(data.apiKeyEnv, data.apiKey);

      // Step 3: Optional
      if (data.webPassword) setEnv("WEB_PASSWORD", data.webPassword);

      fs.writeFileSync(envPath, content);
      res.end(JSON.stringify({ ok: true, note: "Setup complete! Restart needed." }));
    } catch (e: unknown) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }

  // POST /api/validate-bot-token — validate a Telegram bot token
  if (urlPath === "/api/validate-bot-token" && req.method === "POST") {
    try {
      const { token } = JSON.parse(body);
      if (!token || !token.includes(":")) {
        res.end(JSON.stringify({ ok: false, error: "Invalid token format" }));
        return;
      }
      const tgRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const tgData = await tgRes.json() as any;
      if (tgData.ok) {
        res.end(JSON.stringify({ ok: true, bot: { username: tgData.result.username, firstName: tgData.result.first_name, id: tgData.result.id } }));
      } else {
        res.end(JSON.stringify({ ok: false, error: tgData.description || "Invalid token" }));
      }
    } catch (e: unknown) {
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }

  // GET /api/status
  if (urlPath === "/api/status") {
    let modelInfo = { name: "Not configured", model: "none", status: "unconfigured" };
    try {
      const registry = getRegistry();
      const active = registry.getActive().getInfo();
      modelInfo = { name: active.name, model: active.model, status: active.status };
    } catch { /* engine not initialized — no provider configured */ }

    const memory = getMemoryStats();
    const index = getIndexStats();
    const plugins = getLoadedPlugins();
    const mcp = getMCPStatus();
    const users = listProfiles();
    const tools = listCustomTools();

    // Aggregate token usage across all sessions
    const { getAllSessions } = await import("../services/session.js");
    const allSessions = getAllSessions();
    let totalInputTokens = 0, totalOutputTokens = 0, totalCost = 0;
    for (const s of allSessions.values()) {
      totalInputTokens += s.totalInputTokens || 0;
      totalOutputTokens += s.totalOutputTokens || 0;
      totalCost += s.totalCost || 0;
    }

    const { config: appConfig } = await import("../config.js");
    res.end(JSON.stringify({
      bot: { version: BOT_VERSION, uptime: process.uptime() },
      model: modelInfo,
      memory: { ...memory, vectors: index.entries, indexSize: index.sizeBytes },
      plugins: plugins.length,
      mcp: mcp.length,
      users: users.length,
      tools: tools.length,
      tokens: {
        totalInput: totalInputTokens,
        totalOutput: totalOutputTokens,
        total: totalInputTokens + totalOutputTokens,
        totalCost,
      },
      setup: {
        telegram: !!appConfig.botToken,
        provider: modelInfo.status !== "unconfigured",
      },
    }));
    return;
  }

  // GET /api/models
  if (urlPath === "/api/models") {
    const registry = getRegistry();
    registry.listAll().then(models => {
      res.end(JSON.stringify({ models, active: registry.getActiveKey() }));
    });
    return;
  }

  // POST /api/models/switch
  if (urlPath === "/api/models/switch" && req.method === "POST") {
    try {
      const { key } = JSON.parse(body);
      const registry = getRegistry();
      const ok = registry.switchTo(key);
      res.end(JSON.stringify({ ok, active: registry.getActiveKey() }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return;
  }

  // GET /api/fallback — Get fallback order + health
  if (urlPath === "/api/fallback" && req.method === "GET") {
    try {
      const { getFallbackOrder } = await import("../services/fallback-order.js");
      const { getHealthStatus, isFailedOver } = await import("../services/heartbeat.js");
      const registry = getRegistry();
      const providers = await registry.listAll();

      res.end(JSON.stringify({
        order: getFallbackOrder(),
        health: getHealthStatus(),
        failedOver: isFailedOver(),
        activeProvider: registry.getActiveKey(),
        availableProviders: providers.map(p => ({ key: p.key, name: p.name, status: p.status })),
      }));
    } catch (err) {
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // POST /api/fallback — Set fallback order
  if (urlPath === "/api/fallback" && req.method === "POST") {
    try {
      const { primary, fallbacks } = JSON.parse(body);
      const { setFallbackOrder } = await import("../services/fallback-order.js");
      const result = setFallbackOrder(primary, fallbacks, "webui");
      res.end(JSON.stringify({ ok: true, order: result }));
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // POST /api/fallback/move — Move provider up/down
  if (urlPath === "/api/fallback/move" && req.method === "POST") {
    try {
      const { key, direction } = JSON.parse(body);
      const fb = await import("../services/fallback-order.js");
      const result = direction === "up" ? fb.moveUp(key, "webui") : fb.moveDown(key, "webui");
      res.end(JSON.stringify({ ok: true, order: result }));
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // GET /api/heartbeat — Health status
  if (urlPath === "/api/heartbeat") {
    try {
      const { getHealthStatus, isFailedOver } = await import("../services/heartbeat.js");
      res.end(JSON.stringify({
        health: getHealthStatus(),
        failedOver: isFailedOver(),
      }));
    } catch (err) {
      res.end(JSON.stringify({ health: [], failedOver: false }));
    }
    return;
  }

  // GET /api/memory
  if (urlPath === "/api/memory") {
    const ltm = loadLongTermMemory();
    const todayLog = loadDailyLog();
    const stats = getMemoryStats();
    const index = getIndexStats();

    // List daily log files
    let dailyFiles: string[] = [];
    try {
      dailyFiles = fs.readdirSync(MEMORY_DIR)
        .filter(f => f.endsWith(".md") && !f.startsWith("."))
        .sort()
        .reverse();
    } catch { /* empty */ }

    res.end(JSON.stringify({
      longTermMemory: ltm,
      todayLog,
      dailyFiles,
      stats,
      index: { entries: index.entries, files: index.files, sizeBytes: index.sizeBytes },
    }));
    return;
  }

  // GET /api/memory/:file
  if (urlPath.startsWith("/api/memory/")) {
    const file = urlPath.slice(12);
    if (file.includes("..") || !file.endsWith(".md")) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid file" }));
      return;
    }
    try {
      const content = fs.readFileSync(resolve(MEMORY_DIR, file), "utf-8");
      res.end(JSON.stringify({ file, content }));
    } catch {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "File not found" }));
    }
    return;
  }

  // POST /api/memory/save
  if (urlPath === "/api/memory/save" && req.method === "POST") {
    try {
      const { file, content } = JSON.parse(body);
      if (file === "MEMORY.md") {
        fs.writeFileSync(MEMORY_FILE, content);
      } else if (file.endsWith(".md") && !file.includes("..")) {
        fs.writeFileSync(resolve(MEMORY_DIR, file), content);
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Invalid file" }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return;
  }

  // GET /api/plugins
  if (urlPath === "/api/plugins") {
    res.end(JSON.stringify({ plugins: getLoadedPlugins() }));
    return;
  }

  // v4.12.0 — Workspace overview: registry + per-workspace cost breakdown
  if (urlPath === "/api/workspaces") {
    try {
      const { listWorkspaces, getDefaultWorkspace } = await import("../services/workspaces.js");
      const { getCostByWorkspace } = await import("../services/session.js");
      const costs = getCostByWorkspace();
      const registered = listWorkspaces();
      const all = [getDefaultWorkspace(), ...registered];
      const payload = all.map((ws) => ({
        name: ws.name,
        purpose: ws.purpose,
        emoji: ws.emoji ?? null,
        color: ws.color ?? null,
        cwd: ws.cwd,
        channels: ws.channels,
        stats: costs[ws.name] ?? { totalCost: 0, sessionCount: 0, messageCount: 0, toolUseCount: 0 },
      }));
      res.end(JSON.stringify({ workspaces: payload }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // GET /api/users — Enhanced with session data
  if (urlPath === "/api/users" && req.method === "GET") {
    const { getAllSessions } = await import("../services/session.js");
    const profiles = listProfiles();
    const sessions = getAllSessions();
    const sessionMap = new Map(Array.from(sessions.entries()).map(([k, s]) => [Number(k), s]));

    const enriched = profiles.map(p => {
      const session = sessionMap.get(p.userId);
      return {
        ...p,
        session: session ? {
          isProcessing: session.isProcessing,
          totalCost: session.totalCost,
          historyLength: session.history.length,
          effort: session.effort,
          voiceReply: session.voiceReply,
          startedAt: session.startedAt,
          messageCount: session.messageCount,
          toolUseCount: session.toolUseCount,
          workingDir: session.workingDir,
          hasActiveQuery: !!session.abortController,
          queuedMessages: session.messageQueue.length,
        } : null,
      };
    });

    res.end(JSON.stringify({ users: enriched }));
    return;
  }

  // DELETE /api/users/:id — Kill session + delete user data
  if (urlPath.startsWith("/api/users/") && req.method === "DELETE") {
    const userId = parseInt(urlPath.split("/").pop() || "0");
    if (!userId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid user ID" }));
      return;
    }

    const { deleteUser } = await import("../services/users.js");
    const result = deleteUser(userId);
    res.end(JSON.stringify({ ok: true, ...result }));
    return;
  }

  // GET /api/tools
  if (urlPath === "/api/tools") {
    const tools = getCustomTools();
    res.end(JSON.stringify({ tools }));
    return;
  }

  // POST /api/tools/execute — run a tool by name
  if (urlPath === "/api/tools/execute" && req.method === "POST") {
    try {
      const { name, params } = JSON.parse(body);
      if (!name) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "No tool name" }));
        return;
      }
      const output = await executeCustomTool(name, params || {});
      res.end(JSON.stringify({ ok: true, output }));
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.end(JSON.stringify({ error }));
    }
    return;
  }

  // ── MCP Management ─────────────────────────────────────

  // GET /api/mcp — list MCP servers + tools
  if (urlPath === "/api/mcp") {
    const { getMCPStatus, getMCPTools, hasMCPConfig } = await import("../services/mcp.js");
    const servers = getMCPStatus();
    const tools = getMCPTools();
    // Read raw config for editing
    const configPath = MCP_CONFIG;
    let rawConfig: Record<string, unknown> = { servers: {} };
    try { rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch {}
    res.end(JSON.stringify({ servers, tools, config: rawConfig, hasConfig: hasMCPConfig() }));
    return;
  }

  // POST /api/mcp/add — add a new MCP server
  if (urlPath === "/api/mcp/add" && req.method === "POST") {
    try {
      const { name, command, args, url: serverUrl, env, headers } = JSON.parse(body);
      if (!name) { res.statusCode = 400; res.end(JSON.stringify({ error: "Name required" })); return; }
      const configPath = MCP_CONFIG;
      let config: { servers: Record<string, unknown> } = { servers: {} };
      try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch {}
      const entry: Record<string, unknown> = {};
      if (command) { entry.command = command; entry.args = args || []; if (env) entry.env = env; }
      else if (serverUrl) { entry.url = serverUrl; if (headers) entry.headers = headers; }
      else { res.statusCode = 400; res.end(JSON.stringify({ error: "command or url required" })); return; }
      config.servers[name] = entry;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      res.end(JSON.stringify({ ok: true, note: "Restart needed to connect." }));
    } catch (e: unknown) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }

  // POST /api/mcp/remove — remove an MCP server
  if (urlPath === "/api/mcp/remove" && req.method === "POST") {
    try {
      const { name } = JSON.parse(body);
      const configPath = MCP_CONFIG;
      let config: { servers: Record<string, unknown> } = { servers: {} };
      try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch {}
      delete config.servers[name];
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }

  // GET /api/mcp/discover — auto-discover MCP servers on the system
  if (urlPath === "/api/mcp/discover") {
    const discovered: Array<{ name: string; command: string; args: string[]; source: string }> = [];
    const { execSync } = await import("child_process");

    // Check for common MCP server npm packages
    const knownServers = [
      { pkg: "@modelcontextprotocol/server-filesystem", name: "filesystem", args: ["/tmp"] },
      { pkg: "@modelcontextprotocol/server-brave-search", name: "brave-search", args: [] },
      { pkg: "@modelcontextprotocol/server-github", name: "github", args: [] },
      { pkg: "@modelcontextprotocol/server-postgres", name: "postgres", args: [] },
      { pkg: "@modelcontextprotocol/server-sqlite", name: "sqlite", args: [] },
      { pkg: "@modelcontextprotocol/server-slack", name: "slack", args: [] },
      { pkg: "@modelcontextprotocol/server-memory", name: "memory", args: [] },
      { pkg: "@modelcontextprotocol/server-puppeteer", name: "puppeteer", args: [] },
      { pkg: "@modelcontextprotocol/server-fetch", name: "web-fetch", args: [] },
      { pkg: "@anthropic/mcp-server-sequential-thinking", name: "sequential-thinking", args: [] },
    ];

    for (const s of knownServers) {
      try {
        execSync(`npx --yes ${s.pkg} --help`, { timeout: 5000, stdio: "pipe", env: { ...process.env, PATH: process.env.PATH + ":/opt/homebrew/bin:/usr/local/bin" } });
        discovered.push({ name: s.name, command: "npx", args: ["-y", s.pkg, ...s.args], source: "npm" });
      } catch {
        // Not installed — try checking if globally available
        try {
          execSync(`npm list -g ${s.pkg} --depth=0`, { timeout: 5000, stdio: "pipe" });
          discovered.push({ name: s.name, command: "npx", args: ["-y", s.pkg, ...s.args], source: "npm-global" });
        } catch { /* not installed */ }
      }
    }

    // Check for Claude Desktop MCP config
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    const claudeConfigPaths = [
      resolve(homeDir, ".config/claude/claude_desktop_config.json"),
      resolve(homeDir, "Library/Application Support/Claude/claude_desktop_config.json"),
      resolve(homeDir, "AppData/Roaming/Claude/claude_desktop_config.json"),
    ];
    for (const cfgPath of claudeConfigPaths) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        if (cfg.mcpServers) {
          for (const [name, srv] of Object.entries(cfg.mcpServers) as Array<[string, any]>) {
            if (srv.command) {
              discovered.push({ name: `claude-${name}`, command: srv.command, args: srv.args || [], source: "claude-desktop" });
            }
          }
        }
      } catch { /* not found */ }
    }

    res.end(JSON.stringify({ discovered }));
    return;
  }

  // ── Skills Management ─────────────────────────────────

  // GET /api/skills — already in setup-api.ts, but add full CRUD here
  // GET /api/skills/detail/:id — get full skill content
  if (urlPath?.match(/^\/api\/skills\/detail\//) && req.method === "GET") {
    const skillId = urlPath.split("/").pop();
    const { getSkills } = await import("../services/skills.js");
    const skill = getSkills().find(s => s.id === skillId);
    if (skill) {
      res.end(JSON.stringify({ ok: true, skill }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Skill not found" }));
    }
    return;
  }

  // POST /api/skills/create — create a new skill
  if (urlPath === "/api/skills/create" && req.method === "POST") {
    try {
      const { id, name, description, triggers, category, content, priority } = JSON.parse(body);
      if (!id || !name) { res.statusCode = 400; res.end(JSON.stringify({ error: "id and name required" })); return; }
      const skillsDir = SKILLS_DIR;
      const skillDir = resolve(skillsDir, id);
      if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
      const frontmatter = [
        "---",
        `name: ${name}`,
        description ? `description: ${description}` : "",
        triggers ? `triggers: ${Array.isArray(triggers) ? triggers.join(", ") : triggers}` : "",
        `priority: ${priority || 3}`,
        `category: ${category || "custom"}`,
        "---",
      ].filter(Boolean).join("\n");
      fs.writeFileSync(resolve(skillDir, "SKILL.md"), `${frontmatter}\n\n${content || ""}`);
      // Force reload
      const { loadSkills } = await import("../services/skills.js");
      loadSkills();
      res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }

  // POST /api/skills/update — update an existing skill
  if (urlPath === "/api/skills/update" && req.method === "POST") {
    try {
      const { id, content } = JSON.parse(body);
      const skillPath = resolve(SKILLS_DIR, id, "SKILL.md");
      if (!fs.existsSync(skillPath)) {
        // Try flat file
        const flatPath = resolve(SKILLS_DIR, id + ".md");
        if (fs.existsSync(flatPath)) {
          fs.writeFileSync(flatPath, content);
        } else {
          res.statusCode = 404; res.end(JSON.stringify({ error: "Skill not found" })); return;
        }
      } else {
        fs.writeFileSync(skillPath, content);
      }
      const { loadSkills } = await import("../services/skills.js");
      loadSkills();
      res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }

  // POST /api/skills/delete — delete a skill
  if (urlPath === "/api/skills/delete" && req.method === "POST") {
    try {
      const { id } = JSON.parse(body);
      const skillDir = resolve(SKILLS_DIR, id);
      const flatFile = resolve(SKILLS_DIR, id + ".md");
      if (fs.existsSync(skillDir)) {
        fs.rmSync(skillDir, { recursive: true });
      } else if (fs.existsSync(flatFile)) {
        fs.unlinkSync(flatFile);
      } else {
        res.statusCode = 404; res.end(JSON.stringify({ error: "Skill not found" })); return;
      }
      const { loadSkills } = await import("../services/skills.js");
      loadSkills();
      res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }

  // GET /api/config
  if (urlPath === "/api/config") {
    res.end(JSON.stringify({
      providers: config.fallbackProviders,
      primaryProvider: config.primaryProvider,
      allowedUsers: config.allowedUsers,
      hasKeys: {
        groq: !!config.apiKeys.groq,
        openai: !!config.apiKeys.openai,
        google: !!config.apiKeys.google,
        nvidia: !!config.apiKeys.nvidia,
        openrouter: !!config.apiKeys.openrouter,
      },
    }));
    return;
  }

  // GET /api/sessions
  if (urlPath === "/api/sessions") {
    const sessions = getAllSessions();
    const profiles = listProfiles();
    const data = Array.from(sessions.entries()).map(([key, session]) => {
      const userId = Number(key.split(":").pop());
      const profile = profiles.find(p => p.userId === userId);
      return {
        userId: key,
        name: profile?.name || `User ${key}`,
        username: profile?.username,
        messageCount: session.messageCount,
        toolUseCount: session.toolUseCount,
        totalCost: session.totalCost,
        totalInputTokens: session.totalInputTokens || 0,
        totalOutputTokens: session.totalOutputTokens || 0,
        effort: session.effort,
        startedAt: session.startedAt,
        lastActivity: session.lastActivity,
        historyLength: session.history.length,
        isProcessing: session.isProcessing,
        provider: Object.keys(session.queriesByProvider).join(", ") || "none",
      };
    });
    res.end(JSON.stringify({ sessions: data }));
    return;
  }

  // GET /api/sessions/:userId/history
  if (urlPath.match(/^\/api\/sessions\/\d+\/history$/)) {
    const userId = parseInt(urlPath.split("/")[3]);
    const session = getSession(userId);
    res.end(JSON.stringify({
      userId,
      history: session.history.map(h => ({ role: h.role, content: h.content.slice(0, 2000) })),
    }));
    return;
  }

  // GET /api/files?path=...
  if (urlPath === "/api/files") {
    const params = new URLSearchParams((req.url || "").split("?")[1] || "");
    const reqPath = params.get("path") || "";
    const basePath = resolve(BOT_ROOT, reqPath || ".");

    // Security: must be within BOT_ROOT
    if (!basePath.startsWith(BOT_ROOT)) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Access denied" }));
      return;
    }

    try {
      const stat = fs.statSync(basePath);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(basePath, { withFileTypes: true })
          .filter(e => !e.name.startsWith(".") && e.name !== "node_modules")
          .map(e => ({
            name: e.name,
            type: e.isDirectory() ? "dir" : "file",
            size: e.isFile() ? fs.statSync(resolve(basePath, e.name)).size : 0,
            modified: fs.statSync(resolve(basePath, e.name)).mtimeMs,
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        res.end(JSON.stringify({ path: reqPath || ".", entries }));
      } else {
        // Read file content — text files up to 500KB
        const ext = path.extname(basePath).toLowerCase();
        const textExts = new Set([
          ".md", ".txt", ".json", ".js", ".ts", ".jsx", ".tsx", ".css", ".html", ".htm",
          ".xml", ".svg", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env",
          ".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".go", ".rs", ".java", ".kt",
          ".c", ".cpp", ".h", ".hpp", ".cs", ".php", ".sql", ".graphql", ".prisma",
          ".dockerfile", ".gitignore", ".gitattributes", ".editorconfig", ".prettierrc",
          ".eslintrc", ".babelrc", ".npmrc", ".nvmrc", ".lock", ".log", ".csv", ".tsv",
          ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".astro",
        ]);
        // Files without extension that match known names are always text
        const textNames = new Set([
          "dockerfile", "makefile", "procfile", "gemfile", "rakefile",
          "vagrantfile", "brewfile", "justfile", "taskfile", "cakefile",
          "license", "licence", "readme", "changelog", "authors", "contributors",
        ]);
        const baseName = path.basename(basePath).toLowerCase();
        const isKnownTextName = textNames.has(baseName);
        const isText = textExts.has(ext) || isKnownTextName || (!ext && stat.size < 100_000);

        if (stat.size > 500_000) {
          res.end(JSON.stringify({ path: reqPath, content: `[File too large: ${(stat.size / 1024).toFixed(1)} KB — max 500 KB]`, size: stat.size }));
        } else if (isText) {
          try {
            const content = fs.readFileSync(basePath, "utf-8");
            // Quick binary check: if >10% null bytes, it's binary
            const nullCount = [...content.slice(0, 1000)].filter(c => c === "\0").length;
            if (nullCount > 100) {
              res.end(JSON.stringify({ path: reqPath, content: null, size: stat.size, binary: true }));
            } else {
              res.end(JSON.stringify({ path: reqPath, content, size: stat.size }));
            }
          } catch {
            res.end(JSON.stringify({ path: reqPath, content: null, size: stat.size, binary: true }));
          }
        } else {
          res.end(JSON.stringify({ path: reqPath, content: null, size: stat.size, binary: true }));
        }
      }
    } catch {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Not found" }));
    }
    return;
  }

  // POST /api/files/save
  if (urlPath === "/api/files/save" && req.method === "POST") {
    try {
      const { path: filePath, content } = JSON.parse(body);
      const absPath = resolve(BOT_ROOT, filePath);
      if (!absPath.startsWith(BOT_ROOT)) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "Access denied" }));
        return;
      }
      fs.writeFileSync(absPath, content);
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      res.statusCode = 400;
      const error = err instanceof Error ? err.message : "Invalid request";
      res.end(JSON.stringify({ error }));
    }
    return;
  }

  // POST /api/files/delete
  if (urlPath === "/api/files/delete" && req.method === "POST") {
    try {
      const { path: filePath } = JSON.parse(body);
      const absPath = resolve(BOT_ROOT, filePath);
      if (!absPath.startsWith(BOT_ROOT)) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "Access denied" }));
        return;
      }
      // Safety: don't allow deleting critical files
      const critical = [".env", "package.json", "tsconfig.json", "ecosystem.config.cjs"];
      const baseName = path.basename(absPath);
      if (critical.includes(baseName)) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: `${baseName} cannot be deleted (protected)` }));
        return;
      }
      if (!fs.existsSync(absPath)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "File not found" }));
        return;
      }
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Directories cannot be deleted" }));
        return;
      }
      fs.unlinkSync(absPath);
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      res.statusCode = 400;
      const error = err instanceof Error ? err.message : "Invalid request";
      res.end(JSON.stringify({ error }));
    }
    return;
  }

  // POST /api/terminal
  if (urlPath === "/api/terminal" && req.method === "POST") {
    try {
      const { command } = JSON.parse(body);
      if (!command) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "No command" }));
        return;
      }
      // Security: limit command length
      if (command.length > 10000) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Command too long (max 10000 chars)" }));
        return;
      }
      const cwd = typeof (JSON.parse(body)).cwd === "string" ? resolve(JSON.parse(body).cwd) : BOT_ROOT;
      const output = execSync(command, {
        cwd,
        stdio: "pipe",
        timeout: 120000,
        env: { ...process.env, PATH: process.env.PATH + ":/opt/homebrew/bin:/usr/local/bin" },
      }).toString();
      res.end(JSON.stringify({ output: output.slice(0, 100000) }));
    } catch (err: unknown) {
      const error = err as { stderr?: Buffer; message: string };
      const stderr = error.stderr?.toString()?.trim() || "";
      res.end(JSON.stringify({ output: stderr || error.message, exitCode: 1 }));
    }
    return;
  }

  // GET /api/env — read .env keys (names only, values masked)
  if (urlPath === "/api/env") {
    try {
      const envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf-8") : "";
      const lines = envContent.split("\n").filter(l => l.includes("=") && !l.startsWith("#"));
      const vars = lines.map(l => {
        const [key, ...rest] = l.split("=");
        const value = rest.join("=").trim();
        // Mask sensitive values
        const masked = key.includes("KEY") || key.includes("TOKEN") || key.includes("PASSWORD") || key.includes("SECRET")
          ? (value.length > 4 ? value.slice(0, 4) + "..." + value.slice(-4) : "****")
          : value;
        return { key: key.trim(), value: masked, hasValue: value.length > 0 };
      });
      res.end(JSON.stringify({ vars }));
    } catch {
      res.end(JSON.stringify({ vars: [] }));
    }
    return;
  }

  // POST /api/env/set — update an env var
  if (urlPath === "/api/env/set" && req.method === "POST") {
    try {
      const { key, value } = JSON.parse(body);
      if (!key || typeof key !== "string" || !key.match(/^[A-Z_][A-Z0-9_]*$/)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Invalid key name" }));
        return;
      }

      let envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf-8") : "";
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent = envContent.trimEnd() + `\n${key}=${value}\n`;
      }
      // v4.12.2 — enforce 0o600 on .env
      writeSecure(ENV_FILE, envContent);
      res.end(JSON.stringify({ ok: true, note: "Restart required for changes to take effect" }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return;
  }

  // GET /api/soul — read SOUL.md
  if (urlPath === "/api/soul") {
    const content = getSoulContent();
    res.end(JSON.stringify({ content }));
    return;
  }

  // POST /api/soul/save — update SOUL.md
  if (urlPath === "/api/soul/save" && req.method === "POST") {
    try {
      const { content } = JSON.parse(body);
      const soulPath = SOUL_FILE;
      fs.writeFileSync(soulPath, content);
      reloadSoul();
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return;
  }

  // GET /api/platforms — platform adapter status
  if (urlPath === "/api/platforms") {
    const platforms = [
      { name: "Telegram", key: "BOT_TOKEN", icon: "📱", configured: !!process.env.BOT_TOKEN },
      { name: "Discord", key: "DISCORD_TOKEN", icon: "🎮", configured: !!process.env.DISCORD_TOKEN },
      { name: "WhatsApp", key: "WHATSAPP_ENABLED", icon: "💬", configured: process.env.WHATSAPP_ENABLED === "true" },
      { name: "Signal", key: "SIGNAL_API_URL", icon: "🔒", configured: !!process.env.SIGNAL_API_URL },
      { name: "Web UI", key: "WEB_PORT", icon: "🌐", configured: true },
    ];
    res.end(JSON.stringify({ platforms }));
    return;
  }

  // POST /api/restart — restart the bot process
  if (urlPath === "/api/restart" && req.method === "POST") {
    const { scheduleGracefulRestart } = await import("../services/restart.js");
    res.end(JSON.stringify({ ok: true, note: "Restarting..." }));
    scheduleGracefulRestart(500);
    return;
  }

  // POST /api/chat/export — export chat history
  if (urlPath === "/api/chat/export" && req.method === "POST") {
    try {
      const { messages, format } = JSON.parse(body);
      if (format === "json") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ export: messages }, null, 2));
      } else {
        // Markdown
        const md = messages.map((m: { role: string; text: string; time?: string }) => {
          const prefix = m.role === "user" ? "**Du:**" : m.role === "assistant" ? "**Alvin Bot:**" : "*System:*";
          const time = m.time ? ` _(${m.time})_` : "";
          return `${prefix}${time}\n${m.text}\n`;
        }).join("\n---\n\n");
        res.setHeader("Content-Type", "text/markdown");
        res.end(`# Chat Export — Alvin Bot\n_${new Date().toLocaleString("de-DE")}_\n\n---\n\n${md}`);
      }
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return;
  }

  // ── WhatsApp Group Management API ────────────────────────────────────

  // GET /api/whatsapp/groups — list all WhatsApp groups (live from WA)
  if (urlPath === "/api/whatsapp/groups" && req.method === "GET") {
    try {
      const { getWhatsAppAdapter } = await import("../platforms/whatsapp.js");
      const adapter = getWhatsAppAdapter();
      if (!adapter) {
        res.end(JSON.stringify({ groups: [], error: "WhatsApp nicht verbunden" }));
        return;
      }
      const groups = await adapter.getGroups();
      res.end(JSON.stringify({ groups }));
    } catch (err) {
      res.end(JSON.stringify({ groups: [], error: String(err) }));
    }
    return;
  }

  // GET /api/whatsapp/groups/:id/participants — fetch group participants
  if (urlPath.match(/^\/api\/whatsapp\/groups\/[^/]+\/participants$/)) {
    try {
      const groupId = decodeURIComponent(urlPath.split("/")[4]);
      const { getWhatsAppAdapter } = await import("../platforms/whatsapp.js");
      const adapter = getWhatsAppAdapter();
      if (!adapter) {
        res.end(JSON.stringify({ participants: [], error: "WhatsApp nicht verbunden" }));
        return;
      }
      const participants = await adapter.getGroupParticipants(groupId);
      res.end(JSON.stringify({ participants }));
    } catch (err) {
      res.end(JSON.stringify({ participants: [], error: String(err) }));
    }
    return;
  }

  // GET /api/whatsapp/group-rules — get all configured group rules
  if (urlPath === "/api/whatsapp/group-rules" && req.method === "GET") {
    const { getGroupRules } = await import("../platforms/whatsapp.js");
    res.end(JSON.stringify({ rules: getGroupRules() }));
    return;
  }

  // POST /api/whatsapp/group-rules — create or update a group rule
  if (urlPath === "/api/whatsapp/group-rules" && req.method === "POST") {
    try {
      const rule = JSON.parse(body);
      if (!rule.groupId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "groupId ist erforderlich" }));
        return;
      }
      const { upsertGroupRule } = await import("../platforms/whatsapp.js");
      const saved = upsertGroupRule(rule);
      res.end(JSON.stringify({ ok: true, rule: saved }));
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // DELETE /api/whatsapp/group-rules/:id — delete a group rule
  if (urlPath.match(/^\/api\/whatsapp\/group-rules\//) && req.method === "DELETE") {
    const groupId = decodeURIComponent(urlPath.split("/").slice(4).join("/"));
    const { deleteGroupRule } = await import("../platforms/whatsapp.js");
    const ok = deleteGroupRule(groupId);
    res.end(JSON.stringify({ ok }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
}

// ── WebSocket Chat ──────────────────────────────────────

// Set of all currently connected chat WebSocket clients (excluding canvas).
// Populated on connect, cleaned up on close. Used to forward Telegram
// activity to every observer.
const chatClients = new Set<WebSocket>();

/**
 * Wire the broadcast bus once at module load. The bus is singleton, so
 * subscribing here means every Telegram message fan-outs to every connected
 * chat client — without any per-connection re-subscription.
 */
broadcast.on("user_msg", (payload) => {
  if (payload.platform !== "telegram") return; // v4.5.0: telegram only for now
  const json = JSON.stringify({
    type: "mirror:user_msg",
    text: payload.text,
    platform: payload.platform,
    userName: payload.userName,
    ts: payload.ts,
  });
  for (const client of chatClients) {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  }
});
broadcast.on("response_start", (payload) => {
  if (payload.platform !== "telegram") return;
  const json = JSON.stringify({ type: "mirror:response_start", platform: payload.platform, ts: payload.ts });
  for (const client of chatClients) {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  }
});
broadcast.on("response_delta", (payload) => {
  if (payload.platform !== "telegram") return;
  const json = JSON.stringify({ type: "mirror:response_delta", delta: payload.delta, platform: payload.platform, ts: payload.ts });
  for (const client of chatClients) {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  }
});
broadcast.on("response_done", (payload) => {
  if (payload.platform !== "telegram") return;
  const json = JSON.stringify({ type: "mirror:response_done", cost: payload.cost, platform: payload.platform, ts: payload.ts });
  for (const client of chatClients) {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  }
});

function handleWebSocket(wss: WebSocketServer): void {
  wss.on("connection", (ws, req) => {
    // Auth check
    if (WEB_PASSWORD && !checkAuth(req)) {
      ws.close(4001, "Not authenticated");
      return;
    }

    // Canvas WebSocket — separate handler
    const wsUrl = req.url || "/";
    if (wsUrl === "/canvas/ws") {
      addCanvasClient(ws);
      return;
    }

    console.log("WebUI: client connected");
    chatClients.add(ws);

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "chat") {
          let { text, effort, file } = msg;
          // v4.5.0: session routing. The client (TUI/WebUI) tells us which
          // session it wants its message to go into. Supported targets:
          //   - "tui"      → use msg.sessionKey (e.g. "tui:local" or
          //                   "tui:ephemeral:…"). Isolated from Telegram.
          //   - "telegram" → route into the primary Telegram user's session.
          //                   Responses go back to the client AND to the
          //                   actual Telegram chat via the broadcast bus.
          //   - undefined  → backwards-compatible: default to the primary
          //                   allowed user's session (old behavior).
          const target = msg.target as ("tui" | "telegram" | undefined);
          const telegramUserId = config.allowedUsers[0] || 0;
          let sessionKey: string | number;
          if (target === "tui" && typeof msg.sessionKey === "string" && msg.sessionKey.startsWith("tui:")) {
            sessionKey = msg.sessionKey;
          } else if (target === "telegram") {
            sessionKey = telegramUserId;
          } else {
            sessionKey = telegramUserId; // backwards compat
          }

          // Handle file upload — save to temp and reference in prompt
          if (file?.dataUrl && file?.name) {
            try {
              const dataDir = resolve(DATA_DIR, "web-uploads");
              if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
              const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
              const filePath = resolve(dataDir, `${Date.now()}_${safeName}`);
              const base64Data = file.dataUrl.split(",")[1] || file.dataUrl;
              fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
              // Replace placeholder with actual file path
              text = text.replace(/\[File attached:.*?\]/, `[File saved: ${filePath}]`);
            } catch (err) {
              console.error("WebUI file upload error:", err);
            }
          }

          const registry = getRegistry();
          const activeProvider = registry.getActive();
          const isSDK = activeProvider.config.type === "claude-sdk";
          const session = getSession(sessionKey);

          const queryOpts: QueryOptions = {
            prompt: text,
            systemPrompt: buildSystemPrompt(isSDK, session.language, target === "telegram" ? "telegram" : "web-dashboard"),
            workingDir: session.workingDir,
            effort: effort || session.effort,
            sessionId: isSDK ? session.sessionId : null,
            history: !isSDK ? session.history : undefined,
          };

          let gotDone = false;
          let finalText = ""; // v4.5.0: capture the final response for target=telegram relay
          try {
            // Stream response
            for await (const chunk of registry.queryWithFallback(queryOpts)) {
              if (ws.readyState !== WebSocket.OPEN) break;

              switch (chunk.type) {
                case "text":
                  if (chunk.text) finalText = chunk.text;
                  ws.send(JSON.stringify({ type: "text", text: chunk.text, delta: chunk.delta }));
                  break;
                case "tool_use":
                  ws.send(JSON.stringify({ type: "tool", name: chunk.toolName, input: chunk.toolInput }));
                  break;
                case "done":
                  gotDone = true;
                  if (chunk.text) finalText = chunk.text;
                  if (chunk.sessionId) session.sessionId = chunk.sessionId;
                  if (chunk.costUsd) session.totalCost += chunk.costUsd;
                  if (chunk.inputTokens) session.totalInputTokens = (session.totalInputTokens || 0) + chunk.inputTokens;
                  if (chunk.outputTokens) session.totalOutputTokens = (session.totalOutputTokens || 0) + chunk.outputTokens;
                  ws.send(JSON.stringify({
                    type: "done", cost: chunk.costUsd, sessionId: chunk.sessionId,
                    inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens,
                    sessionTokens: { input: session.totalInputTokens || 0, output: session.totalOutputTokens || 0 },
                  }));
                  break;
                case "error":
                  ws.send(JSON.stringify({ type: "error", error: chunk.error }));
                  gotDone = true; // error counts as done
                  break;
                case "fallback":
                  ws.send(JSON.stringify({ type: "fallback", from: chunk.failedProvider, to: chunk.providerName }));
                  break;
              }
            }
            // Ensure we always send done (in case stream ended without done/error chunk)
            if (!gotDone && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "done", cost: 0 }));
            }

            // v4.5.0: if the user typed in the TUI with target=telegram, we
            // must also post the bot's final response to the actual Telegram
            // chat so the continuity is preserved from the Telegram side.
            // (Telegram bots cannot forge user messages, so only the
            // response lands in the chat — the user prompt itself stays
            // in the TUI.)
            if (target === "telegram" && finalText.trim()) {
              try {
                const dq = await import("../services/delivery-queue.js");
                dq.enqueue("telegram", String(telegramUserId), finalText);
              } catch (err) {
                console.error("WebUI → Telegram relay failed:", err);
              }
            }
          } catch (streamErr) {
            const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
            console.error("WebUI stream error:", errMsg);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "error", error: errMsg }));
              if (!gotDone) {
                ws.send(JSON.stringify({ type: "done", cost: 0 }));
              }
            }
          }
        }

        if (msg.type === "reset") {
          // v4.5.0: reset the target session, not a hardcoded one.
          const target = msg.target as ("tui" | "telegram" | undefined);
          const telegramUserId = config.allowedUsers[0] || 0;
          let resetKey: string | number;
          if (target === "tui" && typeof msg.sessionKey === "string" && msg.sessionKey.startsWith("tui:")) {
            resetKey = msg.sessionKey;
          } else {
            resetKey = telegramUserId;
          }
          resetSession(resetKey);
          ws.send(JSON.stringify({ type: "reset", ok: true }));
        }

      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ws.send(JSON.stringify({ type: "error", error }));
      }
    });

    ws.on("close", () => {
      console.log("WebUI: client disconnected");
      chatClients.delete(ws);
    });
  });
}

// ── Start Server ────────────────────────────────────────

/**
 * HTTP request handler for the web UI. Hoisted to a top-level function
 * so every bind attempt can create a fresh http.Server without
 * rebuilding the handler closure.
 */
function handleWebRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const urlPath = (req.url || "/").split("?")[0];

    // OpenAI-compatible API (/v1/chat/completions, /v1/models)
    if (urlPath.startsWith("/v1/")) {
      handleOpenAICompat(req, res, urlPath, body);
      return;
    }

    // API routes
    if (urlPath.startsWith("/api/")) {
      handleAPI(req, res, urlPath, body);
      return;
    }

    // Auth page (if password set and not authenticated)
    if (WEB_PASSWORD && !checkAuth(req) && urlPath !== "/login.html") {
      res.writeHead(302, { Location: "/login.html" });
      res.end();
      return;
    }

    // Canvas UI
    if (urlPath === "/canvas") {
      const canvasFile = resolve(PUBLIC_DIR, "canvas.html");
      try {
        const content = fs.readFileSync(canvasFile);
        res.setHeader("Content-Type", "text/html");
        res.end(content);
      } catch {
        res.statusCode = 404;
        res.end("Not found");
      }
      return;
    }

    // Static files
    let filePath = urlPath === "/" ? "/index.html" : urlPath;
    filePath = resolve(PUBLIC_DIR, filePath.slice(1));

    // Security: prevent path traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      res.end(content);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  });
}

/**
 * Kick off the web-UI bind loop. NEVER throws, NEVER blocks.
 *
 * History: earlier versions returned an http.Server synchronously and
 * let listen() errors bubble up as uncaught exceptions — a colleague
 * flagged this on 2026-04-13 after spending months fighting the exact
 * same bug on a parallel OpenClaw fork. Their resolution: "the gateway
 * is a feature, not core. Decouple it."
 *
 * New contract:
 *   - Returns `void` immediately. The actual bind happens asynchronously.
 *   - If port 3100 is busy, tries 3101…3119 in sequence (same as before).
 *   - If ALL 20 ports are busy, schedules a background retry at 3100
 *     in `BACKGROUND_RETRY_MS` — keeps trying forever until success
 *     or stopWebServer() is called.
 *   - Any non-EADDRINUSE error also falls through to background retry.
 *   - Each attempt uses a FRESH http.Server to avoid node's fragile
 *     "listen-called-twice" state-recycling behaviour.
 *   - The main Telegram bot is completely independent of this — if the
 *     web UI never binds, the bot still answers messages.
 */
export function startWebServer(): void {
  stopRequested = false;
  scheduleBindAttempt(WEB_PORT, 0);
}

function scheduleBindAttempt(port: number, attempt: number): void {
  if (stopRequested) return;

  // Read WEB_PORT live every time rather than closing over the
  // module-load value, so tests that change process.env.WEB_PORT
  // between runs see the new port.
  const originalPort = parseInt(process.env.WEB_PORT || "3100");

  // Fresh server for each attempt. Recycling a server that has already
  // emitted an EADDRINUSE error has produced "Listen method has been
  // called more than once" crashes in the wild.
  //
  // IMPORTANT: do NOT attach the WebSocketServer yet. The `ws` library
  // installs its own event plumbing on the http.Server in its
  // constructor, which causes bind errors to escape as uncaught
  // exceptions. We only attach it AFTER listen() has succeeded.
  const server = http.createServer(handleWebRequest);

  // Double-invocation guard: on some Node versions `server.listen`
  // both throws synchronously AND emits an `error` event for the same
  // bind failure. Without the guard we'd climb the ladder twice in
  // parallel and end up with two retry cascades racing each other.
  let handled = false;

  const cleanupDeadAttempt = () => {
    try { server.removeAllListeners("error"); } catch { /* ignore */ }
    try { server.close(() => { /* noop */ }); } catch { /* ignore */ }
  };

  const handleBindFailure = (err: NodeJS.ErrnoException): void => {
    if (handled) return;
    handled = true;
    cleanupDeadAttempt();
    if (stopRequested) return;

    const action = decideNextBindAction(err, attempt, {
      originalPort,
      maxPortTries: MAX_PORT_TRIES,
      backgroundRetryMs: BACKGROUND_RETRY_MS,
    });

    if (action.type === "retry-port") {
      console.warn(`[web] port ${port} busy (${err.code || err.message}) — trying ${action.port}`);
      scheduleBindAttempt(action.port, action.attempt);
      return;
    }

    // action.type === "retry-background"
    console.warn(
      `[web] bind failed (${err.code || err.message}) — ` +
      `backing off ${action.delayMs / 1000}s then retrying port ${action.port}. ` +
      `Bot is unaffected; Telegram remains live.`,
    );
    bindRetryTimer = setTimeout(() => {
      bindRetryTimer = null;
      scheduleBindAttempt(action.port, 0);
    }, action.delayMs);
  };

  // Use `on` (not `once`) so a pathological server that emits two
  // error events for a single failure doesn't leave the second one
  // uncaught. The `handled` guard makes the handler idempotent.
  server.on("error", handleBindFailure);

  // Defensive try/catch — `server.listen()` usually emits async errors,
  // but certain Node versions + edge cases (already-listening server,
  // invalid backlog, kernel hiccup) can throw synchronously. Catch here
  // so the main routine never crashes during web-UI bind.
  try {
    // v4.20.2 — bind to config.webHost (default 127.0.0.1) so the Web UI
    // is loopback-only unless the operator opts in by setting WEB_HOST=0.0.0.0.
    // Empty/"*" maps to all interfaces.
    const bindHost = (config.webHost === "*" || config.webHost === "") ? undefined : config.webHost;
    server.listen(port, bindHost as string | undefined, () => {
      if (handled) return; // Should be impossible; paranoia.
      handled = true;

      // Now — and only now — attach the WebSocketServer. Before the
      // bind succeeded, the ws library's constructor would hijack the
      // http.Server's error event chain and let EADDRINUSE escape as
      // uncaught. Post-bind is safe.
      const wss = new WebSocketServer({ server });
      handleWebSocket(wss);

      currentServer = server;
      wsServerRef = wss;
      actualWebPort = port;

      // Remove the bind error handler — post-listen errors (socket
      // errors, close events) should not kick off a spurious retry
      // cycle. Install a quiet logger for any stray error events so
      // they can't escape as uncaught.
      server.removeListener("error", handleBindFailure);
      server.on("error", (err) => {
        console.warn(`[web] post-bind server error (ignored): ${err.message}`);
      });
      const bindLabel = bindHost && bindHost !== "127.0.0.1" && bindHost !== "::1"
        ? `http://${bindHost}:${actualWebPort}` + (bindHost === "0.0.0.0" ? " (LAN-reachable)" : "")
        : `http://localhost:${actualWebPort}`;
      console.log(`🌐 Web UI: ${bindLabel}`);
      if (actualWebPort !== originalPort) {
        console.log(`   (Port ${originalPort} was busy, using ${actualWebPort} instead)`);
      }
      if (bindHost === "0.0.0.0" && !process.env.WEB_PASSWORD) {
        console.warn(
          "⚠️ Web UI is bound to 0.0.0.0 but WEB_PASSWORD is empty — anyone on the LAN can log in. " +
            "Set WEB_PASSWORD in ~/.alvin-bot/.env or set WEB_HOST=127.0.0.1."
        );
      }
    });
  } catch (err) {
    handleBindFailure(err as NodeJS.ErrnoException);
  }
}

/**
 * Gracefully close a specific http.Server — the low-level building
 * block. Exported for tests and for any future callers that manage
 * their own servers. Production bot code uses `stopWebServer()` below
 * which operates on the module-global current server instead.
 *
 * What this does:
 *   1. Force-close idle keep-alive sockets (Node 18.2+).
 *   2. Force-close active open requests (long-poll clients).
 *   3. Await `server.close()` so the listening socket is truly freed.
 *
 * Safe to call on already-closed, never-listened, or mid-listen servers.
 * Never throws.
 */
export async function closeHttpServerGracefully(server: http.Server): Promise<void> {
  if (!server.listening) return;
  try {
    const s = server as http.Server & {
      closeIdleConnections?: () => void;
      closeAllConnections?: () => void;
    };
    if (typeof s.closeIdleConnections === "function") s.closeIdleConnections();
    if (typeof s.closeAllConnections === "function") s.closeAllConnections();
  } catch { /* ignore */ }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Stop the web server: cancel any pending background-retry, close
 * WebSocket clients, then gracefully close the HTTP server.
 *
 * Idempotent — safe to call multiple times, and safe to call before
 * startWebServer() ever successfully bound. Never throws.
 */
export async function stopWebServer(): Promise<void> {
  stopRequested = true;

  // Cancel any pending background-retry timer so a late retry doesn't
  // grab the port AFTER we thought we'd shut everything down.
  if (bindRetryTimer) {
    clearTimeout(bindRetryTimer);
    bindRetryTimer = null;
  }

  // Tear down the WebSocket server first so its sockets can't keep
  // the underlying http.Server alive.
  if (wsServerRef) {
    try {
      for (const client of wsServerRef.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => wsServerRef!.close(() => resolve()));
    } catch { /* ignore */ }
    wsServerRef = null;
  }

  if (currentServer) {
    try {
      await closeHttpServerGracefully(currentServer);
    } catch { /* ignore */ }
    currentServer = null;
  }
}

/** Get the actual port the Web UI is running on. */
export function getWebPort(): number {
  return actualWebPort;
}
