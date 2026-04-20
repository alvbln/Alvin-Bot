/**
 * env-file — Shared helpers for reading and persisting key=value pairs
 * in ~/.alvin-bot/.env. Previously private to setup-api.ts; extracted so
 * Telegram command handlers (e.g. /model) can persist the user's runtime
 * choices across bot restarts.
 *
 * All writes go through writeSecure() which enforces 0o600 on the env
 * file — it contains bot tokens and API keys.
 */
import fs from "fs";
import { ENV_FILE } from "../paths.js";
import { writeSecure } from "./file-permissions.js";

/** Read the env file into a plain object. Skips comments and malformed lines. */
export function readEnv(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE)) return {};
  const lines = fs.readFileSync(ENV_FILE, "utf-8").split("\n");
  const env: Record<string, string> = {};
  for (const line of lines) {
    if (line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

/** Upsert a key=value pair in the env file, preserving all other lines. */
export function writeEnvVar(key: string, value: string): void {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf-8") : "";
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  writeSecure(ENV_FILE, content);
}

/** Remove a key from the env file. No-op if missing. */
export function removeEnvVar(key: string): void {
  if (!fs.existsSync(ENV_FILE)) return;
  let content = fs.readFileSync(ENV_FILE, "utf-8");
  content = content.replace(new RegExp(`^${key}=.*\n?`, "m"), "");
  writeSecure(ENV_FILE, content);
}
