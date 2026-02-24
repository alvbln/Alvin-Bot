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
 */

import fs from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS_DIR = resolve(BOT_ROOT, "docs");
const USERS_DIR = resolve(DOCS_DIR, "users");

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
  /** Preferred language */
  language: "de" | "en";
  /** Is this the primary/owner user? */
  isOwner: boolean;
  /** Custom notes about this user (for AI context) */
  notes: string;
}

// ── Profile Management ──────────────────────────────────

function profilePath(userId: number): string {
  return resolve(USERS_DIR, `${userId}.json`);
}

function userMemoryDir(userId: number): string {
  return resolve(USERS_DIR, `${userId}`);
}

/**
 * Load a user profile. Returns null if not found.
 */
export function loadProfile(userId: number): UserProfile | null {
  try {
    const raw = fs.readFileSync(profilePath(userId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Save a user profile.
 */
export function saveProfile(profile: UserProfile): void {
  fs.writeFileSync(profilePath(profile.userId), JSON.stringify(profile, null, 2));
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
      language: "de",
      isOwner,
      notes: "",
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
 */
export function touchProfile(userId: number, name?: string, username?: string): UserProfile {
  const profile = getOrCreateProfile(userId, name, username);
  profile.lastActive = Date.now();
  profile.totalMessages++;
  if (name) profile.name = name;
  if (username) profile.username = username;
  saveProfile(profile);
  return profile;
}

/**
 * List all known user profiles.
 */
export function listProfiles(): UserProfile[] {
  const profiles: UserProfile[] = [];
  try {
    const files = fs.readdirSync(USERS_DIR);
    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          const raw = fs.readFileSync(resolve(USERS_DIR, file), "utf-8");
          profiles.push(JSON.parse(raw));
        } catch { /* skip corrupt */ }
      }
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
    return resolve(DOCS_DIR, "memory");
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
 * Build user context string for system prompt injection.
 */
export function buildUserContext(userId: number): string {
  const profile = loadProfile(userId);
  if (!profile) return "";

  const parts: string[] = [];
  parts.push(`User: ${profile.name}${profile.username ? ` (@${profile.username})` : ""}`);
  parts.push(`Sprache: ${profile.language === "de" ? "Deutsch" : "English"}`);
  parts.push(`Nachrichten: ${profile.totalMessages}`);

  if (profile.notes) {
    parts.push(`\nNotizen über diesen User:\n${profile.notes}`);
  }

  return parts.join("\n");
}
