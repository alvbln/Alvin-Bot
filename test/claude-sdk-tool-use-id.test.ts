/**
 * v4.12.1 — Contract test for claude-sdk-provider's tool_use chunk shape.
 *
 * The task-aware stuck timer depends on tool_use chunks carrying:
 *   - toolUseId (matches the tool_result that arrives later)
 *   - runInBackground (boolean extracted from block.input.run_in_background)
 *
 * Both are must-have, not nice-to-have. Pin the contract so an SDK
 * upgrade or an accidental regression can't silently break it.
 *
 * See src/handlers/stuck-timer.ts for the consumer side and
 * src/handlers/message.ts for the wiring.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamChunk } from "../src/providers/types.js";

beforeEach(() => vi.resetModules());

// Helper: mock the Claude Agent SDK with a scripted async generator so we
// control the tool_use block the provider sees.
function mockSDKWithToolUse(toolUseBlock: Record<string, unknown>): void {
  const asyncIterable = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "system",
        subtype: "init",
        session_id: "s1",
      };
      yield {
        type: "assistant",
        session_id: "s1",
        message: {
          content: [toolUseBlock],
        },
      };
      yield {
        type: "result",
        session_id: "s1",
        total_cost_usd: 0,
        usage: null,
      };
    },
  };

  vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
    query: () => asyncIterable,
  }));
}

// Helper: find the claude binary. The provider calls findClaudeBinary() and
// passes the path to the SDK — since the SDK is mocked, the path doesn't
// matter, but findClaudeBinary itself must not throw.
function mockFindClaudeBinary(): void {
  vi.doMock("../src/find-claude-binary.js", () => ({
    findClaudeBinary: () => "/usr/bin/false",
  }));
}

describe("claude-sdk-provider tool_use chunk contract (v4.12.1)", () => {
  it("emits toolUseId AND runInBackground=true when the flag is set", async () => {
    mockFindClaudeBinary();
    mockSDKWithToolUse({
      type: "tool_use",
      id: "toolu_ABC123",
      name: "Task",
      input: {
        description: "full site audit",
        run_in_background: true,
        prompt: "audit example.com",
      },
    });

    const { ClaudeSDKProvider } = await import("../src/providers/claude-sdk-provider.js");
    const provider = new ClaudeSDKProvider();

    const chunks: StreamChunk[] = [];
    for await (const c of provider.query({
      prompt: "do the audit",
      systemPrompt: "test",
    })) {
      chunks.push(c);
    }

    const toolUse = chunks.find(c => c.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse!.toolUseId).toBe("toolu_ABC123");
    expect(toolUse!.runInBackground).toBe(true);
    expect(toolUse!.toolName).toBe("Task");
  });

  it("extracts runInBackground=undefined when the flag is omitted", async () => {
    mockFindClaudeBinary();
    mockSDKWithToolUse({
      type: "tool_use",
      id: "toolu_XYZ",
      name: "Task",
      input: {
        description: "sync task",
        prompt: "do it",
      },
    });

    const { ClaudeSDKProvider } = await import("../src/providers/claude-sdk-provider.js");
    const provider = new ClaudeSDKProvider();

    const chunks: StreamChunk[] = [];
    for await (const c of provider.query({
      prompt: "test",
      systemPrompt: "test",
    })) {
      chunks.push(c);
    }

    const toolUse = chunks.find(c => c.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse!.toolUseId).toBe("toolu_XYZ");
    expect(toolUse!.runInBackground).toBeUndefined();
  });

  it("extracts runInBackground=false when the flag is explicitly false", async () => {
    mockFindClaudeBinary();
    mockSDKWithToolUse({
      type: "tool_use",
      id: "toolu_EXPLICIT",
      name: "Agent",
      input: {
        description: "explicit sync",
        run_in_background: false,
        prompt: "do it synchronously",
      },
    });

    const { ClaudeSDKProvider } = await import("../src/providers/claude-sdk-provider.js");
    const provider = new ClaudeSDKProvider();

    const chunks: StreamChunk[] = [];
    for await (const c of provider.query({
      prompt: "test",
      systemPrompt: "test",
    })) {
      chunks.push(c);
    }

    const toolUse = chunks.find(c => c.type === "tool_use");
    expect(toolUse!.runInBackground).toBe(false);
  });

  it("toolInput is still serialized (for display in status line), but truncated at 500 chars", async () => {
    mockFindClaudeBinary();
    const longPrompt = "x".repeat(1000);
    mockSDKWithToolUse({
      type: "tool_use",
      id: "toolu_LONG",
      name: "Task",
      input: {
        description: "long prompt task",
        run_in_background: true,
        prompt: longPrompt,
      },
    });

    const { ClaudeSDKProvider } = await import("../src/providers/claude-sdk-provider.js");
    const provider = new ClaudeSDKProvider();

    const chunks: StreamChunk[] = [];
    for await (const c of provider.query({
      prompt: "test",
      systemPrompt: "test",
    })) {
      chunks.push(c);
    }

    const toolUse = chunks.find(c => c.type === "tool_use");
    // runInBackground is extracted cleanly EVEN THOUGH toolInput is truncated
    expect(toolUse!.runInBackground).toBe(true);
    // toolInput is the display-truncated serialization (max ~501 chars)
    expect(toolUse!.toolInput).toBeDefined();
    expect(toolUse!.toolInput!.length).toBeLessThanOrEqual(501);
  });
});
