/**
 * v4.12.0 — Multi-session end-to-end stress tests.
 *
 * Covers the full stack: workspace registry + session key + resolver +
 * persistence + cost aggregation. Validates that parallel sessions
 * across different channels/workspaces stay isolated, survive bot
 * restart, and report correct aggregated metrics.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-multi-stress-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(resolve(TEST_DATA_DIR, "workspaces"), { recursive: true });
  fs.mkdirSync(resolve(TEST_DATA_DIR, "memory"), { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  process.env.SESSION_MODE = "per-channel";
  vi.resetModules();
});

afterEach(() => {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeWs(name: string, purpose: string, body: string, channels: string[] = []): void {
  const fm = [
    `purpose: ${JSON.stringify(purpose)}`,
    `cwd: ${JSON.stringify("~/tmp/" + name)}`,
    channels.length > 0 ? `channels: ${JSON.stringify(channels)}` : "",
  ].filter(Boolean).join("\n");
  fs.writeFileSync(
    resolve(TEST_DATA_DIR, "workspaces", `${name}.md`),
    `---\n${fm}\n---\n${body}`,
  );
}

describe("multi-session stress (v4.12.0)", () => {
  it("5 parallel Slack channels each get isolated sessions", async () => {
    writeWs("my-project", "my-project dev", "my-project persona", ["C_ALEV"]);
    writeWs("homes", "HOMES SaaS", "HOMES persona", ["C_HOMES"]);
    writeWs("my-landing", "my-landing app", "my-landing persona", ["C_JOBS"]);
    writeWs("perseus", "Trading bot", "Perseus persona", ["C_PERSEUS"]);
    writeWs("alvin", "Bot development", "Alvin persona", ["C_ALVIN"]);

    const { initWorkspaces, resolveWorkspaceOrDefault } = await import("../src/services/workspaces.js");
    const { buildSessionKey, getSession } = await import("../src/services/session.js");
    initWorkspaces();

    const channels = [
      { id: "C_ALEV", ws: "my-project" },
      { id: "C_HOMES", ws: "homes" },
      { id: "C_JOBS", ws: "my-landing" },
      { id: "C_PERSEUS", ws: "perseus" },
      { id: "C_ALVIN", ws: "alvin" },
    ];

    for (const { id, ws } of channels) {
      const workspace = resolveWorkspaceOrDefault("slack", id, undefined);
      expect(workspace.name).toBe(ws);
      const sessionKey = buildSessionKey("slack", id, "U_ALI");
      const session = getSession(sessionKey);
      session.workspaceName = workspace.name;
      session.workingDir = workspace.cwd;
      session.history.push({ role: "user", content: `hello from ${ws}` });
      session.sessionId = `sdk-${ws}`;
      session.totalCost = Math.random() * 0.1;
      session.messageCount = 1;
    }

    // Verify isolation: each session key is unique, each has its own workspace
    const { getAllSessions } = await import("../src/services/session.js");
    const allSessions = getAllSessions();
    const slackSessions = Array.from(allSessions.entries()).filter(([k]) => k.startsWith("slack:"));
    expect(slackSessions).toHaveLength(5);
    const wsNames = new Set(slackSessions.map(([, s]) => s.workspaceName));
    expect(wsNames.size).toBe(5);
  });

  it("survives full restart: 5 workspaces + 5 sessions persisted and rehydrated", async () => {
    writeWs("my-project", "my-project", "persona", ["C_ALEV"]);
    writeWs("homes", "HOMES", "persona", ["C_HOMES"]);
    writeWs("my-landing", "my-landing", "persona", ["C_JOBS"]);
    writeWs("perseus", "Perseus", "persona", ["C_PERSEUS"]);
    writeWs("alvin", "Alvin", "persona", ["C_ALVIN"]);

    const { initWorkspaces, resolveWorkspaceOrDefault } = await import("../src/services/workspaces.js");
    const { buildSessionKey, getSession } = await import("../src/services/session.js");
    const { flushSessions } = await import("../src/services/session-persistence.js");
    initWorkspaces();

    for (const id of ["C_ALEV", "C_HOMES", "C_JOBS", "C_PERSEUS", "C_ALVIN"]) {
      const ws = resolveWorkspaceOrDefault("slack", id, undefined);
      const key = buildSessionKey("slack", id, "U_ALI");
      const s = getSession(key);
      s.sessionId = `sdk-${ws.name}`;
      s.workspaceName = ws.name;
      s.workingDir = ws.cwd;
      s.history = [
        { role: "user", content: `persistent ${ws.name}` },
        { role: "assistant", content: `ack ${ws.name}` },
      ];
    }
    await flushSessions();

    // Simulate restart
    vi.resetModules();
    const s2 = await import("../src/services/session.js");
    const p2 = await import("../src/services/session-persistence.js");
    const loaded = p2.loadPersistedSessions();
    expect(loaded).toBe(5);

    for (const id of ["C_ALEV", "C_HOMES", "C_JOBS", "C_PERSEUS", "C_ALVIN"]) {
      const key = `slack:${id}`;
      const s = s2.getSession(key);
      expect(s.sessionId).toMatch(/^sdk-/);
      expect(s.history).toHaveLength(2);
      expect(s.workspaceName).not.toBeNull();
    }
  });

  it("getCostByWorkspace aggregates across sessions correctly", async () => {
    const { getSession, getCostByWorkspace } = await import("../src/services/session.js");

    const a = getSession("slack:C_A");
    a.workspaceName = "my-project";
    a.totalCost = 0.10;
    a.messageCount = 3;
    a.toolUseCount = 5;

    const b = getSession("slack:C_B");
    b.workspaceName = "my-project";
    b.totalCost = 0.05;
    b.messageCount = 2;
    b.toolUseCount = 1;

    const c = getSession("slack:C_C");
    c.workspaceName = "homes";
    c.totalCost = 0.25;
    c.messageCount = 10;
    c.toolUseCount = 8;

    const breakdown = getCostByWorkspace();
    expect(breakdown["my-project"].sessionCount).toBe(2);
    expect(breakdown["my-project"].messageCount).toBe(5);
    expect(breakdown["my-project"].toolUseCount).toBe(6);
    expect(breakdown["my-project"].totalCost).toBeCloseTo(0.15, 10);
    expect(breakdown["homes"].sessionCount).toBe(1);
    expect(breakdown["homes"].messageCount).toBe(10);
    expect(breakdown["homes"].toolUseCount).toBe(8);
    expect(breakdown["homes"].totalCost).toBeCloseTo(0.25, 10);
  });

  it("workspaces hot-reload picks up a new channel ID", async () => {
    writeWs("my-project", "my-project", "persona");
    const { initWorkspaces, resolveWorkspaceOrDefault, reloadWorkspaces } =
      await import("../src/services/workspaces.js");
    initWorkspaces();

    // Initially no channel mapping → default
    let ws = resolveWorkspaceOrDefault("slack", "C_NEW", undefined);
    expect(ws.name).toBe("default");

    // Add channel to config + reload
    writeWs("my-project", "my-project", "persona", ["C_NEW"]);
    reloadWorkspaces();

    ws = resolveWorkspaceOrDefault("slack", "C_NEW", undefined);
    expect(ws.name).toBe("my-project");
  });

  it("channel-name fallback finds workspace when no explicit ID mapping", async () => {
    writeWs("my-project", "my-project", "persona");
    const { initWorkspaces, resolveWorkspaceOrDefault } = await import("../src/services/workspaces.js");
    initWorkspaces();

    const ws = resolveWorkspaceOrDefault("slack", "C_UNMAPPED", "#my-project");
    expect(ws.name).toBe("my-project");
  });

  it("malformed workspace doesn't break loading of other workspaces", async () => {
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "workspaces", "broken.md"),
      "---\n{{{{ not yaml at all }}}}\n---\n",
    );
    writeWs("good", "good one", "body");
    const { initWorkspaces, listWorkspaces } = await import("../src/services/workspaces.js");
    initWorkspaces();
    const names = listWorkspaces().map(w => w.name);
    expect(names).toContain("good");
  });

  it("unicode in workspace filenames + bodies works", async () => {
    writeWs("café-int", "Café International ☕️", "Emoji persona 🦊", ["C_CAFE"]);
    const { initWorkspaces, resolveWorkspaceOrDefault } = await import("../src/services/workspaces.js");
    initWorkspaces();
    const ws = resolveWorkspaceOrDefault("slack", "C_CAFE", undefined);
    expect(ws.name).toBe("café-int");
    expect(ws.purpose).toContain("☕");
    expect(ws.systemPromptOverride).toContain("🦊");
  });

  it("workspace with no cwd frontmatter falls back to config.defaultWorkingDir", async () => {
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "workspaces", "no-cwd.md"),
      "---\npurpose: test\n---\nbody",
    );
    const { initWorkspaces, getWorkspace } = await import("../src/services/workspaces.js");
    initWorkspaces();
    const ws = getWorkspace("no-cwd");
    expect(ws!.cwd).toBeTruthy();
    expect(ws!.cwd.length).toBeGreaterThan(0);
  });

  it("session with workspaceName: null aggregates under 'default' in breakdown", async () => {
    const { getSession, getCostByWorkspace } = await import("../src/services/session.js");
    const s = getSession("slack:C_UNKNOWN");
    s.workspaceName = null;
    s.totalCost = 0.42;
    s.messageCount = 7;

    const breakdown = getCostByWorkspace();
    expect(breakdown["default"]).toBeDefined();
    expect(breakdown["default"].totalCost).toBeGreaterThanOrEqual(0.42);
  });

  it("simulated restart + workspace switch: workspaceName persists across flush cycles", async () => {
    writeWs("my-project", "my-project", "persona", ["C_ALEV"]);
    const { initWorkspaces, resolveWorkspaceOrDefault } = await import("../src/services/workspaces.js");
    const { buildSessionKey, getSession } = await import("../src/services/session.js");
    const { flushSessions } = await import("../src/services/session-persistence.js");
    initWorkspaces();

    const key = buildSessionKey("slack", "C_ALEV", "U_ALI");
    const s = getSession(key);
    const ws = resolveWorkspaceOrDefault("slack", "C_ALEV", undefined);
    s.sessionId = "alev-resume";
    s.workspaceName = ws.name;
    s.workingDir = ws.cwd;
    await flushSessions();

    vi.resetModules();
    const s2 = await import("../src/services/session.js");
    const p2 = await import("../src/services/session-persistence.js");
    p2.loadPersistedSessions();

    const restored = s2.getSession("slack:C_ALEV");
    expect(restored.sessionId).toBe("alev-resume");
    expect(restored.workspaceName).toBe("my-project");
    expect(restored.workingDir).toContain("my-project");
  });
});
