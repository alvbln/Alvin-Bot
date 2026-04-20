/**
 * Task-aware stuck timer for the Telegram message handler (v4.12.1).
 *
 * The main handler must detect genuine SDK hangs (no chunks for N minutes)
 * while NOT aborting legitimate long-running work — specifically sync Agent
 * tool calls that emit no intermediate chunks for their entire duration.
 *
 * State machine:
 *   - Normal mode: idle timeout = NORMAL_MS (default 10 min, env-configurable
 *     in message.ts via ALVIN_STUCK_TIMEOUT_MINUTES)
 *   - When any Agent/Task tool call is known to be running sync (tracked by
 *     its toolUseId), the next reset() arms the timer with EXTENDED_MS
 *     instead (default 120 min, env-configurable via
 *     ALVIN_SYNC_AGENT_IDLE_TIMEOUT_MINUTES)
 *   - Back to NORMAL_MS once all tracked sync tool calls have emitted their
 *     tool_result and been released via exitSync()
 *
 * This module is pure — no grammy, no session, no provider. Takes its ms
 * values and onTimeout callback as constructor args. Testable in isolation
 * with vi.useFakeTimers(). The handler owns the state; the handler decides
 * which chunks flip the mode based on chunk.toolName and chunk.runInBackground.
 *
 * See docs/superpowers/plans/... and test/stuck-timer.test.ts.
 */

export interface StuckTimerConfig {
  /** Timeout in ms when no sync Task/Agent tool call is active. */
  normalMs: number;
  /** Timeout in ms when at least one sync Task/Agent tool call is active. */
  extendedMs: number;
  /** Fired when the current timeout elapses with no reset. */
  onTimeout: () => void;
}

export interface StuckTimer {
  /** Re-arm the timer using the current state (normal vs extended).
   *  Call on every chunk received — mimics the pre-v4.12.1 resetStuckTimer()
   *  behavior but decides the timeout value based on pending state. */
  reset(): void;
  /** Mark a sync Task/Agent tool call as active. Re-arms with extended timeout. */
  enterSync(toolUseId: string): void;
  /** Mark a sync tool call as finished. If none remaining, re-arms with normal. */
  exitSync(toolUseId: string): void;
  /** Clear the timer — for finally-block cleanup in the handler. */
  cancel(): void;
  /** Inspect pending-sync-task count. For tests; not used in production code. */
  _pendingCount(): number;
}

export function createStuckTimer(cfg: StuckTimerConfig): StuckTimer {
  const pending = new Set<string>();
  let handle: ReturnType<typeof setTimeout> | null = null;

  const currentTimeout = () =>
    pending.size > 0 ? cfg.extendedMs : cfg.normalMs;

  const rearm = () => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(cfg.onTimeout, currentTimeout());
  };

  return {
    reset: rearm,
    enterSync(id: string) {
      pending.add(id);
      rearm();
    },
    exitSync(id: string) {
      pending.delete(id);
      rearm();
    },
    cancel() {
      if (handle) {
        clearTimeout(handle);
        handle = null;
      }
    },
    _pendingCount() {
      return pending.size;
    },
  };
}
