import { readFileSync, existsSync } from "fs";
import { config } from "../config.js";
import { EXEC_ALLOWLIST_FILE } from "../paths.js";

const SAFE_BINS = [
  "ls", "cat", "head", "tail", "grep", "rg", "find", "wc", "sort", "uniq",
  "echo", "printf", "date", "which", "whoami", "hostname", "uname",
  "curl", "wget", "git", "node", "npm", "npx", "python3", "pip3",
  "jq", "ffmpeg", "ffprobe", "ffplay",
  "mkdir", "touch", "cp", "mv", "ln", "chmod",
  "tar", "zip", "unzip", "gzip", "gunzip",
  "ssh", "scp", "rsync",
  "docker", "docker-compose",
  "brew", "open", "pbcopy", "pbpaste",
  "osascript", "defaults", "launchctl",
];

function loadUserAllowlist(): string[] {
  if (!existsSync(EXEC_ALLOWLIST_FILE)) return [];
  try {
    return JSON.parse(readFileSync(EXEC_ALLOWLIST_FILE, "utf-8"));
  } catch { return []; }
}

function extractBinary(command: string): string {
  // Get first word, strip env vars, handle pipes
  const cleaned = command.replace(/^(env\s+\w+=\S+\s+)+/, "").trim();
  const first = cleaned.split(/[\s|;&]/)[0];
  // Strip path: /usr/bin/curl -> curl
  return first.split("/").pop() || first;
}

/**
 * v4.12.2 — Reject shell metacharacters in allowlist mode.
 *
 * The pre-v4.12.2 allowlist check only inspected the first word of the
 * command. That was trivially bypassable via:
 *   - ";" chaining:       "echo safe; rm -rf /"
 *   - "&&" / "||" chains:  "echo hi && cat /etc/passwd"
 *   - pipe:                "cat /etc/passwd | head"
 *   - substitution:        "echo $(whoami)" or "`whoami`"
 *   - redirect:            "echo hi > /etc/passwd"
 *   - backgrounding:       "... &"
 *
 * Strategy: in allowlist mode, any command containing any of these
 * metachars is rejected outright. Users who need shell pipelines opt in
 * explicitly via EXEC_SECURITY=full.
 */
const SHELL_METACHAR_PATTERN = /[;&|`$(){}<>]/;

export function checkExecAllowed(command: string): { allowed: boolean; reason?: string } {
  if (config.execSecurity === "full") return { allowed: true };
  if (config.execSecurity === "deny") return { allowed: false, reason: "Shell execution is disabled" };

  // allowlist mode — v4.12.2 metachar guard
  if (SHELL_METACHAR_PATTERN.test(command)) {
    return {
      allowed: false,
      reason:
        `Command contains shell metacharacters (pipes, redirects, substitution, chaining). ` +
        `Allowlist mode only permits simple binary invocations. ` +
        `Set EXEC_SECURITY=full if you need shell pipelines.`,
    };
  }

  const binary = extractBinary(command);
  if (SAFE_BINS.includes(binary)) return { allowed: true };

  const userList = loadUserAllowlist();
  if (userList.includes(binary)) return { allowed: true };

  return { allowed: false, reason: `Binary "${binary}" not in allowlist. Add to ${EXEC_ALLOWLIST_FILE} or set EXEC_SECURITY=full` };
}
