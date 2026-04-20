/**
 * Fix #17 (Stage 2) — when the SDK yields a tool_result chunk with an
 * "Async agent launched successfully" payload, the message handler
 * must register the pending agent with the watcher.
 *
 * This tests the helper `handleToolResultChunk` in isolation —
 * the integration with message.ts is covered by the live e2e test.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("async agent chunk flow (Stage 2)", () => {
  beforeEach(() => vi.resetModules());

  it("tool_result with async_launched gets registered with the watcher", async () => {
    const registered: unknown[] = [];
    vi.doMock("../src/services/async-agent-watcher.js", () => ({
      registerPendingAgent: (input: unknown) => registered.push(input),
      startWatcher: () => {},
      stopWatcher: () => {},
      pollOnce: async () => {},
      listPendingAgents: () => [],
    }));

    const { handleToolResultChunk } = await import(
      "../src/handlers/async-agent-chunk-handler.js"
    );

    const chunk = {
      type: "tool_result" as const,
      toolUseId: "toolu_1",
      toolResultContent:
        "Async agent launched successfully.\n" +
        "agentId: abc-1 (something)\n" +
        "output_file: /tmp/out-abc-1.jsonl\n" +
        "If asked, you can check progress.",
    };
    handleToolResultChunk(chunk, {
      chatId: 42,
      userId: 99,
      lastToolUseInput: {
        description: "SEO audit",
        prompt: "audit example.com",
      },
    });

    expect(registered).toHaveLength(1);
    const r = registered[0] as { agentId: string; description: string; outputFile: string };
    expect(r.agentId).toBe("abc-1");
    expect(r.description).toBe("SEO audit");
    expect(r.outputFile).toBe("/tmp/out-abc-1.jsonl");
  });

  it("v4.12.3 — passes sessionKey to registerPendingAgent and increments session counter", async () => {
    const registered: Array<{ sessionKey?: string }> = [];
    vi.doMock("../src/services/async-agent-watcher.js", () => ({
      registerPendingAgent: (input: { sessionKey?: string }) =>
        registered.push(input),
      startWatcher: () => {},
      stopWatcher: () => {},
      pollOnce: async () => {},
      listPendingAgents: () => [],
    }));

    const { getSession } = await import("../src/services/session.js");
    const session = getSession("v412-chunk-test-session");
    session.pendingBackgroundCount = 0;

    const { handleToolResultChunk } = await import(
      "../src/handlers/async-agent-chunk-handler.js"
    );
    handleToolResultChunk(
      {
        type: "tool_result",
        toolUseId: "toolu_sess",
        toolResultContent:
          "Async agent launched successfully.\n" +
          "agentId: ag-sess\n" +
          "output_file: /tmp/ag-sess.jsonl\n",
      },
      {
        chatId: 10,
        userId: 20,
        sessionKey: "v412-chunk-test-session",
        lastToolUseInput: { description: "SEO", prompt: "do it" },
      },
    );

    expect(registered).toHaveLength(1);
    expect(registered[0].sessionKey).toBe("v412-chunk-test-session");
    expect(session.pendingBackgroundCount).toBe(1);
  });

  it("v4.12.3 — multiple async launches in same turn stack the counter", async () => {
    vi.doMock("../src/services/async-agent-watcher.js", () => ({
      registerPendingAgent: () => {},
      startWatcher: () => {},
      stopWatcher: () => {},
      pollOnce: async () => {},
      listPendingAgents: () => [],
    }));

    const { getSession } = await import("../src/services/session.js");
    const session = getSession("v412-chunk-stack");
    session.pendingBackgroundCount = 0;

    const { handleToolResultChunk } = await import(
      "../src/handlers/async-agent-chunk-handler.js"
    );

    for (let i = 0; i < 3; i++) {
      handleToolResultChunk(
        {
          type: "tool_result",
          toolUseId: `toolu_${i}`,
          toolResultContent:
            `Async agent launched successfully.\n` +
            `agentId: ag-${i}\n` +
            `output_file: /tmp/ag-${i}.jsonl\n`,
        },
        {
          chatId: 10,
          userId: 20,
          sessionKey: "v412-chunk-stack",
          lastToolUseInput: { description: `task ${i}`, prompt: "p" },
        },
      );
    }

    expect(session.pendingBackgroundCount).toBe(3);
  });

  it("v4.12.3 — non-async tool_result does not increment the counter", async () => {
    vi.doMock("../src/services/async-agent-watcher.js", () => ({
      registerPendingAgent: () => {
        throw new Error("should not be called");
      },
      startWatcher: () => {},
      stopWatcher: () => {},
      pollOnce: async () => {},
      listPendingAgents: () => [],
    }));

    const { getSession } = await import("../src/services/session.js");
    const session = getSession("v412-chunk-nonasync");
    session.pendingBackgroundCount = 0;

    const { handleToolResultChunk } = await import(
      "../src/handlers/async-agent-chunk-handler.js"
    );
    handleToolResultChunk(
      {
        type: "tool_result",
        toolUseId: "toolu_read",
        toolResultContent: "plain read result — no async_launched marker",
      },
      {
        chatId: 1,
        userId: 1,
        sessionKey: "v412-chunk-nonasync",
        lastToolUseInput: { description: "read", prompt: "p" },
      },
    );
    expect(session.pendingBackgroundCount).toBe(0);
  });

  it("falls back to a generic description when no toolUseInput is provided", async () => {
    const registered: unknown[] = [];
    vi.doMock("../src/services/async-agent-watcher.js", () => ({
      registerPendingAgent: (input: unknown) => registered.push(input),
      startWatcher: () => {},
      stopWatcher: () => {},
      pollOnce: async () => {},
      listPendingAgents: () => [],
    }));

    const { handleToolResultChunk } = await import(
      "../src/handlers/async-agent-chunk-handler.js"
    );

    handleToolResultChunk(
      {
        type: "tool_result",
        toolUseId: "toolu_2",
        toolResultContent:
          "Async agent launched successfully.\n" +
          "agentId: x\n" +
          "output_file: /tmp/o\n",
      },
      { chatId: 42, userId: 99 },
    );

    expect(registered).toHaveLength(1);
    const r = registered[0] as { description: string };
    expect(r.description.length).toBeGreaterThan(0);
  });

  it("non-async tool_result (e.g. Read) is ignored", async () => {
    const registered: unknown[] = [];
    vi.doMock("../src/services/async-agent-watcher.js", () => ({
      registerPendingAgent: (input: unknown) => registered.push(input),
      startWatcher: () => {},
      stopWatcher: () => {},
      pollOnce: async () => {},
      listPendingAgents: () => [],
    }));

    const { handleToolResultChunk } = await import(
      "../src/handlers/async-agent-chunk-handler.js"
    );

    handleToolResultChunk(
      {
        type: "tool_result",
        toolUseId: "toolu_3",
        toolResultContent: "file contents here (plain Read result)",
      },
      { chatId: 42, userId: 99 },
    );
    expect(registered).toHaveLength(0);
  });

  it("non-tool_result chunks are ignored without throwing", async () => {
    vi.doMock("../src/services/async-agent-watcher.js", () => ({
      registerPendingAgent: () => {
        throw new Error("should not be called");
      },
      startWatcher: () => {},
      stopWatcher: () => {},
      pollOnce: async () => {},
      listPendingAgents: () => [],
    }));

    const { handleToolResultChunk } = await import(
      "../src/handlers/async-agent-chunk-handler.js"
    );

    expect(() =>
      handleToolResultChunk(
        { type: "text", text: "hi" },
        { chatId: 42, userId: 99 },
      ),
    ).not.toThrow();
  });
});
