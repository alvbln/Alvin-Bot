/**
 * WebFetch — Tier 0 of the browser fallback chain.
 *
 * For URLs that don't need JavaScript, cookies, or a real browser —
 * RSS feeds, JSON APIs, static HTML, OG-tag sniffs — a plain `fetch()`
 * is 100× faster than spinning up Playwright and never shows up in
 * bot-detection traffic. When this tier fails (4xx, 5xx, JS-heavy
 * page, certificate error), callers should catch `WebfetchFailed`
 * and cascade to the next tier (hub-stealth → cdp → gateway).
 *
 * See browser-manager.ts for the full cascade; this module is the
 * leaf-level primitive with no dependencies on that file so both can
 * be unit-tested in isolation.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15 AlvinBot/webfetch";

export class WebfetchFailed extends Error {
  readonly status?: number;
  readonly url: string;
  readonly cause?: unknown;

  constructor(url: string, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(`webfetch(${url}): ${message}`);
    this.name = "WebfetchFailed";
    this.url = url;
    this.status = opts.status;
    this.cause = opts.cause;
  }
}

export interface WebfetchOptions {
  /** Abort the fetch after this many ms (default 15 s). */
  timeoutMs?: number;
  /** Throw WebfetchFailed when the response content-type isn't HTML. */
  forceHtml?: boolean;
  /** Override the User-Agent header — otherwise a Safari-like string is used. */
  userAgent?: string;
}

export interface WebfetchResult {
  title: string;
  url: string;
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|quot|#39|apos|lt|gt|nbsp);/gi, (m) => ENTITY_MAP[m.toLowerCase()] ?? m);
}

/**
 * Return the contents of the first `<title>` tag, normalised:
 * whitespace collapsed, common HTML entities decoded. If there's no
 * `<title>` at all, returns the empty string — callers decide what to
 * do with that (the URL is a reasonable default display value).
 */
export function parseTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  const inner = match[1].replace(/\s+/g, " ").trim();
  return decodeEntities(inner);
}

export async function webfetchNavigate(
  url: string,
  options: WebfetchOptions = {},
): Promise<WebfetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (err) {
      throw new WebfetchFailed(url, (err as Error).message, { cause: err });
    }

    if (!response.ok) {
      throw new WebfetchFailed(url, `HTTP ${response.status}`, { status: response.status });
    }

    const contentType = response.headers.get("content-type") || "";
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
    if (options.forceHtml && !isHtml) {
      throw new WebfetchFailed(
        url,
        `expected HTML, got ${contentType || "unknown"}`,
        { status: response.status },
      );
    }

    const body = await response.text();
    const title = parseTitle(body);
    return {
      title: title || url,
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}
