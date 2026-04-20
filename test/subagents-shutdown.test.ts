import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-shutdown-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  delete process.env.MAX_SUBAGENTS;
  vi.resetModules();
});

// Long-running engine stub — holds for 5s so cancelAll catches the agents
// as "running".
vi.mock("../src/engine.js", () => ({
  getRegistry: () => ({
    queryWithFallback: async function* () {
      await new Promise((r) => setTimeout(r, 5000));
      yield { type: "done", text: "ok", inputTokens: 0, outputTokens: 0 };
    },
  }),
}));

describe("cancelAllSubAgents (E2)", () => {
  it("calls delivery for each running agent when notify=true", async () => {
    const deliveredNames: string[] = [];

    vi.doMock("../src/services/subagent-delivery.js", () => ({
      deliverSubAgentResult: async (info: { name: string }) => {
        deliveredNames.push(info.name);
      },
      attachBotApi: () => {},
      __setBotApiForTest: () => {},
    }));

    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({
      name: "agent-a",
      prompt: "x",
      source: "user",
      parentChatId: 1,
    });
    await mod.spawnSubAgent({
      name: "agent-b",
      prompt: "y",
      source: "cron",
      parentChatId: 2,
    });

    await mod.cancelAllSubAgents(true);
    // Give the async delivery calls a chance to run
    await new Promise((r) => setTimeout(r, 100));

    expect(deliveredNames.sort()).toEqual(["agent-a", "agent-b"]);
  });

  it("skips delivery when notify=false", async () => {
    const deliveredNames: string[] = [];

    vi.doMock("../src/services/subagent-delivery.js", () => ({
      deliverSubAgentResult: async (info: { name: string }) => {
        deliveredNames.push(info.name);
      },
      attachBotApi: () => {},
      __setBotApiForTest: () => {},
    }));

    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({
      name: "agent-c",
      prompt: "x",
      source: "user",
      parentChatId: 1,
    });
    await mod.cancelAllSubAgents(false);
    await new Promise((r) => setTimeout(r, 100));

    expect(deliveredNames).toEqual([]);
  });

  it("does not double-deliver when runSubAgent.finally runs after cancelAllSubAgents", async () => {
    // Regression test for the bug caught on the 192.168.178.75 remote
    // test: a slow-fox agent got TWO Telegram messages on shutdown —
    // first an (empty output) 'completed' banner from runSubAgent's
    // finally() block (because queryWithFallback exited gracefully
    // after the abort), and second the 'cancelled · Bot-Restart' banner
    // from cancelAllSubAgents. The delivered flag should prevent the
    // second one firing.
    const deliveredStatuses: string[] = [];

    vi.doMock("../src/services/subagent-delivery.js", () => ({
      deliverSubAgentResult: async (
        info: { name: string },
        result: { status: string },
      ) => {
        deliveredStatuses.push(`${info.name}:${result.status}`);
      },
      attachBotApi: () => {},
      __setBotApiForTest: () => {},
    }));

    const mod = await import("../src/services/subagents.js");
    await mod.spawnSubAgent({
      name: "slow-fox",
      prompt: "x",
      source: "user",
      parentChatId: 1,
    });

    // Give the runSubAgent generator a chance to actually start
    await new Promise((r) => setTimeout(r, 20));

    // Now trigger shutdown — this should cancel and deliver ONCE
    await mod.cancelAllSubAgents(true);

    // Wait for any pending finally() to run
    await new Promise((r) => setTimeout(r, 2500));

    const slowFoxDeliveries = deliveredStatuses.filter((s) => s.startsWith("slow-fox:"));
    expect(slowFoxDeliveries.length).toBe(1);
    expect(slowFoxDeliveries[0]).toBe("slow-fox:cancelled");
  });
});
