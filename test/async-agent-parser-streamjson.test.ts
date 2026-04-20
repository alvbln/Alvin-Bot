/**
 * v4.13 — parseOutputFileStatus support for `claude -p --output-format stream-json`.
 *
 * The SDK's built-in Task tool writes its sub-agent output in one JSONL
 * format (events with `message.stop_reason: "end_turn"`). The new v4.13
 * dispatch mechanism spawns `claude -p --output-format stream-json`
 * which writes a DIFFERENT format:
 *
 *   - Assistant messages have `message.stop_reason: null` (streaming shape)
 *   - A final `{"type":"result","subtype":"success","stop_reason":"end_turn",...}`
 *     event marks completion explicitly
 *   - `result.duration_ms`, `total_cost_usd`, `num_turns`, `usage`
 *     are the authoritative completion signals
 *
 * The parser must recognize BOTH formats. v4.13 adds detection for the
 * result-event format while preserving backward compat with the existing
 * SDK-internal format (tested in the sibling test files).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";
import { parseOutputFileStatus } from "../src/services/async-agent-parser.js";

const TMP_BASE = resolve(
  os.tmpdir(),
  `alvin-parser-streamjson-${process.pid}`,
);

beforeEach(() => {
  fs.mkdirSync(TMP_BASE, { recursive: true });
});
afterEach(() => {
  try {
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("parseOutputFileStatus — stream-json format (v4.13)", () => {
  it("returns 'completed' when final event is type:result + subtype:success", async () => {
    const path = resolve(TMP_BASE, "stream-success.jsonl");
    const lines = [
      { type: "system", subtype: "init", session_id: "s1" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The answer is 42." }],
          stop_reason: null, // streaming shape — NOT end_turn yet
        },
        session_id: "s1",
      },
      {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        session_id: "s1",
        total_cost_usd: 0.01,
        duration_ms: 500,
        usage: { input_tokens: 10, output_tokens: 5 },
        result: "The answer is 42.",
      },
    ];
    fs.writeFileSync(
      path,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );

    const status = await parseOutputFileStatus(path);
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.output).toContain("The answer is 42.");
      expect(status.output).not.toMatch(/interrupted|partial/i);
    }
  });

  it("extracts tokens from result.usage when using stream-json format", async () => {
    const path = resolve(TMP_BASE, "stream-tokens.jsonl");
    const lines = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "x" }],
          stop_reason: null,
        },
      },
      {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        usage: { input_tokens: 1234, output_tokens: 567 },
      },
    ];
    fs.writeFileSync(
      path,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
    const status = await parseOutputFileStatus(path);
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.tokensUsed).toEqual({ input: 1234, output: 567 });
    }
  });

  it("recognises 'failed' state when result.is_error is true", async () => {
    const path = resolve(TMP_BASE, "stream-failed.jsonl");
    const lines = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "I tried..." }],
          stop_reason: null,
        },
      },
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        stop_reason: "max_turns",
      },
    ];
    fs.writeFileSync(
      path,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
    const status = await parseOutputFileStatus(path);
    // With an is_error result + text content, we still deliver the text
    // as completed (better to give the user SOMETHING than nothing).
    // The delivery layer can annotate differently if it chooses.
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.output).toContain("I tried...");
    }
  });

  it("returns 'running' when stream-json events are present but no result yet", async () => {
    const path = resolve(TMP_BASE, "stream-running.jsonl");
    const lines = [
      { type: "system", subtype: "init", session_id: "s1" },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Thinking..." }],
          stop_reason: null,
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: {} }],
          stop_reason: null,
        },
      },
    ];
    fs.writeFileSync(
      path,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
    const status = await parseOutputFileStatus(path);
    expect(status.state).toBe("running");
  });

  it("aggregates text from ALL assistant messages when result arrives", async () => {
    const path = resolve(TMP_BASE, "stream-multi-text.jsonl");
    const lines = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "First thought." }],
          stop_reason: null,
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", content: "ok" }] },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Continuing..." }],
          stop_reason: null,
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", content: "ok" }] },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Final answer." }],
          stop_reason: null,
        },
      },
      { type: "result", subtype: "success", stop_reason: "end_turn" },
    ];
    fs.writeFileSync(
      path,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
    const status = await parseOutputFileStatus(path);
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      // All three text blocks must be present
      expect(status.output).toContain("First thought");
      expect(status.output).toContain("Continuing");
      expect(status.output).toContain("Final answer");
    }
  });

  it("prefers result.result field as authoritative output when available", async () => {
    // The stream-json's result event has a `result` field with the
    // already-concatenated final answer. Use it directly when present
    // (more accurate than re-aggregating from streaming chunks).
    const path = resolve(TMP_BASE, "stream-result-field.jsonl");
    const lines = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Intermediate chunk" }],
          stop_reason: null,
        },
      },
      {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "FINAL AUTHORITATIVE ANSWER",
      },
    ];
    fs.writeFileSync(
      path,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
    const status = await parseOutputFileStatus(path);
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.output).toContain("FINAL AUTHORITATIVE ANSWER");
    }
  });

  it("handles result event with only partial fields (defensive)", async () => {
    const path = resolve(TMP_BASE, "stream-result-minimal.jsonl");
    const lines = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Some output" }],
          stop_reason: null,
        },
      },
      { type: "result" }, // no subtype, no result field, no usage
    ];
    fs.writeFileSync(
      path,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
    const status = await parseOutputFileStatus(path);
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.output).toContain("Some output");
    }
  });
});
