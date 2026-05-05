/**
 * Inject-mode resolver: env override + auto fallback.
 *
 * MEMORY_INJECT_MODE:
 *   - "legacy" / "sqlite" → returned verbatim
 *   - "auto" or unset    → defer to isSqliteMemoryReady()
 *   - invalid             → treated as auto
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => {
  delete process.env.MEMORY_INJECT_MODE;
  vi.resetModules();
});

describe("memory-inject-mode", () => {
  it("getInjectModeRaw defaults to auto when unset", async () => {
    const { getInjectModeRaw } = await import("../src/services/memory-inject-mode.js");
    expect(getInjectModeRaw()).toBe("auto");
  });

  it("getInjectModeRaw parses legacy/sqlite/auto verbatim", async () => {
    process.env.MEMORY_INJECT_MODE = "legacy";
    let mod = await import("../src/services/memory-inject-mode.js");
    expect(mod.getInjectModeRaw()).toBe("legacy");

    vi.resetModules();
    process.env.MEMORY_INJECT_MODE = "SQLITE"; // case-insensitive
    mod = await import("../src/services/memory-inject-mode.js");
    expect(mod.getInjectModeRaw()).toBe("sqlite");
  });

  it("getInjectModeRaw treats invalid values as auto", async () => {
    process.env.MEMORY_INJECT_MODE = "garbage";
    const { getInjectModeRaw } = await import("../src/services/memory-inject-mode.js");
    expect(getInjectModeRaw()).toBe("auto");
  });

  it("getEffectiveInjectMode returns explicit mode when set to legacy", async () => {
    process.env.MEMORY_INJECT_MODE = "legacy";
    vi.doMock("../src/services/embeddings.js", () => ({
      isSqliteMemoryReady: () => true, // even when ready, explicit legacy wins
    }));
    const { getEffectiveInjectMode } = await import("../src/services/memory-inject-mode.js");
    expect(getEffectiveInjectMode()).toBe("legacy");
  });

  it("getEffectiveInjectMode returns explicit mode when set to sqlite", async () => {
    process.env.MEMORY_INJECT_MODE = "sqlite";
    vi.doMock("../src/services/embeddings.js", () => ({
      isSqliteMemoryReady: () => false, // even when not ready, explicit sqlite wins
    }));
    const { getEffectiveInjectMode } = await import("../src/services/memory-inject-mode.js");
    expect(getEffectiveInjectMode()).toBe("sqlite");
  });

  it("getEffectiveInjectMode in auto mode → sqlite when DB has entries", async () => {
    vi.doMock("../src/services/embeddings.js", () => ({
      isSqliteMemoryReady: () => true,
    }));
    const { getEffectiveInjectMode } = await import("../src/services/memory-inject-mode.js");
    expect(getEffectiveInjectMode()).toBe("sqlite");
  });

  it("getEffectiveInjectMode in auto mode → legacy when DB is empty/unavailable", async () => {
    vi.doMock("../src/services/embeddings.js", () => ({
      isSqliteMemoryReady: () => false,
    }));
    const { getEffectiveInjectMode } = await import("../src/services/memory-inject-mode.js");
    expect(getEffectiveInjectMode()).toBe("legacy");
  });
});
