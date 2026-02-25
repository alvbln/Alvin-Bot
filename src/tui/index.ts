#!/usr/bin/env node
/**
 * Alvin Bot TUI — Terminal Chat Interface
 *
 * A full-screen terminal UI that connects to the running Alvin Bot instance
 * via WebSocket (same as Web UI). Features:
 *
 * - Streaming chat with AI responses
 * - Tool use indicators
 * - Model switching (/model)
 * - Status bar (model, cost, uptime)
 * - Color-coded messages
 * - Input history (↑/↓)
 * - Multi-line input (Shift+Enter)
 *
 * Usage: alvin-bot tui [--port 3100] [--host localhost]
 */

import { createInterface, Interface } from "readline";
import WebSocket from "ws";
import http from "http";

// ── ANSI Colors & Styles ────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  // Foreground
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  // Bright
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",

  // Background
  bgBlack: "\x1b[40m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgGray: "\x1b[100m",
};

// ── State ───────────────────────────────────────────────

let ws: WebSocket | null = null;
let rl: Interface;
let connected = false;
let currentModel = "loading...";
let totalCost = 0;
let isStreaming = false;
let currentResponse = "";
let currentToolName = "";
let toolCount = 0;
const inputHistory: string[] = [];
let historyIndex = -1;
const host: string = process.argv.includes("--host")
  ? process.argv[process.argv.indexOf("--host") + 1] || "localhost"
  : "localhost";
const port: number = process.argv.includes("--port")
  ? parseInt(process.argv[process.argv.indexOf("--port") + 1]) || 3100
  : 3100;
const baseUrl = `http://${host}:${port}`;
const wsUrl = `ws://${host}:${port}`;

// ── Screen Drawing ──────────────────────────────────────

function getWidth(): number {
  return process.stdout.columns || 80;
}

function clearLine(): void {
  process.stdout.write("\r\x1b[K");
}

function moveCursorUp(n: number): void {
  if (n > 0) process.stdout.write(`\x1b[${n}A`);
}

function drawHeader(): void {
  const w = getWidth();
  const statusDot = connected ? `${C.brightGreen}●${C.reset}` : `${C.red}●${C.reset}`;
  const status = connected ? "Connected" : "Disconnected";
  const modelStr = `${C.brightMagenta}${currentModel}${C.reset}`;
  const costStr = totalCost > 0 ? ` ${C.gray}· $${totalCost.toFixed(4)}${C.reset}` : "";

  const title = `${C.bold}${C.brightCyan}🤖 Alvin Bot TUI${C.reset}`;
  const right = `${statusDot} ${status} ${C.gray}│${C.reset} ${modelStr}${costStr}`;

  // Top border
  console.log(`${C.gray}${"─".repeat(w)}${C.reset}`);
  console.log(`  ${title}${"".padEnd(10)}${right}`);
  console.log(`${C.gray}${"─".repeat(w)}${C.reset}`);
}

function drawHelp(): void {
  console.log(`
${C.bold}Befehle:${C.reset}
  ${C.cyan}/model${C.reset}        Model wechseln
  ${C.cyan}/status${C.reset}       Bot-Status anzeigen
  ${C.cyan}/clear${C.reset}        Chat löschen
  ${C.cyan}/cron${C.reset}         Cron-Jobs anzeigen
  ${C.cyan}/doctor${C.reset}       Health-Check
  ${C.cyan}/backup${C.reset}       Backup erstellen
  ${C.cyan}/restart${C.reset}      Bot neustarten
  ${C.cyan}/help${C.reset}         Diese Hilfe
  ${C.cyan}/quit${C.reset}         Beenden (oder Ctrl+C)

${C.dim}Enter = Senden · ↑/↓ = History · Ctrl+C = Beenden${C.reset}
`);
}

function printUser(text: string): void {
  console.log(`\n${C.bold}${C.brightGreen}Du:${C.reset} ${text}`);
}

function printAssistantStart(): void {
  process.stdout.write(`\n${C.bold}${C.brightBlue}Alvin Bot:${C.reset} `);
}

function printAssistantDelta(text: string): void {
  process.stdout.write(text);
}

function printAssistantEnd(cost?: number): void {
  const costStr = cost && cost > 0 ? ` ${C.dim}($${cost.toFixed(4)})${C.reset}` : "";
  console.log(costStr);
}

function printTool(name: string): void {
  clearLine();
  process.stdout.write(`\r  ${C.yellow}⚙ ${name}...${C.reset}`);
}

function printToolDone(): void {
  clearLine();
  if (toolCount > 0) {
    console.log(`  ${C.dim}${C.yellow}⚙ ${toolCount} tool${toolCount > 1 ? "s" : ""} used${C.reset}`);
  }
  toolCount = 0;
}

function printError(msg: string): void {
  console.log(`\n${C.red}✖ ${msg}${C.reset}`);
}

function printInfo(msg: string): void {
  console.log(`${C.cyan}ℹ ${msg}${C.reset}`);
}

function printSuccess(msg: string): void {
  console.log(`${C.green}✔ ${msg}${C.reset}`);
}

function showPrompt(): void {
  if (!isStreaming) {
    rl.setPrompt(`${C.brightGreen}❯${C.reset} `);
    rl.prompt();
  }
}

// ── WebSocket Connection ────────────────────────────────

function connectWebSocket(): void {
  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    connected = true;
    printInfo("Verbunden mit Alvin Bot");
    showPrompt();
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(msg);
    } catch { /* ignore */ }
  });

  ws.on("close", () => {
    connected = false;
    isStreaming = false;
    printError("Verbindung verloren. Reconnect in 3s...");
    setTimeout(connectWebSocket, 3000);
  });

  ws.on("error", () => {
    // Error is followed by close event
  });
}

function handleMessage(msg: any): void {
  switch (msg.type) {
    case "text":
      if (!isStreaming) {
        isStreaming = true;
        // End tool indicator line if present
        if (currentToolName) {
          printToolDone();
          currentToolName = "";
        }
        printAssistantStart();
      }
      if (msg.delta) {
        printAssistantDelta(msg.delta);
        currentResponse += msg.delta;
      }
      break;

    case "tool":
      if (!isStreaming) isStreaming = true;
      toolCount++;
      currentToolName = msg.name || "tool";
      printTool(currentToolName);
      break;

    case "fallback":
      printInfo(`Fallback: ${msg.from} → ${msg.to}`);
      break;

    case "done":
      if (isStreaming) {
        printAssistantEnd(msg.cost);
      }
      if (msg.cost) totalCost += msg.cost;
      isStreaming = false;
      currentResponse = "";
      currentToolName = "";
      showPrompt();
      break;

    case "error":
      printError(msg.error || "Unknown error");
      isStreaming = false;
      showPrompt();
      break;

    case "reset":
      printInfo("Session zurückgesetzt");
      showPrompt();
      break;
  }
}

// ── API Calls ───────────────────────────────────────────

async function apiGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); }
      });
    }).on("error", reject);
  });
}

async function apiPost(path: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = http.request(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// ── Commands ────────────────────────────────────────────

async function handleCommand(cmd: string): Promise<void> {
  const parts = cmd.slice(1).split(/\s+/);
  const command = parts[0].toLowerCase();

  switch (command) {
    case "help":
    case "h":
      drawHelp();
      break;

    case "model":
    case "m": {
      try {
        const data = await apiGet("/api/models");
        console.log(`\n${C.bold}Models:${C.reset}`);
        if (data.models) {
          for (const m of data.models) {
            const active = m.key === data.active ? `${C.brightGreen} ◀ aktiv${C.reset}` : "";
            const status = m.status === "ready" ? `${C.green}✓${C.reset}` : `${C.dim}✗${C.reset}`;
            console.log(`  ${status} ${C.bold}${m.key}${C.reset} ${C.dim}(${m.model || m.name})${C.reset}${active}`);
          }
        }
        console.log(`\n${C.dim}Model wechseln: /model <key>${C.reset}`);

        if (parts[1]) {
          const res = await apiPost("/api/models/switch", { key: parts[1] });
          if (res.ok) {
            currentModel = res.active || parts[1];
            printSuccess(`Model gewechselt zu: ${currentModel}`);
          } else {
            printError(res.error || "Fehler beim Wechseln");
          }
        }
      } catch (err) {
        printError(`Konnte Models nicht laden: ${(err as Error).message}`);
      }
      break;
    }

    case "status":
    case "s": {
      try {
        const data = await apiGet("/api/status");
        console.log(`\n${C.bold}${C.brightCyan}Bot Status${C.reset}`);
        console.log(`${C.gray}${"─".repeat(40)}${C.reset}`);
        if (data.model) {
          console.log(`  ${C.cyan}Model:${C.reset}    ${data.model.model || data.model.name || "?"}`);
          console.log(`  ${C.cyan}Provider:${C.reset} ${data.model.name || "?"}`);
          console.log(`  ${C.cyan}Status:${C.reset}   ${data.model.status || "?"}`);
        }
        if (data.bot) {
          const upH = Math.floor((data.bot.uptime || 0) / 3600);
          const upM = Math.floor(((data.bot.uptime || 0) % 3600) / 60);
          console.log(`  ${C.cyan}Version:${C.reset}  ${data.bot.version || "?"}`);
          console.log(`  ${C.cyan}Uptime:${C.reset}   ${upH}h ${upM}m`);
        }
        if (data.memory) {
          console.log(`  ${C.cyan}Memory:${C.reset}   ${data.memory.vectors || 0} Embeddings`);
        }
        console.log(`  ${C.cyan}Plugins:${C.reset}  ${data.plugins || 0}`);
        console.log(`  ${C.cyan}Tools:${C.reset}    ${data.tools || 0}`);
        console.log(`  ${C.cyan}Users:${C.reset}    ${data.users || 0}`);
        console.log("");
      } catch (err) {
        printError(`Status nicht verfügbar: ${(err as Error).message}`);
      }
      break;
    }

    case "cron": {
      try {
        const data = await apiGet("/api/cron");
        console.log(`\n${C.bold}Cron Jobs${C.reset}`);
        console.log(`${C.gray}${"─".repeat(40)}${C.reset}`);
        if (!data.jobs || data.jobs.length === 0) {
          console.log(`  ${C.dim}Keine Cron-Jobs konfiguriert.${C.reset}`);
        } else {
          for (const job of data.jobs) {
            const status = job.enabled ? `${C.green}●${C.reset}` : `${C.red}●${C.reset}`;
            const schedule = job.schedule || job.interval || "?";
            console.log(`  ${status} ${C.bold}${job.name}${C.reset} ${C.dim}(${schedule})${C.reset} — ${job.type}`);
          }
        }
        console.log("");
      } catch (err) {
        printError(`Cron nicht verfügbar: ${(err as Error).message}`);
      }
      break;
    }

    case "doctor": {
      try {
        printInfo("Scanne...");
        const data = await apiGet("/api/doctor");
        const icons: Record<string, string> = { error: `${C.red}✖`, warning: `${C.yellow}⚠`, info: `${C.blue}ℹ` };
        console.log(`\n${C.bold}Health-Check${C.reset}`);
        console.log(`${C.gray}${"─".repeat(40)}${C.reset}`);
        for (const issue of data.issues || []) {
          const icon = icons[issue.severity] || "?";
          console.log(`  ${icon} ${C.bold}${issue.category}${C.reset} — ${issue.message}${C.reset}`);
          if (issue.fix) console.log(`    ${C.dim}💡 ${issue.fix}${C.reset}`);
        }
        console.log("");
      } catch (err) {
        printError(`Doctor nicht verfügbar: ${(err as Error).message}`);
      }
      break;
    }

    case "backup": {
      try {
        printInfo("Erstelle Backup...");
        const data = await apiPost("/api/backups/create", {});
        if (data.ok) {
          printSuccess(`Backup "${data.id}" erstellt (${data.files.length} Dateien)`);
        } else {
          printError(data.error || "Fehlgeschlagen");
        }
      } catch (err) {
        printError(`Backup-Fehler: ${(err as Error).message}`);
      }
      break;
    }

    case "restart": {
      printInfo("Bot wird neugestartet...");
      try {
        await apiPost("/api/restart", {});
        printSuccess("Restart ausgelöst. Reconnect in 3s...");
      } catch {
        printError("Restart-Befehl konnte nicht gesendet werden");
      }
      break;
    }

    case "clear":
    case "c":
      console.clear();
      drawHeader();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "reset" }));
      }
      break;

    case "quit":
    case "q":
    case "exit":
      console.log(`\n${C.dim}Tschüss! 👋${C.reset}\n`);
      process.exit(0);
      break;

    default:
      // Send as chat message (just forward the full text including /)
      sendChat(cmd);
      return;
  }

  showPrompt();
}

function sendChat(text: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    printError("Nicht verbunden. Warte auf Reconnect...");
    showPrompt();
    return;
  }

  printUser(text);
  ws.send(JSON.stringify({ type: "chat", text }));

  // Add to history
  if (inputHistory[0] !== text) {
    inputHistory.unshift(text);
    if (inputHistory.length > 100) inputHistory.pop();
  }
  historyIndex = -1;
}

// ── Init ────────────────────────────────────────────────

async function fetchInitialModel(): Promise<void> {
  try {
    const data = await apiGet("/api/status");
    if (data.model?.model) {
      currentModel = data.model.model;
    } else if (data.model?.name) {
      currentModel = data.model.name;
    }
  } catch { /* will get it on connect */ }
}

export async function startTUI(): Promise<void> {
  // Clear screen and draw header
  console.clear();
  drawHeader();
  console.log(`${C.dim}Verbinde mit ${baseUrl}...${C.reset}\n`);
  drawHelp();

  // Setup readline
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 100,
  });

  // Handle input
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) {
      showPrompt();
      return;
    }

    if (text.startsWith("/")) {
      handleCommand(text);
    } else {
      sendChat(text);
    }
  });

  rl.on("close", () => {
    console.log(`\n${C.dim}Tschüss! 👋${C.reset}\n`);
    process.exit(0);
  });

  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    console.log(`\n${C.dim}Tschüss! 👋${C.reset}\n`);
    process.exit(0);
  });

  // Handle key events for history navigation
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false); // Let readline handle raw mode
  }

  // Fetch initial model info, then connect
  await fetchInitialModel();
  connectWebSocket();
}

// If run directly
const isDirectRun = process.argv[1]?.includes("tui");
if (isDirectRun) {
  startTUI().catch(console.error);
}
