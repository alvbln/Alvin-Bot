/**
 * Fix #1 — Web server must release port on shutdown.
 *
 * Regression: on bot restart the previous http.Server kept listening on
 * :3100 (because shutdown() never called server.close()). launchd then
 * restarted the bot, the next boot tried server.listen(3100), hit
 * EADDRINUSE, and the bot crashed uncaught. Crash-loop.
 *
 * Contract we're establishing:
 *   - src/web/server.ts must export `stopWebServer(server, opts?)`
 *   - It must resolve once `server.close()` finishes.
 *   - It must force-close idle/active sockets so close() can't hang
 *     forever (otherwise shutdown would block on the 5s launchd grace).
 *   - After stopWebServer() returns, a fresh http.Server must be able
 *     to listen(port) on the same port without EADDRINUSE.
 */
import { describe, it, expect } from "vitest";
import http from "http";
import { once } from "events";
// Fix #1 shipped as stopWebServer(server) — Fix #16 (v4.9.4) promoted
// that to `closeHttpServerGracefully(server)` and reserved the name
// `stopWebServer()` for the module-state-aware shutdown. The underlying
// contract (close an http.Server even when clients hold open sockets,
// release the port, idempotent, never throw) is unchanged — these
// tests now exercise the renamed helper.
import { closeHttpServerGracefully as stopWebServer } from "../src/web/server.js";

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

describe("stopWebServer (Fix #1)", () => {
  it("closes an http.Server so the port becomes reusable", async () => {
    const port = await getFreePort();

    const server = http.createServer((_req, res) => {
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(port, () => r()));

    // Hold an open idle keep-alive socket — this is the exact state that
    // prevented server.close() from resolving in production. A real
    // stopWebServer() must break this stall.
    const hanger = http.get(`http://127.0.0.1:${port}/`, () => { /* body */ });
    await once(hanger, "response").catch(() => { /* swallow */ });

    const t0 = Date.now();
    await stopWebServer(server);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(2000);

    // Prove the port is actually free: a new server must be able to bind it.
    const reuse = http.createServer();
    await new Promise<void>((resolve, reject) => {
      reuse.once("error", reject);
      reuse.listen(port, () => resolve());
    });
    await new Promise<void>((r) => reuse.close(() => r()));
  });

  it("is safe to call on an already-closed server", async () => {
    const port = await getFreePort();
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(port, () => r()));
    await stopWebServer(server);
    // Calling twice must not throw
    await expect(stopWebServer(server)).resolves.toBeUndefined();
  });

  it("is safe to call on a server that never listened", async () => {
    const server = http.createServer();
    await expect(stopWebServer(server)).resolves.toBeUndefined();
  });

  it("closes even when a client is holding a long-lived connection", async () => {
    // Production-mirror: a long-polling /api/cron?wait=1 or similar.
    // Before the fix, server.close() would hang on these sockets and the
    // 5s launchd grace would kill the bot before the port was released.
    const port = await getFreePort();
    const server = http.createServer((_req, res) => {
      // Never send a full response — keep the socket open until close.
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("chunk-1");
      // intentionally do NOT call res.end()
    });
    await new Promise<void>((r) => server.listen(port, () => r()));

    const req = http.get(`http://127.0.0.1:${port}/hang`);
    // Swallow the inevitable socket-close error once the server is torn down
    req.on("error", () => { /* expected */ });
    await once(req, "response").catch(() => { /* swallow */ });

    const t0 = Date.now();
    await stopWebServer(server);
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
