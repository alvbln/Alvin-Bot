/**
 * Fix #17 (Stage 1) — buildSystemPrompt must include the async-subagent
 * hint for SDK sessions so Claude autonomously uses run_in_background: true
 * for long-running tasks, unblocking the main Telegram session.
 *
 * See docs/superpowers/plans/2026-04-13-async-subagents.md
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/services/personality.js";

describe("buildSystemPrompt background-subagent hint (Stage 1)", () => {
  it("includes the background hint when isSDK=true", () => {
    const prompt = buildSystemPrompt(true, "en", "1234");
    expect(prompt).toMatch(/run_in_background/);
    expect(prompt.toLowerCase()).toMatch(/background|async/);
  });

  it("instructs Claude to wrap up the turn after launching a background agent", () => {
    const prompt = buildSystemPrompt(true, "en", "1234");
    // Must tell Claude to end the turn quickly, not keep working
    expect(prompt.toLowerCase()).toMatch(/end.*turn|wrap up|finish.*turn|end your turn/);
  });

  it("lists the criteria for when to use background mode", () => {
    const prompt = buildSystemPrompt(true, "en", "1234");
    // Must mention at least one concrete trigger
    expect(prompt.toLowerCase()).toMatch(/audit|research|long|>.*minute|2 min/);
  });

  it("tells Claude NOT to use background for trivial queries", () => {
    const prompt = buildSystemPrompt(true, "en", "1234");
    expect(prompt.toLowerCase()).toMatch(/don'?t use|avoid|not for|simple question/);
  });

  it("skips the hint for non-SDK sessions (no Agent tool available)", () => {
    const prompt = buildSystemPrompt(false, "en", "1234");
    expect(prompt).not.toMatch(/run_in_background/);
  });

  it("hint is present regardless of user UI locale (prompt is always in English for Claude)", () => {
    const en = buildSystemPrompt(true, "en", "1234");
    const de = buildSystemPrompt(true, "de", "1234");
    const es = buildSystemPrompt(true, "es", "1234");
    expect(en).toMatch(/run_in_background/);
    expect(de).toMatch(/run_in_background/);
    expect(es).toMatch(/run_in_background/);
  });

  it("uses CRITICAL framing and decision-tree structure (v4.12.1)", () => {
    const prompt = buildSystemPrompt(true, "en", "1234");
    expect(prompt).toMatch(/CRITICAL/);
    expect(prompt).toMatch(/decision tree/i);
  });

  it("explicitly warns about Telegram session blocking (v4.12.1)", () => {
    const prompt = buildSystemPrompt(true, "en", "1234");
    expect(prompt.toLowerCase()).toMatch(/blocked|blocking/);
    expect(prompt.toLowerCase()).toMatch(/telegram/);
  });

  it("aggressive 30-second threshold (v4.12.1, previously 2 minutes)", () => {
    const prompt = buildSystemPrompt(true, "en", "1234");
    expect(prompt).toMatch(/30\s*seconds?/i);
  });
});
