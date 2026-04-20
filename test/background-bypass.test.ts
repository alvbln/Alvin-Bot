/**
 * v4.12.3 — background-bypass pure helpers.
 *
 * These helpers factor out the SDK-resume-bypass decision from the
 * message handler so it can be unit tested without grammy Context
 * mocks. The real handler composes these functions — they're only
 * state machines over session fields + time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  shouldBypassQueue,
  shouldBypassSdkResume,
  waitUntilProcessingFalse,
} from "../src/handlers/background-bypass.js";

describe("shouldBypassQueue (v4.12.3)", () => {
  it("returns false when session is not processing", () => {
    expect(
      shouldBypassQueue({
        isProcessing: false,
        pendingBackgroundCount: 5,
        abortController: new AbortController(),
      }),
    ).toBe(false);
  });

  it("returns false when no background agent is pending", () => {
    expect(
      shouldBypassQueue({
        isProcessing: true,
        pendingBackgroundCount: 0,
        abortController: new AbortController(),
      }),
    ).toBe(false);
  });

  it("returns false when no abortController exists (can't abort)", () => {
    expect(
      shouldBypassQueue({
        isProcessing: true,
        pendingBackgroundCount: 2,
        abortController: null,
      }),
    ).toBe(false);
  });

  it("returns true when processing, background pending, and abortable", () => {
    expect(
      shouldBypassQueue({
        isProcessing: true,
        pendingBackgroundCount: 1,
        abortController: new AbortController(),
      }),
    ).toBe(true);
  });

  it("returns true even with multiple pending agents", () => {
    expect(
      shouldBypassQueue({
        isProcessing: true,
        pendingBackgroundCount: 3,
        abortController: new AbortController(),
      }),
    ).toBe(true);
  });

  it("returns false if abortController is already aborted — nothing left to abort", () => {
    const ac = new AbortController();
    ac.abort();
    expect(
      shouldBypassQueue({
        isProcessing: true,
        pendingBackgroundCount: 1,
        abortController: ac,
      }),
    ).toBe(false);
  });
});

describe("shouldBypassSdkResume (v4.12.3)", () => {
  it("returns true when pendingBackgroundCount > 0 — old SDK session is blocked, need fresh", () => {
    expect(shouldBypassSdkResume({ pendingBackgroundCount: 1 })).toBe(true);
    expect(shouldBypassSdkResume({ pendingBackgroundCount: 5 })).toBe(true);
  });

  it("returns false when no background pending — safe to resume", () => {
    expect(shouldBypassSdkResume({ pendingBackgroundCount: 0 })).toBe(false);
  });
});

describe("waitUntilProcessingFalse (v4.12.3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves immediately when already not processing", async () => {
    const session = { isProcessing: false };
    const p = waitUntilProcessingFalse(session, 5000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe(true);
  });

  it("waits until isProcessing flips, then resolves true", async () => {
    const session = { isProcessing: true };
    const p = waitUntilProcessingFalse(session, 5000);
    await vi.advanceTimersByTimeAsync(200);
    session.isProcessing = false;
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe(true);
  });

  it("gives up after timeout if still processing, resolves false", async () => {
    const session = { isProcessing: true };
    const p = waitUntilProcessingFalse(session, 1000);
    await vi.advanceTimersByTimeAsync(1100);
    await expect(p).resolves.toBe(false);
  });

  it("uses the provided tick interval (default 50ms)", async () => {
    const session = { isProcessing: true };
    const p = waitUntilProcessingFalse(session, 500, 25);
    // Flip after 130ms of "waiting" — should detect on the next 25ms tick
    await vi.advanceTimersByTimeAsync(130);
    session.isProcessing = false;
    await vi.advanceTimersByTimeAsync(30);
    await expect(p).resolves.toBe(true);
  });
});
