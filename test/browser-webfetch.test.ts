/**
 * Fix #11 (minimal) — webfetch Tier 0 for browser-manager.
 *
 * Background: the current browser fallback chain is
 *   gateway → cdp → hub-stealth → cli
 * Every tier spawns playwright (or talks to a CDP-controlled Chrome),
 * which is slow and occasionally impossible under load. Many scraping
 * tasks only need plain HTTP — an RSS feed, a JSON API, an OG meta-
 * tag sniff. For those, Node's native `fetch` is 100× faster and
 * doesn't need a browser at all.
 *
 * Contract: `webfetchNavigate(url)` returns `{ title, url }` for a
 * successful GET, or throws a distinct `WebfetchFailed` error that the
 * cascade can catch and fall through to the next tier. Title is the
 * first `<title>` tag content; if none, the URL is returned.
 *
 * Keep it small — this is a Tier 0 helper, not a full scraper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  webfetchNavigate,
  WebfetchFailed,
  parseTitle,
} from "../src/services/browser-webfetch.js";

describe("parseTitle (Fix #11)", () => {
  it("extracts a simple <title>", () => {
    expect(parseTitle("<html><head><title>Hello World</title></head></html>")).toBe("Hello World");
  });

  it("handles whitespace and newlines", () => {
    expect(parseTitle("<title>\n  Multi  line  \n</title>")).toBe("Multi line");
  });

  it("returns empty string when there's no title", () => {
    expect(parseTitle("<html><body>no title</body></html>")).toBe("");
  });

  it("decodes basic HTML entities", () => {
    expect(parseTitle("<title>A &amp; B</title>")).toBe("A & B");
    expect(parseTitle("<title>&quot;quoted&quot;</title>")).toBe('"quoted"');
  });

  it("is case-insensitive for the tag name", () => {
    expect(parseTitle("<HEAD><TITLE>Foo</TITLE></HEAD>")).toBe("Foo");
  });
});

describe("webfetchNavigate (Fix #11)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns title + url on a 200 response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        "<html><head><title>GitHub · alvbln/alvin-bot</title></head></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    ) as unknown as typeof fetch;

    const result = await webfetchNavigate("https://github.com/alvbln/alvin-bot");
    expect(result.title).toBe("GitHub · alvbln/alvin-bot");
    expect(result.url).toBe("https://github.com/alvbln/alvin-bot");
  });

  it("throws WebfetchFailed with the HTTP status on 4xx/5xx", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("blocked", { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(webfetchNavigate("https://example.com")).rejects.toThrow(WebfetchFailed);
    try {
      await webfetchNavigate("https://example.com");
    } catch (err) {
      expect((err as WebfetchFailed).status).toBe(403);
    }
  });

  it("throws WebfetchFailed when the response is not HTML and forceHtml=true", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"json":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    await expect(
      webfetchNavigate("https://api.example.com/data", { forceHtml: true }),
    ).rejects.toThrow(WebfetchFailed);
  });

  it("accepts non-HTML responses when forceHtml is false (default)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("plain text", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ) as unknown as typeof fetch;

    const result = await webfetchNavigate("https://example.com/raw");
    // No <title> in plain text → falls back to URL as display title
    expect(result.url).toBe("https://example.com/raw");
    expect(result.title).toBe("https://example.com/raw");
  });

  it("wraps network errors in WebfetchFailed so the cascade can catch a single type", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND nonexistent.invalid");
    }) as unknown as typeof fetch;

    await expect(
      webfetchNavigate("https://nonexistent.invalid/"),
    ).rejects.toThrow(WebfetchFailed);
  });
});
