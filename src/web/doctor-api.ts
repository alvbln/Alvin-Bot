/**
 * Doctor & Backup API — Self-healing, diagnostics, and backup/restore.
 *
 * Features:
 * - Health check (diagnose config issues)
 * - Auto-repair (fix common problems)
 * - Backup (snapshot all config files)
 * - Restore from backup
 * - Bot restart
 */

import fs from "fs";
import http from "http";
import { resolve, dirname, basename } from "path";
import { execSync } from "child_process";
import { BOT_ROOT, ENV_FILE, BACKUP_DIR, DATA_DIR, MEMORY_DIR, MEMORY_FILE, SOUL_FILE, SOUL_EXAMPLE, TOOLS_MD, TOOLS_JSON, CUSTOM_MODELS, CRON_FILE, MCP_CONFIG } from "../paths.js";
import { writeSecure } from "../services/file-permissions.js";

// Files to include in backups (absolute paths)
const BACKUP_FILES: Array<{ src: string; label: string }> = [
  { src: ENV_FILE, label: ".env" },
  { src: SOUL_FILE, label: "soul.md" },
  { src: resolve(BOT_ROOT, "CLAUDE.md"), label: "CLAUDE.md" },
  { src: TOOLS_MD, label: "tools.md" },
  { src: CUSTOM_MODELS, label: "custom-models.json" },
  { src: CRON_FILE, label: "cron-jobs.json" },
  { src: MCP_CONFIG, label: "mcp.json" },
  { src: MEMORY_FILE, label: "MEMORY.md" },
];

// ── Health Checks ───────────────────────────────────────

interface HealthIssue {
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
  fix?: string; // Auto-fix description
  fixAction?: string; // Action ID for auto-repair
}

function runHealthCheck(): HealthIssue[] {
  const issues: HealthIssue[] = [];

  // 1. Check .env exists
  if (!fs.existsSync(ENV_FILE)) {
    issues.push({
      severity: "error",
      category: "Config",
      message: ".env file missing",
      fix: "Create a default .env from .env.example",
      fixAction: "create-env",
    });
  } else {
    // Parse .env
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");

    // Check BOT_TOKEN
    if (!envContent.includes("BOT_TOKEN=") || envContent.match(/BOT_TOKEN=\s*$/m)) {
      issues.push({
        severity: "error",
        category: "Telegram",
        message: "BOT_TOKEN not set — Telegram bot cannot start",
      });
    }

    // Check ALLOWED_USERS
    if (!envContent.includes("ALLOWED_USERS=") || envContent.match(/ALLOWED_USERS=\s*$/m)) {
      issues.push({
        severity: "warning",
        category: "Security",
        message: "ALLOWED_USERS not set — anyone can use the bot",
      });
    }

    // Check for syntax errors in .env
    const lines = envContent.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;
      if (!line.includes("=")) {
        issues.push({
          severity: "error",
          category: "Config",
          message: `.env line ${i + 1}: Invalid format "${line.slice(0, 40)}..."`,
          fix: `Remove or fix the line`,
          fixAction: `fix-env-line:${i}`,
        });
      }
    }

    // Check for common issues
    if (envContent.includes('""') || envContent.match(/="?\s*$/m)) {
      issues.push({
        severity: "warning",
        category: "Config",
        message: "Empty values found in .env — some features may not work",
      });
    }
  }

  // 2. Check data directory
  if (!fs.existsSync(DATA_DIR)) {
    issues.push({
      severity: "error",
      category: "Files",
      message: "Data directory missing (~/.alvin-bot/)",
      fix: "Create data directory",
      fixAction: "create-docs",
    });
  }

  // 3. Check TOOLS.md validity (legacy tools.json as fallback)
  if (fs.existsSync(TOOLS_MD)) {
    // Validate TOOLS.md has at least one ## heading (tool definition)
    const content = fs.readFileSync(TOOLS_MD, "utf-8");
    if (!content.includes("## ")) {
      issues.push({
        severity: "warning",
        category: "Tools",
        message: "TOOLS.md contains no tool definitions (## headings missing)",
        fix: "Recreate TOOLS.md from TOOLS.example.md",
        fixAction: "fix-tools-json",
      });
    }
  } else if (fs.existsSync(TOOLS_JSON)) {
    try {
      JSON.parse(fs.readFileSync(TOOLS_JSON, "utf-8"));
    } catch {
      issues.push({
        severity: "error",
        category: "Tools",
        message: "tools.json is not valid JSON",
        fix: "Auto-repair JSON errors or reset to backup",
        fixAction: "fix-tools-json",
      });
    }
  } else {
    issues.push({
      severity: "info",
      category: "Tools",
      message: "No custom tools configured (tools.md missing)",
      fix: "Create tools.md from example",
      fixAction: "fix-tools-json",
    });
  }

  // 4. Check custom-models.json validity
  if (fs.existsSync(CUSTOM_MODELS)) {
    try {
      JSON.parse(fs.readFileSync(CUSTOM_MODELS, "utf-8"));
    } catch {
      issues.push({
        severity: "error",
        category: "Models",
        message: "custom-models.json is not valid JSON",
        fix: "Reset to empty array",
        fixAction: "fix-custom-models",
      });
    }
  }

  // 5. Check cron-jobs.json
  if (fs.existsSync(CRON_FILE)) {
    try {
      JSON.parse(fs.readFileSync(CRON_FILE, "utf-8"));
    } catch {
      issues.push({
        severity: "error",
        category: "Cron",
        message: "cron-jobs.json is not valid JSON",
        fix: "Reset to empty array",
        fixAction: "fix-cron-json",
      });
    }
  }

  // 6. Check soul.md exists
  if (!fs.existsSync(SOUL_FILE)) {
    issues.push({
      severity: "warning",
      category: "Personality",
      message: "soul.md missing — bot has no personality",
      fix: "Create default soul.md",
      fixAction: "create-soul",
    });
  }

  // 7. Check Node.js version
  try {
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1));
    if (major < 20) {
      issues.push({
        severity: "warning",
        category: "System",
        message: `Node.js ${nodeVersion} — v20+ recommended`,
      });
    }
  } catch { /* ignore */ }

  // 8. Check disk space (basic)
  try {
    const dfOutput = execSync("df -h . | tail -1", { cwd: BOT_ROOT, stdio: "pipe", timeout: 5000 }).toString();
    const parts = dfOutput.trim().split(/\s+/);
    const usagePercent = parseInt(parts[4]);
    if (usagePercent > 90) {
      issues.push({
        severity: "warning",
        category: "System",
        message: `Disk ${usagePercent}% full`,
      });
    }
  } catch { /* ignore */ }

  // 9. Check PM2
  try {
    execSync("pm2 jlist", { stdio: "pipe", timeout: 5000 });
  } catch {
    issues.push({
      severity: "info",
      category: "System",
      message: "PM2 not found — recommended for process management",
    });
  }

  // Good news if no issues
  if (issues.length === 0) {
    issues.push({
      severity: "info",
      category: "Status",
      message: "All good! No issues found.",
    });
  }

  return issues;
}

// ── Auto-Repair ─────────────────────────────────────────

function autoRepair(action: string): { ok: boolean; message: string } {
  try {
    switch (action) {
      case "create-env": {
        const exampleFile = resolve(BOT_ROOT, ".env.example");
        if (fs.existsSync(exampleFile)) {
          fs.copyFileSync(exampleFile, ENV_FILE);
          // v4.12.2 — enforce 0o600 on fresh .env
          try { fs.chmodSync(ENV_FILE, 0o600); } catch { /* fs may not support */ }
          return { ok: true, message: ".env created from .env.example" };
        }
        writeSecure(ENV_FILE, "BOT_TOKEN=\nALLOWED_USERS=\nPRIMARY_PROVIDER=claude-sdk\n");
        return { ok: true, message: "Default .env created (BOT_TOKEN still needs to be set)" };
      }

      case "create-docs": {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.mkdirSync(MEMORY_DIR, { recursive: true });
        return { ok: true, message: "Data directory created" };
      }

      case "fix-tools-json": {
        // Reset to empty — prefer creating tools.md
        if (!fs.existsSync(TOOLS_MD)) {
          fs.mkdirSync(dirname(TOOLS_MD), { recursive: true });
          fs.writeFileSync(TOOLS_MD, "# Custom Tools\n\n> Define your own tools here. Each `##` heading creates a new tool.\n");
          return { ok: true, message: "tools.md created with empty toolset" };
        }
        fs.mkdirSync(dirname(TOOLS_JSON), { recursive: true });
        fs.writeFileSync(TOOLS_JSON, JSON.stringify({ tools: [] }, null, 2));
        return { ok: true, message: "tools.json reset to empty toolset" };
      }

      case "fix-custom-models": {
        fs.mkdirSync(dirname(CUSTOM_MODELS), { recursive: true });
        fs.writeFileSync(CUSTOM_MODELS, "[]");
        return { ok: true, message: "custom-models.json reset" };
      }

      case "fix-cron-json": {
        fs.mkdirSync(dirname(CRON_FILE), { recursive: true });
        fs.writeFileSync(CRON_FILE, "[]");
        return { ok: true, message: "cron-jobs.json reset" };
      }

      case "create-soul": {
        fs.mkdirSync(dirname(SOUL_FILE), { recursive: true });
        // Try to copy from example, otherwise create default
        if (fs.existsSync(SOUL_EXAMPLE)) {
          fs.copyFileSync(SOUL_EXAMPLE, SOUL_FILE);
        } else {
          fs.writeFileSync(SOUL_FILE,
            "# Alvin Bot — Personality\n\n" +
            "You are a helpful, direct, and competent AI assistant.\n" +
            "Reply clearly and precisely. Have opinions. Be genuinely helpful.\n"
          );
        }
        return { ok: true, message: "Default soul.md created" };
      }

      default: {
        if (action.startsWith("fix-env-line:")) {
          const lineIdx = parseInt(action.split(":")[1]);
          const lines = fs.readFileSync(ENV_FILE, "utf-8").split("\n");
          if (lineIdx >= 0 && lineIdx < lines.length) {
            lines[lineIdx] = "# " + lines[lineIdx]; // Comment out broken line
            writeSecure(ENV_FILE, lines.join("\n"));
            return { ok: true, message: `Line ${lineIdx + 1} commented out` };
          }
        }
        return { ok: false, message: `Unknown action: ${action}` };
      }
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ── Backup ──────────────────────────────────────────────

function createBackup(name?: string): { ok: boolean; id: string; files: string[]; path: string } {
  const id = name || `backup-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const backupPath = resolve(BACKUP_DIR, id);

  fs.mkdirSync(backupPath, { recursive: true });

  const backedUp: string[] = [];

  for (const { src, label } of BACKUP_FILES) {
    if (fs.existsSync(src)) {
      const dest = resolve(backupPath, label);
      fs.mkdirSync(dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      backedUp.push(label);
    }
  }

  // Also backup the memory directory
  if (fs.existsSync(MEMORY_DIR)) {
    const memBackup = resolve(backupPath, "memory");
    fs.mkdirSync(memBackup, { recursive: true });
    for (const f of fs.readdirSync(MEMORY_DIR)) {
      if (f.endsWith(".md")) {
        fs.copyFileSync(resolve(MEMORY_DIR, f), resolve(memBackup, f));
        backedUp.push(`memory/${f}`);
      }
    }
  }

  return { ok: true, id, files: backedUp, path: backupPath };
}

function listBackups(): Array<{ id: string; createdAt: number; fileCount: number; size: number }> {
  if (!fs.existsSync(BACKUP_DIR)) return [];

  return fs.readdirSync(BACKUP_DIR)
    .filter(d => {
      const p = resolve(BACKUP_DIR, d);
      return fs.statSync(p).isDirectory();
    })
    .map(d => {
      const p = resolve(BACKUP_DIR, d);
      const stat = fs.statSync(p);
      let fileCount = 0;
      let totalSize = 0;

      function countFiles(dir: string) {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          if (f.isDirectory()) countFiles(resolve(dir, f.name));
          else {
            fileCount++;
            totalSize += fs.statSync(resolve(dir, f.name)).size;
          }
        }
      }
      countFiles(p);

      return { id: d, createdAt: stat.mtimeMs, fileCount, size: totalSize };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function restoreBackup(id: string, files?: string[]): { ok: boolean; restored: string[]; errors: string[] } {
  const backupPath = resolve(BACKUP_DIR, id);
  if (!backupPath.startsWith(BACKUP_DIR) || !fs.existsSync(backupPath)) {
    return { ok: false, restored: [], errors: ["Backup not found"] };
  }

  const restored: string[] = [];
  const errors: string[] = [];

  // Build label→dest mapping from BACKUP_FILES
  const labelToSrc = new Map(BACKUP_FILES.map(bf => [bf.label, bf.src]));

  const filesToRestore = files || BACKUP_FILES.map(bf => bf.label);

  for (const label of filesToRestore) {
    const src = resolve(backupPath, label);
    const dest = labelToSrc.get(label) || resolve(DATA_DIR, label);
    if (fs.existsSync(src)) {
      try {
        fs.mkdirSync(dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        restored.push(label);
      } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { ok: errors.length === 0, restored, errors };
}

function getBackupFiles(id: string): string[] {
  const backupPath = resolve(BACKUP_DIR, id);
  if (!backupPath.startsWith(BACKUP_DIR) || !fs.existsSync(backupPath)) return [];

  const files: string[] = [];
  function walk(dir: string, prefix: string) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${f.name}` : f.name;
      if (f.isDirectory()) walk(resolve(dir, f.name), rel);
      else files.push(rel);
    }
  }
  walk(backupPath, "");
  return files;
}

function deleteBackup(id: string): boolean {
  const backupPath = resolve(BACKUP_DIR, id);
  if (!backupPath.startsWith(BACKUP_DIR) || !fs.existsSync(backupPath)) return false;
  fs.rmSync(backupPath, { recursive: true });
  return true;
}

// ── API Handler ─────────────────────────────────────────

export async function handleDoctorAPI(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string,
  body: string
): Promise<boolean> {
  res.setHeader("Content-Type", "application/json");

  // GET /api/doctor — run health check
  if (urlPath === "/api/doctor") {
    const issues = runHealthCheck();
    const errorCount = issues.filter(i => i.severity === "error").length;
    const warnCount = issues.filter(i => i.severity === "warning").length;
    res.end(JSON.stringify({ issues, errorCount, warnCount, healthy: errorCount === 0 }));
    return true;
  }

  // POST /api/doctor/repair — auto-repair an issue
  if (urlPath === "/api/doctor/repair" && req.method === "POST") {
    try {
      const { action } = JSON.parse(body);
      const result = autoRepair(action);
      res.end(JSON.stringify(result));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // POST /api/doctor/repair-all — fix all auto-fixable issues
  if (urlPath === "/api/doctor/repair-all" && req.method === "POST") {
    const issues = runHealthCheck();
    const results: Array<{ action: string; ok: boolean; message: string }> = [];
    for (const issue of issues) {
      if (issue.fixAction) {
        const result = autoRepair(issue.fixAction);
        results.push({ action: issue.fixAction, ...result });
      }
    }
    res.end(JSON.stringify({ results }));
    return true;
  }

  // GET /api/backups — list backups
  if (urlPath === "/api/backups") {
    const backups = listBackups();
    res.end(JSON.stringify({ backups }));
    return true;
  }

  // POST /api/backups/create — create a backup
  if (urlPath === "/api/backups/create" && req.method === "POST") {
    try {
      const { name } = JSON.parse(body || "{}");
      const result = createBackup(name);
      res.end(JSON.stringify(result));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      res.end(JSON.stringify({ ok: false, error }));
    }
    return true;
  }

  // POST /api/backups/restore — restore from a backup
  if (urlPath === "/api/backups/restore" && req.method === "POST") {
    try {
      const { id, files } = JSON.parse(body);
      const result = restoreBackup(id, files);
      res.end(JSON.stringify(result));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // GET /api/backups/:id/files — list files in a backup
  if (urlPath.match(/^\/api\/backups\/[^/]+\/files$/)) {
    const id = urlPath.split("/")[3];
    const files = getBackupFiles(id);
    res.end(JSON.stringify({ id, files }));
    return true;
  }

  // POST /api/backups/delete — delete a backup
  if (urlPath === "/api/backups/delete" && req.method === "POST") {
    try {
      const { id } = JSON.parse(body);
      const ok = deleteBackup(id);
      res.end(JSON.stringify({ ok }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return true;
  }

  // POST /api/restart — restart the bot (legacy)
  if (urlPath === "/api/bot/restart" && req.method === "POST") {
    const { scheduleGracefulRestart } = await import("../services/restart.js");
    res.end(JSON.stringify({ ok: true, note: "Bot is restarting..." }));
    scheduleGracefulRestart(500);
    return true;
  }

  // ── Process Control (v4.13.1: launchd/pm2/standalone auto-detect) ──
  //
  // Routes kept under `/api/pm2/*` for UI compat — the UI still calls
  // those paths. Under the hood we now use the process-manager
  // abstraction which auto-detects launchd (macOS native installs)
  // or pm2 (VPS / legacy Mac installs) or standalone (neither).

  // GET /api/pm2/status — Get process info via detected manager
  if (urlPath === "/api/pm2/status") {
    try {
      const { detectProcessManager } = await import("../services/process-manager.js");
      const pm = detectProcessManager();
      const status = await pm.getStatus();

      res.end(JSON.stringify({
        process: {
          name: "alvin-bot",
          kind: status.kind,
          pid: status.pid ?? 0,
          status: status.status,
          uptime: status.uptime ?? 0,
          memory: status.memory ?? 0,
          cpu: status.cpu ?? 0,
          restarts: status.restarts ?? 0,
          version: status.version || "?",
          nodeVersion: status.nodeVersion || process.version,
          execPath: status.execPath || "?",
          cwd: status.cwd || "?",
        },
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.end(JSON.stringify({ error: `Process manager detection failed: ${msg}` }));
    }
    return true;
  }

  // POST /api/pm2/action — Execute action via detected manager
  if (urlPath === "/api/pm2/action" && req.method === "POST") {
    try {
      const { action } = JSON.parse(body);
      const allowed = ["restart", "stop", "start", "reload", "flush"];
      if (!allowed.includes(action)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: `Invalid action: ${action}` }));
        return true;
      }

      const { detectProcessManager } = await import("../services/process-manager.js");
      const pm = detectProcessManager();

      if (action === "flush") {
        // Truncate our own log files directly — works on both launchd
        // and standalone. PM2's flush is also just truncation.
        const logDir = resolve(DATA_DIR, "logs");
        for (const f of ["alvin-bot.out.log", "alvin-bot.err.log"]) {
          try {
            fs.truncateSync(resolve(logDir, f), 0);
          } catch {
            /* file may not exist — ignore */
          }
        }
        res.end(JSON.stringify({ ok: true, message: "Logs flushed" }));
        return true;
      }

      if (action === "stop") {
        // Stop is special — can't respond after we've killed ourselves.
        res.end(JSON.stringify({ ok: true, message: `Bot is stopping (${pm.kind})...` }));
        setTimeout(() => {
          pm.stop().catch(() => {
            /* process might already be dead */
          });
        }, 300);
        return true;
      }

      if (action === "start") {
        await pm.start();
        res.end(JSON.stringify({ ok: true, message: `Bot started via ${pm.kind}` }));
        return true;
      }

      if (action === "restart" || action === "reload") {
        const { scheduleGracefulRestart } = await import("../services/restart.js");
        res.end(JSON.stringify({
          ok: true,
          message: `Bot is ${action === "restart" ? "restarting" : "reloading"} (${pm.kind})...`,
        }));
        scheduleGracefulRestart(500);
        return true;
      }
    } catch (err) {
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // GET /api/pm2/logs — Get recent logs via detected manager
  if (urlPath === "/api/pm2/logs") {
    try {
      const { detectProcessManager } = await import("../services/process-manager.js");
      const pm = detectProcessManager();
      const logs = await pm.getLogs(30);
      res.end(JSON.stringify({ logs, kind: pm.kind }));
    } catch (err) {
      res.end(JSON.stringify({
        error: "Logs not available",
        logs: "",
        detail: err instanceof Error ? err.message : String(err),
      }));
    }
    return true;
  }

  return false;
}
