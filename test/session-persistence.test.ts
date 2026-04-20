/**
 * v4.11.0 — Session persistence across bot restarts.
 *
 * Sessions live in an in-memory Map that gets wiped on every bot restart.
 * This persistence layer flushes the Map to disk (debounced) and rehydrates
 * it on bot startup so Claude SDK's `resume: sessionId` keeps working,
 * conversation history survives, and user preferences (language, effort,
 * voiceReply) don't reset.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-session-persist-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  vi.resetModules();
});

afterEach(() => {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("session-persistence (v4.11.0)", () => {
  it("flushSessions writes a JSON file with all session fields that survive restart", async () => {
    const sessionMod = await import("../src/services/session.js");
    const persistMod = await import("../src/services/session-persistence.js");

    const s = sessionMod.getSession("user-1");
    s.sessionId = "sdk-abc-123";
    s.language = "de";
    s.effort = "high";
    s.voiceReply = true;
    s.workingDir = "/tmp/test-cwd";
    s.history = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];

    await persistMod.flushSessions();

    const stateFile = resolve(TEST_DATA_DIR, "state", "sessions.json");
    expect(fs.existsSync(stateFile)).toBe(true);

    // v4.12.0 — Format is now an envelope: { version: 2, sessions: {...}, telegramWorkspaces: {...} }
    const envelope = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(envelope.version).toBe(2);
    const parsed = envelope.sessions;
    expect(parsed).toHaveProperty("user-1");
    expect(parsed["user-1"].sessionId).toBe("sdk-abc-123");
    expect(parsed["user-1"].language).toBe("de");
    expect(parsed["user-1"].effort).toBe("high");
    expect(parsed["user-1"].voiceReply).toBe(true);
    expect(parsed["user-1"].history).toHaveLength(2);
  });

  it("loadPersistedSessions rehydrates the sessions Map from disk", async () => {
    fs.mkdirSync(resolve(TEST_DATA_DIR, "state"), { recursive: true });
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "state", "sessions.json"),
      JSON.stringify({
        "user-7": {
          sessionId: "sdk-restored",
          language: "en",
          effort: "medium",
          voiceReply: false,
          workingDir: "/home/test",
          lastActivity: Date.now() - 60_000,
          lastSdkHistoryIndex: 3,
          history: [{ role: "user", content: "from past life" }],
          messageCount: 5,
          toolUseCount: 2,
        },
      }),
    );

    const persistMod = await import("../src/services/session-persistence.js");
    const sessionMod = await import("../src/services/session.js");

    const loaded = persistMod.loadPersistedSessions();
    expect(loaded).toBe(1);

    const s = sessionMod.getSession("user-7");
    expect(s.sessionId).toBe("sdk-restored");
    expect(s.language).toBe("en");
    expect(s.history).toHaveLength(1);
    expect(s.history[0].content).toBe("from past life");
    expect(s.messageCount).toBe(5);
  });

  it("survives a corrupt sessions.json file (does not crash)", async () => {
    fs.mkdirSync(resolve(TEST_DATA_DIR, "state"), { recursive: true });
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "state", "sessions.json"),
      "{ this is not valid json",
    );

    const persistMod = await import("../src/services/session-persistence.js");
    const loaded = persistMod.loadPersistedSessions();
    expect(loaded).toBe(0);
  });

  it("survives missing sessions.json file (returns 0 loaded)", async () => {
    const persistMod = await import("../src/services/session-persistence.js");
    const loaded = persistMod.loadPersistedSessions();
    expect(loaded).toBe(0);
  });

  it("does NOT persist runtime-only fields (abortController, isProcessing)", async () => {
    const sessionMod = await import("../src/services/session.js");
    const persistMod = await import("../src/services/session-persistence.js");

    const s = sessionMod.getSession("user-2");
    s.isProcessing = true;
    s.abortController = new AbortController();
    s.sessionId = "abc";

    await persistMod.flushSessions();

    const stateFile = resolve(TEST_DATA_DIR, "state", "sessions.json");
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf-8")).sessions;
    expect(parsed["user-2"]).not.toHaveProperty("abortController");
    expect(parsed["user-2"]).not.toHaveProperty("isProcessing");
    expect(parsed["user-2"].sessionId).toBe("abc");
  });

  it("caps history at MAX_PERSISTED_HISTORY (50) so the file doesn't grow unbounded", async () => {
    const sessionMod = await import("../src/services/session.js");
    const persistMod = await import("../src/services/session-persistence.js");

    const s = sessionMod.getSession("user-3");
    s.sessionId = "needs-some-state-to-be-persisted";
    for (let i = 0; i < 200; i++) {
      s.history.push({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` });
    }

    await persistMod.flushSessions();

    const parsed = JSON.parse(fs.readFileSync(resolve(TEST_DATA_DIR, "state", "sessions.json"), "utf-8")).sessions;
    expect(parsed["user-3"].history.length).toBeLessThanOrEqual(50);
    // Last message should still be there
    expect(parsed["user-3"].history.at(-1).content).toContain("199");
  });

  it("debounce: schedulePersist coalesces multiple rapid mutations into one flush", async () => {
    const persistMod = await import("../src/services/session-persistence.js");
    const sessionMod = await import("../src/services/session.js");

    sessionMod.getSession("user-4").sessionId = "v1";
    persistMod.schedulePersist();
    sessionMod.getSession("user-4").sessionId = "v2";
    persistMod.schedulePersist();
    sessionMod.getSession("user-4").sessionId = "v3";
    persistMod.schedulePersist();

    // Force the debounced flush
    await persistMod.flushSessions();

    const parsed = JSON.parse(fs.readFileSync(resolve(TEST_DATA_DIR, "state", "sessions.json"), "utf-8")).sessions;
    expect(parsed["user-4"].sessionId).toBe("v3");
  });

  it("atomic write: tmp+rename, never leaves a half-written file on crash", async () => {
    const persistMod = await import("../src/services/session-persistence.js");
    const sessionMod = await import("../src/services/session.js");

    sessionMod.getSession("user-5").sessionId = "abc";
    await persistMod.flushSessions();

    // After successful flush: no .tmp leftover
    const tmpFile = resolve(TEST_DATA_DIR, "state", "sessions.json.tmp");
    expect(fs.existsSync(tmpFile)).toBe(false);
    expect(fs.existsSync(resolve(TEST_DATA_DIR, "state", "sessions.json"))).toBe(true);
  });

  it("does not persist sessions that have never been activated (only defaults)", async () => {
    const sessionMod = await import("../src/services/session.js");
    const persistMod = await import("../src/services/session-persistence.js");

    // Touching getSession creates an empty default session — but we don't want to
    // persist it if it has no meaningful state (no sessionId, no history)
    sessionMod.getSession("noop-user");
    await persistMod.flushSessions();

    const stateFile = resolve(TEST_DATA_DIR, "state", "sessions.json");
    if (fs.existsSync(stateFile)) {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf-8")).sessions;
      expect(parsed).not.toHaveProperty("noop-user");
    }
  });
});
