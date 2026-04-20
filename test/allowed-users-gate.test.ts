/**
 * v4.12.2 — ALLOWED_USERS startup hard-fail gate.
 *
 * When the Telegram bot token is configured but ALLOWED_USERS is empty,
 * starting the bot would leave it open to any Telegram user sending a DM.
 * Previously this only emitted a console.warn and the bot started anyway.
 *
 * v4.12.2 introduces a pure gate function that decides whether to refuse
 * startup, with two explicit escape hatches:
 *   1. AUTH_MODE=open — user explicitly wants an open bot
 *   2. ALVIN_INSECURE_ACKNOWLEDGED=1 — explicit opt-out for test/scripted envs
 *
 * This test file exercises the pure gate. The actual wiring in src/index.ts
 * is a thin if-block that calls process.exit(1) on deny.
 */
import { describe, it, expect } from "vitest";
import { checkAllowedUsersGate } from "../src/services/allowed-users-gate.js";

describe("allowed-users-gate (v4.12.2)", () => {
  it("allows startup when ALLOWED_USERS is populated", () => {
    const result = checkAllowedUsersGate({
      hasTelegram: true,
      allowedUsersCount: 1,
      authMode: "allowlist",
      insecureAcknowledged: false,
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("BLOCKS startup when telegram enabled but allowedUsers empty (allowlist mode)", () => {
    const result = checkAllowedUsersGate({
      hasTelegram: true,
      allowedUsersCount: 0,
      authMode: "allowlist",
      insecureAcknowledged: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("ALLOWED_USERS");
  });

  it("BLOCKS startup when telegram enabled but allowedUsers empty (pairing mode)", () => {
    // Pairing mode needs allowedUsers[0] as the admin for approval routing.
    // Empty array breaks the whole pairing flow.
    const result = checkAllowedUsersGate({
      hasTelegram: true,
      allowedUsersCount: 0,
      authMode: "pairing",
      insecureAcknowledged: false,
    });
    expect(result.allowed).toBe(false);
  });

  it("ALLOWS startup when AUTH_MODE=open explicitly", () => {
    const result = checkAllowedUsersGate({
      hasTelegram: true,
      allowedUsersCount: 0,
      authMode: "open",
      insecureAcknowledged: false,
    });
    expect(result.allowed).toBe(true);
    expect(result.warning).toContain("open");
  });

  it("ALLOWS startup when ALVIN_INSECURE_ACKNOWLEDGED=1", () => {
    const result = checkAllowedUsersGate({
      hasTelegram: true,
      allowedUsersCount: 0,
      authMode: "allowlist",
      insecureAcknowledged: true,
    });
    expect(result.allowed).toBe(true);
    expect(result.warning).toContain("INSECURE");
  });

  it("ALLOWS startup when telegram is NOT enabled (bot is WebUI-only)", () => {
    // WebUI-only deployments don't have a BOT_TOKEN and don't need
    // ALLOWED_USERS — the gate only applies when hasTelegram === true.
    const result = checkAllowedUsersGate({
      hasTelegram: false,
      allowedUsersCount: 0,
      authMode: "allowlist",
      insecureAcknowledged: false,
    });
    expect(result.allowed).toBe(true);
  });

  it("reason message mentions ~/.alvin-bot/.env and @userinfobot for operator guidance", () => {
    const result = checkAllowedUsersGate({
      hasTelegram: true,
      allowedUsersCount: 0,
      authMode: "allowlist",
      insecureAcknowledged: false,
    });
    expect(result.reason).toMatch(/\.env|alvin-bot/i);
    expect(result.reason).toMatch(/userinfobot|telegram/i);
  });
});
