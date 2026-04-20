/**
 * Console formatter — adds ISO timestamps to every console.log /
 * console.warn / console.error call, and drops high-volume noise
 * (libsignal session dumps, Claude CLI native-binary banner).
 *
 * Installed once at bootstrap time from src/index.ts. Idempotent.
 *
 * Why not pino / winston: those pull in several MB of deps and change
 * the call-site ergonomics. Every caller in the bot today uses plain
 * `console.log`; monkey-patching those is a 40-line change instead of
 * a refactor of every file.
 */

import util from "node:util";

type ConsoleMethod = (...args: unknown[]) => void;

interface ConsoleSnapshot {
  log: ConsoleMethod;
  warn: ConsoleMethod;
  error: ConsoleMethod;
  info: ConsoleMethod;
}

let snapshot: ConsoleSnapshot | null = null;

/**
 * Noise patterns from production logs that fill out.log/err.log with
 * tens of KB per day without carrying useful signal. Added sparingly —
 * every entry here is a line a human will never need to grep for.
 */
const NOISE_PATTERNS: RegExp[] = [
  // libsignal session dump header — the multi-line body following this
  // line is silenced by the first-line detector below.
  /^Closing session: SessionEntry \{/,
  // libsignal prekey bundle swap notification
  /^Closing open session in favor of incoming prekey bundle/,
  // Claude CLI startup banner — spammed once per query
  /^\[claude\] Native binary: /,
  // libsignal Bad MAC — session desync, harmless, repeats endlessly
  /^Session error:Error: Bad MAC Error: Bad MAC/,
];

/** Exported for testing. */
export function isNoisyLine(line: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(line));
}

/**
 * Track whether we're currently inside a libsignal multi-line dump. The
 * dumps look like `Closing session: SessionEntry {` followed by several
 * lines of buffer hex, closing with `}`. We swallow everything from the
 * opening brace to its matching `}` line.
 */
let suppressDepth = 0;

function shouldSuppress(raw: string): boolean {
  const line = raw.trimEnd();
  if (suppressDepth > 0) {
    // Inside a multi-line dump — count braces on this line. The dumps
    // only contain ASCII braces in the structural positions, so this
    // is safe enough for production noise.
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    suppressDepth += opens;
    suppressDepth -= closes;
    if (suppressDepth < 0) suppressDepth = 0;
    return true;
  }
  if (isNoisyLine(line)) {
    // If the noisy header opens a block, start suppressing its body.
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    suppressDepth = Math.max(0, opens - closes);
    return true;
  }
  return false;
}

function formatWithTimestamp(method: ConsoleMethod, stream: NodeJS.WriteStream) {
  return (...args: unknown[]) => {
    // Render args the same way console does — util.format handles %s / %d / objects.
    const text = renderArgs(args);
    if (shouldSuppress(text)) return;
    const stamp = new Date().toISOString();
    // Write directly to the stream so we don't recurse through console.
    stream.write(`${stamp} ${text}\n`);
    void method; // keep original ref alive for uninstall
  };
}

function renderArgs(args: unknown[]): string {
  // Use Node's built-in util.format — it matches console.* exactly.
  return util.format(...args);
}

/**
 * Install timestamp + noise-filter formatters on console.log/warn/info/error.
 * Safe to call multiple times.
 */
export function installConsoleFormatter(): void {
  if (snapshot) return; // already installed

  snapshot = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
  };

  console.log = formatWithTimestamp(snapshot.log, process.stdout);
  console.info = formatWithTimestamp(snapshot.info, process.stdout);
  console.warn = formatWithTimestamp(snapshot.warn, process.stderr);
  console.error = formatWithTimestamp(snapshot.error, process.stderr);
}

/** Restore the original console methods. Used by tests + shutdown. */
export function uninstallConsoleFormatter(): void {
  if (!snapshot) return;
  console.log = snapshot.log;
  console.info = snapshot.info;
  console.warn = snapshot.warn;
  console.error = snapshot.error;
  snapshot = null;
  suppressDepth = 0;
}
