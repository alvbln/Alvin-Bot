/**
 * Pure helpers for the /cron run progress ticker.
 *
 * Separated from commands.ts so the formatting and safety rules can be
 * unit-tested without standing up the entire grammy Context. The command
 * handler wires these into a setInterval that edits a single Telegram
 * message once per tick, giving the user visible proof-of-life during
 * long-running (10+ min) cron jobs.
 *
 * See test/cron-progress-ticker.test.ts for the contract.
 */

/** Human-readable elapsed time — adapts unit to magnitude. */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSec}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}

/**
 * Escape Markdown-breaking characters in untrusted display strings so
 * an edit-message call can safely use `parse_mode: Markdown` without
 * triggering "can't parse entities" — the exact bug that killed every
 * daily-job-alert banner for days.
 *
 * We use Telegram Markdown (v1) escape rules: only `*`, `_`, `[`, `` ` ``.
 * The rest flow through unchanged.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([*_[\]`])/g, "\\$1");
}

/** Intermediate ticker text: "🔄 Running *name* · 2m 5s elapsed…" */
export function buildTickerText(jobName: string, elapsedSeconds: number): string {
  const safe = escapeMarkdown(jobName);
  return `🔄 Running *${safe}* · ${formatElapsed(elapsedSeconds)} elapsed…`;
}

/** Final ticker state: "✅ Done — *name* · 13m 17s" (or ❌ / ⏳). */
export function buildDoneText(
  jobName: string,
  elapsedSeconds: number,
  outcome: { ok: boolean; error?: string; skipped?: boolean },
): string {
  const safe = escapeMarkdown(jobName);
  if (outcome.skipped) {
    return `⏳ *${safe}* is already running — not starting a duplicate`;
  }
  if (!outcome.ok) {
    const errLine = outcome.error ? `\n\n${outcome.error.slice(0, 500)}` : "";
    return `❌ *${safe}* — ${formatElapsed(elapsedSeconds)}${errLine}`;
  }
  return `✅ Done — *${safe}* · ${formatElapsed(elapsedSeconds)}`;
}
