/**
 * Memory inject-mode resolver.
 *
 * v4.22 introduces three modes for how curated long-term memory is added to
 * the system prompt:
 *
 *   legacy  — inject MEMORY.md + daily logs as plain text on every turn.
 *             Pre-v4.22 behaviour. Tokens-heavy but works without any API key
 *             or SQLite. The fallback when nothing else is configured.
 *
 *   sqlite  — DON'T bulk-inject MEMORY.md or daily logs. Trust the SQLite
 *             memory store (vector or FTS5) + searchMemory() to surface
 *             relevant chunks on demand. identity.md and preferences.md are
 *             still always plain-text injected because they're tiny and
 *             always-on by design.
 *
 *   auto    — (default) sqlite if the SQLite store has at least one indexed
 *             entry, otherwise legacy. This is the seamless-upgrade path:
 *             public users keep the legacy behaviour until they've actually
 *             populated the SQLite store, then automatically benefit from
 *             smaller prompts + targeted retrieval.
 *
 * Override via MEMORY_INJECT_MODE=auto|legacy|sqlite. The bot logs the
 * resolved mode at startup.
 */

import { isSqliteMemoryReady } from "./embeddings.js";

export type InjectModeRaw = "auto" | "legacy" | "sqlite";
export type InjectModeEffective = "legacy" | "sqlite";

export function getInjectModeRaw(): InjectModeRaw {
  const v = (process.env.MEMORY_INJECT_MODE || "auto").trim().toLowerCase();
  if (v === "legacy" || v === "sqlite" || v === "auto") return v;
  return "auto";
}

/**
 * Resolve the effective mode. In auto, defer to whether the SQLite store
 * actually has indexed entries — falls back to legacy on a fresh install or
 * when reindex hasn't run yet.
 */
export function getEffectiveInjectMode(): InjectModeEffective {
  const raw = getInjectModeRaw();
  if (raw === "legacy" || raw === "sqlite") return raw;
  return isSqliteMemoryReady() ? "sqlite" : "legacy";
}
