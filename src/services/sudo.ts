/**
 * Sudo / Elevated Access Service
 *
 * Manages superadmin privileges for Mr. Levin on the host system.
 * Password is stored securely in the macOS Keychain (or encrypted file on Linux).
 *
 * Features:
 * - Store/retrieve sudo password securely
 * - Execute commands with sudo
 * - Grant/revoke elevated access
 * - OS dialog handling (Accessibility, Full Disk Access, etc.)
 * - Status check (is sudo configured? does it work?)
 */

import { execSync, spawn } from "child_process";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PLATFORM = os.platform();
const KEYCHAIN_SERVICE = "mr-levin-sudo";
const KEYCHAIN_ACCOUNT = "mr-levin";
const ENCRYPTED_PASS_FILE = resolve(BOT_ROOT, "data", ".sudo-enc");
const ENCRYPTION_KEY_FILE = resolve(BOT_ROOT, "data", ".sudo-key");

// ── Password Storage ────────────────────────────────────

/**
 * Store sudo password securely.
 * macOS: Uses Keychain. Linux: Uses encrypted file.
 */
export function storePassword(password: string): { ok: boolean; method: string; error?: string } {
  try {
    if (PLATFORM === "darwin") {
      // macOS: Store in Keychain
      // First try to delete existing entry
      try {
        execSync(`security delete-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" 2>/dev/null`, { stdio: "pipe" });
      } catch { /* didn't exist */ }

      execSync(
        `security add-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w "${password.replace(/"/g, '\\"')}" -U`,
        { stdio: "pipe", timeout: 5000 }
      );
      return { ok: true, method: "macOS Keychain" };
    } else {
      // Linux/other: Encrypted file
      const key = crypto.randomBytes(32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      let encrypted = cipher.update(password, "utf-8", "hex");
      encrypted += cipher.final("hex");
      const authTag = cipher.getAuthTag();

      const dataDir = resolve(BOT_ROOT, "data");
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

      // Store key separately (basic separation of concerns)
      fs.writeFileSync(ENCRYPTION_KEY_FILE, Buffer.concat([key, iv]).toString("hex"), { mode: 0o600 });
      fs.writeFileSync(ENCRYPTED_PASS_FILE, encrypted + ":" + authTag.toString("hex"), { mode: 0o600 });

      return { ok: true, method: "Encrypted file" };
    }
  } catch (err) {
    return { ok: false, method: "none", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Retrieve stored sudo password.
 */
export function retrievePassword(): string | null {
  try {
    if (PLATFORM === "darwin") {
      const pw = execSync(
        `security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w`,
        { stdio: "pipe", timeout: 5000 }
      ).toString().trim();
      return pw || null;
    } else {
      if (!fs.existsSync(ENCRYPTED_PASS_FILE) || !fs.existsSync(ENCRYPTION_KEY_FILE)) return null;
      const keyData = Buffer.from(fs.readFileSync(ENCRYPTION_KEY_FILE, "utf-8"), "hex");
      const key = keyData.subarray(0, 32);
      const iv = keyData.subarray(32, 48);
      const [encrypted, authTagHex] = fs.readFileSync(ENCRYPTED_PASS_FILE, "utf-8").split(":");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
      let decrypted = decipher.update(encrypted, "hex", "utf-8");
      decrypted += decipher.final("utf-8");
      return decrypted;
    }
  } catch {
    return null;
  }
}

/**
 * Delete stored password (revoke sudo access).
 */
export function revokePassword(): boolean {
  try {
    if (PLATFORM === "darwin") {
      execSync(`security delete-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}"`, { stdio: "pipe", timeout: 5000 });
    } else {
      if (fs.existsSync(ENCRYPTED_PASS_FILE)) fs.unlinkSync(ENCRYPTED_PASS_FILE);
      if (fs.existsSync(ENCRYPTION_KEY_FILE)) fs.unlinkSync(ENCRYPTION_KEY_FILE);
    }
    return true;
  } catch {
    return false;
  }
}

// ── Sudo Execution ──────────────────────────────────────

/**
 * Execute a command with sudo.
 * Returns { ok, output, error }.
 */
export async function sudoExec(command: string, timeoutMs = 30000): Promise<{ ok: boolean; output: string; error?: string }> {
  const password = retrievePassword();
  if (!password) {
    return { ok: false, output: "", error: "Kein Sudo-Passwort hinterlegt. Bitte zuerst einrichten (/setup sudo oder Settings → Sudo)." };
  }

  return new Promise((resolve) => {
    const child = spawn("sudo", ["-S", "bash", "-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      env: { ...process.env, PATH: process.env.PATH + ":/opt/homebrew/bin:/usr/local/bin" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      // sudo prompts on stderr — don't include the prompt in error output
      if (!text.includes("Password:") && !text.includes("password for")) {
        stderr += text;
      }
    });

    // Send password to sudo's stdin
    child.stdin.write(password + "\n");
    child.stdin.end();

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, output: stdout.trim() });
      } else {
        // Check for wrong password
        if (stderr.includes("incorrect password") || stderr.includes("Sorry, try again")) {
          resolve({ ok: false, output: "", error: "Falsches Sudo-Passwort! Bitte neu einrichten." });
        } else {
          resolve({ ok: false, output: stdout.trim(), error: stderr.trim() || `Exit code: ${code}` });
        }
      }
    });

    child.on("error", (err) => {
      resolve({ ok: false, output: "", error: err.message });
    });
  });
}

// ── macOS Permission Dialogs ────────────────────────────

/**
 * Request admin privileges via macOS dialog (osascript).
 * Shows the native macOS password prompt.
 */
export async function requestAdminViaDialog(reason: string): Promise<{ ok: boolean; error?: string }> {
  if (PLATFORM !== "darwin") {
    return { ok: false, error: "Nur auf macOS verfügbar" };
  }

  try {
    execSync(
      `osascript -e 'do shell script "echo ok" with administrator privileges with prompt "${reason.replace(/"/g, '\\"')}"'`,
      { stdio: "pipe", timeout: 60000 }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Open System Settings to a specific pane (macOS).
 */
export function openSystemSettings(pane: string): boolean {
  if (PLATFORM !== "darwin") return false;
  try {
    const paneUrls: Record<string, string> = {
      "accessibility": "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      "full-disk-access": "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      "automation": "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
      "security": "x-apple.systempreferences:com.apple.preference.security",
      "privacy": "x-apple.systempreferences:com.apple.preference.security?Privacy",
    };
    const url = paneUrls[pane] || `x-apple.systempreferences:${pane}`;
    execSync(`open "${url}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ── Status Check ────────────────────────────────────────

export interface SudoStatus {
  configured: boolean;
  storageMethod: string;
  verified: boolean;
  platform: string;
  user: string;
  permissions: {
    accessibility: boolean | null;
    fullDiskAccess: boolean | null;
  };
}

/**
 * Get comprehensive sudo status.
 */
export async function getSudoStatus(): Promise<SudoStatus> {
  const configured = retrievePassword() !== null;
  const user = os.userInfo().username;

  let verified = false;
  if (configured) {
    const test = await sudoExec("echo SUDO_OK", 10000);
    verified = test.ok && test.output.includes("SUDO_OK");
  }

  // Check macOS permissions
  let accessibility: boolean | null = null;
  let fullDiskAccess: boolean | null = null;

  if (PLATFORM === "darwin") {
    try {
      // Check Accessibility (approximate — try to use cliclick)
      execSync("cliclick p:.", { stdio: "pipe", timeout: 3000 });
      accessibility = true;
    } catch {
      accessibility = false;
    }

    try {
      // Check Full Disk Access (try to read a protected file)
      fs.accessSync(resolve(os.homedir(), "Library/Mail"), fs.constants.R_OK);
      fullDiskAccess = true;
    } catch {
      fullDiskAccess = false;
    }
  }

  return {
    configured,
    storageMethod: PLATFORM === "darwin" ? "macOS Keychain" : "Encrypted file",
    verified,
    platform: PLATFORM,
    user,
    permissions: { accessibility, fullDiskAccess },
  };
}

/**
 * Verify the stored password works.
 */
export async function verifyPassword(): Promise<{ ok: boolean; error?: string }> {
  const result = await sudoExec("echo VERIFIED", 10000);
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error };
}
