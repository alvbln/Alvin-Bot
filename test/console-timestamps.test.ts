/**
 * Fix #10 — console output must carry ISO timestamps so out.log / err.log
 * are actually debuggable. Also: silence libsignal's "Closing session"
 * SessionEntry dumps which were pushing tens of KB per day into the logs
 * and making forensic work painful.
 *
 * Contract: `installConsoleFormatter(console)` wraps console.log /
 * console.warn / console.error so every line is prefixed with the
 * current ISO timestamp (zero-padded, UTC), and certain noise patterns
 * (libsignal session dumps) are dropped entirely.
 *
 * The wrapper is idempotent — calling it twice is a no-op.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  installConsoleFormatter,
  uninstallConsoleFormatter,
  isNoisyLine,
} from "../src/util/console-formatter.js";

describe("installConsoleFormatter (Fix #10)", () => {
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let origStdout: typeof process.stdout.write;
  let origStderr: typeof process.stderr.write;

  beforeEach(() => {
    stdoutWrites = [];
    stderrWrites = [];
    origStdout = process.stdout.write.bind(process.stdout);
    origStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    uninstallConsoleFormatter();
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  });

  it("prefixes console.log output with an ISO timestamp", () => {
    installConsoleFormatter();
    console.log("hello world");
    const line = stdoutWrites.join("");
    // ISO format like 2026-04-11T14:00:00.000Z
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+hello world/);
  });

  it("prefixes console.error output with an ISO timestamp", () => {
    installConsoleFormatter();
    console.error("boom");
    const line = stderrWrites.join("");
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+boom/);
  });

  it("is idempotent — second install call does not double-prefix", () => {
    installConsoleFormatter();
    installConsoleFormatter();
    console.log("once");
    const line = stdoutWrites.join("");
    // Exactly one ISO timestamp, not two
    const matches = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });
});

describe("isNoisyLine (Fix #10)", () => {
  it("treats libsignal session dumps as noise", () => {
    const dump = `Closing session: SessionEntry {
  _chains: {
    'BUQxzJlwgVTCxCL5C4rTbZP/7a0ciMPnyo47Pwr4flJt': { chainKey: [Object], chainType: 1, messageKeys: {} }
  },
  registrationId: 1446528770`;
    expect(isNoisyLine(dump)).toBe(true);
  });

  it("treats the one-line 'Closing open session' as noise", () => {
    expect(isNoisyLine("Closing open session in favor of incoming prekey bundle")).toBe(true);
  });

  it("treats the repetitive claude native binary banner as noise", () => {
    expect(isNoisyLine("[claude] Native binary: /Users/foo/.local/share/claude/versions/2.1.101")).toBe(true);
  });

  it("does NOT silence normal log output", () => {
    expect(isNoisyLine("⏰ Cron scheduler started (30s interval)")).toBe(false);
    expect(isNoisyLine("[watchdog] started — beacon every 30s")).toBe(false);
    expect(isNoisyLine("Cron: Running job \"Daily Job Alert\"")).toBe(false);
  });
});
