/**
 * Find the Claude Code native binary path.
 *
 * The Agent SDK requires the native Mach-O/ELF binary, NOT the npm/node wrapper.
 * Native installer: ~/.local/bin/claude → ~/.local/share/claude/versions/<ver>
 */

import { existsSync, openSync, readSync, closeSync, readdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";

/** Check if a file is a node/shell script (NOT a native binary) */
function isScript(filePath: string): boolean {
  try {
    const buf = Buffer.alloc(64);
    const fd = openSync(filePath, "r");
    readSync(fd, buf, 0, 64, 0);
    closeSync(fd);
    const hdr = buf.toString("utf-8", 0, 64);
    return hdr.startsWith("#!") && (hdr.includes("node") || hdr.includes("sh"));
  } catch {
    return false;
  }
}

/** Resolve a candidate path to the native binary, or undefined */
function tryCandidate(p: string, label: string): string | undefined {
  try {
    if (!existsSync(p)) return undefined;
    const resolved = realpathSync(p);
    if (!statSync(resolved).isFile()) return undefined;
    if (isScript(resolved)) {
      console.error(`[claude] ${label}: ${resolved} is a script wrapper, skipping`);
      return undefined;
    }
    return resolved;
  } catch {
    return undefined;
  }
}

/** Find the native Claude Code binary. Returns the path or undefined. */
export function findClaudeBinary(): string | undefined {
  try {
    const home = homedir();

    // Strategy 1: ~/.local/bin/claude (native installer symlink)
    let result = tryCandidate(
      join(home, ".local", "bin", "claude"),
      "Strategy 1 (~/.local/bin/claude)"
    );
    if (result) {
      console.error(`[claude] Native binary: ${result}`);
      return result;
    }

    // Strategy 2: Scan ~/.local/share/claude/versions/ (newest first)
    const versionsDir = join(home, ".local", "share", "claude", "versions");
    if (existsSync(versionsDir)) {
      try {
        const entries = readdirSync(versionsDir)
          .filter((f: string) => !f.startsWith("."))
          .sort()
          .reverse();
        for (const entry of entries) {
          const entryPath = join(versionsDir, entry);
          // Entry might be the binary itself OR a directory containing it
          result = tryCandidate(entryPath, `Strategy 2 (versions/${entry})`);
          if (!result) {
            result = tryCandidate(
              join(entryPath, "claude"),
              `Strategy 2 (versions/${entry}/claude)`
            );
          }
          if (result) {
            console.error(`[claude] Native binary: ${result}`);
            return result;
          }
        }
      } catch (e) {
        console.error(`[claude] Strategy 2: can't read versions dir: ${e}`);
      }
    }

    // Strategy 3: which claude → resolve → verify not a script
    try {
      const p = execSync("which claude", { encoding: "utf-8", stdio: "pipe" }).trim();
      if (p) {
        result = tryCandidate(p, `Strategy 3 (which → ${p})`);
        if (result) {
          console.error(`[claude] Native binary: ${result}`);
          return result;
        }
      }
    } catch { /* not in PATH */ }

    console.error("[claude] WARNING: Native binary not found — SDK will use default (may fail)");
    console.error(`[claude] Checked: ~/.local/bin/claude, ~/.local/share/claude/versions/, which claude`);
    return undefined;
  } catch (err) {
    console.error(`[claude] Binary search error: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}
