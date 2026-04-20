/**
 * Fix #17 (Stage 2) — async-agent-parser unit tests.
 *
 * Two pure helpers:
 *   parseAsyncLaunchedToolResult(text) → { agentId, outputFile } | null
 *   parseOutputFileStatus(path) → { state: "running"|"completed"|"failed"|"missing" }
 *
 * Format details captured from the live SDK probe in
 * docs/superpowers/specs/sdk-async-agent-outputfile-format.md
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";
import {
  parseAsyncLaunchedToolResult,
  parseOutputFileStatus,
} from "../src/services/async-agent-parser.js";

describe("parseAsyncLaunchedToolResult — plain text format (Stage 2)", () => {
  it("extracts agentId and output_file from the real SDK tool-result text", () => {
    const text = `Async agent launched successfully.
agentId: a9e9c5913b2faec71 (internal ID - do not mention to user. Use SendMessage with to: 'a9e9c5913b2faec71' to continue this agent.)
The agent is working in the background. You will be notified automatically when it completes.
Do not duplicate this agent's work — avoid working with the same files or topics it is using.
output_file: /private/tmp/claude-502/-Users-alvin-de-Projects-alvin-bot/abc/tasks/a9e9c5913b2faec71.output
If asked, you can check progress before completion by using Read or Bash tail on the output file.`;

    const info = parseAsyncLaunchedToolResult(text);
    expect(info).not.toBeNull();
    expect(info?.agentId).toBe("a9e9c5913b2faec71");
    expect(info?.outputFile).toBe(
      "/private/tmp/claude-502/-Users-alvin-de-Projects-alvin-bot/abc/tasks/a9e9c5913b2faec71.output",
    );
  });

  it("returns null for ordinary tool result text (e.g. Read output)", () => {
    expect(parseAsyncLaunchedToolResult("file contents here")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseAsyncLaunchedToolResult("")).toBeNull();
  });

  it("returns null when the marker line is missing", () => {
    expect(
      parseAsyncLaunchedToolResult("agentId: x\noutput_file: /tmp/a"),
    ).toBeNull();
  });

  it("returns null when output_file line is missing", () => {
    const text =
      "Async agent launched successfully.\nagentId: abc123\nMore prose";
    expect(parseAsyncLaunchedToolResult(text)).toBeNull();
  });

  it("returns null when agentId line is missing", () => {
    const text =
      "Async agent launched successfully.\noutput_file: /tmp/a\nMore prose";
    expect(parseAsyncLaunchedToolResult(text)).toBeNull();
  });

  it("trims whitespace around extracted values", () => {
    const text = `Async agent launched successfully.
agentId:    abc-with-spaces   (something)
output_file:    /tmp/path with spaces.output   `;
    const info = parseAsyncLaunchedToolResult(text);
    expect(info?.agentId).toBe("abc-with-spaces");
    // Path can contain spaces — we just trim leading/trailing
    expect(info?.outputFile).toBe("/tmp/path with spaces.output");
  });

  it("handles input that is an array of content blocks (Anthropic SDK shape)", () => {
    const blocks = [
      { type: "text", text: "Async agent launched successfully.\nagentId: id1\noutput_file: /tmp/o1\n" },
    ];
    const info = parseAsyncLaunchedToolResult(blocks);
    expect(info?.agentId).toBe("id1");
    expect(info?.outputFile).toBe("/tmp/o1");
  });

  it("handles non-string input gracefully", () => {
    expect(parseAsyncLaunchedToolResult(null)).toBeNull();
    expect(parseAsyncLaunchedToolResult(undefined)).toBeNull();
    expect(parseAsyncLaunchedToolResult(42 as unknown as string)).toBeNull();
  });
});

const TMP_BASE = resolve(os.tmpdir(), `alvin-parser-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(TMP_BASE, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  } catch { /* ignore */ }
});

async function writeJsonl(name: string, lines: object[]): Promise<string> {
  const path = resolve(TMP_BASE, name);
  fs.writeFileSync(
    path,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
  return path;
}

describe("parseOutputFileStatus — JSONL completion detection (Stage 2)", () => {
  it("returns 'missing' when the file doesn't exist", async () => {
    const status = await parseOutputFileStatus(`${TMP_BASE}/nonexistent.jsonl`);
    expect(status.state).toBe("missing");
  });

  it("returns 'missing' for an empty file", async () => {
    const path = resolve(TMP_BASE, "empty.jsonl");
    fs.writeFileSync(path, "", "utf-8");
    const status = await parseOutputFileStatus(path);
    expect(status.state).toBe("missing");
  });

  it("returns 'running' when the file has events but no end_turn", async () => {
    const path = await writeJsonl("running.jsonl", [
      {
        type: "user",
        isSidechain: true,
        agentId: "x",
        message: { role: "user", content: "do the thing" },
      },
      {
        type: "assistant",
        isSidechain: true,
        agentId: "x",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
          stop_reason: "tool_use",
        },
      },
    ]);
    const status = await parseOutputFileStatus(path);
    expect(status.state).toBe("running");
  });

  it("returns 'completed' with the final text when stop_reason is end_turn", async () => {
    const path = await writeJsonl("completed.jsonl", [
      {
        type: "user",
        isSidechain: true,
        agentId: "x",
        message: { role: "user", content: "p" },
      },
      {
        type: "assistant",
        isSidechain: true,
        agentId: "x",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final report: it works!" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ]);
    const status = await parseOutputFileStatus(path);
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.output).toContain("Final report: it works!");
      expect(status.tokensUsed).toEqual({ input: 100, output: 50 });
    }
  });

  it("concatenates multiple text blocks in the final assistant message", async () => {
    const path = await writeJsonl("multi-block.jsonl", [
      {
        type: "assistant",
        isSidechain: true,
        agentId: "x",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", text: "let me think" },
            { type: "text", text: "Part one." },
            { type: "text", text: "Part two." },
          ],
          stop_reason: "end_turn",
        },
      },
    ]);
    const status = await parseOutputFileStatus(path);
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.output).toBe("Part one.\n\nPart two.");
      // thinking blocks are NOT included
      expect(status.output).not.toContain("let me think");
    }
  });

  it("ignores assistant messages with stop_reason !== end_turn (still running)", async () => {
    const path = await writeJsonl("intermediate.jsonl", [
      {
        type: "assistant",
        isSidechain: true,
        agentId: "x",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "checking..." }],
          stop_reason: "tool_use",
        },
      },
    ]);
    const status = await parseOutputFileStatus(path);
    expect(status.state).toBe("running");
  });

  it("uses the LAST end_turn assistant message when there are multiple turns", async () => {
    const path = await writeJsonl("multi-turn.jsonl", [
      {
        type: "assistant",
        agentId: "x",
        message: {
          content: [{ type: "text", text: "first answer" }],
          stop_reason: "end_turn",
        },
      },
      {
        type: "user",
        agentId: "x",
        message: { content: [{ type: "tool_result", content: "..." }] },
      },
      {
        type: "assistant",
        agentId: "x",
        message: {
          content: [{ type: "text", text: "second and final answer" }],
          stop_reason: "end_turn",
        },
      },
    ]);
    const status = await parseOutputFileStatus(path);
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.output).toBe("second and final answer");
    }
  });

  it("survives partial final lines (mid-write)", async () => {
    const path = resolve(TMP_BASE, "partial.jsonl");
    fs.writeFileSync(
      path,
      JSON.stringify({
        type: "assistant",
        agentId: "x",
        message: {
          content: [{ type: "text", text: "checking" }],
          stop_reason: "tool_use",
        },
      }) +
        "\n" +
        '{"type":"assistant","agentId":"x","mes',
      "utf-8",
    );
    const status = await parseOutputFileStatus(path);
    // Partial line is ignored; only the complete event counts
    expect(status.state).toBe("running");
  });

  it("survives unparseable lines (skip them, keep checking)", async () => {
    const path = resolve(TMP_BASE, "garbage.jsonl");
    fs.writeFileSync(
      path,
      "garbage line\n" +
        JSON.stringify({
          type: "assistant",
          agentId: "x",
          message: {
            content: [{ type: "text", text: "the answer" }],
            stop_reason: "end_turn",
          },
        }) +
        "\n",
      "utf-8",
    );
    const status = await parseOutputFileStatus(path);
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.output).toBe("the answer");
    }
  });

  it("only tail-reads large files (does not load entire content into memory)", async () => {
    const path = resolve(TMP_BASE, "huge.jsonl");
    // Write a 200KB padding stream of 'running' events, then an end_turn
    const padding = JSON.stringify({
      type: "assistant",
      agentId: "x",
      message: { content: [{ type: "text", text: "x".repeat(500) }], stop_reason: "tool_use" },
    });
    let buf = "";
    for (let i = 0; i < 200; i++) buf += padding + "\n";
    buf +=
      JSON.stringify({
        type: "assistant",
        agentId: "x",
        message: {
          content: [{ type: "text", text: "FINAL" }],
          stop_reason: "end_turn",
        },
      }) + "\n";
    fs.writeFileSync(path, buf, "utf-8");
    expect(fs.statSync(path).size).toBeGreaterThan(100_000);

    const status = await parseOutputFileStatus(path, { maxTailBytes: 8192 });
    // Tail should still find the last end_turn
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.output).toBe("FINAL");
    }
  });
});
