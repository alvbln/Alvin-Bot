/**
 * v4.12.0 — Telegram /workspace command + workspace-aware session key.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-tgws-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(resolve(TEST_DATA_DIR, "workspaces"), { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  vi.resetModules();
});

describe("Telegram workspace state (v4.12.0)", () => {
  it("getTelegramWorkspace returns null by default", async () => {
    const { getTelegramWorkspace } = await import("../src/services/session.js");
    expect(getTelegramWorkspace("42")).toBeNull();
  });

  it("setTelegramWorkspace stores the name", async () => {
    const { getTelegramWorkspace, setTelegramWorkspace } = await import("../src/services/session.js");
    setTelegramWorkspace("42", "my-project");
    expect(getTelegramWorkspace("42")).toBe("my-project");
  });

  it("setTelegramWorkspace(userId, null) clears the mapping", async () => {
    const { getTelegramWorkspace, setTelegramWorkspace } = await import("../src/services/session.js");
    setTelegramWorkspace("42", "my-project");
    setTelegramWorkspace("42", null);
    expect(getTelegramWorkspace("42")).toBeNull();
  });

  it("persistence: setTelegramWorkspace + flush + reload roundtrips", async () => {
    const { setTelegramWorkspace, attachPersistHook } = await import("../src/services/session.js");
    const { flushSessions, schedulePersist } = await import("../src/services/session-persistence.js");
    attachPersistHook(schedulePersist);

    setTelegramWorkspace("42", "my-project");
    setTelegramWorkspace("99", "homes");
    await flushSessions();

    vi.resetModules();
    const s2 = await import("../src/services/session.js");
    const p2 = await import("../src/services/session-persistence.js");
    p2.loadPersistedSessions();

    expect(s2.getTelegramWorkspace("42")).toBe("my-project");
    expect(s2.getTelegramWorkspace("99")).toBe("homes");
  });

  it("legacy flat session file still loads (backwards compat)", async () => {
    fs.mkdirSync(resolve(TEST_DATA_DIR, "state"), { recursive: true });
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "state", "sessions.json"),
      JSON.stringify({
        "legacy-user": {
          sessionId: "abc",
          history: [{ role: "user", content: "from v4.11 era" }],
          language: "en",
          effort: "medium",
          voiceReply: false,
          workingDir: "/tmp",
        },
      }),
    );

    const { loadPersistedSessions } = await import("../src/services/session-persistence.js");
    const { getSession } = await import("../src/services/session.js");
    const loaded = loadPersistedSessions();
    expect(loaded).toBe(1);
    expect(getSession("legacy-user").sessionId).toBe("abc");
    expect(getSession("legacy-user").history[0].content).toBe("from v4.11 era");
  });
});
