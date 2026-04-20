/**
 * Fix #12 — grammy error noise filter.
 *
 * Regression: chunks like
 *   Fehler: Call to 'editMessageText' failed! (400: Bad Request:
 *   message is not modified: specified new message content and reply
 *   markup are exactly the same as a current content and reply markup
 *   of the message)
 * were being sent to end users 2-3 times per day whenever a live-stream
 * edit raced against itself. The v4.8.8 `bot.catch()` fix swallowed
 * these at the middleware layer, but `telegram.ts` finalize() and
 * `handlers/message.ts` error paths bypass bot.catch completely —
 * they surface the raw grammy error via `ctx.reply()`.
 *
 * Contract: `isHarmlessTelegramError(err)` returns true for:
 *   - "message is not modified" (any language, any prefix)
 *   - "Call to 'editMessageText' failed" combined with the above
 *   - "query is too old" (harmless callback-answer race)
 *   - "MESSAGE_ID_INVALID" (user deleted the message before we edited it)
 *
 * Returns false for all other errors — they still need surfacing.
 */
import { describe, it, expect } from "vitest";
import { isHarmlessTelegramError } from "../src/util/telegram-error-filter.js";

describe("isHarmlessTelegramError (Fix #12)", () => {
  it("matches the exact production message", () => {
    const err = new Error(
      "Call to 'editMessageText' failed! (400: Bad Request: message is not modified: " +
      "specified new message content and reply markup are exactly the same as a current " +
      "content and reply markup of the message)",
    );
    expect(isHarmlessTelegramError(err)).toBe(true);
  });

  it("matches just the 'message is not modified' substring", () => {
    expect(isHarmlessTelegramError(new Error("400: message is not modified"))).toBe(true);
  });

  it("matches 'specified new message content ... exactly the same'", () => {
    expect(
      isHarmlessTelegramError(
        new Error("specified new message content and reply markup are exactly the same"),
      ),
    ).toBe(true);
  });

  it("matches 'query is too old' (answerCallbackQuery race)", () => {
    expect(
      isHarmlessTelegramError(new Error("Bad Request: query is too old and response timeout expired")),
    ).toBe(true);
  });

  it("matches 'message to edit not found' (user deleted)", () => {
    expect(
      isHarmlessTelegramError(new Error("Bad Request: message to edit not found")),
    ).toBe(true);
  });

  it("matches MESSAGE_ID_INVALID", () => {
    expect(isHarmlessTelegramError(new Error("Bad Request: MESSAGE_ID_INVALID"))).toBe(true);
  });

  it("accepts plain strings as well as Error objects", () => {
    expect(isHarmlessTelegramError("message is not modified")).toBe(true);
  });

  it("accepts undefined / null as not harmless (caller decides)", () => {
    expect(isHarmlessTelegramError(undefined)).toBe(false);
    expect(isHarmlessTelegramError(null)).toBe(false);
  });

  it("does NOT swallow real errors", () => {
    expect(isHarmlessTelegramError(new Error("Unauthorized"))).toBe(false);
    expect(isHarmlessTelegramError(new Error("Too Many Requests: retry after 5"))).toBe(false);
    expect(isHarmlessTelegramError(new Error("chat not found"))).toBe(false);
    expect(isHarmlessTelegramError(new Error("stream error: provider timeout"))).toBe(false);
  });

  it("handles nested err.description from grammy", () => {
    const err = new Error("anything") as Error & { description?: string };
    err.description = "Bad Request: message is not modified";
    expect(isHarmlessTelegramError(err)).toBe(true);
  });
});
