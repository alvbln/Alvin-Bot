/**
 * v4.14 — subagent-delivery platform routing tests.
 *
 * Covers the new v4.14 behavior: deliveries with `info.platform` other
 * than "telegram" go through the delivery-registry adapter instead of
 * the grammy bot API. Telegram path is unchanged and still uses the
 * injected grammy-compatible API.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

interface CapturedMsg {
  chatId: string | number;
  text: string;
}

beforeEach(() => vi.resetModules());

async function loadModules() {
  const delivery = await import("../src/services/subagent-delivery.js");
  const registry = await import("../src/services/delivery-registry.js");
  registry.__resetForTest();
  return { delivery, registry };
}

describe("subagent-delivery platform routing (v4.14)", () => {
  afterEach(async () => {
    const { delivery, registry } = await loadModules();
    delivery.__setBotApiForTest(null);
    registry.__resetForTest();
  });

  it("info.platform='slack' routes via delivery-registry (NOT grammy api)", async () => {
    const { delivery, registry } = await loadModules();

    // Register fake Slack adapter
    const sent: CapturedMsg[] = [];
    registry.registerDeliveryAdapter({
      platform: "slack",
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    });

    // Set a grammy api that SHOULD NOT be called
    const grammyCalls: CapturedMsg[] = [];
    delivery.__setBotApiForTest({
      sendMessage: async (chatId: number, text: string) => {
        grammyCalls.push({ chatId, text });
        return { message_id: 1 };
      },
      sendDocument: async () => ({ message_id: 1 }),
    });

    await delivery.deliverSubAgentResult(
      {
        id: "a1",
        name: "Research task",
        status: "completed",
        startedAt: Date.now() - 5000,
        source: "cron",
        depth: 0,
        parentChatId: "C012SLACKCH",
        platform: "slack",
      },
      {
        id: "a1",
        name: "Research task",
        status: "completed",
        output: "Result body",
        tokensUsed: { input: 100, output: 50 },
        duration: 5000,
      },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("C012SLACKCH");
    expect(sent[0].text).toContain("Research task");
    expect(sent[0].text).toContain("Result body");
    // grammy must NOT have been touched
    expect(grammyCalls).toHaveLength(0);
  });

  it("info.platform='telegram' (default) still uses grammy api — behavior unchanged", async () => {
    const { delivery, registry } = await loadModules();

    // Register Slack adapter that SHOULD NOT be called
    const slackCalls: CapturedMsg[] = [];
    registry.registerDeliveryAdapter({
      platform: "slack",
      sendText: async (chatId, text) => slackCalls.push({ chatId, text }),
    });

    const grammyCalls: CapturedMsg[] = [];
    delivery.__setBotApiForTest({
      sendMessage: async (chatId: number, text: string) => {
        grammyCalls.push({ chatId, text });
        return { message_id: 1 };
      },
      sendDocument: async () => ({ message_id: 1 }),
    });

    await delivery.deliverSubAgentResult(
      {
        id: "a2",
        name: "Telegram task",
        status: "completed",
        startedAt: Date.now() - 3000,
        source: "cron",
        depth: 0,
        parentChatId: 1234567890,
        // platform undefined → defaults to telegram
      },
      {
        id: "a2",
        name: "Telegram task",
        status: "completed",
        output: "Telegram body",
        tokensUsed: { input: 10, output: 5 },
        duration: 3000,
      },
    );

    expect(grammyCalls).toHaveLength(1);
    expect(grammyCalls[0].chatId).toBe(1234567890);
    expect(grammyCalls[0].text).toContain("Telegram body");
    // Slack adapter must NOT have been touched
    expect(slackCalls).toHaveLength(0);
  });

  it("info.platform='discord' routes to discord adapter", async () => {
    const { delivery, registry } = await loadModules();

    const discordCalls: CapturedMsg[] = [];
    registry.registerDeliveryAdapter({
      platform: "discord",
      sendText: async (chatId, text) =>
        discordCalls.push({ chatId, text }),
    });

    await delivery.deliverSubAgentResult(
      {
        id: "a3",
        name: "Discord task",
        status: "completed",
        startedAt: Date.now() - 1000,
        source: "cron",
        depth: 0,
        parentChatId: "1234567890123456",
        platform: "discord",
      },
      {
        id: "a3",
        name: "Discord task",
        status: "completed",
        output: "Discord body",
        tokensUsed: { input: 1, output: 1 },
        duration: 1000,
      },
    );

    expect(discordCalls).toHaveLength(1);
    expect(discordCalls[0].chatId).toBe("1234567890123456");
  });

  it("non-telegram platform with NO registered adapter skips delivery (no crash)", async () => {
    const { delivery } = await loadModules();

    await expect(
      delivery.deliverSubAgentResult(
        {
          id: "a4",
          name: "Orphan",
          status: "completed",
          startedAt: Date.now(),
          source: "cron",
          depth: 0,
          parentChatId: "C999",
          platform: "slack",
        },
        {
          id: "a4",
          name: "Orphan",
          status: "completed",
          output: "x",
          tokensUsed: { input: 1, output: 1 },
          duration: 100,
        },
      ),
    ).resolves.not.toThrow();
  });

  it("long output triggers chunking on non-Telegram adapter", async () => {
    const { delivery, registry } = await loadModules();

    const sent: string[] = [];
    registry.registerDeliveryAdapter({
      platform: "slack",
      sendText: async (_chatId, text) => {
        sent.push(text);
      },
    });

    // Build ~8000 chars of output (forces chunking at 3800)
    const longBody = "x".repeat(8000);

    await delivery.deliverSubAgentResult(
      {
        id: "a5",
        name: "Long task",
        status: "completed",
        startedAt: Date.now(),
        source: "cron",
        depth: 0,
        parentChatId: "C1",
        platform: "slack",
      },
      {
        id: "a5",
        name: "Long task",
        status: "completed",
        output: longBody,
        tokensUsed: { input: 1, output: 1 },
        duration: 100,
      },
    );

    // Expect: 1 banner + multiple body chunks
    expect(sent.length).toBeGreaterThan(1);
    const bodyBytes = sent.slice(1).join("").length;
    expect(bodyBytes).toBe(longBody.length);
  });
});
