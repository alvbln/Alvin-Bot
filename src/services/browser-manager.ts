/**
 * Multi-Strategy Browser Manager — with automatic fallback chain.
 *
 * Strategy priority:
 *   1. Gateway (browse-server.cjs HTTP server) — if script exists and is running
 *   2. CDP (Chrome DevTools Protocol) — via hub browser.sh cdp, persistent cookies
 *   3. Hub Stealth (Playwright + stealth plugin) — via hub browser.sh stealth
 *   4. Raw CLI (bare Playwright) — last resort, easily blocked
 *
 * If a strategy is unavailable, we automatically cascade to the next one
 * and log a warning so failures are visible, not silent.
 */

import { execSync, spawn, ChildProcess } from "child_process";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { config } from "../config.js";
import { BROWSE_SERVER_SCRIPT, HUB_BROWSER_SH } from "../paths.js";
import { hasPlaywright, screenshotUrl, extractText, generatePdf } from "./browser.js";
import { webfetchNavigate, WebfetchFailed } from "./browser-webfetch.js";
import * as cdpBootstrap from "./cdp-bootstrap.js";

/**
 * Browser strategies — ordered from cheapest (webfetch, pure HTTP, no
 * browser process) to heaviest (raw Playwright CLI). The Fallback
 * cascade in resolveStrategy() always starts from the requested tier
 * and walks DOWN the priority list if a cheaper one isn't available.
 */
export type BrowserStrategy = "webfetch" | "gateway" | "cdp" | "hub-stealth" | "cli";

const CDP_PORT = 9222;
const EXEC_TIMEOUT = 60_000; // 60s for page loads via shell

export interface BrowserTask {
  interactive?: boolean;
  multiStep?: boolean;
  useUserBrowser?: boolean;
}

export interface PageInfo {
  title: string;
  url: string;
  elements?: number;
  tree?: string[];
}

// ── Logging ──────────────────────────────────────────────────────────

function log(msg: string): void {
  console.warn(`[browser-manager] ${msg}`);
}

// ── Availability Checks ──────────────────────────────────────────────

function isGatewayScriptPresent(): boolean {
  return fs.existsSync(BROWSE_SERVER_SCRIPT);
}

async function isGatewayRunning(): Promise<boolean> {
  try {
    const health = await gatewayRequest("/health");
    return !!health?.ok;
  } catch {
    return false;
  }
}

function isHubBrowserAvailable(): boolean {
  return fs.existsSync(HUB_BROWSER_SH);
}

async function isCDPAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(res.statusCode === 200));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ── Strategy Selection with Fallback ─────────────────────────────────

/** Pick the preferred strategy based on task type.
 *
 *  Default for a one-shot read is `webfetch` — the cheapest tier. It
 *  only fails on JS-heavy or bot-guarded pages, and the cascade in
 *  resolveStrategy() handles the upgrade path automatically.
 */
export function selectStrategy(task: BrowserTask = {}): BrowserStrategy {
  if (task.useUserBrowser || config.cdpUrl) return "cdp";
  if (task.interactive || task.multiStep) return "gateway";
  return "webfetch";
}

/**
 * Resolve the preferred strategy to one that's actually available.
 *
 * Cascade order:
 *   webfetch → hub-stealth → cdp → gateway → cli
 *
 * Rationale:
 *   - `webfetch` is a plain HTTP GET — instant, zero footprint.
 *   - `hub-stealth` (playwright+stealth) handles JS-rendered pages
 *     without a persistent browser process.
 *   - `cdp` brings cookies/auth for login-walled sites.
 *   - `gateway` exposes the multi-step HTTP API (ref-based ops, long
 *     sessions) when the browse-server.cjs helper is available.
 *   - `cli` (raw Playwright) is the last-resort fallback.
 */
export async function resolveStrategy(preferred: BrowserStrategy): Promise<BrowserStrategy> {
  const chain: BrowserStrategy[] = [];

  // Build fallback chain starting from preferred. webfetch and
  // hub-stealth are always available (no external state check), so
  // they're included as floor entries. CDP/gateway only get in if the
  // caller asked for them explicitly, since they need running daemons.
  switch (preferred) {
    case "webfetch":
      chain.push("webfetch", "hub-stealth", "cli");
      break;
    case "gateway":
      chain.push("gateway", "cdp", "hub-stealth", "webfetch", "cli");
      break;
    case "cdp":
      chain.push("cdp", "hub-stealth", "webfetch", "cli");
      break;
    case "hub-stealth":
      chain.push("hub-stealth", "webfetch", "cli");
      break;
    case "cli":
      chain.push("cli");
      break;
  }

  for (const strategy of chain) {
    switch (strategy) {
      case "webfetch":
        // Native fetch is always present on Node ≥ 18 — no availability
        // probe needed. Each call is self-contained, so we return the
        // strategy tag and let navigate() handle per-call errors.
        return "webfetch";

      case "gateway":
        if (isGatewayScriptPresent() && (await isGatewayRunning())) return "gateway";
        if (!isGatewayScriptPresent()) {
          log("Gateway unavailable: browse-server.cjs not found. Falling back.");
        } else {
          log("Gateway not running. Falling back.");
        }
        break;

      case "cdp":
        if (await isCDPAvailable()) return "cdp";
        // Bot-owned bootstrap is the primary path — works for every install,
        // no Hub dependency, no conflict with user's own Chrome.
        try {
          log("CDP not running — starting bot-managed Chromium via cdp-bootstrap...");
          await cdpBootstrap.ensureRunning({ mode: "headless" });
          if (await isCDPAvailable()) {
            log("CDP bootstrap started successfully.");
            return "cdp";
          }
        } catch (err) {
          log(`CDP bootstrap failed: ${(err as Error).message}`);
        }
        // Dev-only fallback: maintainer Hub script, if present
        if (isHubBrowserAvailable()) {
          try {
            log("Trying Hub script as fallback...");
            execSync(`"${HUB_BROWSER_SH}" cdp start headless`, {
              stdio: "pipe",
              timeout: 15_000,
            });
            await new Promise((r) => setTimeout(r, 3000));
            if (await isCDPAvailable()) {
              log("CDP via Hub script.");
              return "cdp";
            }
          } catch (err) {
            log(`Hub script fallback failed: ${(err as Error).message}`);
          }
        }
        log("CDP unavailable. Falling back.");
        break;

      case "hub-stealth":
        if (isHubBrowserAvailable()) return "hub-stealth";
        log("Hub browser.sh not found. Falling back to raw Playwright.");
        break;

      case "cli":
        return "cli"; // Always available as last resort
    }
  }

  return "cli";
}

// ── Hub Script Execution ─────────────────────────────────────────────

interface HubResult {
  title?: string;
  url?: string;
  html_length?: number;
  screenshot?: string;
  error?: string;
  [key: string]: unknown;
}

function execHub(args: string): HubResult | null {
  try {
    const result = execSync(`"${HUB_BROWSER_SH}" ${args}`, {
      stdio: "pipe",
      timeout: EXEC_TIMEOUT,
      env: { ...process.env, PATH: process.env.PATH },
    });
    const stdout = result.toString().trim();
    // Try to parse as JSON (stealth outputs JSON)
    try {
      return JSON.parse(stdout);
    } catch {
      // Not JSON — return as raw text
      return { title: "", url: "", raw: stdout } as unknown as HubResult;
    }
  } catch (err) {
    const error = err as { stderr?: Buffer; message: string };
    log(`Hub script failed: ${error.stderr?.toString()?.trim() || error.message}`);
    return null;
  }
}

// ── Gateway Management ───────────────────────────────────────────────

let gatewayProcess: ChildProcess | null = null;

async function gatewayRequest(
  urlPath: string,
  params: Record<string, string> = {},
  timeoutMs = 15_000
): Promise<any> {
  const query = new URLSearchParams(params).toString();
  const url = `http://127.0.0.1:${config.browseServerPort}${urlPath}${query ? "?" + query : ""}`;

  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON from gateway: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Gateway request timed out after ${timeoutMs}ms: ${urlPath}`));
    });
  });
}

async function ensureGateway(): Promise<boolean> {
  // Check if already running
  if (await isGatewayRunning()) return true;

  // Try to start it
  if (!isGatewayScriptPresent()) {
    log("Cannot start gateway: browse-server.cjs not found.");
    return false;
  }

  gatewayProcess = spawn("node", [BROWSE_SERVER_SCRIPT, String(config.browseServerPort)], {
    stdio: "pipe",
    detached: false,
  });

  gatewayProcess.on("exit", () => {
    gatewayProcess = null;
  });

  // Wait for startup (max 10s)
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isGatewayRunning()) return true;
  }

  log("Gateway failed to start within 10s.");
  return false;
}

// ── Unified Operations ───────────────────────────────────────────────

/** Navigate to URL using best available strategy.
 *
 *  Error-based cascade: if the chosen tier throws, we walk DOWN the
 *  priority chain until one succeeds or we exhaust the list. This lets
 *  a 403 from webfetch transparently upgrade to hub-stealth without
 *  callers having to know about the fallback graph.
 */
export async function navigate(url: string, task: BrowserTask = {}): Promise<PageInfo> {
  const primary = await resolveStrategy(selectStrategy(task));
  log(`navigate(${url}) using strategy: ${primary}`);

  // Try primary, then hub-stealth as a universal fallback. We keep the
  // fallback list short here to avoid cascading timeouts — the full
  // cascade is only for resolveStrategy's availability check.
  const attempt = async (strategy: BrowserStrategy): Promise<PageInfo> => {
    return navigateOne(strategy, url);
  };

  try {
    return await attempt(primary);
  } catch (err) {
    log(`navigate(${url}) ${primary} failed: ${(err as Error).message}`);
    if (primary === "webfetch") {
      // Webfetch is the most common tier and the most common to hit a
      // bot guard — cascade to hub-stealth explicitly, then cli.
      try {
        return await attempt("hub-stealth");
      } catch (err2) {
        log(`navigate(${url}) hub-stealth fallback failed: ${(err2 as Error).message}`);
        return await attempt("cli");
      }
    }
    throw err;
  }
}

/** Single-strategy navigate — no fallback logic, just do the thing. */
async function navigateOne(strategy: BrowserStrategy, url: string): Promise<PageInfo> {
  switch (strategy) {
    case "webfetch": {
      try {
        const r = await webfetchNavigate(url);
        return { title: r.title, url: r.url };
      } catch (err) {
        if (err instanceof WebfetchFailed) throw err;
        throw new WebfetchFailed(url, (err as Error).message, { cause: err });
      }
    }

    case "gateway": {
      await ensureGateway();
      return gatewayRequest("/navigate", { url });
    }

    case "cdp": {
      // Try hub CDP first
      if (isHubBrowserAvailable()) {
        const result = execHub(`cdp goto "${url}"`);
        if (result && !result.error) {
          return { title: result.title || "", url: result.url || url };
        }
      }
      // Fallback: direct Playwright CDP
      try {
        const { chromium } = await import("playwright");
        const browser = await chromium.connectOverCDP(config.cdpUrl || `http://127.0.0.1:${CDP_PORT}`);
        const contexts = browser.contexts();
        const page =
          contexts[0]?.pages()[0] || (await contexts[0]?.newPage()) || (await browser.newPage());
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        const title = await page.title();
        return { title, url: page.url() };
      } catch (err) {
        log(`Direct CDP failed: ${(err as Error).message}`);
        // Last resort: try stealth
        if (isHubBrowserAvailable()) {
          const stealthResult = execHub(`stealth "${url}"`);
          if (stealthResult) {
            return { title: stealthResult.title || "", url: stealthResult.url || url };
          }
        }
        throw err;
      }
    }

    case "hub-stealth": {
      const result = execHub(`stealth "${url}"`);
      if (result && !result.error) {
        return { title: result.title || "", url: result.url || url };
      }
      // Fallback to raw CLI
      log("Hub stealth failed, falling back to raw Playwright.");
      const text = await extractText(url);
      return { title: url, url, tree: [text.slice(0, 500)] };
    }

    case "cli":
    default: {
      const text = await extractText(url);
      return { title: url, url, tree: [text.slice(0, 500)] };
    }
  }
}

/** Take a screenshot */
export async function screenshot(
  url: string,
  options: { fullPage?: boolean } = {}
): Promise<string> {
  const strategy = await resolveStrategy(selectStrategy());
  log(`screenshot(${url}) using strategy: ${strategy}`);

  switch (strategy) {
    case "gateway": {
      await ensureGateway();
      if (url) await gatewayRequest("/navigate", { url });
      const result = await gatewayRequest(
        "/screenshot",
        options.fullPage ? { full: "true" } : {}
      );
      return result.path;
    }

    case "cdp": {
      if (isHubBrowserAvailable()) {
        const tmpName = `shot_${Date.now()}.png`;
        const result = execHub(`cdp shot "${url}" ${tmpName}`);
        if (result?.screenshot) return result.screenshot;
      }
      // Fallback to raw Playwright
      return screenshotUrl(url, { fullPage: options.fullPage });
    }

    case "hub-stealth": {
      const tmpName = `shot_${Date.now()}.png`;
      const result = execHub(`stealth "${url}" --screenshot=${tmpName}`);
      if (result?.screenshot) return result.screenshot;
      // Fallback
      return screenshotUrl(url, { fullPage: options.fullPage });
    }

    case "cli":
    default:
      return screenshotUrl(url, { fullPage: options.fullPage });
  }
}

// ── CDP Direct-Playwright Helper ─────────────────────────────────────
// Used as fallback when the gateway isn't running but CDP Chrome is.
// Each call opens a short-lived CDP connection, operates on the newest
// existing page in the current context (keeps Chrome itself alive), and
// disconnects. Safe for sub-agents that need a single op at a time.

async function withCdpPage<T>(
  fn: (page: import("playwright").Page) => Promise<T>
): Promise<T> {
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP(
    config.cdpUrl || `http://127.0.0.1:${CDP_PORT}`
  );
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("No CDP contexts available — is Chrome CDP running?");
    const pages = context.pages();
    const page = pages[pages.length - 1] || (await context.newPage());
    return await fn(page);
  } finally {
    await browser.close(); // Closes CDP connection, not Chrome itself
  }
}

const NEEDS_INTERACTIVE_HINT =
  "Start CDP: alvin-bot browser start (headless by default)";

/**
 * Get accessibility tree (gateway preferred, CDP fallback returns outerHTML).
 * The @eN ref model only exists in the gateway; under CDP we return a
 * best-effort DOM snippet instead so callers can still see what's there.
 */
export async function getTree(limit = 100): Promise<{ tree: string[]; total: number }> {
  if (await isGatewayRunning()) {
    return gatewayRequest("/tree", { limit: String(limit) });
  }
  if (await isCDPAvailable()) {
    return withCdpPage(async (page) => {
      const elements = await page.$$eval(
        "a, button, input, select, textarea, [role=button], [role=link]",
        (els, max) =>
          els.slice(0, max).map((el, i) => {
            const tag = el.tagName.toLowerCase();
            const text = (el.textContent || "").trim().slice(0, 60);
            const id = el.id ? `#${el.id}` : "";
            const name = (el as HTMLInputElement).name
              ? `[name=${(el as HTMLInputElement).name}]`
              : "";
            return `@e${i + 1} <${tag}${id}${name}> "${text}"`;
          }),
        limit
      );
      return { tree: elements, total: elements.length };
    });
  }
  throw new Error(`[browser-manager] getTree requires gateway or CDP. ${NEEDS_INTERACTIVE_HINT}`);
}

/**
 * Click an element. Accepts a gateway ref (@eN → "eN") when gateway is
 * running, or a CSS selector when only CDP is available.
 */
export async function click(refOrSelector: string): Promise<PageInfo> {
  if (await isGatewayRunning()) {
    return gatewayRequest("/click", { ref: refOrSelector });
  }
  if (await isCDPAvailable()) {
    return withCdpPage(async (page) => {
      await page.click(refOrSelector, { timeout: 10_000 });
      return { title: await page.title(), url: page.url() };
    });
  }
  throw new Error(`[browser-manager] click() requires gateway or CDP. ${NEEDS_INTERACTIVE_HINT}`);
}

/** Fill an input. refOrSelector semantics match click(). */
export async function fill(refOrSelector: string, value: string): Promise<void> {
  if (await isGatewayRunning()) {
    await gatewayRequest("/fill", { ref: refOrSelector, value });
    return;
  }
  if (await isCDPAvailable()) {
    await withCdpPage(async (page) => {
      await page.fill(refOrSelector, value, { timeout: 10_000 });
    });
    return;
  }
  throw new Error(`[browser-manager] fill() requires gateway or CDP. ${NEEDS_INTERACTIVE_HINT}`);
}

/** Type text character-by-character (for inputs that reject page.fill). */
export async function type(refOrSelector: string, text: string): Promise<void> {
  if (await isGatewayRunning()) {
    await gatewayRequest("/type", { ref: refOrSelector, text });
    return;
  }
  if (await isCDPAvailable()) {
    await withCdpPage(async (page) => {
      await page.type(refOrSelector, text, { timeout: 10_000 });
    });
    return;
  }
  throw new Error(`[browser-manager] type() requires gateway or CDP. ${NEEDS_INTERACTIVE_HINT}`);
}

/** Press a keyboard key (page-level if no ref, element-level with ref). */
export async function press(key: string, refOrSelector?: string): Promise<void> {
  if (await isGatewayRunning()) {
    await gatewayRequest("/press", refOrSelector ? { key, ref: refOrSelector } : { key });
    return;
  }
  if (await isCDPAvailable()) {
    await withCdpPage(async (page) => {
      if (refOrSelector) {
        await page.locator(refOrSelector).press(key, { timeout: 10_000 });
      } else {
        await page.keyboard.press(key);
      }
    });
    return;
  }
  throw new Error(`[browser-manager] press() requires gateway or CDP. ${NEEDS_INTERACTIVE_HINT}`);
}

/** Scroll page. CDP fallback uses window.scrollBy. */
export async function scroll(direction: string, amount = 600): Promise<PageInfo> {
  if (await isGatewayRunning()) {
    return gatewayRequest("/scroll", { direction, amount: String(amount) });
  }
  if (await isCDPAvailable()) {
    return withCdpPage(async (page) => {
      const delta =
        direction === "up" ? -amount :
        direction === "top" ? -1e9 :
        direction === "bottom" ? 1e9 :
        amount;
      await page.evaluate((d) => window.scrollBy(0, d), delta);
      return { title: await page.title(), url: page.url() };
    });
  }
  throw new Error(`[browser-manager] scroll() requires gateway or CDP. ${NEEDS_INTERACTIVE_HINT}`);
}

/** Evaluate JS in the page context. */
export async function evaluate(js: string): Promise<unknown> {
  if (await isGatewayRunning()) {
    const result = await gatewayRequest("/eval", { js });
    return result.result;
  }
  if (await isCDPAvailable()) {
    return withCdpPage(async (page) => {
      // `page.evaluate(fn)` wraps a function — we need eval of a raw
      // expression string, so wrap in an IIFE.
      return page.evaluate(new Function(`return (${js})`) as () => unknown);
    });
  }
  throw new Error(`[browser-manager] evaluate() requires gateway or CDP. ${NEEDS_INTERACTIVE_HINT}`);
}

/** Generate PDF from URL */
export async function pdf(url: string): Promise<string> {
  return generatePdf(url);
}

/** Close browser / stop gateway */
export async function close(): Promise<void> {
  try {
    await gatewayRequest("/close");
  } catch {}
  if (gatewayProcess) {
    gatewayProcess.kill();
    gatewayProcess = null;
  }
}

/** Get current page info (gateway preferred, CDP fallback reads newest page). */
export async function info(): Promise<PageInfo> {
  if (await isGatewayRunning()) {
    return gatewayRequest("/info");
  }
  if (await isCDPAvailable()) {
    return withCdpPage(async (page) => ({
      title: await page.title(),
      url: page.url(),
    }));
  }
  throw new Error(`[browser-manager] info() requires gateway or CDP. ${NEEDS_INTERACTIVE_HINT}`);
}
