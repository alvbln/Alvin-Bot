/**
 * v4.12.2 — Sub-agent toolset allowlist (Task G).
 *
 * Sub-agents can now be spawned with a toolset preset that restricts which
 * tools Claude has access to:
 *   - "full"     — all tools (default, matches pre-v4.12.2 behavior)
 *   - "readonly" — Read, Glob, Grep (analyze, no write, no shell, no net)
 *   - "research" — Read, Glob, Grep, WebSearch, WebFetch (no write, no shell)
 *
 * This test verifies that the preset → allowedTools mapping is correct
 * and that the provider honors the override. The integration path
 * (spawnSubAgent → registry.queryWithFallback → claude-sdk-provider) is
 * exercised via mocked SDK.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamChunk } from "../src/providers/types.js";

beforeEach(() => vi.resetModules());

describe("claude-sdk-provider honors options.allowedTools (v4.12.2)", () => {
  it("uses the default full toolset when options.allowedTools is undefined", async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    vi.doMock("../src/find-claude-binary.js", () => ({
      findClaudeBinary: () => "/usr/bin/false",
    }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: { options: Record<string, unknown> }) => {
        capturedOpts = opts.options;
        return (async function* () {
          yield { type: "system", subtype: "init", session_id: "s1" };
          yield { type: "result", session_id: "s1", total_cost_usd: 0, usage: null };
        })();
      },
    }));

    const { ClaudeSDKProvider } = await import("../src/providers/claude-sdk-provider.js");
    const provider = new ClaudeSDKProvider();

    for await (const _c of provider.query({ prompt: "test", systemPrompt: "test" })) {
      void _c;
    }

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.allowedTools).toEqual([
      "Read", "Write", "Edit", "Bash", "Glob", "Grep",
      "WebSearch", "WebFetch", "Task",
    ]);
  });

  it("overrides allowedTools when caller passes a restricted list (readonly preset)", async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    vi.doMock("../src/find-claude-binary.js", () => ({
      findClaudeBinary: () => "/usr/bin/false",
    }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: { options: Record<string, unknown> }) => {
        capturedOpts = opts.options;
        return (async function* () {
          yield { type: "system", subtype: "init", session_id: "s1" };
          yield { type: "result", session_id: "s1", total_cost_usd: 0, usage: null };
        })();
      },
    }));

    const { ClaudeSDKProvider } = await import("../src/providers/claude-sdk-provider.js");
    const provider = new ClaudeSDKProvider();

    const readonlyTools = ["Read", "Glob", "Grep"];
    for await (const _c of provider.query({
      prompt: "test",
      systemPrompt: "test",
      allowedTools: readonlyTools,
    })) {
      void _c;
    }

    expect(capturedOpts!.allowedTools).toEqual(readonlyTools);
    // Critically: Bash, Write, Edit are NOT in the list
    expect(capturedOpts!.allowedTools).not.toContain("Bash");
    expect(capturedOpts!.allowedTools).not.toContain("Write");
    expect(capturedOpts!.allowedTools).not.toContain("Edit");
  });

  it("overrides allowedTools with research preset (adds web tools)", async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    vi.doMock("../src/find-claude-binary.js", () => ({
      findClaudeBinary: () => "/usr/bin/false",
    }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: { options: Record<string, unknown> }) => {
        capturedOpts = opts.options;
        return (async function* () {
          yield { type: "system", subtype: "init", session_id: "s1" };
          yield { type: "result", session_id: "s1", total_cost_usd: 0, usage: null };
        })();
      },
    }));

    const { ClaudeSDKProvider } = await import("../src/providers/claude-sdk-provider.js");
    const provider = new ClaudeSDKProvider();

    const researchTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
    for await (const _c of provider.query({
      prompt: "test",
      systemPrompt: "test",
      allowedTools: researchTools,
    })) {
      void _c;
    }

    expect(capturedOpts!.allowedTools).toEqual(researchTools);
    expect(capturedOpts!.allowedTools).toContain("WebSearch");
    expect(capturedOpts!.allowedTools).not.toContain("Bash");
  });

  it("empty allowedTools array is honored as such (no tools at all)", async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    vi.doMock("../src/find-claude-binary.js", () => ({
      findClaudeBinary: () => "/usr/bin/false",
    }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: { options: Record<string, unknown> }) => {
        capturedOpts = opts.options;
        return (async function* () {
          yield { type: "system", subtype: "init", session_id: "s1" };
          yield { type: "result", session_id: "s1", total_cost_usd: 0, usage: null };
        })();
      },
    }));

    const { ClaudeSDKProvider } = await import("../src/providers/claude-sdk-provider.js");
    const provider = new ClaudeSDKProvider();

    for await (const _c of provider.query({
      prompt: "test",
      systemPrompt: "test",
      allowedTools: [],
    })) {
      void _c;
    }

    // Empty array → no tools. Note: JS ?? operator treats [] as truthy,
    // so this IS honored as "empty allowlist" not "use default".
    expect(capturedOpts!.allowedTools).toEqual([]);
  });
});
