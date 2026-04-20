/**
 * v4.13.1 — Process manager abstraction for the Maintenance Web UI.
 *
 * History: the bot was originally PM2-managed. Since v4.8 the macOS
 * install uses launchd (`com.alvinbot.app.plist`). The WebUI
 * Maintenance section kept calling `pm2 jlist`/`pm2 restart`/...
 * which returned "PM2 not available" for launchd users — all status,
 * stop, start, and logs buttons were broken.
 *
 * This module auto-detects the active manager per request and
 * routes commands accordingly:
 *
 *   - launchd (macOS) — via `launchctl print` / `bootout` / `bootstrap`
 *   - pm2 (VPS / Linux) — via `pm2 jlist` / `pm2 stop` / `pm2 start`
 *   - standalone — no supervisor; only `scheduleGracefulRestart` works
 *
 * Restart is NOT on this interface — it always uses
 * `scheduleGracefulRestart` (Grammy-safe) and relies on whichever
 * supervisor is present to bring the process back. For "standalone",
 * a restart effectively kills the process and the user has to run it
 * again manually (we warn in the UI).
 */
import { execSync } from "node:child_process";
import os from "node:os";
import { resolve } from "node:path";

export type ProcessKind = "launchd" | "pm2" | "standalone";

export interface ProcessStatus {
  kind: ProcessKind;
  /**
   * Human-readable status. launchd: "running" | "not-loaded" | "unknown"
   * pm2: "online" | "stopped" | "errored" | "unknown"
   * standalone: "running" (by definition — we're answering the request)
   */
  status: string;
  pid?: number;
  uptime?: number;
  memory?: number;
  cpu?: number;
  restarts?: number;
  version?: string;
  nodeVersion?: string;
  execPath?: string;
  cwd?: string;
}

export interface ProcessManager {
  kind: ProcessKind;
  getStatus(): Promise<ProcessStatus>;
  stop(): Promise<void>;
  start(): Promise<void>;
  getLogs(lines?: number): Promise<string>;
}

const LAUNCHD_LABEL = "com.alvinbot.app";
const LAUNCHD_PLIST = resolve(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);
const PM2_NAME = "alvin-bot";

// ── Detection ───────────────────────────────────────────────────

export function detectProcessManager(
  opts: { platform?: NodeJS.Platform; uid?: number } = {},
): ProcessManager {
  const platform = opts.platform ?? process.platform;
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);

  // Only try launchd on macOS
  if (platform === "darwin") {
    try {
      const out = execSync(
        `launchctl print gui/${uid}/${LAUNCHD_LABEL}`,
        { encoding: "utf-8", timeout: 3000, stdio: "pipe" },
      );
      if (out && out.length > 0) {
        return createLaunchdManager(uid);
      }
    } catch {
      // Not loaded in launchd — fall through
    }
  }

  // PM2 fallback (Linux VPS, or Mac installs that stayed on PM2)
  try {
    const out = execSync("pm2 jlist", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: "pipe",
    });
    const parsed = JSON.parse(out) as Array<{ name?: string }>;
    if (
      Array.isArray(parsed) &&
      parsed.some((p) => p?.name === PM2_NAME)
    ) {
      return createPm2Manager();
    }
  } catch {
    // pm2 not installed or didn't report our process
  }

  return createStandaloneManager();
}

// ── launchd ─────────────────────────────────────────────────────

interface LaunchdPrintFields {
  state?: string;
  pid?: number;
  program?: string;
  cwd?: string;
}

function parseLaunchdPrint(text: string): LaunchdPrintFields {
  const out: LaunchdPrintFields = {};
  // state = running
  const stateMatch = text.match(/\bstate\s*=\s*(\S+)/);
  if (stateMatch) out.state = stateMatch[1];
  // pid = 12345
  const pidMatch = text.match(/\bpid\s*=\s*(\d+)/);
  if (pidMatch) out.pid = Number(pidMatch[1]);
  // program = /path/to/node
  const programMatch = text.match(/\bprogram\s*=\s*(\S+)/);
  if (programMatch) out.program = programMatch[1];
  // working directory = /path
  const cwdMatch = text.match(/\bworking directory\s*=\s*(\S+)/);
  if (cwdMatch) out.cwd = cwdMatch[1];
  return out;
}

export function createLaunchdManager(uid: number): ProcessManager {
  const service = `gui/${uid}/${LAUNCHD_LABEL}`;

  return {
    kind: "launchd",

    async getStatus(): Promise<ProcessStatus> {
      try {
        const out = execSync(`launchctl print ${service}`, {
          encoding: "utf-8",
          timeout: 3000,
          stdio: "pipe",
        });
        const parsed = parseLaunchdPrint(out);
        const pid = parsed.pid;

        // Enrich with ps info if we have a PID
        let memory: number | undefined;
        let cpu: number | undefined;
        let uptime: number | undefined;
        if (pid) {
          try {
            // ps output: %cpu %mem rss etime
            const psOut = execSync(
              `ps -p ${pid} -o %cpu=,%mem=,rss=,etime=`,
              { encoding: "utf-8", timeout: 2000, stdio: "pipe" },
            ).trim();
            const [cpuStr, , rssStr, etime] = psOut.split(/\s+/);
            cpu = parseFloat(cpuStr) || 0;
            memory = (parseInt(rssStr, 10) || 0) * 1024; // rss is kB
            uptime = parseEtimeToMs(etime);
          } catch {
            /* ps may fail if pid vanished — ignore */
          }
        }

        return {
          kind: "launchd",
          status: parsed.state === "running" ? "running" : parsed.state || "unknown",
          pid,
          uptime,
          memory,
          cpu,
          execPath: parsed.program,
          cwd: parsed.cwd,
          nodeVersion: process.version,
        };
      } catch {
        return { kind: "launchd", status: "not-loaded" };
      }
    },

    async stop(): Promise<void> {
      // bootout removes the service from the domain, which stops it
      // and disables KeepAlive until bootstrap is run again.
      execSync(`launchctl bootout ${service}`, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: "pipe",
      });
    },

    async start(): Promise<void> {
      // bootstrap re-registers the plist with the domain.
      execSync(
        `launchctl bootstrap gui/${uid} ${JSON.stringify(LAUNCHD_PLIST).slice(1, -1)}`,
        { encoding: "utf-8", timeout: 5000, stdio: "pipe" },
      );
    },

    async getLogs(lines = 30): Promise<string> {
      // launchd redirects stdout/stderr to files — just tail them.
      const logDir = resolve(
        process.env.ALVIN_DATA_DIR || resolve(os.homedir(), ".alvin-bot"),
        "logs",
      );
      const outLog = resolve(logDir, "alvin-bot.out.log");
      const errLog = resolve(logDir, "alvin-bot.err.log");
      try {
        return execSync(`tail -n ${lines} ${outLog} ${errLog} 2>/dev/null`, {
          encoding: "utf-8",
          timeout: 3000,
          stdio: "pipe",
        });
      } catch {
        return "No logs available.";
      }
    },
  };
}

function parseEtimeToMs(etime: string): number | undefined {
  // ps etime format: "MM:SS", "HH:MM:SS", "D-HH:MM:SS"
  if (!etime) return undefined;
  const parts = etime.split("-");
  let days = 0;
  let hms: string;
  if (parts.length === 2) {
    days = parseInt(parts[0], 10) || 0;
    hms = parts[1];
  } else {
    hms = parts[0];
  }
  const bits = hms.split(":").map((x) => parseInt(x, 10) || 0);
  let h = 0, m = 0, s = 0;
  if (bits.length === 3) [h, m, s] = bits;
  else if (bits.length === 2) [m, s] = bits;
  else return undefined;
  return (((days * 24 + h) * 60 + m) * 60 + s) * 1000;
}

// ── pm2 ─────────────────────────────────────────────────────────

interface Pm2Env {
  status?: string;
  pm_uptime?: number;
  restart_time?: number;
  version?: string;
  node_version?: string;
  pm_exec_path?: string;
  pm_cwd?: string;
}

export function createPm2Manager(): ProcessManager {
  return {
    kind: "pm2",

    async getStatus(): Promise<ProcessStatus> {
      try {
        const out = execSync("pm2 jlist", {
          encoding: "utf-8",
          timeout: 3000,
          stdio: "pipe",
        });
        const procs = JSON.parse(out) as Array<{
          name?: string;
          pid?: number;
          pm2_env?: Pm2Env;
          monit?: { memory?: number; cpu?: number };
        }>;
        const me = procs.find((p) => p.name === PM2_NAME);
        if (!me) {
          return { kind: "pm2", status: "unknown" };
        }
        const env = me.pm2_env ?? {};
        return {
          kind: "pm2",
          status: env.status || "unknown",
          pid: me.pid,
          uptime: env.pm_uptime ? Date.now() - env.pm_uptime : undefined,
          memory: me.monit?.memory,
          cpu: me.monit?.cpu,
          restarts: env.restart_time ?? 0,
          version: env.version,
          nodeVersion: env.node_version || process.version,
          execPath: env.pm_exec_path,
          cwd: env.pm_cwd,
        };
      } catch {
        return { kind: "pm2", status: "unknown" };
      }
    },

    async stop(): Promise<void> {
      execSync(`pm2 stop ${PM2_NAME}`, {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: "pipe",
      });
    },

    async start(): Promise<void> {
      execSync(`pm2 start ${PM2_NAME}`, {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: "pipe",
      });
    },

    async getLogs(lines = 30): Promise<string> {
      try {
        const raw = execSync(
          `pm2 logs ${PM2_NAME} --nostream --lines ${lines} 2>&1`,
          {
            encoding: "utf-8",
            timeout: 5000,
            stdio: "pipe",
            env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
          },
        );
        // eslint-disable-next-line no-control-regex
        return raw.replace(/\x1b\[[0-9;]*m/g, "");
      } catch {
        return "No logs available.";
      }
    },
  };
}

// ── standalone ──────────────────────────────────────────────────

export function createStandaloneManager(): ProcessManager {
  return {
    kind: "standalone",

    async getStatus(): Promise<ProcessStatus> {
      return {
        kind: "standalone",
        status: "running",
        pid: process.pid,
        uptime: process.uptime() * 1000,
        memory: process.memoryUsage().rss,
        nodeVersion: process.version,
        execPath: process.execPath,
        cwd: process.cwd(),
      };
    },

    async stop(): Promise<void> {
      // No supervisor — just exit. User must restart manually.
      setTimeout(() => process.exit(0), 300);
    },

    async start(): Promise<void> {
      // Cannot start ourselves if we're already running (nonsensical).
      // Callers should not hit this path when status is "running".
      throw new Error(
        "standalone: cannot 'start' — no supervisor. Run the bot manually.",
      );
    },

    async getLogs(lines = 30): Promise<string> {
      // Standalone mode may or may not redirect stdout. Try the
      // default ~/.alvin-bot/logs path first.
      const logDir = resolve(
        process.env.ALVIN_DATA_DIR || resolve(os.homedir(), ".alvin-bot"),
        "logs",
      );
      const outLog = resolve(logDir, "alvin-bot.out.log");
      try {
        return execSync(`tail -n ${lines} ${outLog} 2>/dev/null`, {
          encoding: "utf-8",
          timeout: 3000,
          stdio: "pipe",
        });
      } catch {
        return "No logs available (standalone mode — stdout not captured).";
      }
    },
  };
}
