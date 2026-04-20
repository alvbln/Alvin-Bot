/**
 * v4.13.2 — Slack slash command parser tests.
 *
 * Users on Slack type `/alvin <subcommand> [args...]` which Bolt
 * delivers via app.command('/alvin') with `command.text` containing
 * the part after `/alvin `. We parse it into a platform-agnostic
 * "/subcommand [args]" text that handlePlatformCommand already knows
 * how to route (/new, /status, /effort, /help).
 *
 * Empty text → `/help` (most helpful default).
 * Pass-through for everything else — unknown subcommand falls through
 * to normal LLM prompt handling.
 */
import { describe, it, expect } from "vitest";
import { parseSlackSlashCommand } from "../src/platforms/slack-slash-parser.js";

describe("parseSlackSlashCommand (v4.13.2)", () => {
  it("empty text maps to /help", () => {
    expect(parseSlackSlashCommand("")).toBe("/help");
    expect(parseSlackSlashCommand("   ")).toBe("/help");
  });

  it("single-word subcommand becomes /<subcommand>", () => {
    expect(parseSlackSlashCommand("status")).toBe("/status");
    expect(parseSlackSlashCommand("new")).toBe("/new");
    expect(parseSlackSlashCommand("help")).toBe("/help");
  });

  it("subcommand with args preserves the args", () => {
    expect(parseSlackSlashCommand("effort high")).toBe("/effort high");
    expect(parseSlackSlashCommand("effort low")).toBe("/effort low");
  });

  it("multi-word args are preserved verbatim", () => {
    expect(parseSlackSlashCommand("ask what is the weather in berlin")).toBe(
      "/ask what is the weather in berlin",
    );
  });

  it("collapses extra whitespace around subcommand", () => {
    expect(parseSlackSlashCommand("   status   ")).toBe("/status");
    expect(parseSlackSlashCommand("  effort    max   ")).toBe("/effort max");
  });

  it("lowercases the subcommand for case-insensitive matching", () => {
    expect(parseSlackSlashCommand("Status")).toBe("/status");
    expect(parseSlackSlashCommand("HELP")).toBe("/help");
  });

  it("does NOT lowercase the args (preserve user intent)", () => {
    expect(parseSlackSlashCommand("ask What is THIS")).toBe(
      "/ask What is THIS",
    );
  });

  it("handles leading slash defensively — strips duplicate", () => {
    // If a user literally types `/alvin /status`, Slack delivers text="/status"
    expect(parseSlackSlashCommand("/status")).toBe("/status");
    expect(parseSlackSlashCommand("/effort max")).toBe("/effort max");
  });
});
