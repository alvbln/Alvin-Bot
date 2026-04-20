/**
 * v4.12.1 — Task-aware stuck timer state machine.
 *
 * Before v4.12.1, message.ts used a flat 10-min stuck timeout that
 * aborted the session when no chunks arrived for 10 minutes. This
 * was fatal for synchronous Task/Agent tool calls, which legitimately
 * produce no parent-stream chunks for their entire duration.
 *
 * The new stuck timer is task-aware: it escalates to an extended
 * timeout (default 120 min) as soon as a sync Task/Agent tool call
 * is detected (tracked by toolUseId), then reverts to the normal
 * timeout once all tracked sync tool calls have emitted their
 * tool_result.
 *
 * This module is a pure state machine — no grammy, no session,
 * no provider. Testable in isolation with vi.useFakeTimers().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStuckTimer } from "../src/handlers/stuck-timer.js";

describe("stuck timer — task-aware state machine (v4.12.1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires after normalMs when no pending sync tasks", () => {
    const onTimeout = vi.fn();
    const t = createStuckTimer({ normalMs: 1000, extendedMs: 10_000, onTimeout });
    t.reset();
    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("enterSync extends the timer to extendedMs", () => {
    const onTimeout = vi.fn();
    const t = createStuckTimer({ normalMs: 1000, extendedMs: 10_000, onTimeout });
    t.reset();
    t.enterSync("tool_1");
    // 5 seconds in — should still be alive because we're in extended mode
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
    // 5 more seconds (10s total since enterSync) — extended timer should fire
    vi.advanceTimersByTime(5000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("exitSync returns to normalMs and rearms from that point", () => {
    const onTimeout = vi.fn();
    const t = createStuckTimer({ normalMs: 1000, extendedMs: 10_000, onTimeout });
    t.enterSync("tool_1");
    vi.advanceTimersByTime(500);
    t.exitSync("tool_1");
    // New normal timer is armed from exitSync time; fires after another 1000ms.
    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("multiple pending syncs: exit one keeps extended timer", () => {
    const onTimeout = vi.fn();
    const t = createStuckTimer({ normalMs: 1000, extendedMs: 10_000, onTimeout });
    t.enterSync("tool_1");
    t.enterSync("tool_2");
    expect(t._pendingCount()).toBe(2);
    t.exitSync("tool_1");
    expect(t._pendingCount()).toBe(1);
    // Still in extended mode — 5s of silence must not fire
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("exitSync on unknown id is a no-op and doesn't corrupt state", () => {
    const onTimeout = vi.fn();
    const t = createStuckTimer({ normalMs: 1000, extendedMs: 10_000, onTimeout });
    t.exitSync("never-seen");
    expect(t._pendingCount()).toBe(0);
    // Normal timer should work as usual
    t.reset();
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalled();
  });

  it("cancel stops the timer entirely", () => {
    const onTimeout = vi.fn();
    const t = createStuckTimer({ normalMs: 1000, extendedMs: 10_000, onTimeout });
    t.reset();
    t.cancel();
    vi.advanceTimersByTime(2000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("reset while extended keeps the extended timer (not shortening)", () => {
    const onTimeout = vi.fn();
    const t = createStuckTimer({ normalMs: 1000, extendedMs: 10_000, onTimeout });
    t.enterSync("tool_1");
    vi.advanceTimersByTime(500);
    // A chunk arrived — reset. We should STAY in extended mode.
    t.reset();
    vi.advanceTimersByTime(9000);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("idempotent enterSync: same id twice stays at count 1", () => {
    const onTimeout = vi.fn();
    const t = createStuckTimer({ normalMs: 1000, extendedMs: 10_000, onTimeout });
    t.enterSync("tool_1");
    t.enterSync("tool_1");
    expect(t._pendingCount()).toBe(1);
    t.exitSync("tool_1");
    expect(t._pendingCount()).toBe(0);
  });
});
