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
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_FILE = resolve(BOT_ROOT, ".env");
const BACKUP_DIR = resolve(BOT_ROOT, "backups");
const DOCS_DIR = resolve(BOT_ROOT, "docs");

// Files to include in backups
const BACKUP_FILES = [
  ".env",
  "SOUL.md",
  "CLAUDE.md",
  "docs/tools.json",
  "docs/custom-models.json",
  "docs/cron-jobs.json",
  "docs/mcp.json",
  "docs/MEMORY.md",
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
      message: ".env Datei fehlt",
      fix: "Erstelle eine Standard-.env aus .env.example",
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
        message: "BOT_TOKEN nicht gesetzt — Telegram Bot kann nicht starten",
      });
    }

    // Check ALLOWED_USERS
    if (!envContent.includes("ALLOWED_USERS=") || envContent.match(/ALLOWED_USERS=\s*$/m)) {
      issues.push({
        severity: "warning",
        category: "Security",
        message: "ALLOWED_USERS nicht gesetzt — jeder kann den Bot nutzen",
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
          message: `.env Zeile ${i + 1}: Ungültiges Format "${line.slice(0, 40)}..."`,
          fix: `Zeile entfernen oder korrigieren`,
          fixAction: `fix-env-line:${i}`,
        });
      }
    }

    // Check for common issues
    if (envContent.includes('""') || envContent.match(/="?\s*$/m)) {
      issues.push({
        severity: "warning",
        category: "Config",
        message: "Leere Werte in .env gefunden — einige Features könnten nicht funktionieren",
      });
    }
  }

  // 2. Check docs directory
  if (!fs.existsSync(DOCS_DIR)) {
    issues.push({
      severity: "error",
      category: "Dateien",
      message: "docs/ Verzeichnis fehlt",
      fix: "Erstelle docs/ Verzeichnis",
      fixAction: "create-docs",
    });
  }

  // 3. Check tools.json validity
  const toolsFile = resolve(DOCS_DIR, "tools.json");
  if (fs.existsSync(toolsFile)) {
    try {
      JSON.parse(fs.readFileSync(toolsFile, "utf-8"));
    } catch {
      issues.push({
        severity: "error",
        category: "Tools",
        message: "docs/tools.json ist kein gültiges JSON",
        fix: "JSON-Fehler automatisch reparieren oder auf Backup zurücksetzen",
        fixAction: "fix-tools-json",
      });
    }
  }

  // 4. Check custom-models.json validity
  const modelsFile = resolve(DOCS_DIR, "custom-models.json");
  if (fs.existsSync(modelsFile)) {
    try {
      JSON.parse(fs.readFileSync(modelsFile, "utf-8"));
    } catch {
      issues.push({
        severity: "error",
        category: "Models",
        message: "docs/custom-models.json ist kein gültiges JSON",
        fix: "Auf leeres Array zurücksetzen",
        fixAction: "fix-custom-models",
      });
    }
  }

  // 5. Check cron-jobs.json
  const cronFile = resolve(DOCS_DIR, "cron-jobs.json");
  if (fs.existsSync(cronFile)) {
    try {
      JSON.parse(fs.readFileSync(cronFile, "utf-8"));
    } catch {
      issues.push({
        severity: "error",
        category: "Cron",
        message: "docs/cron-jobs.json ist kein gültiges JSON",
        fix: "Auf leeres Array zurücksetzen",
        fixAction: "fix-cron-json",
      });
    }
  }

  // 6. Check SOUL.md exists
  if (!fs.existsSync(resolve(BOT_ROOT, "SOUL.md"))) {
    issues.push({
      severity: "warning",
      category: "Personality",
      message: "SOUL.md fehlt — Bot hat keine Persönlichkeit",
      fix: "Standard-SOUL.md erstellen",
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
        message: `Node.js ${nodeVersion} — empfohlen ist v20+`,
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
        message: `Festplatte ${usagePercent}% voll`,
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
      message: "PM2 nicht gefunden — empfohlen für Prozess-Management",
    });
  }

  // Good news if no issues
  if (issues.length === 0) {
    issues.push({
      severity: "info",
      category: "Status",
      message: "✅ Alles in Ordnung! Keine Probleme gefunden.",
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
          return { ok: true, message: ".env aus .env.example erstellt" };
        }
        fs.writeFileSync(ENV_FILE, "BOT_TOKEN=\nALLOWED_USERS=\nPRIMARY_PROVIDER=claude-sdk\n");
        return { ok: true, message: "Standard-.env erstellt (BOT_TOKEN muss noch gesetzt werden)" };
      }

      case "create-docs": {
        fs.mkdirSync(DOCS_DIR, { recursive: true });
        fs.mkdirSync(resolve(DOCS_DIR, "memory"), { recursive: true });
        return { ok: true, message: "docs/ Verzeichnis erstellt" };
      }

      case "fix-tools-json": {
        fs.writeFileSync(resolve(DOCS_DIR, "tools.json"), JSON.stringify({ tools: [] }, null, 2));
        return { ok: true, message: "tools.json auf leeres Toolset zurückgesetzt" };
      }

      case "fix-custom-models": {
        fs.writeFileSync(resolve(DOCS_DIR, "custom-models.json"), "[]");
        return { ok: true, message: "custom-models.json zurückgesetzt" };
      }

      case "fix-cron-json": {
        fs.writeFileSync(resolve(DOCS_DIR, "cron-jobs.json"), "[]");
        return { ok: true, message: "cron-jobs.json zurückgesetzt" };
      }

      case "create-soul": {
        fs.writeFileSync(resolve(BOT_ROOT, "SOUL.md"),
          "# Alvin Bot — Persönlichkeit\n\n" +
          "Du bist ein hilfreicher, direkter und kompetenter AI-Assistent.\n" +
          "Antworte klar und präzise. Hab Meinungen. Sei echt hilfreich.\n"
        );
        return { ok: true, message: "Standard-SOUL.md erstellt" };
      }

      default: {
        if (action.startsWith("fix-env-line:")) {
          const lineIdx = parseInt(action.split(":")[1]);
          const lines = fs.readFileSync(ENV_FILE, "utf-8").split("\n");
          if (lineIdx >= 0 && lineIdx < lines.length) {
            lines[lineIdx] = "# " + lines[lineIdx]; // Comment out broken line
            fs.writeFileSync(ENV_FILE, lines.join("\n"));
            return { ok: true, message: `Zeile ${lineIdx + 1} auskommentiert` };
          }
        }
        return { ok: false, message: `Unbekannte Aktion: ${action}` };
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

  for (const relPath of BACKUP_FILES) {
    const src = resolve(BOT_ROOT, relPath);
    if (fs.existsSync(src)) {
      const destDir = resolve(backupPath, dirname(relPath));
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, resolve(backupPath, relPath));
      backedUp.push(relPath);
    }
  }

  // Also backup the memory directory
  const memDir = resolve(DOCS_DIR, "memory");
  if (fs.existsSync(memDir)) {
    const memBackup = resolve(backupPath, "docs", "memory");
    fs.mkdirSync(memBackup, { recursive: true });
    for (const f of fs.readdirSync(memDir)) {
      if (f.endsWith(".md")) {
        fs.copyFileSync(resolve(memDir, f), resolve(memBackup, f));
        backedUp.push(`docs/memory/${f}`);
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
    return { ok: false, restored: [], errors: ["Backup nicht gefunden"] };
  }

  const restored: string[] = [];
  const errors: string[] = [];

  const filesToRestore = files || BACKUP_FILES;

  for (const relPath of filesToRestore) {
    const src = resolve(backupPath, relPath);
    const dest = resolve(BOT_ROOT, relPath);
    if (fs.existsSync(src)) {
      try {
        const destDir = dirname(dest);
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(src, dest);
        restored.push(relPath);
      } catch (err) {
        errors.push(`${relPath}: ${err instanceof Error ? err.message : String(err)}`);
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
    res.end(JSON.stringify({ ok: true, note: "Bot wird neugestartet..." }));
    setTimeout(() => process.exit(0), 500); // PM2 auto-restarts
    return true;
  }

  // ── PM2 Process Control ────────────────────────────────

  // GET /api/pm2/status — Get PM2 process info
  if (urlPath === "/api/pm2/status") {
    try {
      const output = execSync("pm2 jlist", { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
      const processes = JSON.parse(output);

      // Find our process (by name or script)
      const botProcess = processes.find((p: any) =>
        p.name === "alvin-bot" ||
        p.pm2_env?.pm_exec_path?.includes("alvin-bot")
      ) || processes[0]; // fallback to first process

      if (!botProcess) {
        res.end(JSON.stringify({ error: "Kein PM2-Prozess gefunden" }));
        return true;
      }

      const env = botProcess.pm2_env || {};
      res.end(JSON.stringify({
        process: {
          name: botProcess.name,
          pid: botProcess.pid,
          status: env.status || "unknown",
          uptime: env.pm_uptime ? Date.now() - env.pm_uptime : 0,
          memory: botProcess.monit?.memory || 0,
          cpu: botProcess.monit?.cpu || 0,
          restarts: env.restart_time || 0,
          version: env.version || "?",
          nodeVersion: env.node_version || process.version,
          execPath: env.pm_exec_path || "?",
          cwd: env.pm_cwd || "?",
        },
      }));
    } catch (err) {
      res.end(JSON.stringify({ error: "PM2 nicht verfügbar" }));
    }
    return true;
  }

  // POST /api/pm2/action — Execute PM2 action (restart, stop, start, reload, flush)
  if (urlPath === "/api/pm2/action" && req.method === "POST") {
    try {
      const { action } = JSON.parse(body);
      const allowed = ["restart", "stop", "start", "reload", "flush"];
      if (!allowed.includes(action)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: `Ungültige Aktion: ${action}` }));
        return true;
      }

      // Find our process name
      let processName = "alvin-bot";
      try {
        const jlist = execSync("pm2 jlist", { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
        const procs = JSON.parse(jlist);
        const found = procs.find((p: any) =>
          p.name === "alvin-bot" || p.name === "alvin-bot"
        );
        if (found) processName = found.name;
      } catch { /* use default */ }

      if (action === "flush") {
        execSync(`pm2 flush ${processName}`, { encoding: "utf-8", timeout: 10000, stdio: "pipe" });
        res.end(JSON.stringify({ ok: true, message: "Logs geleert" }));
        return true;
      }

      if (action === "stop") {
        // Stop is special — we can't respond after stopping ourselves
        res.end(JSON.stringify({ ok: true, message: "Bot wird gestoppt..." }));
        setTimeout(() => {
          try {
            execSync(`pm2 stop ${processName}`, { timeout: 10000, stdio: "pipe" });
          } catch { /* process might already be dead */ }
        }, 300);
        return true;
      }

      if (action === "start") {
        // Start the process if stopped
        execSync(`pm2 start ${processName}`, { encoding: "utf-8", timeout: 10000, stdio: "pipe" });
        res.end(JSON.stringify({ ok: true, message: "Bot gestartet" }));
        return true;
      }

      if (action === "restart" || action === "reload") {
        res.end(JSON.stringify({ ok: true, message: `Bot wird ${action === "restart" ? "neugestartet" : "neu geladen"}...` }));
        setTimeout(() => {
          try {
            execSync(`pm2 ${action} ${processName} --update-env`, { timeout: 15000, stdio: "pipe" });
          } catch { /* PM2 might kill us during restart */ }
        }, 300);
        return true;
      }
    } catch (err) {
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // GET /api/pm2/logs — Get recent PM2 logs
  if (urlPath === "/api/pm2/logs") {
    try {
      // Find process name
      let processName = "alvin-bot";
      try {
        const jlist = execSync("pm2 jlist", { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
        const procs = JSON.parse(jlist);
        const found = procs.find((p: any) =>
          p.name === "alvin-bot" || p.name === "alvin-bot"
        );
        if (found) processName = found.name;
      } catch { /* use default */ }

      let logs = execSync(`pm2 logs ${processName} --nostream --lines 30 2>&1`, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: "pipe",
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      });
      // Strip ANSI escape codes
      logs = logs.replace(/\x1b\[[0-9;]*m/g, "");
      res.end(JSON.stringify({ logs }));
    } catch (err) {
      res.end(JSON.stringify({ error: "Logs nicht verfügbar", logs: "" }));
    }
    return true;
  }

  return false;
}
