/**
 * Fix #7 — fs.watch emits duplicates on macOS; we need a simple debounce.
 *
 * Contract: `debounce(fn, waitMs)` returns a wrapped function. Calling
 * the wrapped function schedules `fn()` to run `waitMs` ms after the
 * last call. Multiple calls inside the window coalesce into one
 * invocation. Each "quiet period" starts a fresh cycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounce } from "../src/util/debounce.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("debounce (Fix #7)", () => {
  it("runs the function once after the wait period", () => {
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("coalesces many rapid calls into one invocation", () => {
    const fn = vi.fn();
    const d = debounce(fn, 300);
    d(); d(); d(); d();
    vi.advanceTimersByTime(299);
    d(); // resets the timer
    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("allows a second invocation after the wait elapses between calls", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    d();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("passes through the latest arguments to the final call", () => {
    const fn = vi.fn();
    const d = debounce(fn, 50);
    d("first");
    d("second");
    d("third");
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("third");
  });
});
