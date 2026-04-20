/**
 * v4.13.1 — `/api/platforms/test-connection` must accept `slack` as a
 * platformId and validate the Bot Token via Slack's auth.test endpoint.
 *
 * Before v4.13.1, the handler only knew about telegram/discord/signal/
 * whatsapp, so slack fell through to "Unknown platform" even when a
 * valid xoxb- Bot Token was set.
 *
 * These tests hit the handler directly (no HTTP server spin-up) and stub
 * global fetch so the Slack API is never actually contacted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";

/**
 * Minimal request/response pair that the setup-api handler expects.
 * We capture the body written via res.end(body) so the test can assert
 * on the JSON payload.
 */
interface FakeIO {
  req: EventEmitter & { method: string; url: string; headers: Record<string, string> };
  res: Writable & { statusCode: number; headers: Record<string, string>; body: string };
}

function makeIO(method: string, url: string, body: string): FakeIO {
  const req = new EventEmitter() as FakeIO["req"];
  req.method = method;
  req.url = url;
  req.headers = {};

  let captured = "";
  const res = new Writable({
    write(chunk, _enc, cb) {
      captured += chunk.toString();
      cb();
    },
  }) as FakeIO["res"];
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (k: string, v: string) => {
    res.headers[k.toLowerCase()] = v;
    return res as any;
  };
  res.end = (b?: unknown) => {
    if (b != null) captured += String(b);
    res.body = captured;
    return res as any;
  };

  return { req, res };
}

beforeEach(() => {
  vi.resetModules();
  // Prevent the setup-api module from crashing on BOT_ROOT etc.
  process.env.BOT_TOKEN = "";
  process.env.SLACK_BOT_TOKEN = "";
  process.env.SLACK_APP_TOKEN = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
});

describe("POST /api/platforms/test-connection — slack (v4.13.1)", () => {
  it("returns {ok:false, error: 'SLACK_BOT_TOKEN not set'} when no tokens configured", async () => {
    const { handleSetupAPI } = await import("../src/web/setup-api.js");
    const { req, res } = makeIO("POST", "/api/platforms/test-connection", "");
    const body = JSON.stringify({ platformId: "slack" });

    const handled = await handleSetupAPI(req as any, res as any, "/api/platforms/test-connection", body);
    expect(handled).toBe(true);
    const parsed = JSON.parse(res.body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/SLACK_BOT_TOKEN/);
  });

  it("returns {ok:true, info: '...'} when Slack's auth.test accepts the token", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-fake-valid";
    process.env.SLACK_APP_TOKEN = "xapp-fake-valid";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("slack.com/api/auth.test");
        return {
          ok: true,
          json: async () => ({
            ok: true,
            url: "https://my-project.slack.com/",
            team: "my-project Workspace",
            user: "alvinbot",
            team_id: "T123",
            user_id: "U456",
            bot_id: "B789",
          }),
        };
      }),
    );

    const { handleSetupAPI } = await import("../src/web/setup-api.js");
    const { req, res } = makeIO("POST", "/api/platforms/test-connection", "");
    const body = JSON.stringify({ platformId: "slack" });
    await handleSetupAPI(req as any, res as any, "/api/platforms/test-connection", body);

    const parsed = JSON.parse(res.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.info).toMatch(/alvinbot|my-project/i);
  });

  it("returns {ok:false} when Slack's auth.test rejects the token", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-fake-invalid";
    process.env.SLACK_APP_TOKEN = "xapp-fake-invalid";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: false, error: "invalid_auth" }),
      })),
    );

    const { handleSetupAPI } = await import("../src/web/setup-api.js");
    const { req, res } = makeIO("POST", "/api/platforms/test-connection", "");
    const body = JSON.stringify({ platformId: "slack" });
    await handleSetupAPI(req as any, res as any, "/api/platforms/test-connection", body);

    const parsed = JSON.parse(res.body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/invalid_auth/);
  });

  it("warns about missing/invalid App Token format when Bot Token is OK", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-fake-valid";
    process.env.SLACK_APP_TOKEN = "xoxb-not-an-app-token"; // wrong prefix

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          user: "alvinbot",
          team: "x",
          team_id: "T1",
          user_id: "U1",
          bot_id: "B1",
        }),
      })),
    );

    const { handleSetupAPI } = await import("../src/web/setup-api.js");
    const { req, res } = makeIO("POST", "/api/platforms/test-connection", "");
    const body = JSON.stringify({ platformId: "slack" });
    await handleSetupAPI(req as any, res as any, "/api/platforms/test-connection", body);

    const parsed = JSON.parse(res.body);
    // Bot Token was valid, but we should still note the App Token format issue
    expect(parsed.ok).toBe(true);
    expect(parsed.info).toMatch(/App.?Token|xapp-/i);
  });

  it("still rejects 'slack-workspace' or other typos as unknown (regression guard)", async () => {
    const { handleSetupAPI } = await import("../src/web/setup-api.js");
    const { req, res } = makeIO("POST", "/api/platforms/test-connection", "");
    const body = JSON.stringify({ platformId: "slack-workspace" });
    await handleSetupAPI(req as any, res as any, "/api/platforms/test-connection", body);
    const parsed = JSON.parse(res.body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Unknown platform/);
  });
});
