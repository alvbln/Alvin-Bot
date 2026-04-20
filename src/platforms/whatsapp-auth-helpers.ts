/**
 * WhatsApp auth helpers — tiny resilience wrappers around baileys'
 * use-multi-file-auth-state output.
 *
 * Why this exists: baileys' `saveCreds` is called asynchronously from
 * the `creds.update` socket event, long after the auth directory was
 * created at init time. If anything wipes the directory between init
 * and the first save — a crash mid-init, a manual rm -rf, a stale
 * worker on a different code path — the write throws ENOENT and becomes
 * an `unhandledRejection`, which node 15+ default-reports as a crash.
 *
 * This module keeps the wrapper separate from `whatsapp.ts` so it can
 * be unit-tested without having to drag baileys into the test process.
 */

import fs from "fs";

/**
 * Wrap a baileys saveCreds so a missing auth directory is transparently
 * recreated once and the save is retried. Any other error, and any
 * second ENOENT in a row, surfaces unchanged.
 */
export function makeResilientSaveCreds(
  authDir: string,
  innerSaveCreds: () => Promise<void>,
): () => Promise<void> {
  return async function resilientSaveCreds() {
    try {
      await innerSaveCreds();
      return;
    } catch (err) {
      if (!isEnoent(err)) throw err;
      // baileys-auth dir vanished between init and now — rebuild and retry once.
      try {
        fs.mkdirSync(authDir, { recursive: true });
      } catch {
        // If mkdir itself fails, fall through to the retry — it will surface
        // the real error below with its original stack.
      }
      await innerSaveCreds();
    }
  };
}

function isEnoent(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return true;
  // Some baileys wrapper paths re-throw as a plain Error with a message
  // like "ENOENT: no such file or directory, open '.../creds.json'" but
  // without .code — match the message as a fallback.
  const msg = (err as Error).message || "";
  return /ENOENT/.test(msg);
}
