/**
 * Pure decision helper for the web-server bind loop.
 *
 * Decouples the "what should happen next" logic from the side-effect
 * spaghetti of real http.Server binding so it can be unit-tested in
 * isolation. See test/web-server-resilience.test.ts for the contract.
 *
 * Why this exists: the v4.8.x and earlier implementations crashed the
 * entire bot when port 3100 was held by a foreign process. A colleague
 * running an OpenClaw fork hit the same bug years ago and ended up
 * decoupling the web server completely — the main bot should never be
 * gated on a web-UI bind. This helper encodes the decision logic so
 * the new startWebServer() can just act on the returned action.
 */

export interface BindStrategyOpts {
  /** The original port the web server WANTS to bind to. */
  originalPort: number;
  /** How many sequential port-ladder attempts we make before giving up. */
  maxPortTries: number;
  /** How long to wait before the next background retry cycle starts. */
  backgroundRetryMs: number;
}

export type BindAction =
  | {
      /** Retry immediately on the next port (original + 1, + 2, …). */
      type: "retry-port";
      port: number;
      attempt: number;
    }
  | {
      /** Wait `delayMs` then retry from the original port again. */
      type: "retry-background";
      delayMs: number;
      port: number;
    };

/**
 * Decide what the bind loop should do next after a failed listen().
 *
 * Rule of thumb:
 *   - EADDRINUSE AND attempts remaining  → climb the port ladder.
 *   - EADDRINUSE AND ladder exhausted    → background retry at original port.
 *   - any other error (EACCES, listen-called-twice, etc.) → background retry.
 *
 * PURE: no timers, no I/O, no mutation of inputs. Safe to call from tests.
 */
export function decideNextBindAction(
  err: unknown,
  attempt: number,
  opts: BindStrategyOpts,
): BindAction {
  const code = (err as NodeJS.ErrnoException | null)?.code;

  if (code === "EADDRINUSE" && attempt < opts.maxPortTries - 1) {
    return {
      type: "retry-port",
      port: opts.originalPort + attempt + 1,
      attempt: attempt + 1,
    };
  }

  // EADDRINUSE with no attempts left, OR any non-EADDRINUSE error:
  // don't walk the port ladder further, just back off and retry the
  // original port in the background.
  return {
    type: "retry-background",
    delayMs: opts.backgroundRetryMs,
    port: opts.originalPort,
  };
}
