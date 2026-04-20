/**
 * v4.13.1 — process-manager abstraction tests.
 *
 * The maintenance section in the Web UI used to hard-wire PM2 commands
 * (`pm2 jlist`, `pm2 restart`, `pm2 stop`, `pm2 logs ...`). Since v4.8
 * the Mac install uses launchd (`com.alvinbot.app.plist`) — PM2 isn't
 * running, so those calls returned "PM2 not available" and the buttons
 * did nothing.
 *
 * This module abstracts the process manager and auto-detects which one
 * is actually managing the bot. Detection order:
 *
 *   1. launchd (macOS) — if `launchctl print gui/$UID/com.alvinbot.app`
 *      succeeds AND the bot's actual running pid matches
 *   2. PM2 — if `pm2 jlist` returns our process
 *   3. standalone — neither detected; only the in-process graceful
 *      restart works (scheduleGracefulRestart — since there's no
 *      supervisor to bring it back, "stop" is effectively "kill")
 *
 * Each manager implements: getStatus(), stop(), start(), getLogs().
 * Restart is intentionally NOT on the manager — it always routes through
 * scheduleGracefulRestart() (Grammy-safe) and the supervisor auto-brings-
 * back behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

interface ExecCall {
  cmd: string;
  opts?: unknown;
}

let execLog: ExecCall[] = [];
let execReturn: Record<string, string | Error> = {};

function stubExec() {
  vi.doMock("node:child_process", () => ({
    execSync: (cmd: string, opts?: unknown) => {
      execLog.push({ cmd, opts });
      // Find match by pattern — longest matching prefix wins
      const matches = Object.keys(execReturn).filter((k) => cmd.includes(k));
      matches.sort((a, b) => b.length - a.length);
      const key = matches[0];
      if (key) {
        const v = execReturn[key];
        if (v instanceof Error) throw v;
        return v;
      }
      throw new Error(`execSync: no stub for ${cmd}`);
    },
  }));
}

beforeEach(() => {
  execLog = [];
  execReturn = {};
  vi.resetModules();
  stubExec();
});

afterEach(() => {
  vi.doUnmock("node:child_process");
});

describe("detectProcessManager (v4.13.1)", () => {
  it("detects 'launchd' when launchctl print succeeds on darwin", async () => {
    execReturn["launchctl print"] = `gui/502/com.alvinbot.app = {
      state = running
      program = /opt/homebrew/bin/node
    }`;
    const mod = await import("../src/services/process-manager.js");
    const pm = mod.detectProcessManager({ platform: "darwin" });
    expect(pm.kind).toBe("launchd");
  });

  it("falls through to 'pm2' when launchd is not detected", async () => {
    execReturn["launchctl print"] = new Error("Could not find service");
    execReturn["pm2 jlist"] = JSON.stringify([
      { name: "alvin-bot", pid: 1234, pm2_env: { status: "online" } },
    ]);
    const mod = await import("../src/services/process-manager.js");
    const pm = mod.detectProcessManager({ platform: "linux" });
    expect(pm.kind).toBe("pm2");
  });

  it("falls through to 'standalone' when neither is detected", async () => {
    execReturn["launchctl print"] = new Error("not found");
    execReturn["pm2 jlist"] = new Error("command not found");
    const mod = await import("../src/services/process-manager.js");
    const pm = mod.detectProcessManager({ platform: "linux" });
    expect(pm.kind).toBe("standalone");
  });

  it("skips launchd detection on non-darwin platforms", async () => {
    // No launchctl command should be issued on Linux
    execReturn["pm2 jlist"] = JSON.stringify([
      { name: "alvin-bot", pid: 1234, pm2_env: { status: "online" } },
    ]);
    const mod = await import("../src/services/process-manager.js");
    const pm = mod.detectProcessManager({ platform: "linux" });
    expect(pm.kind).toBe("pm2");
    // Verify launchctl was NOT called
    expect(execLog.some((e) => e.cmd.includes("launchctl"))).toBe(false);
  });
});

describe("launchd process manager (v4.13.1)", () => {
  it("getStatus parses launchctl print output for state + PID", async () => {
    execReturn["launchctl print"] = `gui/502/com.alvinbot.app = {
      active count = 1
      state = running
      program = /opt/homebrew/Cellar/node/25.9.0_1/bin/node
      pid = 65432
      program path = /usr/bin/node
      working directory = /Users/alvin_de/Projects/alvin-bot
      stdout path = /Users/alvin_de/.alvin-bot/logs/alvin-bot.out.log
    }`;
    const mod = await import("../src/services/process-manager.js");
    const pm = mod.createLaunchdManager(502);
    const status = await pm.getStatus();
    expect(status.status).toBe("running");
    expect(status.pid).toBe(65432);
    expect(status.kind).toBe("launchd");
  });

  it("getStatus returns 'not-loaded' when service is not registered", async () => {
    execReturn["launchctl print"] = new Error("Could not find service");
    const mod = await import("../src/services/process-manager.js");
    const pm = mod.createLaunchdManager(502);
    const status = await pm.getStatus();
    expect(status.status).toBe("not-loaded");
  });

  it("stop uses launchctl bootout", async () => {
    execReturn["launchctl bootout"] = "";
    const mod = await import("../src/services/process-manager.js");
    const pm = mod.createLaunchdManager(502);
    await pm.stop();
    const stopCall = execLog.find((e) => e.cmd.includes("bootout"));
    expect(stopCall).toBeDefined();
    expect(stopCall!.cmd).toContain("gui/502/com.alvinbot.app");
  });

  it("start uses launchctl bootstrap", async () => {
    execReturn["launchctl bootstrap"] = "";
    const mod = await import("../src/services/process-manager.js");
    const pm = mod.createLaunchdManager(502);
    await pm.start();
    const startCall = execLog.find((e) => e.cmd.includes("bootstrap"));
    expect(startCall).toBeDefined();
    expect(startCall!.cmd).toMatch(/com\.alvinbot\.app\.plist/);
  });
});

describe("pm2 process manager (v4.13.1)", () => {
  it("getStatus parses pm2 jlist for our process", async () => {
    execReturn["pm2 jlist"] = JSON.stringify([
      {
        name: "alvin-bot",
        pid: 9999,
        pm2_env: {
          status: "online",
          pm_uptime: Date.now() - 60_000,
          restart_time: 2,
        },
        monit: { memory: 123456, cpu: 1.5 },
      },
    ]);
    const mod = await import("../src/services/process-manager.js");
    const pm = mod.createPm2Manager();
    const status = await pm.getStatus();
    expect(status.status).toBe("online");
    expect(status.pid).toBe(9999);
    expect(status.kind).toBe("pm2");
    expect(status.restarts).toBe(2);
  });

  it("getStatus returns 'unknown' if pm2 jlist does not include our process", async () => {
    execReturn["pm2 jlist"] = JSON.stringify([
      { name: "other-service", pid: 1111, pm2_env: { status: "online" } },
    ]);
    const mod = await import("../src/services/process-manager.js");
    const pm = mod.createPm2Manager();
    const status = await pm.getStatus();
    expect(status.status).toBe("unknown");
  });
});
