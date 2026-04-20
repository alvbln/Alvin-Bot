/**
 * User Profiles Service — Multi-user support with per-user settings and memory.
 *
 * Each user gets:
 * - Their own memory directory (docs/users/<userId>/)
 * - A profile with preferences (language, effort, voice, personality)
 * - Separate conversation context
 *
 * The admin/owner user uses the global docs/memory/ and docs/MEMORY.md.
 * Additional users get isolated memory spaces.
 *
 * Performance:
 *   Profiles are cached in memory after first read. `touchProfile` — called
 *   on every inbound message — writes to cache and schedules a debounced
 *   disk flush (2s). This avoids two sync fs operations per message on the
 *   hot path. A final flush happens on graceful shutdown so nothing is lost.
 */

import fs from "fs";
import { resolve } from "path";
import { config } from "../config.js";
import { LOCALE_NAMES, type Locale } from "../i18n.js";
import { killSession } from "./session.js";
import { USERS_DIR, MEMORY_DIR } from "../paths.js";

// Ensure users dir exists
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });

// ── Types ───────────────────────────────────────────────

export interface UserProfile {
  /** Telegram user ID */
  userId: number;
  /** Display name */
  name: string;
  /** Telegram username (without @) */
  username?: string;
  /** First seen timestamp */
  firstSeen: number;
  /** Last active timestamp */
  lastActive: number;
  /** Total messages sent */
  totalMessages: number;
  /** Preferred UI language */
  language: Locale;
  /** Is this the primary/owner user? */
  isOwner: boolean;
  /** Custom notes about this user (for AI context) */
  notes: string;
  /** Language usage statistics — tracks how often the user writes in each language */
  langStats?: { de: number; en: number; other: number };
  /** Whether the language was explicitly set by the user (overrides auto-detection) */
  langExplicit?: boolean;
  /** Last platform the user communicated from */
  lastPlatform?: "telegram" | "whatsapp" | "discord" | "signal" | "webui";
  /** Last message text (truncated) */
  lastMessage?: string;
  /** Last message timestamp */
  lastMessageAt?: number;
}

// ── In-memory cache + debounced persistence ─────────────

const cache = new Map<number, UserProfile>();
const dirty = new Set<number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 2000;

function schedule_flush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushProfiles();
  }, FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

/**
 * Write every dirty profile to disk synchronously. Called by the debounce
 * timer AND by the graceful-shutdown handler so no in-flight updates are
 * lost even if the bot exits between debounce ticks.
 */
export function flushProfiles(): void {
  if (dirty.size === 0) return;
  for (const userId of dirty) {
    const profile = cache.get(userId);
    if (!profile) continue;
    try {
      fs.writeFileSync(profilePath(userId), JSON.stringify(profile, null, 2));
    } catch (err) {
      // Don't throw — a persistent error would block future flushes.
      console.warn(`[users] flush ${userId} failed: ${(err as Error).message}`);
    }
  }
  dirty.clear();
}

// ── Profile Management ──────────────────────────────────

function profilePath(userId: number): string {
  return resolve(USERS_DIR, `${userId}.json`);
}

function userMemoryDir(userId: number): string {
  return resolve(USERS_DIR, `${userId}`);
}

/**
 * Load a user profile. Returns null if not found. Reads from cache first,
 * falls back to disk on cache miss.
 */
export function loadProfile(userId: number): UserProfile | null {
  const cached = cache.get(userId);
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(profilePath(userId), "utf-8");
    const profile: UserProfile = JSON.parse(raw);
    cache.set(userId, profile);
    return profile;
  } catch {
    return null;
  }
}

/**
 * Save a user profile — updates cache and schedules a debounced disk flush.
 * For immediate durability (e.g. during shutdown), call flushProfiles()
 * after this.
 */
export function saveProfile(profile: UserProfile): void {
  cache.set(profile.userId, profile);
  dirty.add(profile.userId);
  schedule_flush();
}

/**
 * Get or create a user profile.
 * Auto-creates on first interaction.
 */
export function getOrCreateProfile(userId: number, name?: string, username?: string): UserProfile {
  let profile = loadProfile(userId);

  if (!profile) {
    const isOwner = config.allowedUsers.length > 0 && config.allowedUsers[0] === userId;
    profile = {
      userId,
      name: name || `User ${userId}`,
      username,
      firstSeen: Date.now(),
      lastActive: Date.now(),
      totalMessages: 0,
      language: "en",
      isOwner,
      notes: "",
      langStats: { de: 0, en: 0, other: 0 },
      langExplicit: false,
    };

    // Create user memory directory for non-owner users
    if (!isOwner) {
      const memDir = userMemoryDir(userId);
      if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
    }

    saveProfile(profile);
  }

  return profile;
}

/**
 * Update a user's activity (call on each message).
 *
 * Previously this did a sync read + write per message. Now it works purely
 * in memory and lets the debounce timer batch writes to disk.
 */
export function touchProfile(
  userId: number,
  name?: string,
  username?: string,
  platform?: UserProfile["lastPlatform"],
  messageText?: string,
): UserProfile {
  const profile = getOrCreateProfile(userId, name, username);
  profile.lastActive = Date.now();
  profile.totalMessages++;
  if (name) profile.name = name;
  if (username) profile.username = username;
  if (platform) profile.lastPlatform = platform;
  if (messageText) {
    profile.lastMessage = messageText.length > 120 ? messageText.slice(0, 120) + "…" : messageText;
    profile.lastMessageAt = Date.now();
  }
  saveProfile(profile);
  return profile;
}

/**
 * List all known user profiles. Reads from disk; populates cache for
 * subsequent fast access.
 */
export function listProfiles(): UserProfile[] {
  const profiles: UserProfile[] = [];
  try {
    const files = fs.readdirSync(USERS_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      // Parse user id from filename — skip non-numeric (e.g. stray files)
      const userId = parseInt(file.slice(0, -5), 10);
      if (!Number.isFinite(userId)) continue;
      // If cached, use that; otherwise read once and cache
      const cached = cache.get(userId);
      if (cached) {
        profiles.push(cached);
        continue;
      }
      try {
        const raw = fs.readFileSync(resolve(USERS_DIR, file), "utf-8");
        const p: UserProfile = JSON.parse(raw);
        cache.set(userId, p);
        profiles.push(p);
      } catch { /* skip corrupt */ }
    }
  } catch { /* dir doesn't exist */ }
  return profiles.sort((a, b) => b.lastActive - a.lastActive);
}

/**
 * Get user-specific memory directory.
 * Owner uses global memory, others get isolated dirs.
 */
export function getUserMemoryDir(userId: number): string {
  const profile = loadProfile(userId);
  if (profile?.isOwner) {
    return MEMORY_DIR;
  }
  const dir = userMemoryDir(userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Add a note to a user's profile (for AI context).
 */
export function addUserNote(userId: number, note: string): void {
  const profile = getOrCreateProfile(userId);
  const timestamp = new Date().toISOString().slice(0, 16);
  profile.notes += `\n[${timestamp}] ${note}`;
  profile.notes = profile.notes.trim();
  saveProfile(profile);
}

/**
 * Delete a user and all their data: profile, session, memory, conversation history.
 * Returns a summary of what was deleted.
 */
export function deleteUser(userId: number): { deleted: string[]; errors: string[] } {
  const deleted: string[] = [];
  const errors: string[] = [];

  // 0. Drop from cache + dirty set so the debounce doesn't re-create the file
  cache.delete(userId);
  dirty.delete(userId);

  // 1. Delete profile JSON
  const pPath = profilePath(userId);
  try {
    if (fs.existsSync(pPath)) {
      fs.unlinkSync(pPath);
      deleted.push("Profile");
    }
  } catch (e) { errors.push(`Profile: ${e}`); }

  // 2. Delete user memory directory (non-owner only)
  const memDir = userMemoryDir(userId);
  try {
    if (fs.existsSync(memDir) && fs.statSync(memDir).isDirectory()) {
      fs.rmSync(memDir, { recursive: true, force: true });
      deleted.push("Memory directory");
    }
  } catch (e) { errors.push(`Memory: ${e}`); }

  // 3. Kill active session
  try {
    const result = killSession(userId);
    if (result.hadSession) {
      deleted.push("Session deleted");
      if (result.aborted) {
        deleted.push("Running request aborted");
      }
    }
  } catch (e) { errors.push(`Session: ${e}`); }

  return { deleted, errors };
}

/**
 * Build user context string for system prompt injection.
 */
export function buildUserContext(userId: number): string {
  const profile = loadProfile(userId);
  if (!profile) return "";

  const parts: string[] = [];
  parts.push(`User: ${profile.name}${profile.username ? ` (@${profile.username})` : ""}`);
  parts.push(`Language: ${LOCALE_NAMES[profile.language] || profile.language}`);
  parts.push(`Messages: ${profile.totalMessages}`);

  if (profile.notes) {
    parts.push(`\nNotes about this user:\n${profile.notes}`);
  }

  return parts.join("\n");
}
