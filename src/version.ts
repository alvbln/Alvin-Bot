/**
 * Central source of truth for the running Alvin Bot version.
 * Read from package.json once at module load — subsequent imports
 * return the cached string without touching disk.
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

function readVersion(): string {
  try {
    // dist/version.js is two levels deep; package.json sits at the root
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, "..", "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string") return parsed.version;
  } catch {
    /* fall through to unknown */
  }
  return "unknown";
}

export const BOT_VERSION: string = readVersion();
