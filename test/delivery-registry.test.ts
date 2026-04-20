/**
 * v4.14 — delivery-registry module tests.
 *
 * Registers platform adapters (slack/discord/whatsapp) so the sub-agent
 * watcher can route delivery to the right one based on
 * PendingAsyncAgent.platform. Telegram does NOT go through this registry
 * — it continues to use the existing grammy-bot path via attachBotApi.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => vi.resetModules());

describe("delivery-registry (v4.14)", () => {
  it("register + get roundtrip", async () => {
    const { registerDeliveryAdapter, getDeliveryAdapter, __resetForTest } =
      await import("../src/services/delivery-registry.js");
    __resetForTest();

    const fake = {
      platform: "slack" as const,
      sendText: vi.fn(async () => {}),
    };
    registerDeliveryAdapter(fake);
    expect(getDeliveryAdapter("slack")).toBe(fake);
  });

  it("returns null for unregistered platform", async () => {
    const { getDeliveryAdapter, __resetForTest } = await import(
      "../src/services/delivery-registry.js"
    );
    __resetForTest();
    expect(getDeliveryAdapter("slack")).toBeNull();
    expect(getDeliveryAdapter("discord")).toBeNull();
    expect(getDeliveryAdapter("telegram")).toBeNull();
  });

  it("re-register replaces the existing adapter (handles platform reload)", async () => {
    const {
      registerDeliveryAdapter,
      getDeliveryAdapter,
      __resetForTest,
    } = await import("../src/services/delivery-registry.js");
    __resetForTest();

    const first = { platform: "slack" as const, sendText: vi.fn(async () => {}) };
    const second = { platform: "slack" as const, sendText: vi.fn(async () => {}) };
    registerDeliveryAdapter(first);
    registerDeliveryAdapter(second);
    expect(getDeliveryAdapter("slack")).toBe(second);
  });

  it("adapters are isolated per platform", async () => {
    const {
      registerDeliveryAdapter,
      getDeliveryAdapter,
      __resetForTest,
    } = await import("../src/services/delivery-registry.js");
    __resetForTest();

    const slack = { platform: "slack" as const, sendText: vi.fn(async () => {}) };
    const discord = {
      platform: "discord" as const,
      sendText: vi.fn(async () => {}),
    };
    registerDeliveryAdapter(slack);
    registerDeliveryAdapter(discord);
    expect(getDeliveryAdapter("slack")).toBe(slack);
    expect(getDeliveryAdapter("discord")).toBe(discord);
    expect(getDeliveryAdapter("whatsapp")).toBeNull();
  });
});
