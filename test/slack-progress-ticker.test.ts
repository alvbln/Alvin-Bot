/**
 * v4.12.0 — Slack adapter editMessage support for progress tickers.
 *
 * Slack doesn't stream text like the OpenAI API does; the idiom is to
 * post an initial message, capture its `ts` (timestamp), then edit it
 * with growing content via chat.update. This mirrors Telegram's
 * editMessageText approach used in the cron progress ticker.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

describe("SlackAdapter.editMessage (v4.12.0)", () => {
  it("calls chat.update with the correct channel + ts when editMessage is invoked", async () => {
    const updateSpy = vi.fn().mockResolvedValue({ ok: true, ts: "1234567890.123456" });
    const postSpy = vi.fn().mockResolvedValue({ ok: true, ts: "1234567890.123456" });
    const authSpy = vi.fn().mockResolvedValue({ ok: true, user_id: "U_BOT", user: "alvin", team: "Test" });

    vi.doMock("@slack/bolt", () => ({
      App: class {
        client = {
          auth: { test: authSpy },
          chat: { postMessage: postSpy, update: updateSpy },
          users: { info: vi.fn() },
          reactions: { add: vi.fn() },
          filesUploadV2: vi.fn(),
          conversations: { info: vi.fn() },
          apiCall: vi.fn(),
        };
        constructor(_opts: unknown) {}
        message(_h: unknown) {}
        event(_k: string, _h: unknown) {}
        async start() {}
        async stop() {}
      },
    }));

    const { SlackAdapter } = await import("../src/platforms/slack.js");
    const adapter = new SlackAdapter("xoxb-test", "xapp-test");
    await adapter.start();

    const returnedId = await adapter.editMessage!("C_TEST", "1234567890.123456", "updated text");
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_TEST",
        ts: "1234567890.123456",
        text: "updated text",
      }),
    );
    expect(returnedId).toBe("1234567890.123456");

    await adapter.stop();
  });

  it("sendText returns the message ts so it can be edited later", async () => {
    const postSpy = vi.fn().mockResolvedValue({ ok: true, ts: "9876543210.555555" });
    const authSpy = vi.fn().mockResolvedValue({ ok: true, user_id: "U_BOT", user: "alvin", team: "Test" });

    vi.doMock("@slack/bolt", () => ({
      App: class {
        client = {
          auth: { test: authSpy },
          chat: { postMessage: postSpy, update: vi.fn() },
          users: { info: vi.fn() },
          reactions: { add: vi.fn() },
          filesUploadV2: vi.fn(),
          conversations: { info: vi.fn() },
          apiCall: vi.fn(),
        };
        constructor(_opts: unknown) {}
        message(_h: unknown) {}
        event(_k: string, _h: unknown) {}
        async start() {}
        async stop() {}
      },
    }));

    const { SlackAdapter } = await import("../src/platforms/slack.js");
    const adapter = new SlackAdapter("xoxb-test", "xapp-test");
    await adapter.start();

    const id = await adapter.sendText("C_TEST", "first message");
    expect(id).toBe("9876543210.555555");

    await adapter.stop();
  });

  it("editMessage returns messageId unchanged when chat.update fails", async () => {
    const updateSpy = vi.fn().mockRejectedValue(new Error("slack down"));
    const authSpy = vi.fn().mockResolvedValue({ ok: true, user_id: "U_BOT", user: "alvin", team: "Test" });

    vi.doMock("@slack/bolt", () => ({
      App: class {
        client = {
          auth: { test: authSpy },
          chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "x" }), update: updateSpy },
          users: { info: vi.fn() },
          reactions: { add: vi.fn() },
          filesUploadV2: vi.fn(),
          conversations: { info: vi.fn() },
          apiCall: vi.fn(),
        };
        constructor(_opts: unknown) {}
        message(_h: unknown) {}
        event(_k: string, _h: unknown) {}
        async start() {}
        async stop() {}
      },
    }));

    const { SlackAdapter } = await import("../src/platforms/slack.js");
    const adapter = new SlackAdapter("xoxb-test", "xapp-test");
    await adapter.start();

    // Should not throw
    const result = await adapter.editMessage!("C_TEST", "123.456", "new text");
    expect(result).toBe("123.456");

    await adapter.stop();
  });
});
