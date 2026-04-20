/**
 * ALLOWED_USERS Startup Gate (v4.12.2)
 *
 * Pure decision function that runs at startup to decide whether Alvin should
 * refuse to start because its Telegram bot is configured but has no user
 * allowlist.
 *
 * Before v4.12.2, an empty ALLOWED_USERS with AUTH_MODE=allowlist would only
 * emit a console.warn and the bot would start anyway. On production this
 * left a "configured but unguarded" surface — any Telegram user who sends
 * a DM would reach the bot and could exploit shell/filesystem access via
 * prompt injection.
 *
 * The gate has two explicit escape hatches, both intentional:
 *   1. AUTH_MODE=open — user explicitly wants a public bot (not recommended)
 *   2. ALVIN_INSECURE_ACKNOWLEDGED=1 — explicit operator opt-out used for
 *      test environments and scripted installs where the operator
 *      acknowledges they know what they're doing.
 *
 * Pure: takes config values as args, returns a decision. The actual
 * process.exit(1) lives in src/index.ts as a thin wrapper.
 */

export interface GateInput {
  /** Whether BOT_TOKEN is configured (i.e. Telegram is enabled) */
  hasTelegram: boolean;
  /** Number of Telegram user IDs in the allowlist */
  allowedUsersCount: number;
  /** Authentication mode from config.authMode */
  authMode: "allowlist" | "pairing" | "open";
  /** ALVIN_INSECURE_ACKNOWLEDGED env var present */
  insecureAcknowledged: boolean;
}

export interface GateResult {
  /** Whether startup should be allowed to proceed */
  allowed: boolean;
  /** Human-readable reason when denied — suitable for console.error output */
  reason?: string;
  /** Human-readable warning when allowed via escape hatch — suitable for console.warn */
  warning?: string;
}

export function checkAllowedUsersGate(input: GateInput): GateResult {
  // WebUI-only deployments don't have a BOT_TOKEN → nothing to gate
  if (!input.hasTelegram) {
    return { allowed: true };
  }

  // Telegram is enabled AND allowlist is populated → normal path
  if (input.allowedUsersCount > 0) {
    return { allowed: true };
  }

  // Telegram enabled but allowlist empty — check escape hatches
  if (input.authMode === "open") {
    return {
      allowed: true,
      warning:
        "AUTH_MODE=open explicitly set. Any Telegram user can message the bot. " +
        "This is NOT recommended for machines with sensitive files or shell access.",
    };
  }

  if (input.insecureAcknowledged) {
    return {
      allowed: true,
      warning:
        "ALVIN_INSECURE_ACKNOWLEDGED=1 set. Bot starts with empty ALLOWED_USERS. " +
        "The operator has explicitly opted out of the safety gate.",
    };
  }

  // No escape hatch — refuse to start
  return {
    allowed: false,
    reason:
      "ALLOWED_USERS is empty but BOT_TOKEN is set. " +
      "Alvin Bot has full shell/filesystem access on this machine, so starting with " +
      "an empty allowlist would leave the bot open to anyone who sends it a Telegram message. " +
      "Fix: set ALLOWED_USERS=<your telegram user id> in ~/.alvin-bot/.env (get your ID from @userinfobot). " +
      "Explicit opt-out: AUTH_MODE=open OR ALVIN_INSECURE_ACKNOWLEDGED=1.",
  };
}
