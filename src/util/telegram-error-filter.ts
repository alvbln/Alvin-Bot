/**
 * Telegram error filter — single source of truth for "which grammy
 * errors are harmless and should never reach the end user as a
 * 'Fehler: ...' reply."
 *
 * Context: grammy's Bot API wrapper surfaces these as plain Error
 * objects with the description baked into `.message`. Some call sites
 * (live-stream edit races, callback-answer races after a modal was
 * already dismissed, message-to-edit-gone races when the user just
 * deleted the message) produce errors that are 100% benign — they
 * just mean the UI state we were about to write is already there.
 *
 * This file centralises the list so we can update one regex and have
 * the filter apply everywhere. Used by bot.catch(), by the streaming
 * `telegram.ts` finalize path, by handlers/message.ts, and by any
 * future caller that needs to decide "report this to the user or
 * drop it silently."
 */

const HARMLESS_PATTERNS: RegExp[] = [
  // The big one — live-stream edit races
  /message is not modified/i,
  /specified new message content and reply markup are exactly the same/i,
  // Callback-answer race: the user tapped a stale inline button
  /query is too old and response timeout expired/i,
  /query ID is invalid/i,
  // The user deleted the message we were about to edit
  /message to edit not found/i,
  /message to delete not found/i,
  /MESSAGE_ID_INVALID/i,
];

/**
 * True if the error is one of the known-harmless Telegram races.
 * Accepts Error objects, grammy's GrammyError (which has an additional
 * `description` field), and plain strings. `null` / `undefined` return
 * false so callers can use this directly in catch blocks.
 */
export function isHarmlessTelegramError(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  let haystack = "";
  if (typeof err === "string") {
    haystack = err;
  } else if (err instanceof Error) {
    haystack = err.message || "";
    // grammy's GrammyError carries the server's reason on .description
    const desc = (err as Error & { description?: unknown }).description;
    if (typeof desc === "string") haystack += " " + desc;
  } else if (typeof err === "object") {
    // Plain object — look for message/description fields
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") haystack += obj.message;
    if (typeof obj.description === "string") haystack += " " + obj.description;
  }

  if (!haystack) return false;

  return HARMLESS_PATTERNS.some((re) => re.test(haystack));
}
