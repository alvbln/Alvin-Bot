import fs from "fs";
import { execSync } from "child_process";
import { resolve } from "path";
import dotenv from "dotenv";
import { DATA_DIR, ENV_FILE } from "../paths.js";

interface AuditCheck {
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  message: string;
}

export function runAudit(): AuditCheck[] {
  const checks: AuditCheck[] = [];

  // `alvin-bot audit` runs in its own process (outside the main bot) and
  // does NOT go through src/config.ts, so process.env is empty by default.
  // We must load the .env ourselves or ALLOWED_USERS/WEB_PASSWORD checks
  // will always report as "not set" — which silently contradicts the bot's
  // actual runtime state (a bug up to v4.4.5).
  if (fs.existsSync(ENV_FILE)) {
    dotenv.config({ path: ENV_FILE });
  }

  // 1. .env file permissions
  const envFile = ENV_FILE;
  if (fs.existsSync(envFile)) {
    const stat = fs.statSync(envFile);
    const mode = (stat.mode & 0o777).toString(8);
    checks.push(mode === "600"
      ? { name: ".env permissions", status: "PASS", message: `Mode ${mode} (secure)` }
      : { name: ".env permissions", status: "WARN", message: `Mode ${mode} — should be 600. Run: chmod 600 ${envFile}` }
    );
  } else {
    checks.push({ name: ".env file", status: "WARN", message: "No .env file found" });
  }

  // 2. Check for secrets in git
  try {
    const gitOutput = execSync("git diff HEAD --cached --diff-filter=ACM -- . | grep -iE '(api.key|token|password|secret)\\s*=' || true", { cwd: DATA_DIR, stdio: "pipe" }).toString();
    checks.push(gitOutput.trim()
      ? { name: "Secrets in git", status: "FAIL", message: `Possible secrets in staged files:\n${gitOutput.trim()}` }
      : { name: "Secrets in git", status: "PASS", message: "No secrets detected in staged files" }
    );
  } catch {
    checks.push({ name: "Secrets in git", status: "PASS", message: "Not a git repo or no staged changes" });
  }

  // 3. ALLOWED_USERS set
  const allowedUsers = process.env.ALLOWED_USERS || "";
  checks.push(allowedUsers
    ? { name: "ALLOWED_USERS", status: "PASS", message: `${allowedUsers.split(",").length} user(s) configured` }
    : { name: "ALLOWED_USERS", status: "WARN", message: "Not set — anyone can message the bot" }
  );

  // 4. WEB_PASSWORD
  const webPassword = process.env.WEB_PASSWORD || "";
  checks.push(webPassword
    ? { name: "WEB_PASSWORD", status: "PASS", message: "Set" }
    : { name: "WEB_PASSWORD", status: "WARN", message: "Not set — Web UI is unprotected" }
  );

  // 5. WEBHOOK_TOKEN
  if (process.env.WEBHOOK_ENABLED === "true") {
    checks.push(process.env.WEBHOOK_TOKEN
      ? { name: "WEBHOOK_TOKEN", status: "PASS", message: "Set" }
      : { name: "WEBHOOK_TOKEN", status: "FAIL", message: "Webhooks enabled but no token set — anyone can trigger!" }
    );
  }

  // 6. Data dir permissions
  if (fs.existsSync(DATA_DIR)) {
    const stat = fs.statSync(DATA_DIR);
    const mode = (stat.mode & 0o777).toString(8);
    checks.push(parseInt(mode, 8) <= 0o755
      ? { name: "Data dir permissions", status: "PASS", message: `${DATA_DIR} mode ${mode}` }
      : { name: "Data dir permissions", status: "WARN", message: `${DATA_DIR} mode ${mode} — consider restricting` }
    );
  }

  return checks;
}

export function formatAuditReport(checks: AuditCheck[]): string {
  const icons = { PASS: "✅", WARN: "⚠️", FAIL: "❌" };
  let report = "Security Audit Report\n" + "=".repeat(40) + "\n\n";
  for (const c of checks) {
    report += `${icons[c.status]} ${c.name}: ${c.message}\n`;
  }
  const fails = checks.filter(c => c.status === "FAIL").length;
  const warns = checks.filter(c => c.status === "WARN").length;
  report += `\n${"=".repeat(40)}\n`;
  report += `${checks.length} checks: ${checks.length - fails - warns} passed, ${warns} warnings, ${fails} failures\n`;
  return report;
}
