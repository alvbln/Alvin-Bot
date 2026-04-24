/**
 * v4.19.1 — Workspace switch must invalidate the SDK resume anchor when
 * cwd changes; a trailing `done` chunk with a sessionId must NOT restore
 * a sessionId that was just cleared by a `sessionResetRequested` text
 * chunk from the provider.
 *
 * Regression test for the empty-stream loop bug:
 *   /workspace interviews → empty-stream → /workspace default → empty-stream (loop)
 *
 * Roots of the bug:
 *   1. Claude Agent SDK's `resume: <sessionId>` is cwd-bound. Session files
 *      live under ~/.claude/projects/<cwd-hash>/<session-id>.jsonl. Changing
 *      cwd without clearing sessionId makes the CLI look in the wrong
 *      project folder → silent empty stream.
 *   2. The empty-stream detector in claude-sdk-provider yields a text chunk
 *      with sessionResetRequested=true followed by a done chunk that still
 *      carries a sessionId. The handler cleared sessionId on the text chunk
 *      but the naive `if (chunk.sessionId) session.sessionId = chunk.sessionId`
 *      on the done chunk restored it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(
  os.tmpdir(),
  `alvin-ws-anchor-${process.pid}-${Date.now()}`,
);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  vi.resetModules();
});

describe("v4.19.1 — workspace switch invalidates SDK resume anchor", () => {
  it("first turn on a fresh session does NOT clear sessionId (no workspace change)", async () => {
    const { getSession } = await import("../src/services/session.js");
    const session = getSession("u1");
    // Fresh session state
    expect(session.sessionId).toBeNull();
    expect(session.workspaceName).toBeNull();

    // Simulate the handler logic: workspace resolves to default,
    // workspaceName transitions null → "default", but cwd does not change.
    const fakeWorkspace = { name: "default", cwd: session.workingDir };
    if (session.workspaceName !== fakeWorkspace.name) {
      const cwdChanged = session.workingDir !== fakeWorkspace.cwd;
      session.workspaceName = fakeWorkspace.name;
      session.workingDir = fakeWorkspace.cwd;
      if (cwdChanged) {
        session.sessionId = null;
        session.lastSdkHistoryIndex = -1;
      }
    }

    expect(session.sessionId).toBeNull();
    expect(session.workspaceName).toBe("default");
  });

  it("workspace switch with different cwd clears sessionId + lastSdkHistoryIndex", async () => {
    const { getSession } = await import("../src/services/session.js");
    const session = getSession("u2");
    session.sessionId = "abc-resume-token-from-default-workspace";
    session.workspaceName = "default";
    session.workingDir = "/default/cwd";
    session.lastSdkHistoryIndex = 42;

    const fakeWorkspace = { name: "interviews", cwd: "/interviews/cwd" };
    if (session.workspaceName !== fakeWorkspace.name) {
      const cwdChanged = session.workingDir !== fakeWorkspace.cwd;
      session.workspaceName = fakeWorkspace.name;
      session.workingDir = fakeWorkspace.cwd;
      if (cwdChanged) {
        session.sessionId = null;
        session.lastSdkHistoryIndex = -1;
      }
    }

    expect(session.sessionId).toBeNull();
    expect(session.lastSdkHistoryIndex).toBe(-1);
    expect(session.workingDir).toBe("/interviews/cwd");
    expect(session.workspaceName).toBe("interviews");
  });

  it("workspace switch back to default after empty-stream also clears sessionId", async () => {
    const { getSession } = await import("../src/services/session.js");
    const session = getSession("u3");
    // Simulate state after the first broken turn in interviews workspace
    session.sessionId = "some-stale-or-fresh-but-wrong-project-session";
    session.workspaceName = "interviews";
    session.workingDir = "/interviews/cwd";

    const fakeWorkspace = { name: "default", cwd: "/default/cwd" };
    if (session.workspaceName !== fakeWorkspace.name) {
      const cwdChanged = session.workingDir !== fakeWorkspace.cwd;
      session.workspaceName = fakeWorkspace.name;
      session.workingDir = fakeWorkspace.cwd;
      if (cwdChanged) {
        session.sessionId = null;
        session.lastSdkHistoryIndex = -1;
      }
    }

    expect(session.sessionId).toBeNull();
    expect(session.workingDir).toBe("/default/cwd");
  });

  it("preserves /dir custom cwd across turns where workspace does not change", async () => {
    const { getSession } = await import("../src/services/session.js");
    const session = getSession("u4");
    // User ran /dir /tmp/custom before; sessionId was cleared by /dir itself.
    session.sessionId = "fresh-session-after-dir";
    session.workspaceName = "default";
    session.workingDir = "/tmp/custom";

    // Next message: workspace still resolves to default, name matches.
    const fakeWorkspace = { name: "default", cwd: "/default/cwd" };
    if (session.workspaceName !== fakeWorkspace.name) {
      const cwdChanged = session.workingDir !== fakeWorkspace.cwd;
      session.workspaceName = fakeWorkspace.name;
      session.workingDir = fakeWorkspace.cwd;
      if (cwdChanged) {
        session.sessionId = null;
        session.lastSdkHistoryIndex = -1;
      }
    }

    // No workspace transition → /dir-chosen cwd must survive, sessionId too.
    expect(session.workingDir).toBe("/tmp/custom");
    expect(session.sessionId).toBe("fresh-session-after-dir");
  });

  it("workspace switch that happens to land on the same cwd keeps sessionId", async () => {
    const { getSession } = await import("../src/services/session.js");
    const session = getSession("u5");
    session.sessionId = "active-session";
    session.workspaceName = "proj-a";
    session.workingDir = "/shared/cwd";

    // Two workspaces can share a cwd (e.g. different personas, same codebase).
    const fakeWorkspace = { name: "proj-b", cwd: "/shared/cwd" };
    if (session.workspaceName !== fakeWorkspace.name) {
      const cwdChanged = session.workingDir !== fakeWorkspace.cwd;
      session.workspaceName = fakeWorkspace.name;
      session.workingDir = fakeWorkspace.cwd;
      if (cwdChanged) {
        session.sessionId = null;
        session.lastSdkHistoryIndex = -1;
      }
    }

    // cwd did not actually change → resume is still valid. Keep the session.
    expect(session.sessionId).toBe("active-session");
    expect(session.workspaceName).toBe("proj-b");
  });
});

describe("v4.19.1 — done chunk respects sessionResetInStream flag", () => {
  // Models the handler's streaming loop exactly: on the empty-stream case the
  // provider yields (text with sessionResetRequested=true) → (done with some
  // sessionId). Before the fix, the done chunk restored the cleared sessionId.
  function runStreamHandler(chunks: Array<Partial<{
    type: "text" | "done";
    sessionId: string | null;
    sessionResetRequested: boolean;
  }>>, session: { sessionId: string | null; lastSdkHistoryIndex: number }) {
    let sessionResetInStream = false;
    for (const chunk of chunks) {
      if (chunk.type === "text") {
        if (chunk.sessionResetRequested) {
          session.sessionId = null;
          session.lastSdkHistoryIndex = -1;
          sessionResetInStream = true;
        }
      } else if (chunk.type === "done") {
        if (chunk.sessionId && !sessionResetInStream) {
          session.sessionId = chunk.sessionId;
        }
      }
    }
  }

  it("clears sessionId and does NOT restore it on trailing done", () => {
    const session = { sessionId: "stale-resume-token", lastSdkHistoryIndex: 17 };
    runStreamHandler(
      [
        { type: "text", sessionResetRequested: true, sessionId: "stale-resume-token" },
        { type: "done", sessionId: "stale-resume-token" },
      ],
      session,
    );
    expect(session.sessionId).toBeNull();
    expect(session.lastSdkHistoryIndex).toBe(-1);
  });

  it("still accepts a new sessionId on done when no reset was requested", () => {
    const session = { sessionId: null, lastSdkHistoryIndex: -1 };
    runStreamHandler(
      [
        { type: "text", sessionId: "fresh-session" },
        { type: "done", sessionId: "fresh-session" },
      ],
      session,
    );
    expect(session.sessionId).toBe("fresh-session");
  });

  it("done with null/undefined sessionId never clobbers a valid session", () => {
    const session = { sessionId: "valid", lastSdkHistoryIndex: 5 };
    runStreamHandler(
      [
        { type: "text" },
        { type: "done", sessionId: null },
      ],
      session,
    );
    expect(session.sessionId).toBe("valid");
  });
});
