/**
 * v4.12.0 — Platform session key must honor channelId, not just userId.
 *
 * Before v4.12.0 platform-message.ts used hashUserId(msg.userId) which
 * collapsed all channels from the same user into one session. This broke
 * multi-session on Slack where different channels should be isolated.
 *
 * The fix: route through buildSessionKey(platform, channelId, userId).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-platform-key-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  process.env.SESSION_MODE = "per-channel";
  vi.resetModules();
});

describe("buildSessionKey with string userIds (v4.12.0)", () => {
  it("per-channel mode returns platform:channelId", async () => {
    const { buildSessionKey } = await import("../src/services/session.js");
    const key = buildSessionKey("slack", "C01ABCDEF", "U01HIJKLM");
    expect(key).toBe("slack:C01ABCDEF");
  });

  it("per-channel-peer mode returns platform:channelId:userId", async () => {
    process.env.SESSION_MODE = "per-channel-peer";
    vi.resetModules();
    const { buildSessionKey } = await import("../src/services/session.js");
    const key = buildSessionKey("slack", "C01ABC", "U01XYZ");
    expect(key).toBe("slack:C01ABC:U01XYZ");
  });

  it("per-user mode returns just the userId as string", async () => {
    process.env.SESSION_MODE = "per-user";
    vi.resetModules();
    const { buildSessionKey } = await import("../src/services/session.js");
    const key = buildSessionKey("slack", "C01ABC", "U01XYZ");
    expect(key).toBe("U01XYZ");
  });

  it("two different channels for the same Slack user produce different session keys", async () => {
    const { buildSessionKey } = await import("../src/services/session.js");
    const a = buildSessionKey("slack", "C_ALEV_B", "U01XYZ");
    const b = buildSessionKey("slack", "C_HOMES", "U01XYZ");
    expect(a).not.toBe(b);
  });

  it("two different platforms with the same channel id produce different session keys", async () => {
    const { buildSessionKey } = await import("../src/services/session.js");
    const slack = buildSessionKey("slack", "ABC123", "U01");
    const discord = buildSessionKey("discord", "ABC123", "U01");
    expect(slack).not.toBe(discord);
  });

  it("backwards compat: numeric Telegram userIds still work (per-user)", async () => {
    process.env.SESSION_MODE = "per-user";
    vi.resetModules();
    const { buildSessionKey } = await import("../src/services/session.js");
    const key = buildSessionKey("telegram", "123456", 1234567890);
    expect(key).toBe("1234567890");
  });
});
