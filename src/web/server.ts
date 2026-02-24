/**
 * Web Server — Local dashboard for Mr. Levin.
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
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { WebSocketServer, WebSocket } from "ws";
import { getRegistry } from "../engine.js";
import { getSession, resetSession, getAllSessions } from "../services/session.js";
import { getMemoryStats, loadLongTermMemory, loadDailyLog, appendDailyLog } from "../services/memory.js";
import { getIndexStats } from "../services/embeddings.js";
import { getLoadedPlugins } from "../services/plugins.js";
import { getMCPStatus } from "../services/mcp.js";
import { listProfiles } from "../services/users.js";
import { listCustomTools } from "../services/custom-tools.js";
import { buildSystemPrompt, reloadSoul, getSoulContent } from "../services/personality.js";
import { config } from "../config.js";
import type { QueryOptions, StreamChunk } from "../providers/types.js";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_FILE = resolve(BOT_ROOT, ".env");
const PUBLIC_DIR = resolve(BOT_ROOT, "web", "public");
const DOCS_DIR = resolve(BOT_ROOT, "docs");
const MEMORY_DIR = resolve(DOCS_DIR, "memory");

const WEB_PORT = parseInt(process.env.WEB_PORT || "3100");
const WEB_PASSWORD = process.env.WEB_PASSWORD || "";

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
  const token = cookie.match(/mrlevin_token=([a-f0-9]+)/)?.[1];
  return token ? activeSessions.has(token) : false;
}

// ── REST API ────────────────────────────────────────────

function handleAPI(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string, body: string): void {
  res.setHeader("Content-Type", "application/json");

  // POST /api/login
  if (urlPath === "/api/login" && req.method === "POST") {
    try {
      const { password } = JSON.parse(body);
      if (!WEB_PASSWORD || password === WEB_PASSWORD) {
        const token = generateToken();
        activeSessions.add(token);
        res.setHeader("Set-Cookie", `mrlevin_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
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

  // Auth check for all other API routes
  if (!checkAuth(req)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "Not authenticated" }));
    return;
  }

  // GET /api/status
  if (urlPath === "/api/status") {
    const registry = getRegistry();
    const active = registry.getActive().getInfo();
    const memory = getMemoryStats();
    const index = getIndexStats();
    const plugins = getLoadedPlugins();
    const mcp = getMCPStatus();
    const users = listProfiles();
    const tools = listCustomTools();

    res.end(JSON.stringify({
      bot: { version: "2.3.0", uptime: process.uptime() },
      model: { name: active.name, model: active.model, status: active.status },
      memory: { ...memory, vectors: index.entries, indexSize: index.sizeBytes },
      plugins: plugins.length,
      mcp: mcp.length,
      users: users.length,
      tools: tools.length,
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
        fs.writeFileSync(resolve(DOCS_DIR, "MEMORY.md"), content);
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

  // GET /api/users
  if (urlPath === "/api/users") {
    res.end(JSON.stringify({ users: listProfiles() }));
    return;
  }

  // GET /api/tools
  if (urlPath === "/api/tools") {
    res.end(JSON.stringify({ tools: listCustomTools() }));
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
    const data = sessions.map(s => {
      const profile = profiles.find(p => p.userId === s.userId);
      return {
        userId: s.userId,
        name: profile?.name || `User ${s.userId}`,
        username: profile?.username,
        messageCount: s.session.messageCount,
        toolUseCount: s.session.toolUseCount,
        totalCost: s.session.totalCost,
        effort: s.session.effort,
        startedAt: s.session.startedAt,
        lastActivity: s.session.lastActivity,
        historyLength: s.session.history.length,
        isProcessing: s.session.isProcessing,
        provider: Object.keys(s.session.queriesByProvider).join(", ") || "none",
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
        // Read file content (text files only, max 100KB)
        if (stat.size > 100_000) {
          res.end(JSON.stringify({ path: reqPath, content: `[File too large: ${(stat.size / 1024).toFixed(1)} KB]`, size: stat.size }));
        } else {
          const content = fs.readFileSync(basePath, "utf-8");
          res.end(JSON.stringify({ path: reqPath, content, size: stat.size }));
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
      if (command.length > 1000) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Command too long" }));
        return;
      }
      const output = execSync(command, {
        cwd: BOT_ROOT,
        stdio: "pipe",
        timeout: 30000,
        env: process.env,
      }).toString();
      res.end(JSON.stringify({ output: output.slice(0, 50000) }));
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
      fs.writeFileSync(ENV_FILE, envContent);
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
      const soulPath = resolve(BOT_ROOT, "SOUL.md");
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
    res.end(JSON.stringify({ ok: true, note: "Restarting..." }));
    setTimeout(() => process.exit(0), 500); // PM2 will auto-restart
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
          const prefix = m.role === "user" ? "**Du:**" : m.role === "assistant" ? "**Mr. Levin:**" : "*System:*";
          const time = m.time ? ` _(${m.time})_` : "";
          return `${prefix}${time}\n${m.text}\n`;
        }).join("\n---\n\n");
        res.setHeader("Content-Type", "text/markdown");
        res.end(`# Chat Export — Mr. Levin\n_${new Date().toLocaleString("de-DE")}_\n\n---\n\n${md}`);
      }
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
}

// ── WebSocket Chat ──────────────────────────────────────

function handleWebSocket(wss: WebSocketServer): void {
  wss.on("connection", (ws, req) => {
    // Auth check
    if (WEB_PASSWORD && !checkAuth(req)) {
      ws.close(4001, "Not authenticated");
      return;
    }

    console.log("WebUI: client connected");

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "chat") {
          const { text, effort } = msg;
          const userId = config.allowedUsers[0] || 0;

          const registry = getRegistry();
          const activeProvider = registry.getActive();
          const isSDK = activeProvider.config.type === "claude-sdk";
          const session = getSession(userId);

          const queryOpts: QueryOptions = {
            prompt: text,
            systemPrompt: buildSystemPrompt(isSDK, session.language),
            workingDir: session.workingDir,
            effort: effort || session.effort,
            sessionId: isSDK ? session.sessionId : null,
            history: !isSDK ? session.history : undefined,
          };

          // Stream response
          for await (const chunk of registry.queryWithFallback(queryOpts)) {
            if (ws.readyState !== WebSocket.OPEN) break;

            switch (chunk.type) {
              case "text":
                ws.send(JSON.stringify({ type: "text", text: chunk.text, delta: chunk.delta }));
                break;
              case "tool_use":
                ws.send(JSON.stringify({ type: "tool", name: chunk.toolName, input: chunk.toolInput }));
                break;
              case "done":
                if (chunk.sessionId) session.sessionId = chunk.sessionId;
                if (chunk.costUsd) session.totalCost += chunk.costUsd;
                ws.send(JSON.stringify({ type: "done", cost: chunk.costUsd, sessionId: chunk.sessionId }));
                break;
              case "error":
                ws.send(JSON.stringify({ type: "error", error: chunk.error }));
                break;
              case "fallback":
                ws.send(JSON.stringify({ type: "fallback", from: chunk.failedProvider, to: chunk.providerName }));
                break;
            }
          }
        }

        if (msg.type === "reset") {
          const userId = config.allowedUsers[0] || 0;
          resetSession(userId);
          ws.send(JSON.stringify({ type: "reset", ok: true }));
        }

      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ws.send(JSON.stringify({ type: "error", error }));
      }
    });

    ws.on("close", () => {
      console.log("WebUI: client disconnected");
    });
  });
}

// ── Start Server ────────────────────────────────────────

export function startWebServer(): http.Server {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const urlPath = (req.url || "/").split("?")[0];

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
  });

  const wss = new WebSocketServer({ server });
  handleWebSocket(wss);

  server.listen(WEB_PORT, () => {
    console.log(`🌐 Web UI: http://localhost:${WEB_PORT}`);
  });

  return server;
}
