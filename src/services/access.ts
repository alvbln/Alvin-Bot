/**
 * Access Control Service — Manages group approvals and security.
 *
 * Security model:
 * - DMs: only ALLOWED_USERS can interact (unchanged)
 * - Groups: must be explicitly approved by an admin before bot responds
 * - New groups: bot sends approval request to admin, stays silent until approved
 * - Admin can block/unblock groups at any time
 * - Forwarded message processing can be toggled
 */

import fs from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ACCESS_FILE = resolve(BOT_ROOT, "data", "access.json");
const DATA_DIR = resolve(BOT_ROOT, "data");

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

interface GroupInfo {
  chatId: number;
  title: string;
  /** Who added the bot */
  addedBy?: number;
  /** When the group was first seen */
  firstSeen: number;
  /** Approval status */
  status: "pending" | "approved" | "blocked";
  /** When status was last changed */
  statusChanged: number;
  /** Message count in this group */
  messageCount: number;
}

interface AccessConfig {
  /** Approved/blocked groups */
  groups: Record<string, GroupInfo>;
  /** Global settings */
  settings: {
    /** Allow forwarded message processing */
    allowForwards: boolean;
    /** Auto-approve groups (DANGEROUS — off by default) */
    autoApproveGroups: boolean;
    /** Max messages per group per hour (rate limit) */
    groupRateLimitPerHour: number;
  };
}

let config: AccessConfig = {
  groups: {},
  settings: {
    allowForwards: true,
    autoApproveGroups: false,
    groupRateLimitPerHour: 30,
  },
};

// Load on startup
try {
  const raw = fs.readFileSync(ACCESS_FILE, "utf-8");
  config = JSON.parse(raw);
} catch {
  save(); // Create default file
}

function save(): void {
  fs.writeFileSync(ACCESS_FILE, JSON.stringify(config, null, 2));
}

// ── Group Management ─────────────────────────────────

/**
 * Check if a group chat is approved.
 * Returns: "approved" | "pending" | "blocked" | "new"
 */
export function getGroupStatus(chatId: number): "approved" | "pending" | "blocked" | "new" {
  const key = String(chatId);
  const group = config.groups[key];
  if (!group) return "new";
  return group.status;
}

/**
 * Register a new group (first time the bot sees it).
 * Returns the group info.
 */
export function registerGroup(chatId: number, title: string, addedBy?: number): GroupInfo {
  const key = String(chatId);

  if (config.groups[key]) {
    // Update title if changed
    config.groups[key].title = title;
    save();
    return config.groups[key];
  }

  const group: GroupInfo = {
    chatId,
    title,
    addedBy,
    firstSeen: Date.now(),
    status: config.settings.autoApproveGroups ? "approved" : "pending",
    statusChanged: Date.now(),
    messageCount: 0,
  };

  config.groups[key] = group;
  save();
  return group;
}

/**
 * Approve a group.
 */
export function approveGroup(chatId: number): boolean {
  const key = String(chatId);
  const group = config.groups[key];
  if (!group) return false;
  group.status = "approved";
  group.statusChanged = Date.now();
  save();
  return true;
}

/**
 * Block a group.
 */
export function blockGroup(chatId: number): boolean {
  const key = String(chatId);
  const group = config.groups[key];
  if (!group) return false;
  group.status = "blocked";
  group.statusChanged = Date.now();
  save();
  return true;
}

/**
 * Increment message count for a group.
 */
export function trackGroupMessage(chatId: number): void {
  const key = String(chatId);
  if (config.groups[key]) {
    config.groups[key].messageCount++;
    // Save periodically (every 10 messages to reduce I/O)
    if (config.groups[key].messageCount % 10 === 0) save();
  }
}

/**
 * Get all groups.
 */
export function listGroups(): GroupInfo[] {
  return Object.values(config.groups).sort((a, b) => b.firstSeen - a.firstSeen);
}

/**
 * Remove a group from tracking.
 */
export function removeGroup(chatId: number): boolean {
  const key = String(chatId);
  if (!config.groups[key]) return false;
  delete config.groups[key];
  save();
  return true;
}

// ── Settings ─────────────────────────────────────────

export function isForwardingAllowed(): boolean {
  return config.settings.allowForwards;
}

export function setForwardingAllowed(allowed: boolean): void {
  config.settings.allowForwards = allowed;
  save();
}

export function isAutoApproveEnabled(): boolean {
  return config.settings.autoApproveGroups;
}

export function setAutoApprove(enabled: boolean): void {
  config.settings.autoApproveGroups = enabled;
  save();
}

export function getSettings(): AccessConfig["settings"] {
  return { ...config.settings };
}
