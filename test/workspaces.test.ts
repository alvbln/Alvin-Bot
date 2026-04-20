/**
 * v4.12.0 — Workspace registry tests.
 *
 * A workspace is a markdown file under ~/.alvin-bot/workspaces/<name>.md
 * with YAML frontmatter defining name, purpose, cwd, color, emoji, and
 * an optional "channels" array for explicit channel-ID mapping. The
 * markdown body (below the frontmatter) is the persona instruction
 * that gets injected into the system prompt for that workspace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-workspaces-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.mkdirSync(resolve(TEST_DATA_DIR, "workspaces"), { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  vi.resetModules();
});

afterEach(() => {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeWorkspace(name: string, frontmatter: Record<string, unknown>, body: string): void {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : JSON.stringify(v)}`)
    .join("\n");
  const content = `---\n${fm}\n---\n${body}`;
  fs.writeFileSync(resolve(TEST_DATA_DIR, "workspaces", `${name}.md`), content, "utf-8");
}

describe("workspace registry (v4.12.0)", () => {
  it("returns a default workspace when nothing is configured", async () => {
    const { loadWorkspaces, getDefaultWorkspace } = await import("../src/services/workspaces.js");
    loadWorkspaces();
    const def = getDefaultWorkspace();
    expect(def.name).toBe("default");
    expect(def.purpose).toBe("");
    expect(def.systemPromptOverride).toBe("");
  });

  it("loads a workspace from a markdown file with frontmatter", async () => {
    writeWorkspace(
      "my-project",
      { purpose: "my-project consulting website dev", cwd: "~/Projects/my-project-website", emoji: "🏢", color: "#6366f1" },
      "You are the my-project dev assistant. Stack: React + Express + Drizzle.",
    );
    const { loadWorkspaces, getWorkspace } = await import("../src/services/workspaces.js");
    loadWorkspaces();
    const ws = getWorkspace("my-project");
    expect(ws).not.toBeNull();
    expect(ws!.name).toBe("my-project");
    expect(ws!.purpose).toBe("my-project consulting website dev");
    expect(ws!.cwd).toContain("my-project-website");
    expect(ws!.emoji).toBe("🏢");
    expect(ws!.color).toBe("#6366f1");
    expect(ws!.systemPromptOverride).toContain("my-project dev assistant");
  });

  it("loads multiple workspaces and listWorkspaces returns all of them", async () => {
    writeWorkspace("my-project", { purpose: "p1" }, "body1");
    writeWorkspace("homes", { purpose: "p2" }, "body2");
    writeWorkspace("my-landing", { purpose: "p3" }, "body3");
    const { loadWorkspaces, listWorkspaces } = await import("../src/services/workspaces.js");
    loadWorkspaces();
    const names = listWorkspaces().map(w => w.name).sort();
    expect(names).toEqual(["homes", "my-landing", "my-project"]);
  });

  it("expands ~ in cwd to the user's home directory", async () => {
    writeWorkspace("tilde", { purpose: "p", cwd: "~/some/path" }, "");
    const { loadWorkspaces, getWorkspace } = await import("../src/services/workspaces.js");
    loadWorkspaces();
    const ws = getWorkspace("tilde");
    expect(ws!.cwd).toBe(resolve(os.homedir(), "some/path"));
    expect(ws!.cwd).not.toContain("~");
  });

  it("matchWorkspaceForChannel matches by explicit channel ID in frontmatter", async () => {
    writeWorkspace(
      "my-project",
      { purpose: "p", channels: ["C01ALEVABC", "C01ALEVXYZ"] },
      "",
    );
    const { loadWorkspaces, matchWorkspaceForChannel } = await import("../src/services/workspaces.js");
    loadWorkspaces();
    const ws = matchWorkspaceForChannel("slack", "C01ALEVABC", undefined);
    expect(ws?.name).toBe("my-project");
  });

  it("matchWorkspaceForChannel falls back to channel name match (case-insensitive, # stripped)", async () => {
    writeWorkspace("my-project", { purpose: "p" }, "");
    const { loadWorkspaces, matchWorkspaceForChannel } = await import("../src/services/workspaces.js");
    loadWorkspaces();
    const byHash = matchWorkspaceForChannel("slack", "C_UNKNOWN", "#my-project");
    const noHash = matchWorkspaceForChannel("slack", "C_UNKNOWN", "MY-PROJECT");
    expect(byHash?.name).toBe("my-project");
    expect(noHash?.name).toBe("my-project");
  });

  it("matchWorkspaceForChannel returns null for unknown channel with no name match", async () => {
    writeWorkspace("my-project", { purpose: "p" }, "");
    const { loadWorkspaces, matchWorkspaceForChannel } = await import("../src/services/workspaces.js");
    loadWorkspaces();
    const ws = matchWorkspaceForChannel("slack", "C_MYSTERY", "#unmapped");
    expect(ws).toBeNull();
  });

  it("resolveWorkspaceOrDefault returns the matched workspace when one is found", async () => {
    writeWorkspace("my-project", { purpose: "p" }, "persona body");
    const { loadWorkspaces, resolveWorkspaceOrDefault } = await import("../src/services/workspaces.js");
    loadWorkspaces();
    const ws = resolveWorkspaceOrDefault("slack", "C_UNKNOWN", "#my-project");
    expect(ws.name).toBe("my-project");
    expect(ws.systemPromptOverride).toContain("persona body");
  });

  it("resolveWorkspaceOrDefault returns the default workspace when no match", async () => {
    const { loadWorkspaces, resolveWorkspaceOrDefault } = await import("../src/services/workspaces.js");
    loadWorkspaces();
    const ws = resolveWorkspaceOrDefault("slack", "C_UNKNOWN", "#whatever");
    expect(ws.name).toBe("default");
  });

  it("reloadWorkspaces picks up a newly created file", async () => {
    const { loadWorkspaces, reloadWorkspaces, listWorkspaces } = await import("../src/services/workspaces.js");
    loadWorkspaces();
    expect(listWorkspaces()).toHaveLength(0);
    writeWorkspace("new-one", { purpose: "p" }, "body");
    reloadWorkspaces();
    expect(listWorkspaces()).toHaveLength(1);
    expect(listWorkspaces()[0].name).toBe("new-one");
  });

  it("skips files that aren't .md", async () => {
    fs.writeFileSync(resolve(TEST_DATA_DIR, "workspaces", "notes.txt"), "ignored");
    writeWorkspace("real", { purpose: "p" }, "body");
    const { loadWorkspaces, listWorkspaces } = await import("../src/services/workspaces.js");
    loadWorkspaces();
    expect(listWorkspaces()).toHaveLength(1);
    expect(listWorkspaces()[0].name).toBe("real");
  });

  it("malformed frontmatter: workspace is skipped or loaded with defaults, other workspaces still load", async () => {
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "workspaces", "broken.md"),
      "---\nthis is: not: valid: yaml:\n---\nbody",
    );
    writeWorkspace("good", { purpose: "p" }, "body");
    const { loadWorkspaces, listWorkspaces } = await import("../src/services/workspaces.js");
    loadWorkspaces();
    const names = listWorkspaces().map(w => w.name);
    expect(names).toContain("good");
  });

  it("missing workspaces directory is handled gracefully", async () => {
    fs.rmSync(resolve(TEST_DATA_DIR, "workspaces"), { recursive: true, force: true });
    const { loadWorkspaces, listWorkspaces } = await import("../src/services/workspaces.js");
    const count = loadWorkspaces();
    expect(count).toBe(0);
    expect(listWorkspaces()).toEqual([]);
  });
});

describe("workspace resolver integration with session (v4.12.0)", () => {
  it("two channels resolve to two different workspaces", async () => {
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "workspaces", "my-project.md"),
      `---\npurpose: project-a\ncwd: ~/tmp/project-a\nchannels: ["C_PROJECT_A"]\n---\nproject-a persona`,
    );
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "workspaces", "project-b.md"),
      `---\npurpose: project-b\ncwd: ~/tmp/project-b\nchannels: ["C_PROJECT_B"]\n---\nproject-b persona`,
    );

    vi.resetModules();
    const { initWorkspaces, resolveWorkspaceOrDefault } = await import("../src/services/workspaces.js");
    initWorkspaces();

    const a = resolveWorkspaceOrDefault("slack", "C_PROJECT_A", undefined);
    const b = resolveWorkspaceOrDefault("slack", "C_PROJECT_B", undefined);
    const unknown = resolveWorkspaceOrDefault("slack", "C_MYSTERY", undefined);

    expect(a.name).toBe("my-project");
    expect(a.systemPromptOverride).toBe("project-a persona");
    expect(b.name).toBe("project-b");
    expect(b.systemPromptOverride).toBe("project-b persona");
    expect(unknown.name).toBe("default");
    expect(unknown.systemPromptOverride).toBe("");
  });
});
