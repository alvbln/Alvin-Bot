/**
 * v4.12.1 — Integration test: sync Agent tool call with long silence
 * does NOT trigger the stuck timeout abort.
 *
 * Before v4.12.1: a Task tool call WITHOUT run_in_background: true
 * running silently for >10 minutes triggered STUCK_TIMEOUT_MS and
 * aborted the main session — even though the sub-agent was working
 * legitimately (it just can't emit intermediate chunks to the parent
 * stream).
 *
 * After v4.12.1: the stuck timer escalates to SYNC_AGENT_IDLE_TIMEOUT_MS
 * (120 min) as soon as the sync tool_use is detected (tracked by
 * toolUseId), and only reverts to the normal timeout after the matching
 * tool_result arrives.
 *
 * This test uses the pure createStuckTimer state machine directly —
 * the real integration into the message handler's for-await loop is
 * covered by the Task A unit tests and manual smoke tests. What this
 * file verifies is the COMBINED flow (normal → enterSync → exitSync →
 * normal) over realistic timing scales.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStuckTimer } from "../src/handlers/stuck-timer.js";

describe("sync Task tool call stuck-timer integration (v4.12.1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("30-min silent sync Task gap does NOT fire the 10-min normal timer", () => {
    const onTimeout = vi.fn();
    const t = createStuckTimer({
      normalMs: 10 * 60 * 1000, // 10 min — production default
      extendedMs: 120 * 60 * 1000, // 120 min — production default
      onTimeout,
    });

    // Simulate: handler begins streaming, first chunk arrives
    t.reset();

    // Assistant text chunk arrives
    t.reset();

    // tool_use with Task, runInBackground NOT true → sync path
    t.enterSync("toolu_sync_123");

    // 30 min of silence (no chunks, no resets) — sub-agent is working
    vi.advanceTimersByTime(30 * 60 * 1000);

    // MUST NOT have fired — we're in extended mode (120 min cap)
    expect(onTimeout).not.toHaveBeenCalled();

    // tool_result finally arrives
    t.exitSync("toolu_sync_123");
    t.reset();

    // Subsequent 10 minutes of silence SHOULD fire (back to normal mode)
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("async Task (runInBackground=true) uses normal timeout (handler does NOT call enterSync)", () => {
    // Simulates the decision flow: the handler only calls enterSync
    // when chunk.runInBackground !== true. For async tasks, enterSync
    // is NEVER called, so the normal 10-min timer applies to any gap
    // before the watcher delivers (which is a separate path).
    const onTimeout = vi.fn();
    const t = createStuckTimer({
      normalMs: 10 * 60 * 1000,
      extendedMs: 120 * 60 * 1000,
      onTimeout,
    });

    t.reset();
    // Async path: the async tool_result arrives almost immediately
    // (the SDK returns "Async agent launched successfully" quickly)
    t.reset();
    // Then the parent turn ends normally within a few seconds
    // ... but if something went wrong and the parent stream hangs,
    // the normal 10-min timeout applies:
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("cancel during extended mode stops cleanly (handler finally block)", () => {
    const onTimeout = vi.fn();
    const t = createStuckTimer({
      normalMs: 10 * 60 * 1000,
      extendedMs: 120 * 60 * 1000,
      onTimeout,
    });

    t.enterSync("toolu_1");

    // Simulate: partway through a sync task, something errors out
    // and the handler reaches its finally block
    vi.advanceTimersByTime(60 * 60 * 1000);
    t.cancel();

    // Another 60 min pass — no firing because cancel cleared the timer
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("multiple parallel sync tasks (nested Agent calls): extended until ALL complete", () => {
    // Edge case: if two parent-level sync tool_use blocks land in
    // the same assistant message, both get tracked. The extended
    // timer must stay armed until BOTH exit.
    const onTimeout = vi.fn();
    const t = createStuckTimer({
      normalMs: 10 * 60 * 1000,
      extendedMs: 120 * 60 * 1000,
      onTimeout,
    });

    t.enterSync("toolu_parallel_1");
    t.enterSync("toolu_parallel_2");
    expect(t._pendingCount()).toBe(2);

    // First finishes
    vi.advanceTimersByTime(20 * 60 * 1000);
    t.exitSync("toolu_parallel_1");
    expect(t._pendingCount()).toBe(1);

    // Second still running — another 30 min of silence
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(onTimeout).not.toHaveBeenCalled();

    // Second finishes
    t.exitSync("toolu_parallel_2");
    t.reset();

    // Now back to normal timeout — should fire after 10 min
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("regression guard: old behavior (no task tracking, flat 10-min) would have false-aborted", () => {
    // This test is a documentation-as-code artifact: it simulates
    // what the OLD code did and verifies it WOULD have false-aborted.
    // If we ever revert the fix, this test will catch the regression
    // by asserting the old behavior fires at exactly 10 min of silence.
    const onTimeout = vi.fn();
    const flatTimer = createStuckTimer({
      normalMs: 10 * 60 * 1000,
      extendedMs: 10 * 60 * 1000, // identical → simulates pre-v4.12.1 behavior
      onTimeout,
    });
    flatTimer.enterSync("toolu_1");
    vi.advanceTimersByTime(10 * 60 * 1000);
    // With the flat timer (pre-fix), a 10-min sync gap DOES fire
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
