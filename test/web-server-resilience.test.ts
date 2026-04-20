/**
 * Fix #16 — Web server must never crash the bot.
 *
 * Colleague feedback (WhatsApp voice note, 2026-04-13):
 *   > The gateway binds to port 3100 like OpenClaw. When the bot
 *   > restarts, the port is often still held → catastrophic crash.
 *   > I ended up decoupling the gateway process completely, because
 *   > the actual bot runs independently of the gateway — it can still
 *   > answer Telegram even if the web endpoint isn't reachable yet.
 *   > It's weird that the main routine crashes when the port is busy.
 *   > It should just run in the background, watch for the port to
 *   > become free, and connect then. Zero impact on the main routine.
 *
 * This file tests the pure decision helper that the new startWebServer
 * uses to choose between "try the next port immediately" and "retry
 * the default port in the background after a delay".
 *
 * Contract:
 *   decideNextBindAction(err, attempt, opts)
 *
 *   err.code = "EADDRINUSE", attempt < maxPortTries
 *     → { type: "retry-port", port: opts.originalPort + attempt + 1, attempt: attempt + 1 }
 *
 *   err.code = "EADDRINUSE", attempt >= maxPortTries
 *     → { type: "retry-background", delayMs: opts.backgroundRetryMs, port: opts.originalPort }
 *
 *   err.code = anything else (EACCES, ECONNRESET, "Listen method called twice"…)
 *     → { type: "retry-background", delayMs: opts.backgroundRetryMs, port: opts.originalPort }
 *
 *   Pure function, no side effects, no timers, no I/O.
 */
import { describe, it, expect } from "vitest";
import { decideNextBindAction } from "../src/web/bind-strategy.js";

const defaultOpts = {
  originalPort: 3100,
  maxPortTries: 20,
  backgroundRetryMs: 30_000,
};

describe("decideNextBindAction (Fix #16)", () => {
  it("retries on the next port when EADDRINUSE and attempts remain", () => {
    const err = Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
    const result = decideNextBindAction(err, 0, defaultOpts);
    expect(result).toEqual({ type: "retry-port", port: 3101, attempt: 1 });
  });

  it("walks the port ladder across multiple attempts", () => {
    const err = Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
    expect(decideNextBindAction(err, 5, defaultOpts)).toEqual({
      type: "retry-port",
      port: 3106,
      attempt: 6,
    });
    expect(decideNextBindAction(err, 18, defaultOpts)).toEqual({
      type: "retry-port",
      port: 3119,
      attempt: 19,
    });
  });

  it("switches to background retry when all port attempts are exhausted", () => {
    const err = Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
    const result = decideNextBindAction(err, 19, defaultOpts); // 20th failure
    expect(result).toEqual({
      type: "retry-background",
      delayMs: 30_000,
      port: 3100,
    });
  });

  it("goes straight to background retry on non-EADDRINUSE errors", () => {
    const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const result = decideNextBindAction(err, 0, defaultOpts);
    expect(result).toEqual({
      type: "retry-background",
      delayMs: 30_000,
      port: 3100,
    });
  });

  it("handles errors without a .code field by doing background retry", () => {
    const err = new Error("Listen method has been called more than once");
    const result = decideNextBindAction(err, 3, defaultOpts);
    expect(result.type).toBe("retry-background");
    if (result.type === "retry-background") {
      expect(result.port).toBe(3100);
    }
  });

  it("respects custom maxPortTries", () => {
    const err = Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
    const opts = { ...defaultOpts, maxPortTries: 3 };
    // attempts 0, 1 still retry; attempt 2 is the LAST retry; attempt 3 -> background
    expect(decideNextBindAction(err, 0, opts).type).toBe("retry-port");
    expect(decideNextBindAction(err, 1, opts).type).toBe("retry-port");
    expect(decideNextBindAction(err, 2, opts).type).toBe("retry-background");
  });

  it("respects custom backgroundRetryMs", () => {
    const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const opts = { ...defaultOpts, backgroundRetryMs: 5_000 };
    const result = decideNextBindAction(err, 0, opts);
    expect(result).toEqual({
      type: "retry-background",
      delayMs: 5_000,
      port: 3100,
    });
  });

  it("is pure — same input, same output, no mutation", () => {
    const err = Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
    const snapshot = JSON.stringify({ ...defaultOpts });
    decideNextBindAction(err, 5, defaultOpts);
    decideNextBindAction(err, 5, defaultOpts);
    expect(JSON.stringify({ ...defaultOpts })).toBe(snapshot);
  });
});
