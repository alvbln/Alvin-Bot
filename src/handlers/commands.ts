import type { Bot } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import fs from "fs";
import path, { resolve } from "path";
import os from "os";
import { getSession, resetSession, markSessionDirty, getTelegramWorkspace, setTelegramWorkspace, type EffortLevel } from "../services/session.js";
import { listWorkspaces, getWorkspace } from "../services/workspaces.js";
import { getRegistry } from "../engine.js";
import { reloadSoul } from "../services/personality.js";
import { parseDuration, createReminder, listReminders, cancelReminder } from "../services/reminders.js";
import { writeSessionSummary, getMemoryStats, appendDailyLog } from "../services/memory.js";
import {
  approveGroup, blockGroup, removeGroup, listGroups,
  getSettings, setForwardingAllowed, setAutoApprove,
} from "../services/access.js";
import { generateImage } from "../services/imagegen.js";
import { searchMemory, reindexMemory, getIndexStats } from "../services/embeddings.js";
import { listProfiles, addUserNote } from "../services/users.js";
import { getLoadedPlugins, getPluginsDir } from "../services/plugins.js";
import { getMCPStatus, getMCPTools, callMCPTool } from "../services/mcp.js";
import { listCustomTools, executeCustomTool, hasCustomTools } from "../services/custom-tools.js";
import { screenshotUrl, extractText, generatePdf, hasPlaywright } from "../services/browser.js";
import { writeEnvVar } from "../services/env-file.js";
import { listJobs, createJob, deleteJob, toggleJob, runJobNow, formatNextRun, humanReadableSchedule, type JobType } from "../services/cron.js";
import { resolveJobByNameOrId } from "../services/cron-resolver.js";
import { buildTickerText, buildDoneText, escapeMarkdown } from "./cron-progress.js";
import { isHarmlessTelegramError } from "../util/telegram-error-filter.js";
import { storePassword, revokePassword, getSudoStatus, verifyPassword, sudoExec } from "../services/sudo.js";
import { config } from "../config.js";
import { BOT_VERSION } from "../version.js";
import { getWebPort } from "../web/server.js";
import { getUsageSummary, getRateLimits, getAllRateLimits, formatTokens } from "../services/usage-tracker.js";
import { runUpdate, getAutoUpdate, setAutoUpdate, startAutoUpdateLoop } from "../services/updater.js";
import { getReleaseHighlights } from "../services/release-highlights.js";
import { getHealthStatus, isFailedOver } from "../services/heartbeat.js";
import { t, LOCALE_NAMES, LOCALE_FLAGS, type Locale } from "../i18n.js";

// Kick off auto-update loop on module load if the persistent flag is set.
// Doing this as a module side-effect avoids touching the bot entry point.
if (getAutoUpdate()) {
  // 30s delay so the bot is fully started before the first check
  setTimeout(() => startAutoUpdateLoop(), 30_000);
}

/** Bot start time for uptime tracking */
const botStartTime = Date.now();

/** Format bytes to human-readable */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Render a working directory path with a meaningful label.
 * Home → 🏠 ~ (Home), anywhere under home → 📁 ~/rel/path, absolute → 📁 /path */
function formatWorkingDir(workingDir: string, locale: Locale): string {
  const home = os.homedir();
  if (workingDir === home) {
    return `🏠 \`~\` _(${t("bot.status.homeLabel", locale)})_`;
  }
  if (workingDir.startsWith(home + "/")) {
    return `📁 \`~${workingDir.slice(home.length)}\``;
  }
  return `📁 \`${workingDir}\``;
}

/** Format a raw token count for the context progress line.
 * Keeps precision tight — "450k/1M" not "450.2k/1.0M". */
function formatContextTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  const m = n / 1_000_000;
  return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}

/** Human relative-time rendered in the user's locale. */
function formatRelativeTime(ms: number, locale: Locale): string {
  const s = Math.floor(ms / 1000);
  if (s < 10) return t("bot.time.justNow", locale);
  if (s < 60) return t("bot.time.secondsAgo", locale, { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("bot.time.minutesAgo", locale, { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("bot.time.hoursAgo", locale, { n: h });
  const d = Math.floor(h / 24);
  return t(d === 1 ? "bot.time.dayAgo" : "bot.time.daysAgo", locale, { n: d });
}

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low — Quick, concise answers",
  medium: "Medium — Moderate reasoning depth",
  high: "High — Deep reasoning (default)",
  max: "Max — Maximum effort (Opus only)",
};

export function registerCommands(bot: Bot): void {
  bot.command("ping", async (ctx) => {
    const start = Date.now();
    const registry = getRegistry();
    const active = registry.getActive();
    const info = active.getInfo();
    const latency = Date.now() - start;
    await ctx.reply(`🏓 Pong! (${latency}ms)\n${info.name} ${info.status}`);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `🤖 *Alvin Bot — Commands*\n\n` +
      `💬 *Chat*\n` +
      `Just write — I'll respond.\n` +
      `I also understand voice messages & photos.\n\n` +
      `⚙️ *Controls*\n` +
      `/model — Switch AI model\n` +
      `/fallback — Provider order\n` +
      `/effort — Set reasoning depth\n` +
      `/voice — Voice replies on/off\n` +
      `/dir <path> — Working directory\n\n` +
      `🧭 *Workspaces*\n` +
      `/workspaces — List all workspaces\n` +
      `/workspace <name> — Switch active workspace\n` +
      `/workspace default — Reset to default\n\n` +
      `🎨 *Extras*\n` +
      `/imagine <prompt> — Generate image\n` +
      `/remind <time> <text> — Set reminder\n` +
      `/export — Export conversation\n\n` +
      `🧠 *Memory*\n` +
      `/recall <query> — Semantic search\n` +
      `/remember <text> — Remember something\n` +
      `/reindex — Re-index memory\n\n` +
      `🌐 *Browser*\n` +
      `/browse <URL> — Screenshot\n` +
      `/browse text <URL> — Extract text\n` +
      `/browse pdf <URL> — Save as PDF\n\n` +
      `🔌 *Extensions*\n` +
      `/plugins — Loaded plugins\n` +
      `/mcp — MCP servers & tools\n` +
      `/users — User profiles\n\n` +
      `🖥️ *Web UI*\n` +
      `/webui — Open Web UI in browser\n\n` +
      `📊 *Session*\n` +
      `/status — Current status\n` +
      `/new — Start new session\n` +
      `/cancel — Cancel running request\n\n` +
      `🔧 *Ops*\n` +
      `/restart — Restart the bot\n` +
      `/update — Pull latest + rebuild + restart\n` +
      `/autoupdate on|off — Auto-update loop (6h)\n\n` +
      `_Tip: Send me documents, photos, or voice messages!_\n` +
      `_In groups: @mention me or reply to my messages._`,
      { parse_mode: "Markdown" }
    );
  });

  // Register bot commands in Telegram's menu
  bot.api.setMyCommands([
    { command: "help", description: "Show all commands" },
    { command: "model", description: "Switch AI model" },
    { command: "effort", description: "Set reasoning depth" },
    { command: "voice", description: "Voice replies on/off" },
    { command: "status", description: "Current status" },
    { command: "version", description: "Show Alvin Bot version" },
    { command: "new", description: "Start new session" },
    { command: "dir", description: "Change working directory" },
    { command: "workspaces", description: "List all workspaces" },
    { command: "workspace", description: "Switch active workspace" },
    { command: "web", description: "Quick web search" },
    { command: "imagine", description: "Generate image (e.g. /imagine A fox)" },
    { command: "remind", description: "Set reminder (e.g. /remind 30m Text)" },
    { command: "export", description: "Export conversation" },
    { command: "recall", description: "Semantic memory search" },
    { command: "remember", description: "Remember something" },
    { command: "cron", description: "Manage scheduled jobs" },
    { command: "subagents", description: "Manage background sub-agents" },
    { command: "webui", description: "Open Web UI in browser" },
    { command: "setup", description: "Configure API keys & platforms" },
    { command: "cancel", description: "Cancel running request" },
    { command: "restart", description: "Restart the bot" },
    { command: "update", description: "Pull latest, build, restart" },
    { command: "autoupdate", description: "Auto-update on|off|status" },
  ]).catch(err => console.error("Failed to set bot commands:", err));

  bot.command("start", async (ctx) => {
    const registry = getRegistry();
    const activeInfo = registry.getActive().getInfo();

    await ctx.reply(
      `👋 *Hey! I'm Alvin Bot.*\n\n` +
      `Your autonomous AI assistant on Telegram. Just write me — ` +
      `I understand text, voice messages, photos, and documents.\n\n` +
      `🤖 Model: *${activeInfo.name}*\n` +
      `🧠 Reasoning: High\n\n` +
      `Type /help for all commands.`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("webui", async (ctx) => {
    const port = getWebPort();
    const url = `http://localhost:${port}`;
    await ctx.reply(
      `🌐 *Web UI* is running on port ${port}.\n\n` +
      `Open in your browser:\n${url}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("new", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);

    const hadSession = !!session.sessionId || session.history.length > 0;
    const msgCount = session.messageCount;
    const cost = session.totalCost;

    // Write session summary to daily log before reset
    if (hadSession && msgCount > 0) {
      const registry = getRegistry();
      writeSessionSummary({
        messageCount: msgCount,
        toolUseCount: session.toolUseCount,
        costUsd: cost,
        provider: registry.getActiveKey(),
      });
    }

    resetSession(userId);

    if (hadSession) {
      await ctx.reply(
        `🔄 *New session started.*\n\n` +
        `Previous session: ${msgCount} messages, $${cost.toFixed(4)} cost.\n` +
        `Summary saved to memory.`,
        { parse_mode: "Markdown" }
      );
    } else {
      await ctx.reply("🔄 New session started.");
    }
  });

  bot.command("dir", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    const newDir = ctx.match?.trim();

    if (!newDir) {
      await ctx.reply(`Current directory: ${session.workingDir}`);
      return;
    }

    const resolved = newDir.startsWith("~")
      ? path.join(os.homedir(), newDir.slice(1))
      : path.resolve(newDir);

    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      session.workingDir = resolved;
      await ctx.reply(`Working directory: ${session.workingDir}`);
    } else {
      await ctx.reply(`Directory not found: ${resolved}`);
    }
  });

  bot.command("version", async (ctx) => {
    await ctx.reply(
      `🤖 *Alvin Bot* \`v${BOT_VERSION}\`\n` +
      `Node ${process.version} · ${process.platform}/${process.arch}`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("status", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    const lang = session.language;
    const registry = getRegistry();
    const active = registry.getActive();
    const info = active.getInfo();

    // Uptime
    const uptimeMs = Date.now() - botStartTime;
    const uptimeH = Math.floor(uptimeMs / 3_600_000);
    const uptimeM = Math.floor((uptimeMs % 3_600_000) / 60_000);

    // Provider type detection
    const isOAuth = active.config.type === "claude-sdk" || active.config.type === "codex-cli";
    const providerTag = isOAuth ? "_Flat-Rate_" : "_API_";

    // ── Session block — intelligent empty/active/idle rendering ─────────
    // The in-memory session is always fresh after a bot restart, so plain
    // "Session (0 min)" with all zeros looks broken. Render an empty state
    // explicitly, plus active/idle badges based on last activity.
    const now = Date.now();
    const idleMs = now - session.lastActivity;
    const sessionAgeMs = now - session.startedAt;
    const sessionAgeMin = Math.floor(sessionAgeMs / 60_000);
    const IDLE_THRESHOLD_MS = 2 * 60 * 1000;

    const isEmpty = session.messageCount === 0
      && !session.sessionId
      && session.history.length === 0;

    let sessionBlock: string;
    const sessionHeader = t("bot.status.sessionHeader", lang);
    if (isEmpty) {
      sessionBlock = `${sessionHeader}\n${t("bot.status.sessionNew", lang)}`;
    } else {
      const isActiveNow = idleMs < IDLE_THRESHOLD_MS;
      const badge = isActiveNow ? t("bot.status.active", lang) : t("bot.status.idle", lang);

      // Line 1: activity summary
      const msgWord = t(session.messageCount === 1 ? "bot.status.message" : "bot.status.messages", lang);
      const toolWord = t(session.toolUseCount === 1 ? "bot.status.toolCall" : "bot.status.toolCalls", lang);
      const summary = `${badge} — ${session.messageCount} ${msgWord}, ${session.toolUseCount} ${toolWord}`;

      // Line 2: tokens (only if non-zero — zero is noise after restart)
      const totalTok = session.totalInputTokens + session.totalOutputTokens;
      const tokenLine = totalTok > 0
        ? `\nTokens: ${formatTokens(session.totalInputTokens)} in / ${formatTokens(session.totalOutputTokens)} out`
        : "";

      // Line 2.5: context window usage progress (X / Y with percentage).
      // Shown only when we have both a last-turn input token count AND the
      // provider declares its context window. Otherwise skipped to avoid
      // showing meaningless zeros.
      const ctxWindow = (active.config as { contextWindow?: number }).contextWindow;
      let contextLine = "";
      if (session.lastTurnInputTokens > 0 && typeof ctxWindow === "number" && ctxWindow > 0) {
        const used = session.lastTurnInputTokens;
        const pct = Math.round((used / ctxWindow) * 100);
        contextLine = `\nContext: ${formatContextTokens(used)}/${formatContextTokens(ctxWindow)} (${pct}%)`;
      }

      // Line 3: timing (age + last turn)
      const ageStr = sessionAgeMin >= 1
        ? `${sessionAgeMin} min`
        : t("bot.status.lessThanMin", lang);
      const timingLine = `\n${t("bot.status.duration", lang)}: ${ageStr} | ${t("bot.status.lastTurn", lang)}: ${formatRelativeTime(idleMs, lang)}`;

      // Line 4: cost (only for non-OAuth providers AND only when meaningful)
      const costLine = (!isOAuth && session.totalCost > 0)
        ? `\nCost: $${session.totalCost.toFixed(4)}`
        : "";

      // Line 5: telemetry counters — compactions (non-SDK), checkpoint
      // hints (SDK), and SDK-internal sub-tasks (Claude's Task tool).
      // Each only shown when > 0 to keep the status clean.
      const telemetryParts: string[] = [];
      if (session.compactionCount > 0) {
        telemetryParts.push(`Compactions: ${session.compactionCount}`);
      }
      if (session.checkpointHintsInjected > 0) {
        telemetryParts.push(`Checkpoint hints: ${session.checkpointHintsInjected}`);
      }
      if (session.sdkSubTaskCount > 0) {
        telemetryParts.push(`SDK sub-tasks: ${session.sdkSubTaskCount}`);
      }
      const telemetryLine = telemetryParts.length > 0
        ? `\n${telemetryParts.join(" | ")}`
        : "";

      sessionBlock = `${sessionHeader}\n${summary}${tokenLine}${contextLine}${timingLine}${costLine}${telemetryLine}`;
    }

    // Usage summary (daily/weekly from tracker)
    const usage = getUsageSummary();
    const todayTotalTok = usage.today.inputTokens + usage.today.outputTokens;
    const weekTotalTok = usage.week.inputTokens + usage.week.outputTokens;
    const todayTok = formatTokens(todayTotalTok);
    const weekTok = formatTokens(weekTotalTok);

    // Cost or plan label for usage section
    const todayCostStr = isOAuth ? "" : ` ($${usage.today.costUsd.toFixed(4)})`;
    const weekCostStr = isOAuth ? "" : ` ($${usage.week.costUsd.toFixed(4)})`;

    // Rate limits (from last API response)
    let rlLines = "";
    const allRL = getAllRateLimits();
    if (allRL.size > 0) {
      const parts: string[] = [];
      for (const [prov, rl] of allRL) {
        const lines: string[] = [];
        if (rl.requestsRemaining != null && rl.requestsLimit) {
          const pct = Math.round((rl.requestsRemaining / rl.requestsLimit) * 100);
          const reset = rl.requestsReset ? ` (reset ${rl.requestsReset.replace(/T.*/, "").slice(5) || rl.requestsReset})` : "";
          lines.push(`Req: ${rl.requestsRemaining}/${rl.requestsLimit} (${pct}%)${reset}`);
        }
        if (rl.tokensRemaining != null && rl.tokensLimit) {
          const pct = Math.round((rl.tokensRemaining / rl.tokensLimit) * 100);
          lines.push(`Tok: ${formatTokens(rl.tokensRemaining)}/${formatTokens(rl.tokensLimit)} (${pct}%)`);
        }
        if (lines.length > 0) {
          parts.push(`  ${lines.join(" | ")}`);
        }
      }
      if (parts.length > 0) {
        rlLines = `\n⚡ *Rate Limits*\n${parts.join("\n")}\n`;
      }
    }

    // Memory stats
    const memStats = getMemoryStats();
    const idxStats = getIndexStats();
    const memLine = `${memStats.dailyLogs} days, ${memStats.todayEntries} entries today, ${formatBytes(memStats.longTermSize)} LTM | 🔍 ${idxStats.entries} vectors`;

    // Provider health + failover state
    const healthRows = getHealthStatus();
    const failedOver = isFailedOver();
    const activeKey = registry.getActiveKey();
    let healthLines = "";
    if (healthRows.length > 0) {
      // Render each row, live-checking lifecycle-managed providers so the
      // status reflects reality (not just heartbeat's always-healthy flag
      // for on-demand runners).
      const rows = await Promise.all(healthRows.map(async (h) => {
        const isActive = h.key === activeKey;
        const arrow = isActive ? "→" : "  ";
        const provider = registry.get(h.key);

        // Lifecycle-managed providers (local runners) get on-demand rendering
        if (provider?.lifecycle) {
          const running = await provider.lifecycle.isRunning();
          const botManaged = provider.lifecycle.isBotManaged();
          if (!running) {
            return `${arrow} 💤 ${h.key} ${t("bot.status.ollamaOnDemand", lang)}`;
          }
          if (botManaged) {
            return `${arrow} 🔧 ${h.key} ${t("bot.status.ollamaBotManaged", lang)}`;
          }
          return `${arrow} ✅ ${h.key} ${t("bot.status.ollamaExternal", lang)}`;
        }

        // Default rendering for cloud providers
        const icon = h.healthy ? "✅" : "❌";
        const latency = h.latencyMs > 0 ? ` ${h.latencyMs}ms` : "";
        const fails = h.failCount > 0 ? ` (${h.failCount} fails)` : "";
        return `${arrow} ${icon} ${h.key}${latency}${fails}`;
      }));
      const failoverBadge = failedOver ? ` ${t("bot.status.failedOver", lang)}` : "";
      healthLines = `\n${t("bot.status.providerHealth", lang)}${failoverBadge}\n${rows.join("\n")}\n`;
    }

    await ctx.reply(
      `🤖 *Alvin Bot* \`v${BOT_VERSION}\`\n\n` +
      `*Model:* ${info.name} ${providerTag}\n` +
      `*Effort:* ${EFFORT_LABELS[session.effort]}\n` +
      `*Voice:* ${session.voiceReply ? "on" : "off"}\n` +
      `*Working Dir:* ${formatWorkingDir(session.workingDir, lang)}\n\n` +
      `${sessionBlock}\n` +
      `\n📈 *Usage*\n` +
      `Today: ${usage.today.queries} req, ${todayTok} tokens${todayCostStr}\n` +
      `Week:  ${usage.week.queries} req, ${weekTok} tokens${weekCostStr}\n` +
      (usage.daysTracked > 1 ? `Avg:   ${formatTokens(usage.avgDailyTokens)} tok/day _(7d rolling)_\n` : "") +
      rlLines +
      healthLines +
      `\n🧠 *Memory:* ${memLine}\n` +
      `⏱ *Uptime:* ${uptimeH}h ${uptimeM}m`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("voice", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    session.voiceReply = !session.voiceReply;
    markSessionDirty(userId);
    await ctx.reply(
      session.voiceReply
        ? "Voice replies enabled. Responses will also be sent as voice messages."
        : "Voice replies disabled. Text-only responses."
    );
  });

  bot.command("effort", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    const level = ctx.match?.trim().toLowerCase();

    if (!level) {
      const keyboard = new InlineKeyboard();
      for (const [key, label] of Object.entries(EFFORT_LABELS)) {
        const marker = key === session.effort ? "✅ " : "";
        keyboard.text(`${marker}${label}`, `effort:${key}`).row();
      }
      await ctx.reply(
        `🧠 *Choose reasoning depth:*\n\nActive: *${EFFORT_LABELS[session.effort]}*`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      return;
    }

    if (!["low", "medium", "high", "max"].includes(level)) {
      await ctx.reply("Invalid. Use: /effort low | medium | high | max");
      return;
    }

    session.effort = level as EffortLevel;
    markSessionDirty(userId);
    await ctx.reply(`✅ Effort: ${EFFORT_LABELS[session.effort]}`);
  });

  // v4.12.0 P1 #3 — Multi-workspace support on Telegram
  bot.command("workspaces", async (ctx) => {
    const userId = ctx.from!.id;
    const active = getTelegramWorkspace(userId) ?? "default";
    const all = listWorkspaces();
    if (all.length === 0) {
      await ctx.reply(
        "🧭 No workspaces configured.\n\n" +
        "Create one by adding a file at `~/.alvin-bot/workspaces/<name>.md` " +
        "with YAML frontmatter. See docs/install/slack-setup.md for the format.",
        { parse_mode: "Markdown" },
      );
      return;
    }
    const lines = [`🧭 *Workspaces* (active: \`${active}\`)`, ""];
    for (const ws of all) {
      const marker = ws.name === active ? "✅" : (ws.emoji ?? "▪️");
      const purpose = ws.purpose || "(no purpose)";
      lines.push(`${marker} \`${ws.name}\` — ${purpose}`);
    }
    lines.push("");
    lines.push("Switch with: `/workspace <name>` · Reset: `/workspace default`");
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.command("workspace", async (ctx) => {
    const userId = ctx.from!.id;
    const arg = ctx.match?.trim();
    if (!arg) {
      const active = getTelegramWorkspace(userId) ?? "default";
      const ws = active === "default" ? null : getWorkspace(active);
      const purpose = ws?.purpose || "global default — no persona, global cwd";
      await ctx.reply(
        `🧭 Active workspace: *${active}*\n_${purpose}_\n\nUse \`/workspaces\` to see all available.`,
        { parse_mode: "Markdown" },
      );
      return;
    }
    if (arg === "default" || arg === "reset") {
      setTelegramWorkspace(userId, null);
      await ctx.reply("✅ Switched to the default workspace.");
      return;
    }
    const ws = getWorkspace(arg);
    if (!ws) {
      await ctx.reply(
        `❌ Workspace \`${arg}\` not found.\nUse \`/workspaces\` to list available ones.`,
        { parse_mode: "Markdown" },
      );
      return;
    }
    setTelegramWorkspace(userId, arg);
    await ctx.reply(
      `✅ Switched to workspace *${ws.emoji ?? "🧭"} ${ws.name}*\n_${ws.purpose || "(no purpose set)"}_\n\nNext message will use this workspace's persona and cwd (\`${ws.cwd}\`).`,
      { parse_mode: "Markdown" },
    );
  });

  // Inline keyboard callback for effort switching
  bot.callbackQuery(/^effort:(.+)$/, async (ctx) => {
    const level = ctx.match![1];
    if (!["low", "medium", "high", "max"].includes(level)) {
      await ctx.answerCallbackQuery("Invalid level");
      return;
    }

    const userId = ctx.from!.id;
    const session = getSession(userId);
    session.effort = level as EffortLevel;
    markSessionDirty(userId);

    const keyboard = new InlineKeyboard();
    for (const [key, label] of Object.entries(EFFORT_LABELS)) {
      const marker = key === session.effort ? "✅ " : "";
      keyboard.text(`${marker}${label}`, `effort:${key}`).row();
    }

    await ctx.editMessageText(
      `🧠 *Choose reasoning depth:*\n\nActive: *${EFFORT_LABELS[session.effort]}*`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
    await ctx.answerCallbackQuery(`Effort: ${EFFORT_LABELS[session.effort]}`);
  });

  // Helper: switch provider with lifecycle management for local runners.
  // Boots the target's lifecycle daemon (if any) BEFORE the switch, and
  // tears down the previous provider's lifecycle (if any) AFTER the switch.
  // Fully generic — no hardcoded provider keys.
  async function switchProviderWithLifecycle(targetKey: string, lang: Locale): Promise<{ ok: boolean; error?: string }> {
    const registry = getRegistry();
    const previousKey = registry.getActiveKey();
    if (previousKey === targetKey) return { ok: true };

    const target = registry.get(targetKey);
    if (!target) return { ok: false, error: `provider "${targetKey}" not found` };
    const previous = registry.get(previousKey);

    // Boot the target's lifecycle (if any) before the switch
    if (target.lifecycle) {
      const booted = await target.lifecycle.ensureRunning();
      if (!booted) {
        return { ok: false, error: t("bot.model.bootFailed", lang, { key: targetKey }) };
      }
    }

    if (!registry.switchTo(targetKey)) {
      return { ok: false, error: "switch rejected by registry" };
    }

    // v4.15 — Persist the switch to ~/.alvin-bot/.env so the choice
    // survives bot restarts. In-memory switchTo() alone would revert to
    // PRIMARY_PROVIDER on next boot.
    try {
      writeEnvVar("PRIMARY_PROVIDER", targetKey);
    } catch (err) {
      console.warn("⚠️ Failed to persist PRIMARY_PROVIDER:", err);
    }

    // Tear down the previous provider's lifecycle (if any) after the switch.
    // ensureStopped() internally checks isBotManaged — no-op for externally
    // managed daemons.
    if (previous?.lifecycle) {
      await previous.lifecycle.ensureStopped();
    }

    return { ok: true };
  }

  bot.command("model", async (ctx) => {
    const lang = getSession(ctx.from!.id).language;
    const arg = ctx.match?.trim().toLowerCase();
    const registry = getRegistry();

    if (!arg) {
      // Show inline keyboard with available models
      const providers = await registry.listAll();
      const keyboard = new InlineKeyboard();

      for (const p of providers) {
        const label = p.active ? `✅ ${p.name}` : p.name;
        keyboard.text(label, `model:${p.key}`).row();
      }

      await ctx.reply(
        `${t("bot.model.chooseHeader", lang)}\n\n${t("bot.model.active", lang)} *${registry.getActive().getInfo().name}*`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      return;
    }

    const result = await switchProviderWithLifecycle(arg, lang);
    if (result.ok) {
      const info = registry.get(arg)!.getInfo();
      await ctx.reply(`${t("bot.model.switched", lang)} ${info.name} (${info.model})`);
    } else {
      await ctx.reply(`${t("bot.model.switchFailed", lang)} ${result.error || `"${arg}"`}\n${t("bot.model.notFoundHint", lang)}`);
    }
  });

  // Inline keyboard callback for model switching
  bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
    const key = ctx.match![1];
    const registry = getRegistry();
    const lang = getSession(ctx.from!.id).language;

    const result = await switchProviderWithLifecycle(key, lang);
    if (result.ok) {
      const provider = registry.get(key)!;
      const info = provider.getInfo();

      // Update the keyboard to show new selection
      const providers = await registry.listAll();
      const keyboard = new InlineKeyboard();
      for (const p of providers) {
        const label = p.active ? `✅ ${p.name}` : p.name;
        keyboard.text(label, `model:${p.key}`).row();
      }

      await ctx.editMessageText(
        `🤖 *Choose model:*\n\nActive: *${info.name}*`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      await ctx.answerCallbackQuery(`Switched: ${info.name}`);
    } else {
      await ctx.answerCallbackQuery(`Switch failed: ${result.error || "unknown"}`);
    }
  });

  // ── Fallback Order ────────────────────────────────────────────────────

  bot.command("fallback", async (ctx) => {
    const { getFallbackOrder, setFallbackOrder, formatOrder } = await import("../services/fallback-order.js");
    const { getHealthStatus } = await import("../services/heartbeat.js");
    const registry = getRegistry();

    const arg = ctx.match?.trim();

    if (!arg) {
      // Show current order with inline keyboard
      const order = getFallbackOrder();
      const health = getHealthStatus();
      const healthMap = new Map(health.map(h => [h.key, h]));

      const allKeys = [order.primary, ...order.fallbacks];
      const keyboard = new InlineKeyboard();

      for (let i = 0; i < allKeys.length; i++) {
        const key = allKeys[i];
        const h = healthMap.get(key);
        const status = h ? (h.healthy ? "✅" : "❌") : "❓";
        const label = i === 0 ? `🥇 ${key} ${status}` : `${i + 1}. ${key} ${status}`;

        if (i > 0) keyboard.text("⬆️", `fb:up:${key}`);
        keyboard.text(label, `fb:info:${key}`);
        if (i < allKeys.length - 1) keyboard.text("⬇️", `fb:down:${key}`);
        keyboard.row();
      }

      const text = `🔄 *Fallback Order*\n\n` +
        `Providers are tried in this order.\n` +
        `Use ⬆️/⬇️ to reorder.\n\n` +
        `_Last changed: ${order.updatedBy} (${new Date(order.updatedAt).toLocaleString("en-US")})_`;

      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
      return;
    }

    // Direct text commands: /fallback set groq,openai,nvidia-llama-3.3-70b
    if (arg.startsWith("set ")) {
      const parts = arg.slice(4).split(",").map(s => s.trim()).filter(Boolean);
      if (parts.length < 1) {
        await ctx.reply("Usage: `/fallback set primary,fallback1,fallback2,...`", { parse_mode: "Markdown" });
        return;
      }
      const [primary, ...fallbacks] = parts;
      setFallbackOrder(primary, fallbacks, "telegram");
      await ctx.reply(`✅ New order:\n\n${formatOrder()}`);
      return;
    }

    await ctx.reply(
      `🔄 *Fallback Order*\n\n` +
      `\`/fallback\` — Show & change order\n` +
      `\`/fallback set groq,openai,...\` — Set directly`,
      { parse_mode: "Markdown" }
    );
  });

  // Callback queries for fallback ordering
  bot.callbackQuery(/^fb:up:(.+)$/, async (ctx) => {
    const { moveUp, formatOrder, getFallbackOrder } = await import("../services/fallback-order.js");
    const { getHealthStatus } = await import("../services/heartbeat.js");
    const key = ctx.match![1];

    moveUp(key, "telegram");
    const order = getFallbackOrder();
    const health = getHealthStatus();
    const healthMap = new Map(health.map(h => [h.key, h]));

    const allKeys = [order.primary, ...order.fallbacks];
    const keyboard = new InlineKeyboard();

    for (let i = 0; i < allKeys.length; i++) {
      const k = allKeys[i];
      const h = healthMap.get(k);
      const status = h ? (h.healthy ? "✅" : "❌") : "❓";
      const label = i === 0 ? `🥇 ${k} ${status}` : `${i + 1}. ${k} ${status}`;

      if (i > 0) keyboard.text("⬆️", `fb:up:${k}`);
      keyboard.text(label, `fb:info:${k}`);
      if (i < allKeys.length - 1) keyboard.text("⬇️", `fb:down:${k}`);
      keyboard.row();
    }

    await ctx.editMessageText(
      `🔄 *Fallback Order*\n\n` +
      `Provider werden in dieser Reihenfolge versucht.\n` +
      `Nutze ⬆️/⬇️ zum Umsortieren.\n\n` +
      `_Last changed: telegram (${new Date().toLocaleString("en-US")})_`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
    await ctx.answerCallbackQuery(`${key} moved up`);
  });

  bot.callbackQuery(/^fb:down:(.+)$/, async (ctx) => {
    const { moveDown, getFallbackOrder } = await import("../services/fallback-order.js");
    const { getHealthStatus } = await import("../services/heartbeat.js");
    const key = ctx.match![1];

    moveDown(key, "telegram");
    const order = getFallbackOrder();
    const health = getHealthStatus();
    const healthMap = new Map(health.map(h => [h.key, h]));

    const allKeys = [order.primary, ...order.fallbacks];
    const keyboard = new InlineKeyboard();

    for (let i = 0; i < allKeys.length; i++) {
      const k = allKeys[i];
      const h = healthMap.get(k);
      const status = h ? (h.healthy ? "✅" : "❌") : "❓";
      const label = i === 0 ? `🥇 ${k} ${status}` : `${i + 1}. ${k} ${status}`;

      if (i > 0) keyboard.text("⬆️", `fb:up:${k}`);
      keyboard.text(label, `fb:info:${k}`);
      if (i < allKeys.length - 1) keyboard.text("⬇️", `fb:down:${k}`);
      keyboard.row();
    }

    await ctx.editMessageText(
      `🔄 *Fallback Order*\n\n` +
      `Provider werden in dieser Reihenfolge versucht.\n` +
      `Nutze ⬆️/⬇️ zum Umsortieren.\n\n` +
      `_Last changed: telegram (${new Date().toLocaleString("en-US")})_`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
    await ctx.answerCallbackQuery(`${key} moved down`);
  });

  bot.callbackQuery(/^fb:info:(.+)$/, async (ctx) => {
    const { getHealthStatus } = await import("../services/heartbeat.js");
    const key = ctx.match![1];
    const health = getHealthStatus();
    const h = health.find(p => p.key === key);

    if (h) {
      await ctx.answerCallbackQuery({
        text: `${key}: ${h.healthy ? "✅ Healthy" : "❌ Unhealthy"} | ${h.latencyMs}ms | Errors: ${h.failCount}`,
        show_alert: true,
      });
    } else {
      await ctx.answerCallbackQuery(`${key}: Not checked yet`);
    }
  });

  bot.command("web", async (ctx) => {
    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply("Search: `/web your search query`", { parse_mode: "Markdown" });
      return;
    }

    await ctx.api.sendChatAction(ctx.chat!.id, "typing");

    try {
      // Use DuckDuckGo instant answer API (no key needed)
      const encoded = encodeURIComponent(query);
      const res = await fetch(`https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`);
      const data = await res.json() as {
        AbstractText?: string;
        AbstractSource?: string;
        AbstractURL?: string;
        Answer?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };

      const lines: string[] = [];

      if (data.Answer) {
        lines.push(`💡 *${data.Answer}*\n`);
      }

      if (data.AbstractText) {
        const text = data.AbstractText.length > 500
          ? data.AbstractText.slice(0, 500) + "..."
          : data.AbstractText;
        lines.push(text);
        if (data.AbstractSource && data.AbstractURL) {
          lines.push(`\n_Source: [${data.AbstractSource}](${data.AbstractURL})_`);
        }
      }

      if (lines.length === 0 && data.RelatedTopics && data.RelatedTopics.length > 0) {
        lines.push(`🔍 *Results for "${query}":*\n`);
        for (const topic of data.RelatedTopics.slice(0, 5)) {
          if (topic.Text) {
            const short = topic.Text.length > 150 ? topic.Text.slice(0, 150) + "..." : topic.Text;
            lines.push(`• ${short}`);
          }
        }
      }

      if (lines.length === 0) {
        lines.push(`No results for "${query}". Try it as a regular message — I'll search using the AI model.`);
      }

      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() =>
        ctx.reply(lines.join("\n"))
      );
    } catch (err) {
      await ctx.reply(`Search error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command("imagine", async (ctx) => {
    const prompt = ctx.match?.trim();
    if (!prompt) {
      await ctx.reply("Describe what I should generate:\n`/imagine A fox sitting on the moon`", { parse_mode: "Markdown" });
      return;
    }

    if (!config.apiKeys.google) {
      await ctx.reply("⚠️ Image generation unavailable (GOOGLE_API_KEY missing).");
      return;
    }

    await ctx.api.sendChatAction(ctx.chat!.id, "upload_photo");

    const result = await generateImage(prompt, config.apiKeys.google);

    if (result.success && result.filePath) {
      try {
        const fileData = fs.readFileSync(result.filePath);
        await ctx.replyWithPhoto(new InputFile(fileData, `generated${result.filePath.endsWith(".png") ? ".png" : ".jpg"}`), {
          caption: `🎨 _${prompt}_`,
          parse_mode: "Markdown",
        });
        fs.unlink(result.filePath, () => {});
      } catch (err) {
        await ctx.reply(`Error sending: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      await ctx.reply(`❌ ${result.error || "Image generation failed."}`);
    }
  });

  bot.command("remind", async (ctx) => {
    const userId = ctx.from!.id;
    const chatId = ctx.chat!.id;
    const input = ctx.match?.trim();

    if (!input) {
      // List reminders
      const pending = listReminders(userId);
      if (pending.length === 0) {
        await ctx.reply("No active reminders.\n\nNew: `/remind 30m Call mom`", { parse_mode: "Markdown" });
      } else {
        const lines = pending.map(r => `• *${r.remaining}* — ${r.text} (ID: ${r.id})`);
        await ctx.reply(
          `⏰ *Active Reminders:*\n\n${lines.join("\n")}\n\nCancel: \`/remind cancel <ID>\``,
          { parse_mode: "Markdown" }
        );
      }
      return;
    }

    // Cancel a reminder
    if (input.startsWith("cancel ")) {
      const id = parseInt(input.slice(7).trim());
      if (isNaN(id)) {
        await ctx.reply("Invalid ID. Use: `/remind cancel <ID>`", { parse_mode: "Markdown" });
        return;
      }
      if (cancelReminder(id, userId)) {
        await ctx.reply(`✅ Reminder #${id} cancelled.`);
      } else {
        await ctx.reply(`❌ Reminder #${id} not found.`);
      }
      return;
    }

    // Parse: /remind <duration> <text>
    const spaceIdx = input.indexOf(" ");
    if (spaceIdx === -1) {
      await ctx.reply("Format: `/remind 30m Reminder text`", { parse_mode: "Markdown" });
      return;
    }

    const durationStr = input.slice(0, spaceIdx);
    const text = input.slice(spaceIdx + 1).trim();
    const delayMs = parseDuration(durationStr);

    if (!delayMs) {
      await ctx.reply("Invalid duration. Examples: `30s`, `5m`, `2h`, `1d`", { parse_mode: "Markdown" });
      return;
    }

    if (!text) {
      await ctx.reply("Please provide text: `/remind 30m Call mom`", { parse_mode: "Markdown" });
      return;
    }

    const reminder = createReminder(chatId, userId, text, delayMs, ctx.api);

    // Format trigger time
    const triggerDate = new Date(reminder.triggerAt);
    const timeStr = triggerDate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    await ctx.reply(`✅ Reminder set for *${timeStr}*: ${text}`, { parse_mode: "Markdown" });
  });

  bot.command("export", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);

    if (session.history.length === 0 && !session.sessionId) {
      await ctx.reply("No conversation data to export.");
      return;
    }

    // Build export text
    const lines: string[] = [
      `# Alvin Bot — Conversation Export`,
      `Date: ${new Date().toLocaleString("en-US")}`,
      `Messages: ${session.messageCount}`,
      `Cost: $${session.totalCost.toFixed(4)}`,
      `---\n`,
    ];

    for (const msg of session.history) {
      const role = msg.role === "user" ? "👤 User" : "🤖 Alvin Bot";
      lines.push(`### ${role}\n${msg.content}\n`);
    }

    if (session.history.length === 0) {
      lines.push("(SDK session — history managed internally, no export available)\n");
    }

    const exportText = lines.join("\n");
    const buffer = Buffer.from(exportText, "utf-8");
    const filename = `chat-export-${new Date().toISOString().slice(0, 10)}.md`;

    await ctx.replyWithDocument(new InputFile(buffer, filename), {
      caption: `📄 Export: ${session.history.length} messages`,
    });
  });

  // Helper: build the /language inline keyboard for all 4 locales + auto.
  function buildLangKeyboard(current: Locale): InlineKeyboard {
    const kb = new InlineKeyboard();
    const order: Locale[] = ["en", "de", "es", "fr"];
    // First row: 2 buttons
    kb.text(
      `${current === "en" ? "✅ " : ""}${LOCALE_FLAGS.en} ${LOCALE_NAMES.en}`, "lang:en"
    ).text(
      `${current === "de" ? "✅ " : ""}${LOCALE_FLAGS.de} ${LOCALE_NAMES.de}`, "lang:de"
    ).row();
    // Second row: 2 buttons
    kb.text(
      `${current === "es" ? "✅ " : ""}${LOCALE_FLAGS.es} ${LOCALE_NAMES.es}`, "lang:es"
    ).text(
      `${current === "fr" ? "✅ " : ""}${LOCALE_FLAGS.fr} ${LOCALE_NAMES.fr}`, "lang:fr"
    ).row();
    // Third row: auto-detect
    void order; // silence unused warning from the `order` declaration (kept for doc clarity)
    kb.text(t("bot.lang.autoDetect", current), "lang:auto");
    return kb;
  }

  bot.command("lang", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    const arg = ctx.match?.trim().toLowerCase();

    if (!arg) {
      const header = t("bot.lang.header", session.language);
      const currentName = `${LOCALE_FLAGS[session.language]} ${LOCALE_NAMES[session.language]}`;
      await ctx.reply(`${header} ${currentName}`, {
        parse_mode: "Markdown",
        reply_markup: buildLangKeyboard(session.language),
      });
      return;
    }

    if (arg === "auto") {
      const { resetToAutoLanguage } = await import("../services/language-detect.js");
      resetToAutoLanguage(userId);
      await ctx.reply(t("bot.lang.autoEnabled", session.language));
    } else if (arg === "en" || arg === "de" || arg === "es" || arg === "fr") {
      session.language = arg;
      markSessionDirty(userId);
      const { setExplicitLanguage } = await import("../services/language-detect.js");
      setExplicitLanguage(userId, arg);
      await ctx.reply(t("bot.lang.setFixed", arg, { name: LOCALE_NAMES[arg] }));
    } else {
      await ctx.reply(t("bot.lang.usage", session.language), { parse_mode: "Markdown" });
    }
  });

  // /lang callback — accept all 4 locales plus auto
  bot.callbackQuery(/^lang:(en|de|es|fr|auto)$/, async (ctx) => {
    const choice = ctx.match![1];
    const userId = ctx.from!.id;
    const session = getSession(userId);

    if (choice === "auto") {
      const { resetToAutoLanguage } = await import("../services/language-detect.js");
      resetToAutoLanguage(userId);
      await ctx.answerCallbackQuery({ text: t("bot.lang.autoEnabled", session.language).slice(0, 60) });
      await ctx.editMessageText(`${t("bot.lang.header", session.language)} ${t("bot.lang.autoDetect", session.language)}`, {
        parse_mode: "Markdown",
      });
      return;
    }

    const newLang = choice as Locale;
    session.language = newLang;
    markSessionDirty(userId);
    const { setExplicitLanguage } = await import("../services/language-detect.js");
    setExplicitLanguage(userId, newLang);

    const currentName = `${LOCALE_FLAGS[newLang]} ${LOCALE_NAMES[newLang]}`;
    await ctx.editMessageText(`${t("bot.lang.header", newLang)} ${currentName}`, {
      parse_mode: "Markdown",
      reply_markup: buildLangKeyboard(newLang),
    });
    await ctx.answerCallbackQuery(LOCALE_NAMES[newLang]);
  });

  bot.command("memory", async (ctx) => {
    const stats = getMemoryStats();
    const arg = ctx.match?.trim();

    if (!arg) {
      await ctx.reply(
        `🧠 *Memory*\n\n` +
        `*Long-term memory:* ${formatBytes(stats.longTermSize)}\n` +
        `*Daily logs:* ${stats.dailyLogs} files\n` +
        `*Today:* ${stats.todayEntries} entries\n\n` +
        `_Memory is automatically written on /new._\n` +
        `_Non-SDK providers load memory as context._`,
        { parse_mode: "Markdown" }
      );
      return;
    }
  });

  bot.command("system", async (ctx) => {
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memUsed = memTotal - memFree;
    const memPercent = Math.round((memUsed / memTotal) * 100);

    const uptime = os.uptime();
    const uptimeH = Math.floor(uptime / 3600);
    const uptimeM = Math.floor((uptime % 3600) / 60);

    const cpus = os.cpus();
    const loadAvg = os.loadavg();

    const procMem = process.memoryUsage();

    await ctx.reply(
      `🖥 *System Info*\n\n` +
      `*OS:* ${os.platform()} ${os.arch()} (${os.release()})\n` +
      `*Host:* ${os.hostname()}\n` +
      `*CPUs:* ${cpus.length}x ${cpus[0]?.model?.trim() || "unknown"}\n` +
      `*Load:* ${loadAvg.map(l => l.toFixed(2)).join(", ")}\n` +
      `*RAM:* ${formatBytes(memUsed)} / ${formatBytes(memTotal)} (${memPercent}%)\n` +
      `*System Uptime:* ${uptimeH}h ${uptimeM}m\n\n` +
      `🤖 *Bot Process*\n` +
      `*Node:* ${process.version}\n` +
      `*Heap:* ${formatBytes(procMem.heapUsed)} / ${formatBytes(procMem.heapTotal)}\n` +
      `*RSS:* ${formatBytes(procMem.rss)}\n` +
      `*PID:* ${process.pid}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("reload", async (ctx) => {
    const success = reloadSoul();
    await ctx.reply(success ? "✅ SOUL.md reloaded." : "❌ SOUL.md not found.");
  });

  // ── Access Control ────────────────────────────────

  // Callback for group approval/block
  bot.callbackQuery(/^access:(approve|block):(-?\d+)$/, async (ctx) => {
    const action = ctx.match![1];
    const chatId = parseInt(ctx.match![2]);

    if (action === "approve") {
      approveGroup(chatId);
      await ctx.editMessageText(`✅ Group ${chatId} approved. Alvin Bot will now respond there.`);
      // Notify the group
      try {
        await ctx.api.sendMessage(chatId, "👋 Alvin Bot is now active in this group!\n\n@mention me or reply to my messages.");
      } catch { /* group might not allow bot messages yet */ }
    } else {
      blockGroup(chatId);
      await ctx.editMessageText(`🚫 Group ${chatId} blocked. Alvin Bot will ignore this group.`);
    }
    await ctx.answerCallbackQuery();
  });

  bot.command("groups", async (ctx) => {
    const groups = listGroups();

    if (groups.length === 0) {
      await ctx.reply("No groups registered.");
      return;
    }

    const lines = groups.map(g => {
      const status = g.status === "approved" ? "✅" : g.status === "blocked" ? "🚫" : "⏳";
      return `${status} *${g.title}* (${g.messageCount} msgs)\n   ID: \`${g.chatId}\``;
    });

    const keyboard = new InlineKeyboard();
    for (const g of groups) {
      if (g.status === "approved") {
        keyboard.text(`🚫 Block: ${g.title.slice(0, 20)}`, `access:block:${g.chatId}`).row();
      } else if (g.status === "blocked" || g.status === "pending") {
        keyboard.text(`✅ Approve: ${g.title.slice(0, 20)}`, `access:approve:${g.chatId}`).row();
      }
    }

    const settings = getSettings();
    await ctx.reply(
      `🔐 *Group Management*\n\n` +
      `${lines.join("\n\n")}\n\n` +
      `⚙️ *Settings:*\n` +
      `Forwards: ${settings.allowForwards ? "✅" : "❌"}\n` +
      `Auto-Approve: ${settings.autoApproveGroups ? "⚠️ ON" : "✅ OFF"}`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  });

  bot.command("security", async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase();
    const settings = getSettings();

    if (!arg) {
      await ctx.reply(
        `🔐 *Security Settings*\n\n` +
        `*Forwards:* ${settings.allowForwards ? "✅ allowed" : "❌ blocked"}\n` +
        `*Auto-Approve Groups:* ${settings.autoApproveGroups ? "⚠️ ON (dangerous!)" : "✅ OFF"}\n` +
        `*Group Rate Limit:* ${settings.groupRateLimitPerHour}/h\n\n` +
        `Change:\n` +
        `\`/security forwards on|off\`\n` +
        `\`/security autoapprove on|off\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (arg.startsWith("forwards ")) {
      const val = arg.slice(9).trim();
      setForwardingAllowed(val === "on" || val === "true");
      await ctx.reply(`✅ Forwards: ${val === "on" || val === "true" ? "allowed" : "blocked"}`);
    } else if (arg.startsWith("autoapprove ")) {
      const val = arg.slice(12).trim();
      setAutoApprove(val === "on" || val === "true");
      await ctx.reply(`${val === "on" || val === "true" ? "⚠️" : "✅"} Auto-Approve: ${val === "on" || val === "true" ? "ON" : "OFF"}`);
    } else {
      await ctx.reply("Unknown. Use `/security` for options.", { parse_mode: "Markdown" });
    }
  });

  // ── Browser Automation ─────────────────────────────────

  bot.command("browse", async (ctx) => {
    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply(
        "🌐 *Browser Commands:*\n\n" +
        "`/browse <URL>` — Screenshot a webpage\n" +
        "`/browse text <URL>` — Extract text\n" +
        "`/browse pdf <URL>` — Save as PDF",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (!hasPlaywright()) {
      await ctx.reply(
        "❌ Playwright not installed.\n`npm install playwright && npx playwright install chromium`",
        { parse_mode: "Markdown" }
      );
      return;
    }

    try {
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");

      // /browse text <url>
      if (arg.startsWith("text ")) {
        const url = arg.slice(5).trim();
        const text = await extractText(url);
        const truncated = text.length > 3500 ? text.slice(0, 3500) + "\n\n_[...truncated]_" : text;
        await ctx.reply(`🌐 *Text from ${url}:*\n\n${truncated}`, { parse_mode: "Markdown" });
        return;
      }

      // /browse pdf <url>
      if (arg.startsWith("pdf ")) {
        const url = arg.slice(4).trim();
        await ctx.api.sendChatAction(ctx.chat!.id, "upload_document");
        const pdfPath = await generatePdf(url);
        await ctx.replyWithDocument(new InputFile(fs.readFileSync(pdfPath), "page.pdf"), {
          caption: `📄 PDF from ${url}`,
        });
        fs.unlink(pdfPath, () => {});
        return;
      }

      // Default: screenshot
      const url = arg.startsWith("http") ? arg : `https://${arg}`;
      await ctx.api.sendChatAction(ctx.chat!.id, "upload_photo");
      const screenshotPath = await screenshotUrl(url, { fullPage: false });
      await ctx.replyWithPhoto(new InputFile(fs.readFileSync(screenshotPath), "screenshot.png"), {
        caption: `🌐 ${url}`,
      });
      fs.unlink(screenshotPath, () => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Browser error: ${msg}`);
    }
  });

  // ── Custom Tools ──────────────────────────────────────

  bot.command("tools", async (ctx) => {
    const arg = ctx.match?.toString().trim();

    // /tools run <name> [params json]
    if (arg?.startsWith("run ")) {
      const parts = arg.slice(4).trim().split(/\s+/);
      const toolName = parts[0];
      let params: Record<string, unknown> = {};
      if (parts.length > 1) {
        try { params = JSON.parse(parts.slice(1).join(" ")); } catch {
          await ctx.reply("❌ Invalid JSON for parameters.", { parse_mode: "Markdown" });
          return;
        }
      }

      try {
        await ctx.api.sendChatAction(ctx.chat!.id, "typing");
        const result = await executeCustomTool(toolName, params);
        const truncated = result.length > 3000 ? result.slice(0, 3000) + "\n..." : result;
        await ctx.reply(`🔧 *${toolName}:*\n\`\`\`\n${truncated}\n\`\`\``, { parse_mode: "Markdown" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ Tool error: ${msg}`);
      }
      return;
    }

    // /tools — list all
    const tools = listCustomTools();
    if (tools.length === 0) {
      await ctx.reply(
        "🔧 *Custom Tools*\n\n" +
        "No tools configured.\n" +
        "Create `TOOLS.md` (see `TOOLS.example.md`).",
        { parse_mode: "Markdown" }
      );
      return;
    }

    const lines = tools.map(t => {
      const icon = t.type === "http" ? "🌐" : "⚡";
      return `${icon} \`${t.name}\` — ${t.description}`;
    });

    await ctx.reply(
      `🔧 *Custom Tools (${tools.length}):*\n\n${lines.join("\n")}\n\n` +
      `_Run: \`/tools run <name> {"param":"value"}\`_`,
      { parse_mode: "Markdown" }
    );
  });

  // ── MCP ────────────────────────────────────────────────

  bot.command("mcp", async (ctx) => {
    const arg = ctx.match?.toString().trim();

    // /mcp call <server> <tool> <json-args>
    if (arg?.startsWith("call ")) {
      const parts = arg.slice(5).trim().split(/\s+/);
      if (parts.length < 2) {
        await ctx.reply("Format: `/mcp call <server> <tool> {\"arg\":\"value\"}`", { parse_mode: "Markdown" });
        return;
      }
      const [server, tool, ...rest] = parts;
      let args: Record<string, unknown> = {};
      if (rest.length > 0) {
        try { args = JSON.parse(rest.join(" ")); } catch {
          await ctx.reply("❌ Invalid JSON for tool arguments.");
          return;
        }
      }
      try {
        await ctx.api.sendChatAction(ctx.chat!.id, "typing");
        const result = await callMCPTool(server, tool, args);
        const truncated = result.length > 3000 ? result.slice(0, 3000) + "\n..." : result;
        await ctx.reply(`🔧 *${server}/${tool}:*\n\`\`\`\n${truncated}\n\`\`\``, { parse_mode: "Markdown" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ MCP error: ${msg}`);
      }
      return;
    }

    // Default: show status
    const mcpServers = getMCPStatus();
    const tools = getMCPTools();

    if (mcpServers.length === 0) {
      await ctx.reply(
        `🔌 *MCP (Model Context Protocol)*\n\n` +
        `No servers configured.\n` +
        `Create \`docs/mcp.json\` (see \`docs/mcp.example.json\`).`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const serverLines = mcpServers.map(s => {
      const status = s.connected ? "🟢" : "🔴";
      return `${status} *${s.name}* — ${s.tools} Tools`;
    });

    const toolLines = tools.length > 0
      ? "\n\n*Available Tools:*\n" + tools.map(t => `  🔧 \`${t.server}/${t.name}\` — ${t.description}`).join("\n")
      : "";

    await ctx.reply(
      `🔌 *MCP Server (${mcpServers.length}):*\n\n` +
      serverLines.join("\n") +
      toolLines +
      `\n\n_Use \`/mcp call <server> <tool> {args}\` to execute._`,
      { parse_mode: "Markdown" }
    );
  });

  // ── Plugins ───────────────────────────────────────────

  bot.command("plugins", async (ctx) => {
    const plugins = getLoadedPlugins();

    if (plugins.length === 0) {
      await ctx.reply(
        `🔌 No plugins loaded.\n\n` +
        `Place plugins in \`${getPluginsDir()}/\`.\n` +
        `Each plugin needs a folder with \`index.js\`.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const lines = plugins.map(p => {
      const cmds = p.commands.length > 0 ? `\n   Commands: ${p.commands.join(", ")}` : "";
      const tools = p.tools.length > 0 ? `\n   Tools: ${p.tools.join(", ")}` : "";
      return `🔌 *${p.name}* v${p.version}\n   ${p.description}${cmds}${tools}`;
    });

    await ctx.reply(`🔌 *Loaded Plugins (${plugins.length}):*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
  });

  // ── Skills ─────────────────────────────────────────────

  bot.command("skills", async (ctx) => {
    const { getSkills } = await import("../services/skills.js");
    const skills = getSkills();
    if (skills.length === 0) {
      await ctx.reply("🎯 No skills installed.\n\nAdd SKILL.md files to the `skills/` directory.", { parse_mode: "HTML" });
      return;
    }
    const lines = skills.map(s =>
      `🎯 <b>${s.name}</b> (${s.category})\n   ${s.description || "(no description)"}\n   Triggers: ${s.triggers.slice(0, 5).join(", ")}`
    );
    await ctx.reply(`🎯 <b>Skills (${skills.length}):</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  });

  // ── User Profiles ─────────────────────────────────────

  bot.command("users", async (ctx) => {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      await ctx.reply("No user profiles saved yet.");
      return;
    }

    const lines = profiles.map(p => {
      const lastActive = new Date(p.lastActive).toLocaleDateString("en-US");
      const badge = p.isOwner ? "👑" : "👤";
      return `${badge} *${p.name}*${p.username ? ` (@${p.username})` : ""}\n   ${p.totalMessages} messages, last active: ${lastActive}`;
    });

    await ctx.reply(`👥 *User-Profile (${profiles.length}):*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
  });

  bot.command("note", async (ctx) => {
    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply("📝 Use: `/note @username Note text`\nSaves a note about a user.", { parse_mode: "Markdown" });
      return;
    }

    // Parse @username or userId + note text
    const match = arg.match(/^@?(\S+)\s+(.+)$/s);
    if (!match) {
      await ctx.reply("Format: `/note @username Text`", { parse_mode: "Markdown" });
      return;
    }

    const [, target, noteText] = match;
    const profiles = listProfiles();
    const profile = profiles.find(p =>
      p.username === target || p.userId.toString() === target || p.name.toLowerCase() === target.toLowerCase()
    );

    if (!profile) {
      await ctx.reply(`User "${target}" not found.`);
      return;
    }

    addUserNote(profile.userId, noteText);
    await ctx.reply(`📝 Note saved for ${profile.name}.`);
  });

  // ── Memory Search Commands ───────────────────────────

  bot.command("recall", async (ctx) => {
    const query = ctx.match?.toString().trim();
    if (!query) {
      await ctx.reply("🔍 Use: `/recall <search term>`\nSemantic search through my memory.", { parse_mode: "Markdown" });
      return;
    }

    try {
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      const results = await searchMemory(query, 5, 0.25);

      if (results.length === 0) {
        await ctx.reply(`🔍 No memories found for "${query}".`);
        return;
      }

      const lines = results.map((r, i) => {
        const score = Math.round(r.score * 100);
        const preview = r.text.length > 200 ? r.text.slice(0, 200) + "..." : r.text;
        return `**${i + 1}.** (${score}%) _${r.source}_\n${preview}`;
      });

      await ctx.reply(`🧠 Memories for "${query}":\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Recall error: ${msg}`);
    }
  });

  bot.command("remember", async (ctx) => {
    const text = ctx.match?.toString().trim();
    if (!text) {
      await ctx.reply("💾 Use: `/remember <text>`\nSaves something to my memory.", { parse_mode: "Markdown" });
      return;
    }

    try {
      appendDailyLog(`**Manually remembered:** ${text}`);
      // Trigger reindex so the new entry is searchable
      const stats = await reindexMemory();
      await ctx.reply(`💾 Remembered! (${stats.total} entries in index)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Error saving: ${msg}`);
    }
  });

  bot.command("reindex", async (ctx) => {
    try {
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      const stats = await reindexMemory(true);
      const indexStats = getIndexStats();
      const sizeKB = (indexStats.sizeBytes / 1024).toFixed(1);
      await ctx.reply(
        `🔄 Memory re-indexed!\n\n` +
        `📊 ${stats.indexed} chunks processed\n` +
        `📁 ${indexStats.files} files indexed\n` +
        `🧠 ${stats.total} total entries\n` +
        `💾 Index size: ${sizeKB} KB`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Reindex error: ${msg}`);
    }
  });

  // ── Cron Jobs ──────────────────────────────────────────

  bot.command("cron", async (ctx) => {
    const arg = ctx.match?.toString().trim() || "";
    const userId = ctx.from!.id;
    const chatId = ctx.chat!.id;

    // /cron — list all jobs
    if (!arg) {
      const jobs = listJobs();
      if (jobs.length === 0) {
        await ctx.reply(
          "⏰ <b>Cron Jobs</b>\n\nNo jobs configured.\n\n" +
          "Create:\n" +
          "<code>/cron add 5m reminder Wasser trinken</code>\n" +
          "<code>/cron add \"0 9 * * 1\" shell pm2 status</code>\n" +
          "<code>/cron add 1h http https://api.example.com/health</code>\n\n" +
          "<i>Manage jobs also in the Web UI under ⏰ Cron.</i>",
          { parse_mode: "HTML" }
        );
        return;
      }

      const lines = jobs.map(j => {
        const status = j.enabled ? "🟢" : "⏸️";
        const next = j.enabled ? formatNextRun(j.nextRunAt) : "paused";
        const lastErr = j.lastError ? " ⚠️" : "";
        const readable = humanReadableSchedule(j.schedule);
        const recur = j.oneShot ? "⚡ One-shot" : "🔄 " + readable;
        return `${status} <b>${j.name}</b>\n   📅 ${recur} | Next: ${next}\n   Runs: ${j.runCount}${lastErr} | ID: <code>${j.id}</code>`;
      });

      const keyboard = new InlineKeyboard();
      for (const j of jobs) {
        const label = j.enabled ? `⏸ ${j.name}` : `▶️ ${j.name}`;
        keyboard.text(label, `cron:toggle:${j.id}`);
        keyboard.text(`🗑`, `cron:delete:${j.id}`);
        keyboard.row();
      }

      await ctx.reply(
        `⏰ <b>Cron Jobs (${jobs.length}):</b>\n\n${lines.join("\n\n")}\n\n` +
        `Commands: /cron add · delete · toggle · run · info`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
      return;
    }

    // /cron add <schedule> <type> <payload> [--timeout <sec|off>]
    if (arg.startsWith("add ")) {
      let rest = arg.slice(4).trim();

      // Extract optional --timeout flag from anywhere in the command.
      // Accepts seconds, "off", "unlimited", "-1", or "0" — anything ≤ 0
      // or non-numeric collapses to -1 (unlimited).
      let timeoutMs: number | undefined;
      const timeoutMatch = rest.match(/(^|\s)--timeout\s+(\S+)/);
      if (timeoutMatch) {
        const val = timeoutMatch[2].toLowerCase();
        if (["off", "unlimited", "infinite", "-1", "0"].includes(val)) {
          timeoutMs = -1;
        } else {
          const secs = Number(timeoutMatch[2]);
          if (!Number.isFinite(secs) || secs < 0) {
            await ctx.reply(
              `❌ Invalid <code>--timeout</code> value: ${timeoutMatch[2]}`,
              { parse_mode: "HTML" },
            );
            return;
          }
          timeoutMs = Math.floor(secs * 1000);
        }
        rest = rest.replace(/(^|\s)--timeout\s+\S+/, "").trim();
      }

      // Natural language schedule shortcuts (German + English)
      const naturalSchedules: Record<string, string> = {
        "täglich": "0 8 * * *", "daily": "0 8 * * *",
        "stündlich": "0 * * * *", "hourly": "0 * * * *",
        "wöchentlich": "0 8 * * 1", "weekly": "0 8 * * 1",
        "monatlich": "0 8 1 * *", "monthly": "0 8 1 * *",
        "werktags": "0 8 * * 1-5", "weekdays": "0 8 * * 1-5",
        "wochenende": "0 10 * * 0,6", "weekend": "0 10 * * 0,6",
        "montags": "0 8 * * 1", "dienstags": "0 8 * * 2", "mittwochs": "0 8 * * 3",
        "donnerstags": "0 8 * * 4", "freitags": "0 8 * * 5", "samstags": "0 10 * * 6", "sonntags": "0 10 * * 0",
        "morgens": "0 8 * * *", "mittags": "0 12 * * *", "abends": "0 18 * * *", "nachts": "0 0 * * *",
      };

      // Time-prefixed natural: "8:30 täglich" or "täglich 8:30"
      function resolveNatural(input: string): { schedule: string; rest: string } | null {
        // Try "HH:MM keyword rest" or "keyword HH:MM rest"
        const timeKeyword = input.match(/^(\d{1,2}):(\d{2})\s+(\S+)\s*(.*)/);
        if (timeKeyword) {
          const key = timeKeyword[3].toLowerCase();
          if (naturalSchedules[key]) {
            const base = naturalSchedules[key].split(" ");
            base[0] = String(parseInt(timeKeyword[2]));
            base[1] = String(parseInt(timeKeyword[1]));
            return { schedule: base.join(" "), rest: timeKeyword[4] };
          }
        }
        const keywordTime = input.match(/^(\S+)\s+(\d{1,2}):(\d{2})\s*(.*)/);
        if (keywordTime) {
          const key = keywordTime[1].toLowerCase();
          if (naturalSchedules[key]) {
            const base = naturalSchedules[key].split(" ");
            base[0] = String(parseInt(keywordTime[3]));
            base[1] = String(parseInt(keywordTime[2]));
            return { schedule: base.join(" "), rest: keywordTime[4] };
          }
        }
        // Simple keyword
        const firstWord = input.split(" ")[0].toLowerCase();
        if (naturalSchedules[firstWord]) {
          return { schedule: naturalSchedules[firstWord], rest: input.slice(firstWord.length).trim() };
        }
        return null;
      }

      // Parse: schedule can be "5m", natural keyword, or "0 9 * * 1" (quoted)
      let schedule: string;
      let remainder: string;

      const natural = resolveNatural(rest);
      if (natural) {
        schedule = natural.schedule;
        remainder = natural.rest;
      } else if (rest.startsWith('"')) {
        const endQuote = rest.indexOf('"', 1);
        if (endQuote < 0) { await ctx.reply("❌ Missing closing quote for cron expression."); return; }
        schedule = rest.slice(1, endQuote);
        remainder = rest.slice(endQuote + 1).trim();
      } else {
        const sp = rest.indexOf(" ");
        if (sp < 0) { await ctx.reply("Format: <code>/cron add &lt;schedule&gt; &lt;type&gt; &lt;payload&gt; [--timeout &lt;sec|off&gt;]</code>\n\nSchedule options:\n• <b>Intervals:</b> 5m, 1h, 30s, 2d\n• <b>Natural:</b> daily, weekly, monthly, weekdays, hourly\n• <b>With time:</b> 8:30 daily, weekdays 9:00\n• <b>German:</b> täglich, wöchentlich, morgens, abends\n• <b>Cron:</b> \"0 9 * * 1-5\"\n\nOptional <code>--timeout</code> in seconds, or <code>off</code>/<code>-1</code> for unlimited.", { parse_mode: "HTML" }); return; }
        schedule = rest.slice(0, sp);
        remainder = rest.slice(sp + 1).trim();
      }

      // Parse type + payload
      const typeSp = remainder.indexOf(" ");
      const typeStr = typeSp >= 0 ? remainder.slice(0, typeSp) : remainder;
      const payloadStr = typeSp >= 0 ? remainder.slice(typeSp + 1).trim() : "";

      const validTypes = ["reminder", "shell", "http", "message", "ai-query"];
      if (!validTypes.includes(typeStr)) {
        await ctx.reply(`❌ Invalid type "${typeStr}". Allowed: ${validTypes.join(", ")}`);
        return;
      }

      const payload: Record<string, string> = {};
      switch (typeStr) {
        case "reminder": case "message": payload.text = payloadStr; break;
        case "shell": payload.command = payloadStr; break;
        case "http": payload.url = payloadStr; break;
        case "ai-query": payload.prompt = payloadStr; break;
      }

      const name = `${typeStr}: ${payloadStr.slice(0, 30)}${payloadStr.length > 30 ? "..." : ""}`;

      const job = createJob({
        name,
        type: typeStr as JobType,
        schedule,
        payload,
        target: { platform: "telegram", chatId: String(chatId) },
        createdBy: `telegram:${userId}`,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });

      const readableSched = humanReadableSchedule(job.schedule);
      const timeoutLine =
        typeof job.timeoutMs === "number"
          ? job.timeoutMs <= 0
            ? `<b>Timeout:</b> ∞ (unlimited)\n`
            : `<b>Timeout:</b> ${Math.round(job.timeoutMs / 1000)}s\n`
          : "";
      await ctx.reply(
        `✅ <b>Cron Job created</b>\n\n` +
        `<b>Name:</b> ${job.name}\n` +
        `📅 <b>${readableSched}</b>\n` +
        `<b>Type:</b> ${job.type}\n` +
        timeoutLine +
        `<b>Next run:</b> ${formatNextRun(job.nextRunAt)}\n` +
        `<b>ID:</b> <code>${job.id}</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // /cron delete <id>
    if (arg.startsWith("delete ")) {
      const id = arg.slice(7).trim();
      if (deleteJob(id)) {
        await ctx.reply(`✅ Job \`${id}\` deleted.`, { parse_mode: "Markdown" });
      } else {
        await ctx.reply(`❌ Job \`${id}\` not found.`, { parse_mode: "Markdown" });
      }
      return;
    }

    // /cron toggle <id>
    if (arg.startsWith("toggle ")) {
      const id = arg.slice(7).trim();
      const job = toggleJob(id);
      if (job) {
        await ctx.reply(`${job.enabled ? "▶️" : "⏸️"} Job "${job.name}" ${job.enabled ? "enabled" : "paused"}.`);
      } else {
        await ctx.reply(`❌ Job not found.`);
      }
      return;
    }

    // /cron run <name-or-id>
    //
    // UX contract:
    //   1. Instantly post a "🚀 Started …" message so the user knows
    //      the command was received.
    //   2. Every 60s edit that message with the elapsed-time ticker
    //      so the chat shows proof-of-life during 10+ min sub-agent
    //      runs (the Daily Job Alert takes ~13 min in production).
    //   3. When runJobNow returns, edit the same message into a
    //      final "✅ Done" / "❌ error" / "⏳ already running" state.
    //   4. The heavy lifting (banner + full body + chunking) stays in
    //      subagent-delivery.ts — which now has a Markdown→plain-text
    //      fallback so it actually reaches the user.
    if (arg.startsWith("run ")) {
      const nameOrId = arg.slice(4).trim();

      // Resolve up-front so we can show the real job name in the
      // "Started" ack, and so we handle the not-found case BEFORE
      // spending a Telegram round-trip on a pointless placeholder.
      const resolved = resolveJobByNameOrId(listJobs(), nameOrId);
      if (!resolved) {
        const jobs = listJobs();
        const hint = jobs.length > 0
          ? `\n\nAvailable:\n${jobs.slice(0, 10).map(j => `• ${j.name}`).join("\n")}`
          : "";
        await ctx.reply(`❌ No job matches <code>${nameOrId}</code>.${hint}`, { parse_mode: "HTML" });
        return;
      }

      const jobName = resolved.name;
      const startedAt = Date.now();

      // Post initial ack — we'll edit THIS message for the ticker and
      // the final state.
      let ackMessageId: number | null = null;
      try {
        const ack = await ctx.reply(
          `🚀 Started *${escapeMarkdown(jobName)}* — working…`,
          { parse_mode: "Markdown" },
        );
        ackMessageId = ack.message_id;
      } catch (err) {
        // If even the initial ack fails, fall back to plain text so
        // the user still knows we received the command.
        try {
          const ack = await ctx.reply(`🚀 Started ${jobName} — working…`);
          ackMessageId = ack.message_id;
        } catch { /* give up on the ack — run still fires below */ }
      }

      const chatId = ctx.chat!.id;

      // Progress ticker: edit the ack message with elapsed time every
      // 60s. Errors from editMessageText (including the harmless
      // "message is not modified") are swallowed via the central filter.
      const ticker = setInterval(async () => {
        if (ackMessageId === null) return;
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        try {
          await ctx.api.editMessageText(
            chatId,
            ackMessageId,
            buildTickerText(jobName, elapsed),
            { parse_mode: "Markdown" },
          );
        } catch (err) {
          if (!isHarmlessTelegramError(err)) {
            console.warn(`[cron:run] ticker edit failed:`, err);
          }
        }
      }, 60_000);

      let outcome: Awaited<ReturnType<typeof runJobNow>>;
      try {
        outcome = await runJobNow(nameOrId);
      } finally {
        clearInterval(ticker);
      }

      // Final state — edit the ack message one last time.
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const finalText = (() => {
        if (outcome.status === "not-found") {
          // Shouldn't happen — we already resolved successfully above —
          // but handle it for completeness.
          return `❌ ${escapeMarkdown(jobName)} — not found (race?)`;
        }
        if (outcome.status === "already-running") {
          return buildDoneText(outcome.job.name, elapsed, { ok: true, skipped: true });
        }
        return buildDoneText(outcome.job.name, elapsed, {
          ok: !outcome.error,
          error: outcome.error,
        });
      })();

      if (ackMessageId !== null) {
        try {
          await ctx.api.editMessageText(
            chatId,
            ackMessageId,
            finalText,
            { parse_mode: "Markdown" },
          );
        } catch (err) {
          if (!isHarmlessTelegramError(err)) {
            // Last-ditch fallback: post as a new plain message so the
            // user sees the result even if the edit failed.
            await ctx.reply(finalText).catch(() => { /* nothing more to do */ });
          }
        }
      } else {
        // We never got an ack message id — just post fresh
        await ctx.reply(finalText, { parse_mode: "Markdown" }).catch(() =>
          ctx.reply(finalText),
        );
      }
      return;
    }

    await ctx.reply("Unknown cron command. Use /cron for help.");
  });

  // Inline keyboard callbacks for cron
  bot.callbackQuery(/^cron:toggle:(.+)$/, async (ctx) => {
    const id = ctx.match![1];
    const job = toggleJob(id);
    if (job) {
      await ctx.answerCallbackQuery(`${job.enabled ? "Enabled" : "Paused"}: ${job.name}`);
      // Refresh the cron list
      (ctx as any).match = "";
      // Re-render the list message (HTML to avoid Markdown * conflicts with cron expressions)
      const jobs = listJobs();
      const lines = jobs.map(j => {
        const status = j.enabled ? "🟢" : "⏸️";
        const next = j.enabled ? formatNextRun(j.nextRunAt) : "paused";
        const readable = humanReadableSchedule(j.schedule);
        const recur = j.oneShot ? "⚡ One-shot" : "🔄 " + readable;
        return `${status} <b>${j.name}</b>\n   📅 ${recur} | Next: ${next}\n   Runs: ${j.runCount} | ID: <code>${j.id}</code>`;
      });
      const keyboard = new InlineKeyboard();
      for (const j of jobs) {
        keyboard.text(j.enabled ? `⏸ ${j.name}` : `▶️ ${j.name}`, `cron:toggle:${j.id}`);
        keyboard.text(`🗑`, `cron:delete:${j.id}`);
        keyboard.row();
      }
      await ctx.editMessageText(`⏰ <b>Cron Jobs (${jobs.length}):</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", reply_markup: keyboard });
    }
  });

  bot.callbackQuery(/^cron:delete:(.+)$/, async (ctx) => {
    const id = ctx.match![1];
    deleteJob(id);
    await ctx.answerCallbackQuery("Deleted");
    // Refresh (HTML parse mode)
    const jobs = listJobs();
    if (jobs.length === 0) {
      await ctx.editMessageText("⏰ No cron jobs configured.");
    } else {
      const lines = jobs.map(j => {
        const status = j.enabled ? "🟢" : "⏸️";
        const readable = humanReadableSchedule(j.schedule);
        return `${status} <b>${j.name}</b>\n   📅 ${readable} | ID: <code>${j.id}</code>`;
      });
      const keyboard = new InlineKeyboard();
      for (const j of jobs) {
        keyboard.text(j.enabled ? `⏸ ${j.name}` : `▶️ ${j.name}`, `cron:toggle:${j.id}`);
        keyboard.text(`🗑`, `cron:delete:${j.id}`);
        keyboard.row();
      }
      await ctx.editMessageText(`⏰ <b>Cron Jobs (${jobs.length}):</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", reply_markup: keyboard });
    }
  });

  // ── Setup (API Keys & Platforms via Telegram) ─────────

  bot.command("setup", async (ctx) => {
    const arg = ctx.match?.toString().trim() || "";

    if (!arg) {
      const registry = getRegistry();
      const providers = await registry.listAll();
      const activeInfo = registry.getActive().getInfo();

      const keyboard = new InlineKeyboard()
        .text("🔑 Manage API Keys", "setup:keys").row()
        .text("📱 Platforms", "setup:platforms").row()
        .text("🔐 Sudo / Admin Access", "setup:sudo").row()
        .text("🔧 Open Web Dashboard", "setup:web").row();

      await ctx.reply(
        `⚙️ *Alvin Bot Setup*\n\n` +
        `*Active Model:* ${activeInfo.name}\n` +
        `*Providers:* ${providers.length} configured\n` +
        `*Web UI:* http://localhost:${process.env.WEB_PORT || 3100}\n\n` +
        `What would you like to configure?`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      return;
    }

    // /setup sudo [password] — configure sudo access
    if (arg.startsWith("sudo")) {
      const pw = arg.slice(4).trim();

      if (!pw) {
        // Show status
        const status = await getSudoStatus();
        const statusIcon = status.configured ? (status.verified ? "✅" : "⚠️") : "❌";

        const keyboard = new InlineKeyboard();
        if (status.configured) {
          keyboard.text("🧪 Verify", "sudo:verify").row();
          keyboard.text("🔴 Revoke Access", "sudo:revoke").row();
        }

        await ctx.reply(
          `🔐 *Sudo / Admin Access*\n\n` +
          `*Status:* ${statusIcon} ${status.configured ? (status.verified ? "Configured & verified" : "Configured, not verified") : "Not set up"}\n` +
          `*Storage:* ${status.storageMethod}\n` +
          `*System:* ${status.platform} (${status.user})\n` +
          (status.permissions.accessibility !== null ? `*Accessibility:* ${status.permissions.accessibility ? "✅" : "❌"}\n` : "") +
          (status.permissions.fullDiskAccess !== null ? `*Full Disk Access:* ${status.permissions.fullDiskAccess ? "✅" : "❌"}\n` : "") +
          `\n*Setup:*\n\`/setup sudo <your-system-password>\`\n\n` +
          `_The password is securely stored in ${status.storageMethod}. ` +
          `This allows Alvin Bot to run admin commands (install software, change system settings, etc.)._\n\n` +
          `⚠️ _Delete this message after setup! The password is visible in chat history._`,
          { parse_mode: "Markdown", reply_markup: keyboard }
        );
        return;
      }

      // Store the password
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      const result = storePassword(pw);

      if (!result.ok) {
        await ctx.reply(`❌ Error saving: ${result.error}`);
        return;
      }

      // Verify
      const verify = await verifyPassword();
      if (verify.ok) {
        await ctx.reply(
          `✅ *Sudo access configured!*\n\n` +
          `Password stored in: ${result.method}\n` +
          `Verification: ✅ successful\n\n` +
          `Alvin Bot can now run admin commands.\n\n` +
          `⚠️ _Please delete the message with the password from the chat!_`,
          { parse_mode: "Markdown" }
        );
      } else {
        revokePassword(); // Wrong password — clean up
        await ctx.reply(
          `❌ *Wrong password!*\n\n` +
          `The entered password does not work for sudo.\n` +
          `Please try again: \`/setup sudo <correct-password>\``,
          { parse_mode: "Markdown" }
        );
      }

      // Try to delete the user's message containing the password
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, ctx.message!.message_id);
      } catch {
        // Can't delete in private chats sometimes — that's ok
      }
      return;
    }

    // /setup key <provider> <key>
    if (arg.startsWith("key ")) {
      const parts = arg.slice(4).trim().split(/\s+/);
      if (parts.length < 2) {
        await ctx.reply(
          "🔑 *Set API Key:*\n\n" +
          "`/setup key openai sk-...`\n" +
          "`/setup key google AIza...`\n" +
          "`/setup key nvidia nvapi-...`\n" +
          "`/setup key openrouter sk-or-...`\n\n" +
          "_The key will be saved to .env. Restart required._",
          { parse_mode: "Markdown" }
        );
        return;
      }

      const envMap: Record<string, string> = {
        openai: "OPENAI_API_KEY",
        google: "GOOGLE_API_KEY",
        nvidia: "NVIDIA_API_KEY",
        openrouter: "OPENROUTER_API_KEY",
        groq: "GROQ_API_KEY",
      };

      const provider = parts[0].toLowerCase();
      const key = parts.slice(1).join(" ");
      const envKey = envMap[provider];

      if (!envKey) {
        await ctx.reply(`❌ Unknown provider "${provider}". Use: ${Object.keys(envMap).join(", ")}`);
        return;
      }

      // Write to .env
      const envFile = resolve(process.cwd(), ".env");
      let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf-8") : "";
      const regex = new RegExp(`^${envKey}=.*$`, "m");
      if (regex.test(content)) content = content.replace(regex, `${envKey}=${key}`);
      else content = content.trimEnd() + `\n${envKey}=${key}\n`;
      fs.writeFileSync(envFile, content);

      await ctx.reply(`✅ ${envKey} saved! Please restart the bot (/system restart or Web UI).`);
      return;
    }
  });

  bot.callbackQuery(/^sudo:(.+)$/, async (ctx) => {
    const action = ctx.match![1];
    if (action === "verify") {
      const result = await verifyPassword();
      await ctx.answerCallbackQuery(result.ok ? "✅ Sudo works!" : `❌ ${result.error}`);
    } else if (action === "revoke") {
      revokePassword();
      await ctx.editMessageText("🔴 Sudo access revoked. Password deleted.");
      await ctx.answerCallbackQuery("Access revoked");
    }
  });

  bot.callbackQuery(/^setup:(.+)$/, async (ctx) => {
    const action = ctx.match![1];

    switch (action) {
      case "keys": {
        const envMap = [
          { name: "OpenAI", env: "OPENAI_API_KEY", has: !!config.apiKeys.openai },
          { name: "Google", env: "GOOGLE_API_KEY", has: !!config.apiKeys.google },
          { name: "NVIDIA", env: "NVIDIA_API_KEY", has: !!config.apiKeys.nvidia },
          { name: "OpenRouter", env: "OPENROUTER_API_KEY", has: !!config.apiKeys.openrouter },
          { name: "Groq", env: "GROQ_API_KEY", has: !!config.apiKeys.groq },
        ];

        const lines = envMap.map(e => `${e.has ? "✅" : "❌"} *${e.name}* — \`${e.env}\``);

        await ctx.editMessageText(
          `🔑 *API Keys*\n\n${lines.join("\n")}\n\n` +
          `Set key: \`/setup key <provider> <key>\`\n` +
          `Example: \`/setup key nvidia nvapi-...\`\n\n` +
          `_Restart required after changes._`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      case "platforms": {
        const platforms = [
          { name: "Telegram", icon: "📱", env: "BOT_TOKEN", has: !!process.env.BOT_TOKEN },
          { name: "Discord", icon: "🎮", env: "DISCORD_TOKEN", has: !!process.env.DISCORD_TOKEN },
          { name: "WhatsApp", icon: "💬", env: "WHATSAPP_ENABLED", has: process.env.WHATSAPP_ENABLED === "true" },
          { name: "Signal", icon: "🔒", env: "SIGNAL_API_URL", has: !!process.env.SIGNAL_API_URL },
        ];

        const lines = platforms.map(p => `${p.has ? "✅" : "❌"} ${p.icon} *${p.name}* — \`${p.env}\``);

        await ctx.editMessageText(
          `📱 *Platforms*\n\n${lines.join("\n")}\n\n` +
          `_Set up platforms in Web UI: Models → Platforms_\n` +
          `_There you can enter tokens and install dependencies._`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      case "sudo": {
        const status = await getSudoStatus();
        const statusIcon = status.configured ? (status.verified ? "✅" : "⚠️") : "❌";
        await ctx.editMessageText(
          `🔐 *Sudo / Admin Access*\n\n` +
          `*Status:* ${statusIcon} ${status.configured ? (status.verified ? "Active & verified" : "Configured") : "Not set up"}\n` +
          `*Storage:* ${status.storageMethod}\n\n` +
          `Setup: \`/setup sudo <system-password>\`\n` +
          `Revoke: \`/setup sudo\` → "Revoke" button\n\n` +
          `_The password is securely stored in ${status.storageMethod}._`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      case "web": {
        await ctx.editMessageText(
          `🌐 *Web Dashboard*\n\n` +
          `URL: \`http://localhost:${process.env.WEB_PORT || 3100}\`\n\n` +
          `In the dashboard you can:\n` +
          `• 🤖 Manage models & API keys\n` +
          `• 📱 Set up platforms\n` +
          `• ⏰ Manage cron jobs\n` +
          `• 🧠 Edit memory\n` +
          `• 💻 Use terminal\n` +
          `• 🛠️ Run tools`,
          { parse_mode: "Markdown" }
        );
        break;
      }
    }
    await ctx.answerCallbackQuery();
  });

  bot.command("cancel", async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    const lang = session.language;
    if (session.isProcessing && session.abortController) {
      session.abortController.abort();
      await ctx.reply(t("bot.cancel.cancelling", lang));
    } else {
      await ctx.reply(t("bot.cancel.noRunning", lang));
    }
  });

  // /restart — trigger a PM2-managed restart by exiting the process.
  // The PM2 supervisor picks up the exit and respawns with --update-env.
  bot.command("restart", async (ctx) => {
    const lang = getSession(ctx.from!.id).language;
    await ctx.reply(t("bot.restart.triggered", lang));
    // Small delay so the Telegram message is actually delivered before exit
    setTimeout(() => process.exit(0), 500);
  });

  // /update — git pull + install + build, then PM2-restart if anything changed.
  bot.command("update", async (ctx) => {
    const lang = getSession(ctx.from!.id).language;
    await ctx.reply(t("bot.update.checking", lang));
    try {
      const result = await runUpdate();
      if (result.ok) {
        await ctx.reply(`✅ ${result.message}`);
        // Extract the installed version from the message (e.g. "Installed v4.16.1 ...")
        // so we can look up its CHANGELOG block. Falls silently if no match.
        const versionMatch = result.message.match(/v(\d+\.\d+\.\d+)/);
        if (versionMatch) {
          const highlights = getReleaseHighlights(versionMatch[1]);
          if (highlights) {
            await ctx.reply(`📝 *What's new in v${versionMatch[1]}*\n\n${highlights}`, {
              parse_mode: "Markdown",
            });
          }
        }
        if (result.requiresRestart) {
          await ctx.reply(t("bot.update.restarting", lang));
          setTimeout(() => process.exit(0), 500);
        }
      } else {
        await ctx.reply(`${t("bot.update.failed", lang)}\n\`${result.message}\``, { parse_mode: "Markdown" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`${t("bot.update.error", lang)} ${msg}`);
    }
  });

  // /autoupdate on|off|status — toggle the background auto-update loop.
  // Persisted to ~/.alvin-bot/auto-update.flag so it survives restarts.
  bot.command("autoupdate", async (ctx) => {
    const lang = getSession(ctx.from!.id).language;
    const arg = (ctx.match || "").trim().toLowerCase();
    if (arg === "on") {
      setAutoUpdate(true);
      await ctx.reply(t("bot.autoupdate.enabled", lang), { parse_mode: "Markdown" });
    } else if (arg === "off") {
      setAutoUpdate(false);
      await ctx.reply(t("bot.autoupdate.disabled", lang), { parse_mode: "Markdown" });
    } else {
      const status = getAutoUpdate();
      await ctx.reply(
        `${t("bot.autoupdate.statusLabel", lang)} *${status ? "ON" : "OFF"}*\n\n${t("bot.autoupdate.commandsLabel", lang)}\n\`/autoupdate on\`\n\`/autoupdate off\``,
        { parse_mode: "Markdown" }
      );
    }
  });

  // ── /sub-agents — manage background subagents (cron jobs + manual spawns) ──
  //
  // /sub-agents                → show current config + running agents
  // /sub-agents max <n>        → set max parallel (0 = auto = CPU cores, capped 16)
  // /sub-agents list           → list all agents with IDs
  // /sub-agents cancel <id>    → cancel a specific running agent
  // /sub-agents result <id>    → show the result of a completed agent
  //
  // Grammy normalises command names — dashes are not allowed in the command
  // string, so the actual handler binds to "subagents" (no dash). Users can
  // type both "/sub-agents" and "/subagents" — Telegram routes both to this.
  bot.command(["sub_agents", "subagents"], async (ctx) => {
    const lang = getSession(ctx.from!.id).language;
    const {
      listSubAgents,
      listActiveSubAgents,
      cancelSubAgent,
      getSubAgentResult,
      getMaxParallelAgents,
      getConfiguredMaxParallel,
      setMaxParallelAgents,
      findSubAgentByName,
      getVisibility,
      setVisibility,
      getQueueCap,
      setQueueCap,
      getDefaultTimeoutMs,
      setDefaultTimeoutMs,
    } = await import("../services/subagents.js");

    const arg = (ctx.match || "").trim();
    const tokens = arg.split(/\s+/).filter(Boolean);
    const sub = tokens[0]?.toLowerCase() || "";

    // Helper: shorten a UUID to its first 8 chars for display
    const shortId = (id: string) => id.slice(0, 8);

    // Helper: format a SubAgentInfo line with depth indent (F2 visibility)
    const formatAgent = (a: {
      id: string;
      name: string;
      status: string;
      source?: string;
      startedAt: number;
      depth: number;
      queuePosition?: number;
    }) => {
      const indent = "  ".repeat(Math.max(0, a.depth));
      const ageSec = Math.floor((Date.now() - a.startedAt) / 1000);
      const ageLabel = ageSec < 60 ? `${ageSec}s` : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m` : `${Math.floor(ageSec / 3600)}h`;
      const sourceBadge = a.source === "cron" ? "⏰" : a.source === "implicit" ? "🔗" : "👤";
      const depthTag = a.depth > 0 ? ` d${a.depth}` : "";
      const queueTag = a.status === "queued" && a.queuePosition ? ` #${a.queuePosition}` : "";
      return `${indent}${sourceBadge} \`${shortId(a.id)}\` ${a.name} (${a.status}${queueTag}, ${ageLabel}${depthTag})`;
    };

    // /sub-agents max <n>
    if (sub === "max") {
      const n = parseInt(tokens[1] || "", 10);
      if (isNaN(n)) {
        await ctx.reply(t("bot.subagents.usage", lang), { parse_mode: "Markdown" });
        return;
      }
      const effective = setMaxParallelAgents(n);
      await ctx.reply(t("bot.subagents.maxSet", lang, { n, eff: effective }), { parse_mode: "Markdown" });
      return;
    }

    // /subagents stats — show rolling 24h run stats (H3)
    if (sub === "stats") {
      const { getSubAgentStats } = await import("../services/subagent-stats.js");
      const s = getSubAgentStats();
      const formatTok = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
      const formatDur = (ms: number) => {
        const sec = Math.floor(ms / 1000);
        if (sec < 60) return `${sec}s`;
        const m = Math.floor(sec / 60);
        return `${m}m`;
      };
      const lines = [
        `📊 *Sub-Agent Stats* — last ${s.windowHours}h`,
        ``,
        `*Total:* ${s.total.runs} runs · ${formatTok(s.total.inputTokens)} in / ${formatTok(s.total.outputTokens)} out · ${formatDur(s.total.totalDurationMs)}`,
        ``,
        `*By source:*`,
        `  👤 user:     ${s.bySource.user.runs} runs · ${formatTok(s.bySource.user.inputTokens)} in / ${formatTok(s.bySource.user.outputTokens)} out`,
        `  ⏰ cron:     ${s.bySource.cron.runs} runs · ${formatTok(s.bySource.cron.inputTokens)} in / ${formatTok(s.bySource.cron.outputTokens)} out`,
        `  🔗 implicit: ${s.bySource.implicit.runs} runs · ${formatTok(s.bySource.implicit.inputTokens)} in / ${formatTok(s.bySource.implicit.outputTokens)} out`,
        ``,
        `*By status:*`,
        `  ✅ completed: ${s.byStatus.completed}`,
        `  ⚠️ cancelled: ${s.byStatus.cancelled}`,
        `  ⏱️ timeout:   ${s.byStatus.timeout}`,
        `  ❌ error:     ${s.byStatus.error}`,
      ];
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }

    // /subagents timeout [sec|off|unlimited|-1] — set default sub-agent timeout
    if (sub === "timeout") {
      const val = tokens[1];
      const formatTimeout = (ms: number): string => {
        if (ms <= 0) return "∞ (unlimited)";
        if (ms < 1000) return `${ms}ms`;
        const sec = ms / 1000;
        if (sec < 60) return `${sec}s`;
        const min = sec / 60;
        if (min < 60) return `${min.toFixed(min < 10 ? 1 : 0)}min`;
        return `${(min / 60).toFixed(1)}h`;
      };
      if (!val) {
        const current = getDefaultTimeoutMs();
        await ctx.reply(
          `⏱ Default sub-agent timeout: *${formatTimeout(current)}*\n\n` +
            `Usage: \`/subagents timeout <sec>\` · \`/subagents timeout off\`\n` +
            `\`off\`, \`unlimited\`, \`-1\` oder \`0\` = kein Timeout. ` +
            `Gilt für neue Subagents und ai-query Cron-Jobs ohne eigenen Wert.`,
          { parse_mode: "Markdown" },
        );
        return;
      }
      const lower = val.toLowerCase();
      let ms: number;
      if (["off", "unlimited", "infinite", "-1", "0"].includes(lower)) {
        ms = -1;
      } else {
        const secs = Number(val);
        if (!Number.isFinite(secs) || secs < 0) {
          await ctx.reply(
            `❌ Ungültiger Wert \`${val}\`. Nutze Sekunden (z.B. \`300\`) oder \`off\`.`,
            { parse_mode: "Markdown" },
          );
          return;
        }
        ms = Math.floor(secs * 1000);
      }
      const effective = setDefaultTimeoutMs(ms);
      await ctx.reply(
        `✅ Default sub-agent timeout: *${formatTimeout(effective)}*`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    // /subagents queue <n> — set bounded-queue cap (0 disables queue)
    if (sub === "queue") {
      const n = parseInt(tokens[1] || "", 10);
      if (isNaN(n)) {
        const current = getQueueCap();
        await ctx.reply(
          `Queue cap: *${current}* (${current === 0 ? "disabled" : "bounded"})\nUsage: \`/subagents queue <n>\` (0 disables the queue, max 200)`,
          { parse_mode: "Markdown" },
        );
        return;
      }
      const effective = setQueueCap(n);
      await ctx.reply(
        `✅ Queue cap set to *${effective}* ${effective === 0 ? "(queue disabled — full pool rejects immediately)" : ""}`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    // /sub-agents visibility <auto|banner|silent|live>
    if (sub === "visibility") {
      const mode = tokens[1];
      if (!mode) {
        // Show current value
        const current = getVisibility();
        await ctx.reply(
          `${t("bot.subagents.visibilityLabel", lang)} *${current}*\n\n${t("bot.subagents.usage", lang)}`,
          { parse_mode: "Markdown" },
        );
        return;
      }
      try {
        setVisibility(mode as "auto" | "banner" | "silent" | "live");
        await ctx.reply(
          t("bot.subagents.visibilitySet", lang, { mode }),
          { parse_mode: "Markdown" },
        );
      } catch {
        await ctx.reply(
          t("bot.subagents.visibilityInvalid", lang, { mode }),
          { parse_mode: "Markdown" },
        );
      }
      return;
    }

    // /sub-agents list  — same rendering as the default, but forced
    // v4.14.1 — uses listActiveSubAgents (merged view) so v4.13+
    // alvin_dispatch_agent detached subprocesses also show up here.
    if (sub === "list") {
      const agents = await listActiveSubAgents();
      if (agents.length === 0) {
        await ctx.reply(t("bot.subagents.noneRunning", lang));
        return;
      }
      const lines = agents.map(formatAgent).join("\n");
      await ctx.reply(`${t("bot.subagents.activeHeader", lang)}\n${lines}`, { parse_mode: "Markdown" });
      return;
    }

    // /sub-agents cancel <name|id>
    // Resolution order: exact name → base-name (single match) → UUID prefix.
    // If the base name is ambiguous, show a disambiguation reply.
    if (sub === "cancel") {
      const key = tokens[1] || "";
      if (!key) {
        await ctx.reply(t("bot.subagents.usage", lang), { parse_mode: "Markdown" });
        return;
      }
      // 1. Ambiguity check via the resolver
      const ambig = findSubAgentByName(key, { ambiguousAsList: true });
      if (ambig && "ambiguous" in ambig) {
        const list = ambig.candidates.map((c) => `• ${c.name}`).join("\n");
        await ctx.reply(
          `Mehrdeutig — welchen meinst du?\n${list}\n\nBenutze den genauen Namen (z.B. \`${ambig.candidates[0].name}\`).`,
          { parse_mode: "Markdown" },
        );
        return;
      }
      // 2. Name match → cancel via that id
      let targetId: string | null = null;
      let displayName = key;
      if (ambig && !("ambiguous" in ambig)) {
        targetId = ambig.id;
        displayName = ambig.name;
      } else {
        // 3. Fallback: UUID-prefix match (back-compat with old usage)
        const allAgents = listSubAgents();
        const byId = allAgents.find((a) => a.id.startsWith(key));
        if (byId) {
          targetId = byId.id;
          displayName = byId.name;
        }
      }
      if (!targetId || !cancelSubAgent(targetId)) {
        await ctx.reply(t("bot.subagents.notFound", lang, { id: key }));
        return;
      }
      await ctx.reply(t("bot.subagents.cancelled", lang, { id: displayName }));
      return;
    }

    // /sub-agents result <name|id>
    if (sub === "result") {
      const key = tokens[1] || "";
      if (!key) {
        await ctx.reply(t("bot.subagents.usage", lang), { parse_mode: "Markdown" });
        return;
      }
      const ambig = findSubAgentByName(key, { ambiguousAsList: true });
      if (ambig && "ambiguous" in ambig) {
        const list = ambig.candidates.map((c) => `• ${c.name}`).join("\n");
        await ctx.reply(
          `Mehrdeutig — welchen meinst du?\n${list}`,
          { parse_mode: "Markdown" },
        );
        return;
      }
      let target: { id: string; name: string } | null = null;
      if (ambig && !("ambiguous" in ambig)) {
        target = { id: ambig.id, name: ambig.name };
      } else {
        const allAgents = listSubAgents();
        const byId = allAgents.find((a) => a.id.startsWith(key));
        if (byId) target = { id: byId.id, name: byId.name };
      }
      if (!target) {
        await ctx.reply(t("bot.subagents.notFound", lang, { id: key }));
        return;
      }
      const result = getSubAgentResult(target.id);
      if (!result) {
        await ctx.reply(t("bot.subagents.notFound", lang, { id: key }));
        return;
      }
      const duration = Math.floor(result.duration / 1000);
      const header = t("bot.subagents.resultHeader", lang, { name: result.name, status: result.status });
      const meta = t("bot.subagents.resultDuration", lang, { sec: duration, in: result.tokensUsed.input, out: result.tokensUsed.output });
      // Cap output at ~3500 chars to stay inside Telegram message limit
      const body = result.output.length > 3500 ? result.output.slice(0, 3500) + "\n\n…[truncated]" : result.output;
      await ctx.reply(`${header}\n${meta}\n\n${body || result.error || "(no output)"}`, { parse_mode: "Markdown" }).catch(() =>
        // retry without markdown in case the body has unescaped characters
        ctx.reply(`${header}\n${meta}\n\n${body || result.error || "(no output)"}`)
      );
      return;
    }

    // Default: /sub-agents — show state + running list
    const configured = getConfiguredMaxParallel();
    const effective = getMaxParallelAgents();
    const maxLabel = configured === 0
      ? `${t("bot.subagents.maxLabel", lang)} 0 ${t("bot.subagents.autoSuffix", lang, { n: effective })}`
      : `${t("bot.subagents.maxLabel", lang)} ${configured}`;
    const visibilityLabel = `${t("bot.subagents.visibilityLabel", lang)} *${getVisibility()}*`;
    const currentTimeout = getDefaultTimeoutMs();
    const timeoutLabel = currentTimeout <= 0
      ? `⏱ Timeout: *∞ (unlimited)*`
      : `⏱ Timeout: *${Math.round(currentTimeout / 1000)}s*`;

    // v4.14.1 — merged view incl. v4.13+ alvin_dispatch_agent agents.
    const agents = await listActiveSubAgents();
    let body = "";
    if (agents.length === 0) {
      body = `\n${t("bot.subagents.noneRunning", lang)}`;
    } else {
      body = `\n${t("bot.subagents.activeHeader", lang)}\n${agents.map(formatAgent).join("\n")}`;
    }

    const header = t("bot.subagents.header", lang);
    const usage = `\n\n${t("bot.subagents.usage", lang)}`;
    const full = `${header}\n${maxLabel}\n${visibilityLabel}\n${timeoutLabel}${body}${usage}`;
    await ctx.reply(full, { parse_mode: "Markdown" }).catch(() =>
      ctx.reply(full)
    );
  });
}
