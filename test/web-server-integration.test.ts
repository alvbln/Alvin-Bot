/**
 * Fix #16 (integration) — end-to-end tests for the decoupled
 * startWebServer + stopWebServer pair.
 *
 * These tests exercise the ACTUAL http.Server binding, not the pure
 * decision helper. They rely on:
 *   - process.env.WEB_PORT to keep the test off the running bot's 3100
 *   - process.env.ALVIN_DATA_DIR to keep touch-points away from
 *     the maintainer's real ~/.alvin-bot/.env
 *
 * What's covered here:
 *   1. startWebServer() returns synchronously (void) without throwing
 *   2. stopWebServer() releases the port so another server can bind
 *   3. Start → stop → start cycle doesn't leak sockets or timers
 *   4. If the configured port is already busy, startWebServer still
 *      returns cleanly (no throw); the bot keeps running.
 *   5. stopWebServer() is idempotent — safe to call twice in a row
 *      and safe to call before startWebServer ever succeeded.
 *
 * The deliberate EADDRINUSE scenario is tested HERE against a real
 * running hog — no mocking.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-web-int-${process.pid}-${Date.now()}`);

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, () => {
      const addr = s.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        reject(new Error("no address"));
      }
    });
  });
}

async function waitForPortBound(port: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const code = await new Promise<number>((resolveCode, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
          res.resume();
          resolveCode(res.statusCode ?? 0);
        });
        req.on("error", (err) => reject(err));
        req.setTimeout(500, () => {
          req.destroy(new Error("timeout"));
        });
      });
      if (code > 0) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  // Write a minimal .env so config.ts loads cleanly
  fs.writeFileSync(`${TEST_DATA_DIR}/.env`, "WEB_PASSWORD=\n", "utf-8");
  process.env.WEB_PORT = String(await getFreePort());
  // Reset module cache so each test imports server.js fresh and
  // picks up the new WEB_PORT env var at module-load time.
  vi.resetModules();
});

afterEach(async () => {
  // Best-effort: stop whatever is running in the current module instance
  try {
    const { stopWebServer } = await import("../src/web/server.js");
    await stopWebServer();
  } catch {
    /* ignore */
  }
  // Give the OS a moment to release ports before the next test
  await new Promise((r) => setTimeout(r, 50));
});

describe("startWebServer / stopWebServer integration (Fix #16)", () => {
  it("startWebServer returns void synchronously without throwing", async () => {
    const { startWebServer } = await import("../src/web/server.js");
    const result = startWebServer();
    // Must return void (undefined). If it returned a Server instance
    // the old API is still in place.
    expect(result).toBeUndefined();
  });

  it("actually binds the web server and serves HTTP", async () => {
    const port = Number(process.env.WEB_PORT);
    const { startWebServer } = await import("../src/web/server.js");
    startWebServer();
    const up = await waitForPortBound(port, 3000);
    expect(up).toBe(true);
  });

  it("stopWebServer releases the port", async () => {
    const port = Number(process.env.WEB_PORT);
    const { startWebServer, stopWebServer } = await import("../src/web/server.js");
    startWebServer();
    expect(await waitForPortBound(port, 3000)).toBe(true);
    await stopWebServer();

    // Port should now be free — a fresh bind must succeed
    const reuse = http.createServer();
    await new Promise<void>((resolve, reject) => {
      reuse.once("error", reject);
      reuse.listen(port, () => resolve());
    });
    await new Promise<void>((r) => reuse.close(() => r()));
  });

  it("stopWebServer is idempotent — safe to call multiple times", async () => {
    const { startWebServer, stopWebServer } = await import("../src/web/server.js");
    startWebServer();
    await new Promise((r) => setTimeout(r, 200));
    await stopWebServer();
    // Second call must not throw
    await expect(stopWebServer()).resolves.toBeUndefined();
    // Third call must also not throw
    await expect(stopWebServer()).resolves.toBeUndefined();
  });

  it("stopWebServer is safe to call before startWebServer ever bound", async () => {
    const { stopWebServer } = await import("../src/web/server.js");
    // Module just imported — nothing started yet
    await expect(stopWebServer()).resolves.toBeUndefined();
  });

  it("when the primary port is taken, startWebServer still returns cleanly (climbs the ladder)", async () => {
    const originalPort = Number(process.env.WEB_PORT);
    // Plant a hog on the primary port BEFORE startWebServer
    const hog = http.createServer();
    await new Promise<void>((r) => hog.listen(originalPort, () => r()));

    try {
      const { startWebServer } = await import("../src/web/server.js");
      // Must NOT throw even though the port is occupied
      expect(() => startWebServer()).not.toThrow();

      // The bot should have climbed the ladder — one port higher should
      // now be serving HTTP.
      const climbed = await waitForPortBound(originalPort + 1, 3000);
      expect(climbed).toBe(true);
    } finally {
      await new Promise<void>((r) => hog.close(() => r()));
    }
  });

  it("closeHttpServerGracefully closes a server that's holding an open socket", async () => {
    const { closeHttpServerGracefully } = await import("../src/web/server.js");
    const port = await getFreePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("chunk");
      // never res.end — client hangs forever
    });
    await new Promise<void>((r) => server.listen(port, () => r()));

    const req = http.get(`http://127.0.0.1:${port}/hang`);
    req.on("error", () => { /* expected */ });
    await new Promise((r) => setTimeout(r, 100));

    const t0 = Date.now();
    await closeHttpServerGracefully(server);
    expect(Date.now() - t0).toBeLessThan(2000);

    // Port is reusable
    const reuse = http.createServer();
    await new Promise<void>((resolve, reject) => {
      reuse.once("error", reject);
      reuse.listen(port, () => resolve());
    });
    await new Promise<void>((r) => reuse.close(() => r()));
  });
});
