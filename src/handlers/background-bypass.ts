/**
 * v4.12.3 — Background-agent bypass helpers.
 *
 * Pure state-machine helpers used by the Telegram + platform message
 * handlers to decide whether to:
 *   1. Abort a running query instead of queueing the next user message,
 *      when the running query is blocked waiting for a background
 *      task-notification (SDK's CLI subprocess stays alive for the full
 *      duration of the background task).
 *   2. Start the next SDK query with a fresh session (sessionId=null)
 *      when any background agent is still pending, so the new query
 *      doesn't inherit the old session's block.
 *
 * These are separated into their own module so they can be unit tested
 * without a grammy Context mock.
 */

export interface BypassQueueState {
  isProcessing: boolean;
  pendingBackgroundCount: number;
  abortController: AbortController | null;
}

/**
 * Decide whether to bypass the normal "queue this message" branch and
 * interrupt the running query so the new message can proceed immediately.
 *
 * True when:
 *   - A query is currently running (`isProcessing`)
 *   - At least one background agent is pending in this session
 *   - An unaborted abortController exists to cancel the running query
 *
 * Otherwise false → fall back to the normal queue/drop behavior.
 */
export function shouldBypassQueue(state: BypassQueueState): boolean {
  if (!state.isProcessing) return false;
  if (state.pendingBackgroundCount <= 0) return false;
  const ac = state.abortController;
  if (!ac) return false;
  if (ac.signal.aborted) return false;
  return true;
}

export interface BypassResumeState {
  pendingBackgroundCount: number;
}

/**
 * Decide whether the next SDK query should skip `resume: sessionId`
 * and start a fresh session instead. Needed when a background agent is
 * still pending — resuming the original session would inherit its block
 * (the SDK's CLI subprocess for that session is waiting to deliver the
 * task-notification inline). A fresh session has no such block and
 * proceeds immediately. Context is preserved via the bridge preamble
 * (buildBridgeMessage in message.ts).
 */
export function shouldBypassSdkResume(state: BypassResumeState): boolean {
  return state.pendingBackgroundCount > 0;
}

/**
 * Poll-wait until `session.isProcessing` becomes false (or the timeout
 * elapses). Returns true if the flag flipped, false on timeout.
 *
 * Used by the bypass path: after calling `abort()` on the running query,
 * we wait for its finally block to run and flip isProcessing=false
 * before starting the new query. The handler's own message loop is the
 * one flipping the flag, so we just have to yield the event loop and
 * re-check.
 *
 * Timeouts above 0 are recommended. Default tick interval is 50ms which
 * is short enough that the fall-through feels instant to the user.
 */
export async function waitUntilProcessingFalse(
  session: { isProcessing: boolean },
  timeoutMs: number,
  tickMs = 50,
): Promise<boolean> {
  if (!session.isProcessing) return true;
  const start = Date.now();
  while (session.isProcessing) {
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, tickMs));
  }
  return true;
}
