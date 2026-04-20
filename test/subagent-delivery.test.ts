import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";
import type { SubAgentInfo, SubAgentResult } from "../src/services/subagents.js";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-delivery-${process.pid}-${Date.now()}`);

const sentMessages: Array<{ chatId: number; text: string }> = [];
const sentDocuments: Array<{ chatId: number }> = [];

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  sentMessages.length = 0;
  sentDocuments.length = 0;
  vi.resetModules();
});

async function wireFakeApi() {
  const mod = await import("../src/services/subagent-delivery.js");
  mod.__setBotApiForTest({
    sendMessage: async (chatId: number, text: string) => {
      sentMessages.push({ chatId, text });
      return {};
    },
    sendDocument: async (chatId: number) => {
      sentDocuments.push({ chatId });
      return {};
    },
  });
  return mod;
}

describe("subagent-delivery (I3)", () => {
  it("does nothing for source='implicit' (parent-stream handles it)", async () => {
    const mod = await wireFakeApi();

    const info: SubAgentInfo = {
      id: "x",
      name: "impl",
      status: "completed",
      startedAt: Date.now() - 1000,
      source: "implicit",
      depth: 0,
      parentChatId: 123,
    };
    const result: SubAgentResult = {
      id: "x",
      name: "impl",
      status: "completed",
      output: "anything",
      tokensUsed: { input: 10, output: 5 },
      duration: 1000,
    };

    await mod.deliverSubAgentResult(info, result);
    expect(sentMessages).toHaveLength(0);
    expect(sentDocuments).toHaveLength(0);
  });

  it("sends banner+final to parentChatId for source='user'", async () => {
    const mod = await wireFakeApi();

    const info: SubAgentInfo = {
      id: "u",
      name: "code-review",
      status: "completed",
      startedAt: Date.now() - 192000,
      source: "user",
      depth: 0,
      parentChatId: 555,
    };
    const result: SubAgentResult = {
      id: "u",
      name: "code-review",
      status: "completed",
      output: "Found 2 issues:\n1. bug\n2. nit",
      tokensUsed: { input: 4200, output: 2100 },
      duration: 192000,
    };

    await mod.deliverSubAgentResult(info, result);
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const all = sentMessages.map((m) => m.text).join("\n");
    expect(sentMessages[0].chatId).toBe(555);
    expect(all).toContain("code-review");
    expect(all).toContain("4.2k"); // token formatting
    expect(all).toContain("2.1k");
    expect(all).toContain("Found 2 issues");
  });

  it("splits long output into chunks (>3800 chars)", async () => {
    const mod = await wireFakeApi();

    const info: SubAgentInfo = {
      id: "c",
      name: "long",
      status: "completed",
      startedAt: Date.now() - 1000,
      source: "user",
      depth: 0,
      parentChatId: 1,
    };
    const result: SubAgentResult = {
      id: "c",
      name: "long",
      status: "completed",
      output: "x".repeat(9000),
      tokensUsed: { input: 0, output: 9000 },
      duration: 1000,
    };

    await mod.deliverSubAgentResult(info, result);
    // Expect: 1 banner + 3 content chunks (9000 / 3800 = 3 chunks)
    expect(sentMessages.length).toBeGreaterThanOrEqual(3);
  });

  it("silent visibility produces no delivery", async () => {
    const mod = await wireFakeApi();

    const info: SubAgentInfo = {
      id: "s",
      name: "silent-job",
      status: "completed",
      startedAt: Date.now() - 1000,
      source: "user",
      depth: 0,
      parentChatId: 1,
    };
    const result: SubAgentResult = {
      id: "s",
      name: "silent-job",
      status: "completed",
      output: "hello",
      tokensUsed: { input: 1, output: 1 },
      duration: 1000,
    };

    await mod.deliverSubAgentResult(info, result, { visibility: "silent" });
    expect(sentMessages).toHaveLength(0);
  });

  it("missing parentChatId logs but does not throw", async () => {
    const mod = await wireFakeApi();

    const info: SubAgentInfo = {
      id: "noparent",
      name: "orphan",
      status: "completed",
      startedAt: Date.now() - 1000,
      source: "user",
      depth: 0,
      // no parentChatId
    };
    const result: SubAgentResult = {
      id: "noparent",
      name: "orphan",
      status: "completed",
      output: "hi",
      tokensUsed: { input: 0, output: 0 },
      duration: 1000,
    };

    await expect(mod.deliverSubAgentResult(info, result)).resolves.toBeUndefined();
    expect(sentMessages).toHaveLength(0);
  });
});

describe("subagent-delivery LiveStream (A4)", () => {
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  let messageCounter = 100;

  beforeEach(() => {
    edits.length = 0;
    messageCounter = 100;
  });

  async function wireLiveApi() {
    const mod = await import("../src/services/subagent-delivery.js");
    mod.__setBotApiForTest({
      sendMessage: async (chatId: number, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: messageCounter++ };
      },
      sendDocument: async (chatId: number) => {
        sentDocuments.push({ chatId });
        return {};
      },
      editMessageText: async (chatId: number, messageId: number, text: string) => {
        edits.push({ chatId, messageId, text });
        return {};
      },
    });
    return mod;
  }

  it("start posts an initial 'thinking…' message and records messageId", async () => {
    const mod = await wireLiveApi();
    const stream = mod.createLiveStream(555, "code-review");
    expect(stream).not.toBeNull();
    await stream!.start();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].chatId).toBe(555);
    expect(sentMessages[0].text).toContain("thinking");
    expect(stream!.failed).toBe(false);
  });

  it("update coalesces multiple rapid calls into a single throttled edit", async () => {
    const mod = await wireLiveApi();
    const stream = mod.createLiveStream(1, "fast");
    await stream!.start();

    stream!.update("hello");
    stream!.update("hello world");
    stream!.update("hello world and more");

    // Wait for the throttle window to elapse
    await new Promise((r) => setTimeout(r, 900));

    // Should have produced exactly one edit with the LAST text
    expect(edits.length).toBe(1);
    expect(edits[0].text).toContain("hello world and more");
  });

  it("finalize posts a banner as a new message", async () => {
    const mod = await wireLiveApi();
    const stream = mod.createLiveStream(42, "done-agent");
    await stream!.start();
    stream!.update("final text");
    await new Promise((r) => setTimeout(r, 900)); // let flush run

    await stream!.finalize(
      {
        id: "x",
        name: "done-agent",
        status: "completed",
        startedAt: Date.now() - 5000,
        source: "user",
        depth: 0,
        parentChatId: 42,
      },
      {
        id: "x",
        name: "done-agent",
        status: "completed",
        output: "final text",
        tokensUsed: { input: 100, output: 50 },
        duration: 5000,
      },
    );

    // Two sends total: initial "thinking…" + final banner
    expect(sentMessages.length).toBe(2);
    const banner = sentMessages[sentMessages.length - 1].text;
    expect(banner).toContain("done-agent");
    expect(banner).toContain("completed");
  });

  it("createLiveStream returns null when bot api lacks editMessageText", async () => {
    const mod = await import("../src/services/subagent-delivery.js");
    // Set an api that intentionally has no editMessageText
    mod.__setBotApiForTest({
      sendMessage: async () => ({ message_id: 1 }),
      sendDocument: async () => ({}),
      // no editMessageText
    });
    const stream = mod.createLiveStream(1, "no-edit");
    expect(stream).toBeNull();
  });
});
