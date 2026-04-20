/**
 * Fix #5 — runSubAgent must preserve the full final text, even when the
 * stream ends on a tool_use or is aborted mid-stream.
 *
 * Regressions this closes:
 *
 *   (a) The SDK yields `text` chunks as accumulated strings, then tool
 *       calls, then more text, then finally a `done` chunk that ALSO
 *       carries the final accumulated text. The old runSubAgent read
 *       `text` from text-chunks only and ignored `done.text`. If the
 *       assistant's very last action was a tool call with no trailing
 *       text block, `finalText` kept the pre-tool text and the
 *       cron-jobs.json `lastResult` ended mid-sentence.
 *
 *   (b) When queryWithFallback threw mid-stream (provider aborted,
 *       network error, etc.), the catch block set `output: ""` —
 *       throwing away whatever text had already streamed in before the
 *       failure. Users saw an empty "(empty output)" delivery.
 *
 * Contract:
 *   - Output = last non-empty value observed from (text.text | done.text)
 *   - On error / abort: output = whatever we'd buffered so far (never "")
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";
import type { StreamChunk } from "../src/providers/types.js";

const TEST_DATA_DIR = resolve(os.tmpdir(), `alvin-bot-finaltext-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ALVIN_DATA_DIR = TEST_DATA_DIR;
  delete process.env.MAX_SUBAGENTS;
  vi.resetModules();
});

function mockStream(chunks: StreamChunk[] | (() => AsyncIterable<StreamChunk>)) {
  vi.doMock("../src/engine.js", () => ({
    getRegistry: () => ({
      queryWithFallback: typeof chunks === "function"
        ? chunks
        : async function* () { for (const c of chunks) yield c; },
    }),
  }));
  vi.doMock("../src/services/subagent-delivery.js", () => ({
    deliverSubAgentResult: async () => { /* no-op */ },
    attachBotApi: () => {},
    __setBotApiForTest: () => {},
  }));
}

async function runAndGetResult(prompt = "test") {
  const mod = await import("../src/services/subagents.js");
  return new Promise<{ output: string; status: string; tokensUsed: { input: number; output: number } }>((resolveResult) => {
    mod.spawnSubAgent({
      name: "test-agent",
      prompt,
      source: "cron",
      parentChatId: 1,
      onComplete: (r) => resolveResult({
        output: r.output,
        status: r.status,
        tokensUsed: r.tokensUsed,
      }),
    }).catch(() => { /* spawn errors handled elsewhere */ });
  });
}

describe("runSubAgent finalText (Fix #5)", () => {
  it("uses done.text as the authoritative final output", async () => {
    mockStream([
      { type: "text", text: "Working on it…" },
      { type: "tool_use", toolName: "Bash" },
      { type: "text", text: "Intermediate finding: 5 results." },
      { type: "tool_use", toolName: "Write" },
      // No trailing text chunk — the assistant ended on a tool call,
      // then the done chunk carries the authoritative final text.
      { type: "done", text: "Job complete. Report at /tmp/out.html", inputTokens: 100, outputTokens: 50 },
    ]);
    const r = await runAndGetResult();
    expect(r.status).toBe("completed");
    expect(r.output).toBe("Job complete. Report at /tmp/out.html");
    expect(r.tokensUsed).toEqual({ input: 100, output: 50 });
  });

  it("falls back to last text chunk when done has no text", async () => {
    mockStream([
      { type: "text", text: "First sentence." },
      { type: "text", text: "Second sentence." },
      { type: "done", inputTokens: 10, outputTokens: 5 },
    ]);
    const r = await runAndGetResult();
    expect(r.output).toBe("Second sentence.");
  });

  it("preserves buffered text when stream errors mid-way", async () => {
    mockStream(async function* () {
      yield { type: "text", text: "Partial progress so far…" };
      yield { type: "tool_use", toolName: "Bash" };
      throw new Error("network: socket hang up");
    });
    const r = await runAndGetResult();
    // Status can legitimately be "error" or "cancelled" — but output
    // must NOT be an empty string. That's the regression.
    expect(r.output.length).toBeGreaterThan(0);
    expect(r.output).toContain("Partial progress");
  });

  it("preserves buffered text when the provider yields an error chunk", async () => {
    mockStream([
      { type: "text", text: "Started the task." },
      { type: "text", text: "Started the task. More detail here." },
      { type: "error", error: "Provider 'claude-sdk' failed: Request aborted" },
    ]);
    const r = await runAndGetResult();
    expect(r.output).toContain("More detail");
  });

  it("returns empty output gracefully when nothing was buffered", async () => {
    mockStream(async function* () {
      throw new Error("immediate failure");
    });
    const r = await runAndGetResult();
    // No text at all → empty is acceptable (nothing to preserve), but
    // status must reflect the failure.
    expect(r.output).toBe("");
    expect(["error", "cancelled", "timeout"]).toContain(r.status);
  });
});
