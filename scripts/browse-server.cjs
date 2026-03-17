#!/usr/bin/env node
/**
 * Browse Server — Persistent Playwright browser for Claude agent interaction.
 *
 * Gives Claude "eyes" and "hands" to interact with running web apps.
 * Inspired by gstack's /browse approach (Playwright + Accessibility Tree refs).
 *
 * Start:  node scripts/browse-server.js [port]
 * Usage:  curl http://127.0.0.1:3800/navigate?url=https://example.com
 *
 * Auto-shuts down after 5 minutes of inactivity.
 */

const http = require("http");
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { URL, URLSearchParams } = require("url");

// ── Config ───────────────────────────────────────────────
const PORT = parseInt(process.argv[2]) || 3800;
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 min
const SCREENSHOT_DIR = path.join(os.tmpdir(), "alvin-bot", "browse");
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ── State ────────────────────────────────────────────────
let browser = null;
let context = null;
let page = null;
let idleTimer = null;

function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    console.log("⏰ Idle timeout — shutting down");
    await cleanup();
    process.exit(0);
  }, IDLE_TIMEOUT);
}

async function cleanup() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
    context = null;
    page = null;
  }
}

async function ensureBrowser() {
  if (!browser || !page) {
    if (browser) try { await browser.close(); } catch {}
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    page = await context.newPage();
    console.log("🌐 Browser launched");
  }
  return page;
}

// ── Accessibility Tree ───────────────────────────────────

/**
 * Build accessibility tree with @eN refs for interactive elements.
 * This is the core innovation: Claude uses refs like @e5 instead of
 * fragile CSS selectors — robust, readable, human-like interaction.
 */
async function getAccessibilityTree(p) {
  return p.evaluate(() => {
    const elements = [];
    let counter = 1;

    // All interactive element types
    const selectors = [
      "a[href]", "button", "input", "textarea", "select",
      '[role="button"]', '[role="link"]', '[role="tab"]', '[role="tabpanel"]',
      '[role="menuitem"]', '[role="checkbox"]', '[role="radio"]',
      '[role="switch"]', '[role="slider"]', '[role="combobox"]',
      '[role="searchbox"]', '[role="dialog"]', '[role="alertdialog"]',
      "[onclick]", "[tabindex]:not([tabindex='-1'])",
      "summary", "details", "label[for]",
    ];

    const allEls = document.querySelectorAll(selectors.join(","));

    for (const el of allEls) {
      // Skip hidden elements
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const ref = `e${counter++}`;
      el.setAttribute("data-browse-ref", ref);

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || "";
      const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
      const href = el.getAttribute("href") || "";
      const type = el.getAttribute("type") || "";
      const name = el.getAttribute("name") || "";
      const placeholder = el.getAttribute("placeholder") || "";
      const value = el.value || el.getAttribute("value") || "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
      const checked = el.checked;

      // Build compact description
      let desc = `@${ref} <${tag}`;
      if (role) desc += ` role="${role}"`;
      if (type) desc += ` type="${type}"`;
      if (name) desc += ` name="${name}"`;
      if (placeholder) desc += ` placeholder="${placeholder}"`;
      if (href && href !== "#") desc += ` href="${href.slice(0, 120)}"`;
      if (ariaLabel) desc += ` aria-label="${ariaLabel}"`;
      if (disabled) desc += " disabled";
      if (checked) desc += " checked";
      desc += ">";
      if (text && !["input", "textarea", "select"].includes(tag)) desc += ` "${text}"`;
      if (value && ["input", "textarea"].includes(tag)) desc += ` value="${value.slice(0, 60)}"`;

      elements.push(desc);
    }

    return elements;
  });
}

/** Find element by @eN ref */
async function findByRef(p, ref) {
  const cleanRef = ref.replace(/^@/, "");
  const el = p.locator(`[data-browse-ref="${cleanRef}"]`);
  const count = await el.count();
  if (count === 0) throw new Error(`Element @${cleanRef} not found. Run /tree to see current elements.`);
  return el.first();
}

// ── Route Handlers ───────────────────────────────────────

const routes = {
  /** Navigate to a URL */
  "/navigate": async (params) => {
    let url = params.get("url");
    if (!url) return { error: "Missing url parameter" };
    if (!url.startsWith("http")) url = `https://${url}`;

    const p = await ensureBrowser();
    const response = await p.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    const title = await p.title();
    const currentUrl = p.url();
    const status = response?.status() || 0;
    const tree = await getAccessibilityTree(p);

    return {
      ok: true,
      title,
      url: currentUrl,
      status,
      elements: tree.length,
      tree: tree.slice(0, 50),
    };
  },

  /** Take a screenshot — returns file path (view with Read tool) */
  "/screenshot": async (params) => {
    if (!page) return { error: "No page open. Use /navigate first." };

    const fullPage = params.get("full") === "true";
    const filename = `browse_${Date.now()}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);

    await page.screenshot({ path: filepath, fullPage });

    return { ok: true, path: filepath, fullPage };
  },

  /** Get accessibility tree — all interactive elements with @eN refs */
  "/tree": async (params) => {
    if (!page) return { error: "No page open. Use /navigate first." };

    const limit = parseInt(params.get("limit") || "100");
    const tree = await getAccessibilityTree(page);
    const title = await page.title();
    const url = page.url();

    return {
      ok: true,
      title,
      url,
      total: tree.length,
      showing: Math.min(limit, tree.length),
      tree: tree.slice(0, limit),
    };
  },

  /** Click an element by @eN ref */
  "/click": async (params) => {
    if (!page) return { error: "No page open." };

    const ref = params.get("ref");
    if (!ref) return { error: "Missing ref parameter (e.g. e5 or @e5)" };

    const locator = await findByRef(page, ref);
    await locator.click({ timeout: 5000 });

    // Wait for potential navigation
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

    const title = await page.title();
    const url = page.url();
    const tree = await getAccessibilityTree(page);

    return { ok: true, clicked: ref, title, url, elements: tree.length, tree: tree.slice(0, 30) };
  },

  /** Fill an input element by @eN ref */
  "/fill": async (params) => {
    if (!page) return { error: "No page open." };

    const ref = params.get("ref");
    const value = params.get("value") || "";
    if (!ref) return { error: "Missing ref parameter" };

    const locator = await findByRef(page, ref);
    await locator.fill(value, { timeout: 5000 });

    return { ok: true, ref, filled: value };
  },

  /** Type text character by character (for inputs that need keystrokes) */
  "/type": async (params) => {
    if (!page) return { error: "No page open." };

    const ref = params.get("ref");
    const text = params.get("text") || "";
    if (!ref) return { error: "Missing ref parameter" };

    const locator = await findByRef(page, ref);
    await locator.click({ timeout: 5000 });
    await page.keyboard.type(text, { delay: 50 });

    return { ok: true, ref, typed: text };
  },

  /** Press a keyboard key (optionally on a specific element) */
  "/press": async (params) => {
    if (!page) return { error: "No page open." };

    const key = params.get("key") || "Enter";
    const ref = params.get("ref");

    if (ref) {
      const locator = await findByRef(page, ref);
      await locator.press(key);
    } else {
      await page.keyboard.press(key);
    }

    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

    return { ok: true, key, ref: ref || "(page)" };
  },

  /** Select a dropdown option by @eN ref */
  "/select": async (params) => {
    if (!page) return { error: "No page open." };

    const ref = params.get("ref");
    const value = params.get("value");
    if (!ref || !value) return { error: "Missing ref or value parameter" };

    const locator = await findByRef(page, ref);
    await locator.selectOption(value, { timeout: 5000 });

    return { ok: true, ref, selected: value };
  },

  /** Hover over an element */
  "/hover": async (params) => {
    if (!page) return { error: "No page open." };

    const ref = params.get("ref");
    if (!ref) return { error: "Missing ref parameter" };

    const locator = await findByRef(page, ref);
    await locator.hover({ timeout: 5000 });

    return { ok: true, ref };
  },

  /** Scroll the page */
  "/scroll": async (params) => {
    if (!page) return { error: "No page open." };

    const direction = params.get("direction") || "down";
    const amount = parseInt(params.get("amount") || "600");

    if (direction === "down") await page.mouse.wheel(0, amount);
    else if (direction === "up") await page.mouse.wheel(0, -amount);
    else if (direction === "top") await page.evaluate("window.scrollTo(0, 0)");
    else if (direction === "bottom") await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");

    await page.waitForTimeout(500);
    const tree = await getAccessibilityTree(page);

    return { ok: true, direction, amount, elements: tree.length, tree: tree.slice(0, 30) };
  },

  /** Evaluate JavaScript on the page */
  "/eval": async (params) => {
    if (!page) return { error: "No page open." };

    const js = params.get("js");
    if (!js) return { error: "Missing js parameter" };

    const result = await page.evaluate(js);

    return { ok: true, result };
  },

  /** Wait for time or selector */
  "/wait": async (params) => {
    if (!page) return { error: "No page open." };

    const selector = params.get("selector");
    const ms = parseInt(params.get("ms") || "2000");

    if (selector) {
      await page.waitForSelector(selector, { timeout: ms });
      return { ok: true, waited: `selector: ${selector}` };
    } else {
      await page.waitForTimeout(ms);
      return { ok: true, waited: `${ms}ms` };
    }
  },

  /** Get current page info */
  "/info": async () => {
    if (!page) return { error: "No page open." };

    const title = await page.title();
    const url = page.url();
    const viewport = page.viewportSize();
    const cookies = await context.cookies();

    return {
      ok: true,
      title,
      url,
      viewport,
      cookies: cookies.length,
    };
  },

  /** Go back in browser history */
  "/back": async () => {
    if (!page) return { error: "No page open." };

    await page.goBack({ waitUntil: "networkidle", timeout: 10000 });
    const title = await page.title();
    const url = page.url();

    return { ok: true, title, url };
  },

  /** Go forward in browser history */
  "/forward": async () => {
    if (!page) return { error: "No page open." };

    await page.goForward({ waitUntil: "networkidle", timeout: 10000 });
    const title = await page.title();
    const url = page.url();

    return { ok: true, title, url };
  },

  /** Reload the page */
  "/reload": async () => {
    if (!page) return { error: "No page open." };

    await page.reload({ waitUntil: "networkidle", timeout: 15000 });
    const title = await page.title();
    const url = page.url();

    return { ok: true, title, url };
  },

  /** Set viewport size */
  "/viewport": async (params) => {
    if (!page) return { error: "No page open." };

    const width = parseInt(params.get("width") || "1280");
    const height = parseInt(params.get("height") || "720");
    const device = params.get("device");

    if (device === "mobile") {
      await page.setViewportSize({ width: 375, height: 812 });
    } else if (device === "tablet") {
      await page.setViewportSize({ width: 768, height: 1024 });
    } else {
      await page.setViewportSize({ width, height });
    }

    const vp = page.viewportSize();
    return { ok: true, viewport: vp };
  },

  /** Set cookies (for auth) */
  "/cookies": async (params) => {
    if (!context) return { error: "No browser context." };

    const setCookie = params.get("set");
    if (setCookie) {
      // JSON string of cookie array
      const cookies = JSON.parse(setCookie);
      await context.addCookies(cookies);
      return { ok: true, added: cookies.length };
    }

    // Get all cookies
    const cookies = await context.cookies();
    return { ok: true, cookies };
  },

  /** Get console logs from the page */
  "/console": async () => {
    if (!page) return { error: "No page open." };

    // Start collecting console messages
    const logs = [];
    const listener = (msg) => {
      logs.push({ type: msg.type(), text: msg.text() });
    };
    page.on("console", listener);

    // Give it a beat to collect
    await page.waitForTimeout(100);
    page.removeListener("console", listener);

    return { ok: true, logs };
  },

  /** Get network requests (last N) */
  "/network": async (params) => {
    if (!page) return { error: "No page open." };

    const limit = parseInt(params.get("limit") || "20");

    // This returns a snapshot of recent requests via Performance API
    const requests = await page.evaluate((lim) => {
      return performance.getEntriesByType("resource").slice(-lim).map((e) => ({
        name: e.name.slice(0, 120),
        type: e.initiatorType,
        duration: Math.round(e.duration),
        size: e.transferSize || 0,
      }));
    }, limit);

    return { ok: true, total: requests.length, requests };
  },

  /** Close browser and shutdown server */
  "/close": async () => {
    await cleanup();
    setTimeout(() => process.exit(0), 200);
    return { ok: true, message: "Browser closed, server shutting down." };
  },

  /** Health check */
  "/health": async () => {
    return {
      ok: true,
      browser: !!browser,
      page: !!page,
      url: page ? page.url() : null,
      uptime: Math.round(process.uptime()),
      port: PORT,
    };
  },

  /** List all available routes */
  "/": async () => {
    return {
      name: "Alvin Browse Server",
      version: "1.0.0",
      routes: Object.keys(routes).sort(),
      status: {
        browser: !!browser,
        page: !!page,
        url: page ? page.url() : null,
      },
    };
  },
};

// ── HTTP Server ──────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  resetIdle();

  let reqUrl;
  try {
    reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Invalid URL" }));
    return;
  }

  const pathname = reqUrl.pathname;
  const params = reqUrl.searchParams;

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const handler = routes[pathname];
  if (!handler) {
    res.writeHead(404);
    res.end(
      JSON.stringify({
        error: `Unknown route: ${pathname}`,
        available: Object.keys(routes).sort(),
      })
    );
    return;
  }

  const startTime = Date.now();

  try {
    const result = await handler(params);
    const duration = Date.now() - startTime;
    result._ms = duration;

    res.writeHead(200);
    res.end(JSON.stringify(result, null, 2));

    // Compact log
    const summary = result.title ? ` — ${result.title}` : result.path ? ` → ${result.path}` : "";
    console.log(`${pathname} (${duration}ms)${summary}`);
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`❌ ${pathname} (${duration}ms):`, err.message);

    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message, route: pathname }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n🌐 Alvin Browse Server v1.0.0`);
  console.log(`   http://127.0.0.1:${PORT}`);
  console.log(`   ${Object.keys(routes).length} routes available`);
  console.log(`   Auto-shutdown: ${IDLE_TIMEOUT / 60000} min idle\n`);
  resetIdle();
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down...");
  await cleanup();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(0);
});
