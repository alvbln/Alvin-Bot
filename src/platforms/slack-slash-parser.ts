/**
 * v4.13.2 — Parse Slack `/alvin <subcommand> [args...]` slash command
 * text into the platform-agnostic `/<subcommand> [args]` format that
 * handlePlatformCommand already knows.
 *
 * Pure function — tested in isolation. Called from the Slack adapter's
 * `app.command('/alvin')` handler.
 *
 * Rules:
 *   - Empty text → `/help` (useful default, shows the commands list)
 *   - Subcommand is lowercased for case-insensitive matching
 *   - Args are kept verbatim (preserve user capitalization)
 *   - A literal leading `/` on the subcommand is stripped defensively
 *     (handles `/alvin /status` which becomes just `/status`, not `//status`)
 */
export function parseSlackSlashCommand(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "/help";

  // Split on first whitespace run — head is the subcommand, tail is args
  const match = trimmed.match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) return "/help";
  let sub = (match[1] || "").toLowerCase();
  // Strip a literal leading slash the user might have typed
  if (sub.startsWith("/")) sub = sub.slice(1);
  if (sub.length === 0) return "/help";

  const args = (match[2] || "").trim();
  return args ? `/${sub} ${args}` : `/${sub}`;
}
