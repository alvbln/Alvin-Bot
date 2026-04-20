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
 * - i18n: English (default) / German (--lang de or ALVIN_LANG=de)
 *
 * Usage: alvin-bot tui [--port 3100] [--host localhost] [--lang en|de]
 */

import { createInterface, Interface, cursorTo, clearLine as rlClearLine } from "readline";
import WebSocket from "ws";
import http from "http";
import { initI18n, t } from "../i18n.js";
import { BOT_VERSION } from "../version.js";

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
let isMirrorStreaming = false;
let currentResponse = "";
let currentToolName = "";
let toolCount = 0;
const inputHistory: string[] = [];
let historyIndex = -1;

// ── v4.5.0: Session routing state ──────────────────────────────────────────
// The TUI can either chat in its own isolated session (default) or remote-
// control the Telegram session (target = telegram). Observer mode decides
// whether incoming Telegram events are mirrored into the TUI output.
type ChatTarget = "tui" | "telegram";
let activeTarget: ChatTarget = "tui";
let observerEnabled = true;

// TUI's own session key — either ephemeral (new every start) or persistent
// ("tui:local") if --resume is passed. Set once in startTUI().
let tuiSessionKey = `tui:ephemeral:${Date.now()}`;
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

/**
 * Clear the current readline input line so we can write content "above" the
 * prompt cleanly. Uses readline's own cursor API instead of raw escape
 * sequences — this cooperates with readline's internal cursor tracking.
 */
function clearCurrentLine(): void {
  cursorTo(process.stdout, 0);
  rlClearLine(process.stdout, 0);
}

function drawHeader(): void {
  const w = getWidth();
  const statusDot = connected ? `${C.brightGreen}●${C.reset}` : `${C.red}●${C.reset}`;
  const status = connected ? t("tui.connected") : t("tui.disconnected");
  const modelStr = `${C.brightMagenta}${currentModel}${C.reset}`;
  const costStr = totalCost > 0 ? ` ${C.gray}· $${totalCost.toFixed(4)}${C.reset}` : "";
  const targetStr = ` ${C.gray}│${C.reset} ${C.brightYellow}${activeTarget === "telegram" ? "→ Telegram" : "TUI session"}${C.reset}`;

  const title = `${C.bold}${C.brightCyan}${t("tui.title")}${C.reset}`;
  const right = `${statusDot} ${status} ${C.gray}│${C.reset} ${modelStr}${costStr}${targetStr}`;

  console.log(`${C.gray}${"─".repeat(w)}${C.reset}`);
  console.log(`  ${title}${"".padEnd(10)}${right}`);
  console.log(`${C.gray}${"─".repeat(w)}${C.reset}`);
}

/**
 * Redraw the header. The old "in-place" implementation used cursor save/
 * restore escape sequences and jumped to \x1b[H — but once the terminal
 * has scrolled past the original header, \x1b[H resolves to the current
 * viewport top (not the document top), which means the header gets
 * re-rendered inline in the middle of the content. That's what produced
 * the "header appears in the middle of the bot response" bug in 4.5.0.
 *
 * The only safe way to redraw the header in a scrolling terminal is to
 * clear the whole screen and redraw from scratch. Do that only in
 * explicit reset contexts (/clear, SIGWINCH resize, initial connect).
 * For mid-session cost/status updates, use inline info messages instead.
 */
function redrawHeader(opts: { clearScreen?: boolean } = {}): void {
  if (isStreaming) return;
  if (opts.clearScreen) {
    console.clear();
  }
  drawHeader();
  if (rl && !isStreaming) rl.prompt(true);
}

function drawHelp(): void {
  console.log(`
${C.bold}${t("help.title")}${C.reset}
  ${C.cyan}/model${C.reset}              ${t("help.model")}
  ${C.cyan}/status${C.reset}             ${t("help.status")}
  ${C.cyan}/clear${C.reset}              ${t("help.clear")}
  ${C.cyan}/cron${C.reset}               ${t("help.cron")}
  ${C.cyan}/doctor${C.reset}             ${t("help.doctor")}
  ${C.cyan}/backup${C.reset}             ${t("help.backup")}
  ${C.cyan}/restart${C.reset}            ${t("help.restart")}
  ${C.cyan}/target tui${C.reset}|${C.cyan}telegram${C.reset}  Switch where your messages go
  ${C.cyan}/observe on${C.reset}|${C.cyan}off${C.reset}       Mirror Telegram activity (default: on)
  ${C.cyan}/help${C.reset}               ${t("help.help")}
  ${C.cyan}/quit${C.reset}               ${t("help.quit")}

${C.dim}${t("help.footer")}${C.reset}
`);
}

function printUser(text: string): void {
  clearCurrentLine();
  console.log(`\n${C.bold}${C.brightGreen}${t("tui.you")}:${C.reset} ${text}`);
}

function printAssistantStart(): void {
  clearCurrentLine();
  const targetTag = activeTarget === "telegram" ? ` ${C.dim}[→ Tel]${C.reset}` : "";
  process.stdout.write(`\n${C.bold}${C.brightBlue}Alvin Bot${targetTag}:${C.reset} `);
}

function printAssistantDelta(text: string): void {
  process.stdout.write(text);
}

function printAssistantEnd(cost?: number): void {
  const costStr = cost && cost > 0 ? ` ${C.dim}($${cost.toFixed(4)})${C.reset}` : "";
  process.stdout.write(costStr + "\n");
}

function printTool(name: string): void {
  clearCurrentLine();
  process.stdout.write(`  ${C.yellow}⚙ ${name}...${C.reset}`);
}

function printToolDone(): void {
  clearCurrentLine();
  if (toolCount > 0) {
    const label = toolCount > 1 ? t("tui.toolsUsed") : t("tui.toolUsed");
    console.log(`  ${C.dim}${C.yellow}⚙ ${toolCount} ${label}${C.reset}`);
  }
  toolCount = 0;
}

function printError(msg: string): void {
  clearCurrentLine();
  console.log(`\n${C.red}✖ ${msg}${C.reset}`);
}

function printInfo(msg: string): void {
  clearCurrentLine();
  console.log(`${C.cyan}ℹ ${msg}${C.reset}`);
}

function printSuccess(msg: string): void {
  clearCurrentLine();
  console.log(`${C.green}✔ ${msg}${C.reset}`);
}

/**
 * Render the mirror of a Telegram event (user message or bot response).
 * Distinct styling: dim, phone prefix, grayed color.
 */
function printMirrorUser(text: string): void {
  clearCurrentLine();
  console.log(`\n${C.dim}${C.gray}📱 Tel User: ${text}${C.reset}`);
}
function printMirrorAssistantStart(): void {
  clearCurrentLine();
  process.stdout.write(`\n${C.dim}${C.gray}📱 Tel Bot: ${C.reset}`);
}
function printMirrorAssistantDelta(text: string): void {
  // Dim styling while streaming the mirrored response
  process.stdout.write(`${C.dim}${C.gray}${text}${C.reset}`);
}
function printMirrorAssistantEnd(): void {
  process.stdout.write("\n");
}

/**
 * The single source of truth for rendering the input prompt. Only ever
 * called at state-transition points (connect, done, error, command result)
 * and no-ops during streaming so the prompt never races with delta writes.
 */
function showPrompt(): void {
  if (isStreaming || !rl) return;
  rl.setPrompt(`${C.brightGreen}❯${C.reset} `);
  rl.prompt(true);
}

// ── WebSocket Connection ────────────────────────────────

function connectWebSocket(): void {
  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    connected = true;
    // No header redraw here — the header was already drawn at startTUI().
    // Calling redrawHeader() in a scrolled terminal re-renders it inline.
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
    // No header redraw — it would appear inline mid-chat.
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
      // NOTE: do NOT call redrawHeader() here. On a scrolled terminal it
      // renders the header inline at the viewport top, which looks like
      // the header appeared in the middle of the conversation. The total
      // cost is already shown inline at the end of each response.
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

    // ── v4.5.0: Telegram activity mirror events ────────────────────────
    // These arrive whenever someone interacts with the bot via Telegram,
    // regardless of what the TUI is currently doing. We render them
    // distinctly (dim + 📱 prefix) so they don't confuse themselves with
    // the user's own session.
    case "mirror:user_msg":
      if (!observerEnabled) break;
      printMirrorUser(msg.text || "");
      break;

    case "mirror:response_start":
      if (!observerEnabled) break;
      isMirrorStreaming = true;
      printMirrorAssistantStart();
      break;

    case "mirror:response_delta":
      if (!observerEnabled) break;
      if (!isMirrorStreaming) {
        isMirrorStreaming = true;
        printMirrorAssistantStart();
      }
      printMirrorAssistantDelta(msg.delta || "");
      break;

    case "mirror:response_done":
      if (!observerEnabled) break;
      if (isMirrorStreaming) {
        printMirrorAssistantEnd();
        isMirrorStreaming = false;
      }
      // Don't call showPrompt here — the user's own prompt state is
      // independent of mirror activity.
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
            // Header stays as-is (would appear inline otherwise) —
            // next /clear redraws it with the new model.
          } else {
            printError(res.error || t("tui.switchError"));
          }
        }
      } catch (err) {
        printError(`${t("tui.modelsError")}: ${(err as Error).message}`);
      }
      break;
    }

    case "version":
    case "v": {
      console.log(
        `\n${C.bold}${C.brightCyan}🤖 Alvin Bot${C.reset} ${C.dim}v${BOT_VERSION}${C.reset}`,
      );
      console.log(
        `${C.dim}Node ${process.version} · ${process.platform}/${process.arch}${C.reset}\n`,
      );
      break;
    }

    case "status":
    case "s": {
      try {
        const data = await apiGet("/api/status");
        console.log(`\n${C.bold}${C.brightCyan}🤖 Alvin Bot${C.reset} ${C.dim}v${BOT_VERSION}${C.reset}`);
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
      // /clear is the ONLY command that safely redraws the header, because
      // it wipes the entire screen first.
      redrawHeader({ clearScreen: true });
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "reset",
          target: activeTarget,
          sessionKey: activeTarget === "tui" ? tuiSessionKey : undefined,
        }));
      }
      break;

    case "target":
    case "t": {
      const val = (parts[1] || "").toLowerCase();
      if (val === "tui") {
        activeTarget = "tui";
        printSuccess("Target: TUI (your own isolated session)");
      } else if (val === "telegram" || val === "tel") {
        activeTarget = "telegram";
        printSuccess("Target: Telegram (your messages now go into the Telegram session — the bot replies in Telegram AND here)");
      } else {
        printInfo(`Current target: ${activeTarget}. Use /target tui or /target telegram.`);
      }
      break;
    }

    case "observe":
    case "o": {
      const val = (parts[1] || "").toLowerCase();
      if (val === "on" || val === "1" || val === "true") {
        observerEnabled = true;
        printSuccess("Observer mode: ON — Telegram activity will be mirrored here (dim)");
      } else if (val === "off" || val === "0" || val === "false") {
        observerEnabled = false;
        printSuccess("Observer mode: OFF — Telegram activity will NOT be shown here");
      } else {
        printInfo(`Observer: ${observerEnabled ? "on" : "off"}. Use /observe on or /observe off.`);
      }
      break;
    }

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
  // v4.5.0: include target + sessionKey so the web server routes the
  // message to the right session. For target=tui, sessionKey is the
  // TUI's own ephemeral (or persistent) key; for target=telegram,
  // the server resolves it to the primary Telegram user's key.
  ws.send(JSON.stringify({
    type: "chat",
    text,
    target: activeTarget,
    sessionKey: activeTarget === "tui" ? tuiSessionKey : undefined,
  }));

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
  // --resume: use persistent TUI session (survives restarts).
  // Default: ephemeral session, fresh every TUI start.
  const wantResume = process.argv.includes("--resume");
  tuiSessionKey = wantResume ? "tui:local" : `tui:ephemeral:${Date.now()}`;

  console.clear();
  drawHeader();
  console.log(`${C.dim}${t("tui.connecting")} ${baseUrl}...${C.reset}`);
  console.log(`${C.dim}Session: ${wantResume ? "resuming tui:local (persistent)" : "new ephemeral session"}${C.reset}\n`);
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

  // NOTE: Do NOT call process.stdin.setRawMode(false) here. readline with
  // `terminal: true` already controls the terminal mode, and forcing cooked
  // mode on top of that causes every keystroke to be echoed TWICE (once by
  // the terminal, once by readline's line editor) — producing the classic
  // "hheelllloo" double-echo bug. Let readline manage the tty mode itself.

  // Handle terminal resize — we can't safely redraw the header in place
  // on a scrolled buffer. Just re-render the prompt so readline picks up
  // the new width for its line editor.
  process.stdout.on("resize", () => {
    if (!isStreaming) showPrompt();
  });

  await fetchInitialModel();
  connectWebSocket();
}

const isDirectRun = process.argv[1]?.includes("tui");
if (isDirectRun) {
  startTUI().catch(console.error);
}
