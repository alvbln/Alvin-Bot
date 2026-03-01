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
 * - i18n: English (default) / German (--lang de)
 *
 * Usage: alvin-bot tui [--port 3100] [--host localhost] [--lang en|de]
 */

import { createInterface, Interface } from "readline";
import WebSocket from "ws";
import http from "http";
import { initI18n, t } from "../i18n.js";

// Init i18n before anything else
initI18n();

// ── ANSI Colors & Styles ────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",

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

// Track header line count for redraw
const HEADER_LINES = 3;

// ── Screen Drawing ──────────────────────────────────────

function getWidth(): number {
  return process.stdout.columns || 80;
}

function clearLine(): void {
  process.stdout.write("\r\x1b[K");
}

function drawHeader(): void {
  const w = getWidth();
  const statusDot = connected ? `${C.brightGreen}●${C.reset}` : `${C.red}●${C.reset}`;
  const status = connected ? t("tui.connected") : t("tui.disconnected");
  const modelStr = `${C.brightMagenta}${currentModel}${C.reset}`;
  const costStr = totalCost > 0 ? ` ${C.gray}· $${totalCost.toFixed(4)}${C.reset}` : "";

  const title = `${C.bold}${C.brightCyan}${t("tui.title")}${C.reset}`;
  const right = `${statusDot} ${status} ${C.gray}│${C.reset} ${modelStr}${costStr}`;

  console.log(`${C.gray}${"─".repeat(w)}${C.reset}`);
  console.log(`  ${title}${"".padEnd(10)}${right}`);
  console.log(`${C.gray}${"─".repeat(w)}${C.reset}`);
}

function redrawHeader(): void {
  // Save cursor, move to top, redraw header, restore cursor
  process.stdout.write("\x1b7");      // Save cursor position
  process.stdout.write("\x1b[H");     // Move to top-left (1,1)
  // Clear the 3 header lines
  for (let i = 0; i < HEADER_LINES; i++) {
    process.stdout.write("\x1b[K");   // Clear line
    if (i < HEADER_LINES - 1) process.stdout.write("\x1b[1B"); // Move down
  }
  process.stdout.write("\x1b[H");     // Back to top
  drawHeader();
  process.stdout.write("\x1b8");      // Restore cursor position
}

function drawHelp(): void {
  console.log(`
${C.bold}${t("help.title")}${C.reset}
  ${C.cyan}/model${C.reset}        ${t("help.model")}
  ${C.cyan}/status${C.reset}       ${t("help.status")}
  ${C.cyan}/clear${C.reset}        ${t("help.clear")}
  ${C.cyan}/cron${C.reset}         ${t("help.cron")}
  ${C.cyan}/doctor${C.reset}       ${t("help.doctor")}
  ${C.cyan}/backup${C.reset}       ${t("help.backup")}
  ${C.cyan}/restart${C.reset}      ${t("help.restart")}
  ${C.cyan}/help${C.reset}         ${t("help.help")}
  ${C.cyan}/quit${C.reset}         ${t("help.quit")}

${C.dim}${t("help.footer")}${C.reset}
`);
}

function printUser(text: string): void {
  console.log(`\n${C.bold}${C.brightGreen}${t("tui.you")}:${C.reset} ${text}`);
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
    const label = toolCount > 1 ? t("tui.toolsUsed") : t("tui.toolUsed");
    console.log(`  ${C.dim}${C.yellow}⚙ ${toolCount} ${label}${C.reset}`);
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
    redrawHeader();
    printInfo(t("tui.connectedTo"));
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
    redrawHeader();
    printError(t("tui.connectionLost"));
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
      printInfo(`${t("tui.fallback")} ${msg.from} → ${msg.to}`);
      break;

    case "done":
      if (isStreaming) {
        printAssistantEnd(msg.cost);
      }
      if (msg.cost) totalCost += msg.cost;
      isStreaming = false;
      currentResponse = "";
      currentToolName = "";
      redrawHeader(); // Update cost in header
      showPrompt();
      break;

    case "error":
      printError(msg.error || "Unknown error");
      isStreaming = false;
      showPrompt();
      break;

    case "reset":
      printInfo(t("tui.sessionReset"));
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
        console.log(`\n${C.bold}${t("tui.models")}:${C.reset}`);
        if (data.models) {
          for (const m of data.models) {
            const active = m.key === data.active ? `${C.brightGreen} ◀ ${t("tui.active")}${C.reset}` : "";
            const status = m.status === "ready" ? `${C.green}✓${C.reset}` : `${C.dim}✗${C.reset}`;
            console.log(`  ${status} ${C.bold}${m.key}${C.reset} ${C.dim}(${m.model || m.name})${C.reset}${active}`);
          }
        }
        console.log(`\n${C.dim}${t("tui.switchModel")} /model <key>${C.reset}`);

        if (parts[1]) {
          const res = await apiPost("/api/models/switch", { key: parts[1] });
          if (res.ok) {
            currentModel = res.active || parts[1];
            printSuccess(`${t("tui.switchedTo")}: ${currentModel}`);
            redrawHeader();
          } else {
            printError(res.error || t("tui.switchError"));
          }
        }
      } catch (err) {
        printError(`${t("tui.modelsError")}: ${(err as Error).message}`);
      }
      break;
    }

    case "status":
    case "s": {
      try {
        const data = await apiGet("/api/status");
        console.log(`\n${C.bold}${C.brightCyan}${t("status.title")}${C.reset}`);
        console.log(`${C.gray}${"─".repeat(40)}${C.reset}`);
        if (data.model) {
          console.log(`  ${C.cyan}${t("status.model")}${C.reset}    ${data.model.model || data.model.name || "?"}`);
          console.log(`  ${C.cyan}${t("status.provider")}${C.reset} ${data.model.name || "?"}`);
          console.log(`  ${C.cyan}${t("status.status")}${C.reset}   ${data.model.status || "?"}`);
        }
        if (data.bot) {
          const upH = Math.floor((data.bot.uptime || 0) / 3600);
          const upM = Math.floor(((data.bot.uptime || 0) % 3600) / 60);
          console.log(`  ${C.cyan}${t("status.version")}${C.reset}  ${data.bot.version || "?"}`);
          console.log(`  ${C.cyan}${t("status.uptime")}${C.reset}   ${upH}h ${upM}m`);
        }
        if (data.memory) {
          console.log(`  ${C.cyan}${t("status.memory")}${C.reset}   ${data.memory.vectors || 0} ${t("status.embeddings")}`);
        }
        console.log(`  ${C.cyan}${t("status.plugins")}${C.reset}  ${data.plugins || 0}`);
        console.log(`  ${C.cyan}${t("status.tools")}${C.reset}    ${data.tools || 0}`);
        console.log(`  ${C.cyan}${t("status.users")}${C.reset}    ${data.users || 0}`);
        console.log("");
      } catch (err) {
        printError(`${t("tui.statusError")}: ${(err as Error).message}`);
      }
      break;
    }

    case "cron": {
      try {
        const data = await apiGet("/api/cron");
        console.log(`\n${C.bold}Cron Jobs${C.reset}`);
        console.log(`${C.gray}${"─".repeat(40)}${C.reset}`);
        if (!data.jobs || data.jobs.length === 0) {
          console.log(`  ${C.dim}${t("tui.noCronJobs")}${C.reset}`);
        } else {
          for (const job of data.jobs) {
            const status = job.enabled ? `${C.green}●${C.reset}` : `${C.red}●${C.reset}`;
            const schedule = job.schedule || job.interval || "?";
            console.log(`  ${status} ${C.bold}${job.name}${C.reset} ${C.dim}(${schedule})${C.reset} — ${job.type}`);
          }
        }
        console.log("");
      } catch (err) {
        printError(`${t("tui.cronError")}: ${(err as Error).message}`);
      }
      break;
    }

    case "doctor": {
      try {
        printInfo(t("tui.scanning"));
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
        printError(`${t("tui.doctorError")}: ${(err as Error).message}`);
      }
      break;
    }

    case "backup": {
      try {
        printInfo(t("tui.creatingBackup"));
        const data = await apiPost("/api/backups/create", {});
        if (data.ok) {
          printSuccess(`${t("tui.backupCreated")} "${data.id}" (${data.files.length} files)`);
        } else {
          printError(data.error || t("tui.backupFailed"));
        }
      } catch (err) {
        printError(`${t("tui.backupError")}: ${(err as Error).message}`);
      }
      break;
    }

    case "restart": {
      printInfo(t("tui.botRestarting"));
      try {
        await apiPost("/api/restart", {});
        printSuccess(t("tui.restartTriggered"));
      } catch {
        printError(t("tui.restartFailed"));
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
      console.log(`\n${C.dim}${t("tui.bye")}${C.reset}\n`);
      process.exit(0);
      break;

    default:
      sendChat(cmd);
      return;
  }

  showPrompt();
}

function sendChat(text: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    printError(t("tui.notConnected"));
    showPrompt();
    return;
  }

  printUser(text);
  ws.send(JSON.stringify({ type: "chat", text }));

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
  console.clear();
  drawHeader();
  console.log(`${C.dim}${t("tui.connecting")} ${baseUrl}...${C.reset}\n`);
  drawHelp();

  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 100,
  });

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
    console.log(`\n${C.dim}${t("tui.bye")}${C.reset}\n`);
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log(`\n${C.dim}${t("tui.bye")}${C.reset}\n`);
    process.exit(0);
  });

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  await fetchInitialModel();
  connectWebSocket();
}

const isDirectRun = process.argv[1]?.includes("tui");
if (isDirectRun) {
  startTUI().catch(console.error);
}
