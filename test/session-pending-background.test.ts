/**
 * v4.12.3 — UserSession.pendingBackgroundCount
 *
 * When Claude launches an Agent/Task tool with run_in_background: true,
 * the SDK's CLI subprocess stays alive until the task-notification is
 * ready to deliver. During that window the main Telegram session is
 * effectively blocked — isProcessing=true, all new user messages get
 * queued. For 5-minute+ background tasks that's unacceptable UX.
 *
 * v4.12.3 tracks the count of pending background agents on each session
 * so the handler can detect the blocked state and bypass the SDK resume
 * (start a fresh SDK session for the new user message while the old
 * session drains in the background).
 *
 * The count is incremented by the message handler on async_launched
 * tool_result and decremented by the async-agent-watcher when it
 * delivers the sub-agent's result.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => vi.resetModules());

describe("UserSession.pendingBackgroundCount (v4.12.3)", () => {
  it("new session starts with pendingBackgroundCount=0", async () => {
    const { getSession } = await import("../src/services/session.js");
    const s = getSession("test-user-new");
    expect(s.pendingBackgroundCount).toBe(0);
  });

  it("incrementing on the session persists across getSession calls", async () => {
    const { getSession } = await import("../src/services/session.js");
    const s1 = getSession("test-user-inc");
    s1.pendingBackgroundCount = 2;
    const s2 = getSession("test-user-inc");
    expect(s2.pendingBackgroundCount).toBe(2);
    expect(s1).toBe(s2);
  });

  it("resetSession zeroes pendingBackgroundCount", async () => {
    const { getSession, resetSession } = await import("../src/services/session.js");
    const s = getSession("test-user-reset");
    s.pendingBackgroundCount = 3;
    resetSession("test-user-reset");
    expect(s.pendingBackgroundCount).toBe(0);
  });

  it("count can be decremented without going negative via explicit guard", async () => {
    // The handler/watcher code is responsible for not decrementing below
    // zero. This test just documents that the field is a plain number
    // with no built-in guard — decrement logic lives in the consumers.
    const { getSession } = await import("../src/services/session.js");
    const s = getSession("test-user-dec");
    s.pendingBackgroundCount = 1;
    s.pendingBackgroundCount = Math.max(0, s.pendingBackgroundCount - 1);
    expect(s.pendingBackgroundCount).toBe(0);
    s.pendingBackgroundCount = Math.max(0, s.pendingBackgroundCount - 1);
    expect(s.pendingBackgroundCount).toBe(0);
  });
});
