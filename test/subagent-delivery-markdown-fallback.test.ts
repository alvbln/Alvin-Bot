/**
 * Fix #15 (A) — subagent-delivery must retry without parse_mode when
 * Telegram rejects the Markdown entities.
 *
 * Real regression: Daily Job Alert banners have been silently failing
 * with "Bad Request: can't parse entities: Can't find end of the entity"
 * every single day since the subagent-delivery module shipped. The
 * result text contains mixed `|`, `**`, `\|`, emoji, and asterisks that
 * Telegram's Markdown parser chokes on. The code currently logs the
 * error and drops the delivery, so the user never sees the banner.
 *
 * Contract: when `sendMessage(..., parse_mode: Markdown)` throws with
 * the "can't parse entities" pattern, retry the SAME text WITHOUT
 * `parse_mode`. Any other error still logs + bails.
 *
 * This file uses a minimal bot-api stub so we can drive both the happy
 * path and the parse-error path deterministically.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { deliverSubAgentResult, __setBotApiForTest } from "../src/services/subagent-delivery.js";
import type { SubAgentInfo, SubAgentResult } from "../src/services/subagents.js";

interface Sent {
  chatId: number;
  text: string;
  parseMode?: string;
}

function makeInfo(overrides: Partial<SubAgentInfo> = {}): SubAgentInfo {
  return {
    id: "id-1",
    name: "Daily Job Alert",
    status: "completed",
    startedAt: 0,
    depth: 0,
    source: "cron",
    parentChatId: 42,
    ...overrides,
  };
}

function makeResult(output: string): SubAgentResult {
  return {
    id: "id-1",
    name: "Daily Job Alert",
    status: "completed",
    output,
    tokensUsed: { input: 1000, output: 200 },
    duration: 60_000,
  };
}

beforeEach(() => {
  __setBotApiForTest(null);
});

describe("deliverSubAgentResult Markdown fallback (Fix #15)", () => {
  it("retries without parse_mode when Telegram rejects entity parsing", async () => {
    const sent: Sent[] = [];
    let callCount = 0;

    __setBotApiForTest({
      sendMessage: async (chatId: number, text: string, opts?: Record<string, unknown>) => {
        callCount++;
        const parseMode = opts?.parse_mode as string | undefined;
        // First call (Markdown) throws the real production error
        if (callCount === 1 && parseMode === "Markdown") {
          const err = Object.assign(
            new Error("Call to 'sendMessage' failed! (400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 2636)"),
            {
              description: "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 2636",
              error_code: 400,
            },
          );
          throw err;
        }
        sent.push({ chatId, text, parseMode });
        return { message_id: 1 };
      },
      sendDocument: async () => ({}),
    });

    const info = makeInfo();
    const result = makeResult("This **has** | broken markdown \\| entities that fail Markdown parsing");

    await deliverSubAgentResult(info, result);

    // Must have retried at least once WITHOUT parse_mode
    const plainAttempt = sent.find((s) => s.parseMode === undefined);
    expect(plainAttempt).toBeDefined();
    expect(plainAttempt?.text).toContain("Daily Job Alert");
    expect(plainAttempt?.text).toContain("broken markdown");
  });

  it("does NOT retry for non-parse errors (e.g. chat not found)", async () => {
    let callCount = 0;
    __setBotApiForTest({
      sendMessage: async () => {
        callCount++;
        const err = Object.assign(new Error("Forbidden: bot was blocked by the user"), {
          description: "Forbidden: bot was blocked by the user",
          error_code: 403,
        });
        throw err;
      },
      sendDocument: async () => ({}),
    });

    await deliverSubAgentResult(makeInfo(), makeResult("some text"));

    // Should have tried once and given up — no retry
    expect(callCount).toBe(1);
  });

  it("chunked delivery also retries without parse_mode on parse errors", async () => {
    const sent: Sent[] = [];
    let callCount = 0;

    __setBotApiForTest({
      sendMessage: async (chatId: number, text: string, opts?: Record<string, unknown>) => {
        callCount++;
        const parseMode = opts?.parse_mode as string | undefined;
        // First banner attempt fails — should retry without parse_mode
        if (callCount === 1 && parseMode === "Markdown") {
          const err = Object.assign(
            new Error("400: Bad Request: can't parse entities"),
            { description: "can't parse entities", error_code: 400 },
          );
          throw err;
        }
        sent.push({ chatId, text, parseMode });
        return { message_id: callCount };
      },
      sendDocument: async () => ({}),
    });

    const info = makeInfo();
    // Large body forces the chunked path
    const result = makeResult("x".repeat(5000));

    await deliverSubAgentResult(info, result);

    // At least one plain-text delivery must have landed
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((s) => s.parseMode === undefined)).toBe(true);
  });
});
