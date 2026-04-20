/**
 * v4.11.0 — Layered memory loader.
 *
 * Replaces the monolithic MEMORY.md → System Prompt with a structured
 * 4-layer architecture (inspired by mempalace's L0–L3 stack):
 *
 *   L0 identity.md      — always loaded, ~200 tokens (who the user is)
 *   L1 preferences.md   — always loaded (how to communicate)
 *   L1 MEMORY.md        — backwards-compat: existing curated knowledge
 *   L2 projects/*.md    — loaded on topic match
 *   L3 daily logs       — only via vector search (existing embeddings.ts)
 *
 * If the new files don't exist, this falls back to the monolithic MEMORY.md
 * so existing setups keep working without migration.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-mem-layers-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(resolve(TEST_DATA_DIR, "memory"), { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  vi.resetModules();
});

describe("memory-layers (v4.11.0)", () => {
  it("returns empty when nothing exists", async () => {
    const { loadMemoryLayers } = await import("../src/services/memory-layers.js");
    const layered = loadMemoryLayers();
    expect(layered.identity).toBe("");
    expect(layered.preferences).toBe("");
    expect(layered.longTerm).toBe("");
    expect(layered.projects).toEqual([]);
  });

  it("loads identity.md as L0 always", async () => {
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "identity.md"),
      "# Identity\n\nName: Test User\nLocation: Berlin",
    );
    const { loadMemoryLayers } = await import("../src/services/memory-layers.js");
    const layered = loadMemoryLayers();
    expect(layered.identity).toMatch(/Test User/);
  });

  it("loads preferences.md as L1 always", async () => {
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "preferences.md"),
      "- Reply in German\n- No 'Gerne' in responses",
    );
    const { loadMemoryLayers } = await import("../src/services/memory-layers.js");
    const layered = loadMemoryLayers();
    expect(layered.preferences).toMatch(/Reply in German/);
  });

  it("falls back to monolithic MEMORY.md when split files are missing", async () => {
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "MEMORY.md"),
      "# Old monolithic\n\n- Some legacy fact",
    );
    const { loadMemoryLayers } = await import("../src/services/memory-layers.js");
    const layered = loadMemoryLayers();
    expect(layered.longTerm).toMatch(/legacy fact/);
  });

  it("loads projects/*.md and exposes them with their filename as topic", async () => {
    fs.mkdirSync(resolve(TEST_DATA_DIR, "memory", "projects"), { recursive: true });
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "projects", "my-project.md"),
      "# my-project\nVPS: 10.0.0.1, runs nginx + pm2",
    );
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "projects", "homes.md"),
      "# HOMES\nDB: homes_production (Postgres)",
    );
    const { loadMemoryLayers } = await import("../src/services/memory-layers.js");
    const layered = loadMemoryLayers();
    expect(layered.projects).toHaveLength(2);
    const topics = layered.projects.map(p => p.topic).sort();
    expect(topics).toEqual(["homes", "my-project"]);
    expect(layered.projects.find(p => p.topic === "homes")?.content).toMatch(/homes_production/);
  });

  it("buildLayeredContext returns all L0+L1 plus matching L2 by topic keyword", async () => {
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "identity.md"),
      "Name: User",
    );
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "preferences.md"),
      "Be terse.",
    );
    fs.mkdirSync(resolve(TEST_DATA_DIR, "memory", "projects"), { recursive: true });
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "projects", "homes.md"),
      "HOMES uses Postgres",
    );
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "projects", "my-project.md"),
      "my-project uses MySQL",
    );

    const { buildLayeredContext } = await import("../src/services/memory-layers.js");

    // Query mentions HOMES → only the homes project should be loaded
    const ctx = buildLayeredContext("Tell me about HOMES backups");
    expect(ctx).toMatch(/Name: User/); // L0
    expect(ctx).toMatch(/Be terse/); // L1
    expect(ctx).toMatch(/HOMES uses Postgres/); // L2 matched
    expect(ctx).not.toMatch(/my-project uses MySQL/); // L2 not matched
  });

  it("buildLayeredContext without a query returns L0+L1 only (boot-up brief)", async () => {
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "identity.md"),
      "Name: User",
    );
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "preferences.md"),
      "Be terse.",
    );
    fs.mkdirSync(resolve(TEST_DATA_DIR, "memory", "projects"), { recursive: true });
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "projects", "homes.md"),
      "HOMES uses Postgres",
    );

    const { buildLayeredContext } = await import("../src/services/memory-layers.js");
    const ctx = buildLayeredContext();
    expect(ctx).toMatch(/Name: User/);
    expect(ctx).not.toMatch(/Postgres/); // L2 only loaded with a query
  });

  it("token budget: layered context truncates long projects to fit budget", async () => {
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "identity.md"),
      "Name: User",
    );
    fs.mkdirSync(resolve(TEST_DATA_DIR, "memory", "projects"), { recursive: true });
    const longContent = "homes ".repeat(2000); // ~10000 chars
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "projects", "homes.md"),
      longContent,
    );
    const { buildLayeredContext } = await import("../src/services/memory-layers.js");
    const ctx = buildLayeredContext("HOMES");
    // Total context should be capped (~6000 chars max for L0+L1+L2)
    expect(ctx.length).toBeLessThan(8000);
  });

  it("monolithic MEMORY.md and split files coexist (split takes priority, mono is secondary)", async () => {
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "identity.md"),
      "Name: User",
    );
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "memory", "MEMORY.md"),
      "# Legacy\n\n- Old fact still there",
    );
    const { buildLayeredContext } = await import("../src/services/memory-layers.js");
    const ctx = buildLayeredContext("anything");
    expect(ctx).toMatch(/Name: User/); // L0
    expect(ctx).toMatch(/Old fact still there/); // legacy still included
  });
});
