import { readFileSync, existsSync } from "fs";
import { AGENTS_FILE } from "../paths.js";

let cached = "";

/** Load standing orders from AGENTS.md. Called once at startup and on reload. */
export function loadStandingOrders(): string {
  if (!existsSync(AGENTS_FILE)) return "";
  try {
    cached = readFileSync(AGENTS_FILE, "utf-8");
    return cached;
  } catch {
    return "";
  }
}

/** Get cached standing orders (fast, no disk I/O) */
export function getStandingOrders(): string {
  return cached;
}

/** Reload from disk (e.g., after editing via tools) */
export function reloadStandingOrders(): boolean {
  try {
    cached = readFileSync(AGENTS_FILE, "utf-8");
    return true;
  } catch {
    return false;
  }
}
