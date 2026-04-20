/**
 * Fix #15 (B) — /cron run must give visible feedback during long runs.
 *
 * Regression from production: a 13-minute Daily Job Alert run showed
 * the user ZERO feedback between trigger time and completion. The
 * sub-agent was actually working (and eventually succeeded), but the
 * Telegram chat was silent for the whole duration.
 *
 * This test doesn't exercise grammy directly — it tests the pure
 * helper that drives the live progress message so we can verify the
 * formatting, cadence math, and safety edges in isolation.
 */
import { describe, it, expect } from "vitest";
import { formatElapsed, buildTickerText, buildDoneText } from "../src/handlers/cron-progress.js";

describe("formatElapsed (Fix #15B)", () => {
  it("formats seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(45)).toBe("45s");
    expect(formatElapsed(59)).toBe("59s");
  });

  it("formats minutes+seconds above a minute", () => {
    expect(formatElapsed(60)).toBe("1m 0s");
    expect(formatElapsed(61)).toBe("1m 1s");
    expect(formatElapsed(125)).toBe("2m 5s");
    expect(formatElapsed(797)).toBe("13m 17s"); // real prod duration
  });

  it("formats hours+minutes above 60m", () => {
    expect(formatElapsed(3600)).toBe("1h 0m");
    expect(formatElapsed(3660)).toBe("1h 1m");
  });
});

describe("buildTickerText (Fix #15B)", () => {
  it("shows job name and elapsed time in the running state", () => {
    const text = buildTickerText("Daily Job Alert", 125);
    expect(text).toContain("Daily Job Alert");
    expect(text).toContain("2m 5s");
    expect(text).toMatch(/🔄|running/i);
  });

  it("escapes markdown-breaking characters in the job name", () => {
    // Underscores and asterisks in job names would otherwise break
    // the Markdown edit and trigger "can't parse entities".
    const text = buildTickerText("weird_job*name", 10);
    expect(text).not.toContain("_job*"); // no raw unescaped asterisk
    // We expect some form of escaping — back-slashes are fine
    expect(text).toMatch(/weird/);
  });
});

describe("buildDoneText (Fix #15B)", () => {
  it("shows green check for a clean completion", () => {
    const text = buildDoneText("Daily Job Alert", 797, { ok: true });
    expect(text).toContain("✅");
    expect(text).toContain("Daily Job Alert");
    expect(text).toContain("13m 17s");
  });

  it("shows red cross and error excerpt for a failure", () => {
    const text = buildDoneText("Daily Job Alert", 10, {
      ok: false,
      error: "Sub-agent cancelled: timeout",
    });
    expect(text).toContain("❌");
    expect(text).toContain("timeout");
  });

  it("shows warning for an already-running skip", () => {
    const text = buildDoneText("Daily Job Alert", 0, { ok: true, skipped: true });
    expect(text).toContain("⏳");
    expect(text).toMatch(/already running|in progress/i);
  });
});
