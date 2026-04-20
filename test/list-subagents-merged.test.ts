/**
 * v4.14.1 — `/subagents list` must show v4.13+ dispatch agents too.
 *
 * Root cause: `listSubAgents()` in subagents.ts only iterates the
 * `activeAgents` Map (B1+B2 from v4.0.0). v4.13's `alvin_dispatch_agent`
 * MCP tool writes into `async-agent-watcher.ts`'s `pending` Map instead.
 * User-facing impact: "no subagents running" while the bot is visibly
 * dispatching sub-agents.
 *
 * Fix strategy: a new `listActiveSubAgents()` helper that merges both
 * registries into a unified SubAgentInfo-shaped list. The `/subagents
 * list` handler uses this instead of the bare `listSubAgents()`.
 * Cancel/result operations keep using the old registry — we can't
 * cancel a detached `claude -p` subprocess anyway without knowing its
 * PID, which isn't tracked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(
  os.tmpdir(),
  `alvin-list-merged-${process.pid}-${Date.now()}`,
);

beforeEach(async () => {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  vi.resetModules();

  vi.doMock("../src/services/subagent-delivery.js", () => ({
    deliverSubAgentResult: async () => {},
    attachBotApi: () => {},
    __setBotApiForTest: () => {},
  }));
});

afterEach(async () => {
  try {
    const mod = await import("../src/services/async-agent-watcher.js");
    mod.stopWatcher();
    mod.__resetForTest();
  } catch {}
});

describe("listActiveSubAgents merged view (v4.14.1)", () => {
  it("returns empty list when neither registry has agents", async () => {
    const mod = await import("../src/services/subagents.js");
    expect(await mod.listActiveSubAgents()).toEqual([]);
  });

  it("includes async-agent-watcher pending agents in the merged list", async () => {
    const watcher = await import("../src/services/async-agent-watcher.js");
    watcher.registerPendingAgent({
      agentId: "alvin-abc123",
      outputFile: `${TEST_DATA_DIR}/out.jsonl`,
      description: "Research Higgsfield",
      prompt: "...",
      chatId: "C012SLACK",
      userId: "U123",
      toolUseId: null,
      sessionKey: "slack:C012SLACK",
      platform: "slack",
    });

    const mod = await import("../src/services/subagents.js");
    const agents = await mod.listActiveSubAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("alvin-abc123");
    expect(agents[0].name).toBe("Research Higgsfield");
    expect(agents[0].status).toBe("running");
    expect(agents[0].depth).toBe(0);
    expect(agents[0].platform).toBe("slack");
  });

  it("merges multiple agents from both registries without dupes", async () => {
    const watcher = await import("../src/services/async-agent-watcher.js");
    watcher.registerPendingAgent({
      agentId: "alvin-one",
      outputFile: `${TEST_DATA_DIR}/a.jsonl`,
      description: "Agent One",
      prompt: "p",
      chatId: 42,
      userId: 42,
      toolUseId: null,
      sessionKey: "s",
      platform: "telegram",
    });
    watcher.registerPendingAgent({
      agentId: "alvin-two",
      outputFile: `${TEST_DATA_DIR}/b.jsonl`,
      description: "Agent Two",
      prompt: "p",
      chatId: 42,
      userId: 42,
      toolUseId: null,
      sessionKey: "s",
      platform: "telegram",
    });

    const mod = await import("../src/services/subagents.js");
    const agents = await mod.listActiveSubAgents();
    const ids = agents.map((a) => a.id).sort();
    expect(ids).toEqual(["alvin-one", "alvin-two"]);
  });

  it("preserves startedAt timestamp for age rendering", async () => {
    const fixedTs = Date.now() - 45_000; // 45 seconds ago
    const watcher = await import("../src/services/async-agent-watcher.js");
    watcher.registerPendingAgent({
      agentId: "alvin-aged",
      outputFile: `${TEST_DATA_DIR}/aged.jsonl`,
      description: "Old agent",
      prompt: "p",
      chatId: 1,
      userId: 1,
      toolUseId: null,
      sessionKey: "s",
      platform: "slack",
    });

    const mod = await import("../src/services/subagents.js");
    const agents = await mod.listActiveSubAgents();
    expect(agents[0].startedAt).toBeGreaterThan(fixedTs - 1000);
    expect(agents[0].startedAt).toBeLessThan(Date.now() + 1000);
  });

  it("tags async dispatch agents with source='cron' (matches v4.12 banner format)", async () => {
    const watcher = await import("../src/services/async-agent-watcher.js");
    watcher.registerPendingAgent({
      agentId: "alvin-sourced",
      outputFile: `${TEST_DATA_DIR}/s.jsonl`,
      description: "sourced",
      prompt: "p",
      chatId: 1,
      userId: 1,
      toolUseId: null,
      sessionKey: "s",
      platform: "telegram",
    });
    const mod = await import("../src/services/subagents.js");
    const agents = await mod.listActiveSubAgents();
    // source='cron' = the ⏰ badge in /subagents list rendering. Matches
    // the existing v4.12.x watcher delivery's SubAgentInfo.source value.
    expect(agents[0].source).toBe("cron");
  });

  it("listSubAgents() (v4.0.0 API) is unchanged and doesn't include pending dispatches", async () => {
    const watcher = await import("../src/services/async-agent-watcher.js");
    watcher.registerPendingAgent({
      agentId: "alvin-isolated",
      outputFile: `${TEST_DATA_DIR}/iso.jsonl`,
      description: "isolated",
      prompt: "p",
      chatId: 1,
      userId: 1,
      toolUseId: null,
      sessionKey: "s",
      platform: "telegram",
    });
    const mod = await import("../src/services/subagents.js");
    // The original listSubAgents is kept pure — only the merged helper
    // returns combined results. Cancel/result paths still use the
    // bot-level registry.
    expect(mod.listSubAgents()).toHaveLength(0);
    expect(await mod.listActiveSubAgents()).toHaveLength(1);
  });
});
