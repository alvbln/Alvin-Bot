/**
 * v4.12.4 — parseOutputFileStatus staleness detection.
 *
 * Problem this fixes: when a background sub-agent is interrupted (e.g. by
 * v4.12.3's bypass-abort propagating through the SDK subprocess), its
 * outputFile is left with partial JSONL — real work, real text — but
 * without the `stop_reason: "end_turn"` marker the pre-v4.12.4 parser
 * required for "completed" state.
 *
 * Real-world evidence (2026-04-16):
 *   - Three agents (a03ce829, af61fa6e, ac47c4a2) pending in state file
 *   - Each outputFile has 81-131 lines of REAL work (WebSearch, tool_use,
 *     partial reports like "Here's the summary:\n\n## Critical Bugs")
 *   - Last event is either "[Request interrupted by user for tool use]"
 *     or a mid-streaming assistant text that never got end_turn
 *   - Watcher polls forever, hits 12h giveUpAt, delivers "empty output"
 *   - User sees useless "720m timeout · 0 in / 0 out · (empty output)"
 *     messages hours later, while the actual work is sitting on disk
 *
 * Fix behavior:
 *   - If no end_turn is found, check mtime/size of the file
 *   - If file hasn't been touched for `stalenessMs` (default 5 min) AND
 *     there's usable text content in the tail, mark as "completed"
 *     with the partial output PREFIXED by an "⚠️ interrupted, partial
 *     output" header so the user knows it's not a clean finish
 *   - If file IS fresh or has no text content, stay in "running" state
 *     (normal polling continues)
 *
 * This deliberately biases toward delivering SOMETHING rather than
 * nothing. Worst case: an agent that's still alive but genuinely idle
 * for >5 min gets its partial text delivered early. Best case: dozens
 * of stuck interrupted agents get their real work back to the user.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";
import { parseOutputFileStatus } from "../src/services/async-agent-parser.js";

const TMP_BASE = resolve(os.tmpdir(), `alvin-parser-stale-${process.pid}`);

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

/**
 * Write a JSONL file with a mid-execution interrupted state. No end_turn,
 * but contains real assistant text + tool calls. Last line is the
 * "Request interrupted" marker.
 */
function writeInterruptedJsonl(name: string): string {
  const path = resolve(TMP_BASE, name);
  const lines = [
    JSON.stringify({
      type: "user",
      isSidechain: true,
      agentId: "x",
      message: { role: "user", content: "do a report" },
    }),
    JSON.stringify({
      type: "assistant",
      isSidechain: true,
      agentId: "x",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Starting research..." }],
        stop_reason: "tool_use",
      },
    }),
    JSON.stringify({
      type: "assistant",
      isSidechain: true,
      agentId: "x",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              "Here's what I found:\n\n## Key Findings\n- Finding A\n- Finding B\n- Finding C",
          },
        ],
        stop_reason: "tool_use",
      },
    }),
    JSON.stringify({
      type: "user",
      isSidechain: true,
      agentId: "x",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: "[Request interrupted by user for tool use]",
          },
        ],
      },
    }),
  ];
  fs.writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  return path;
}

/** Set file mtime to N ms in the past. */
function setStale(path: string, ageMs: number): void {
  const target = Date.now() - ageMs;
  fs.utimesSync(path, target / 1000, target / 1000);
}

describe("parseOutputFileStatus — staleness detection (v4.12.4)", () => {
  it("still returns 'completed' when end_turn is present (staleness is a fallback only)", async () => {
    const path = resolve(TMP_BASE, "complete.jsonl");
    fs.writeFileSync(
      path,
      JSON.stringify({
        type: "assistant",
        agentId: "x",
        message: {
          content: [{ type: "text", text: "clean end" }],
          stop_reason: "end_turn",
        },
      }) + "\n",
      "utf-8",
    );
    setStale(path, 3600_000); // 1h old
    const status = await parseOutputFileStatus(path, {
      stalenessMs: 300_000,
    });
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.output).toContain("clean end");
      // No interrupted banner for clean end_turn
      expect(status.output).not.toMatch(/interrupt/i);
    }
  });

  it("returns 'running' when file is fresh and no end_turn (normal polling)", async () => {
    const path = writeInterruptedJsonl("fresh-interrupted.jsonl");
    // File is fresh (just written)
    const status = await parseOutputFileStatus(path, {
      stalenessMs: 300_000,
    });
    expect(status.state).toBe("running");
  });

  it("returns 'completed' (partial) when file is stale AND has text content", async () => {
    const path = writeInterruptedJsonl("stale-interrupted.jsonl");
    setStale(path, 600_000); // 10 min old
    const status = await parseOutputFileStatus(path, {
      stalenessMs: 300_000, // 5 min threshold
    });
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      // Should contain the real report content
      expect(status.output).toContain("Key Findings");
      expect(status.output).toContain("Finding A");
      // Should be prefixed with an interrupted banner so user knows
      // (German "unterbrochen" / "partielle" OR English "interrupted"/"partial")
      expect(status.output).toMatch(/interrupt|partial|unterbroch|partiell|⚠️/i);
    }
  });

  it("returns 'running' when file is stale but has NO text content (nothing to deliver)", async () => {
    // Only tool-use events, no text. Delivery would be useless.
    const path = resolve(TMP_BASE, "no-text.jsonl");
    fs.writeFileSync(
      path,
      [
        JSON.stringify({
          type: "user",
          agentId: "x",
          message: { role: "user", content: "go" },
        }),
        JSON.stringify({
          type: "assistant",
          agentId: "x",
          message: {
            content: [
              { type: "tool_use", name: "Bash", input: { command: "ls" } },
            ],
            stop_reason: "tool_use",
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    setStale(path, 600_000);
    const status = await parseOutputFileStatus(path, {
      stalenessMs: 300_000,
    });
    expect(status.state).toBe("running");
  });

  it("default stalenessMs is applied when not provided (no crashes on legacy callers)", async () => {
    const path = writeInterruptedJsonl("default-cfg.jsonl");
    setStale(path, 24 * 3600_000); // 24h old — very stale
    const status = await parseOutputFileStatus(path);
    // Whatever the default is, 24h should definitely exceed it
    expect(status.state).toBe("completed");
  });

  it("stalenessMs: 0 disables the staleness fallback entirely", async () => {
    const path = writeInterruptedJsonl("disabled.jsonl");
    setStale(path, 24 * 3600_000);
    const status = await parseOutputFileStatus(path, { stalenessMs: 0 });
    // With staleness disabled, we're back to strict end_turn requirement
    expect(status.state).toBe("running");
  });

  it("aggregates ALL text blocks from ALL assistant turns when delivering partial", async () => {
    const path = resolve(TMP_BASE, "multi-turn-interrupted.jsonl");
    const lines = [
      { type: "user", agentId: "x", message: { role: "user", content: "go" } },
      {
        type: "assistant",
        agentId: "x",
        message: {
          content: [{ type: "text", text: "First thought." }],
          stop_reason: "tool_use",
        },
      },
      {
        type: "assistant",
        agentId: "x",
        message: {
          content: [{ type: "text", text: "Second thought." }],
          stop_reason: "tool_use",
        },
      },
      {
        type: "assistant",
        agentId: "x",
        message: {
          content: [{ type: "text", text: "Final partial report." }],
          stop_reason: "tool_use",
        },
      },
    ];
    fs.writeFileSync(
      path,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
    setStale(path, 600_000);
    const status = await parseOutputFileStatus(path, {
      stalenessMs: 300_000,
    });
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      // Should contain text from all three turns (bias toward delivering more)
      expect(status.output).toContain("First thought");
      expect(status.output).toContain("Second thought");
      expect(status.output).toContain("Final partial report");
    }
  });

  it("ignores thinking blocks in partial delivery (user doesn't want Claude's scratchpad)", async () => {
    const path = resolve(TMP_BASE, "thinking-filter.jsonl");
    const lines = [
      {
        type: "assistant",
        agentId: "x",
        message: {
          content: [
            { type: "thinking", text: "internal reasoning nobody should see" },
            { type: "text", text: "Actual output text." },
          ],
          stop_reason: "tool_use",
        },
      },
    ];
    fs.writeFileSync(
      path,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
    setStale(path, 600_000);
    const status = await parseOutputFileStatus(path, {
      stalenessMs: 300_000,
    });
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.output).toContain("Actual output text");
      expect(status.output).not.toContain("internal reasoning");
    }
  });

  it("extracts usage tokens from the last assistant event when available", async () => {
    const path = resolve(TMP_BASE, "tokens-partial.jsonl");
    const lines = [
      {
        type: "assistant",
        agentId: "x",
        message: {
          content: [{ type: "text", text: "partial text" }],
          stop_reason: "tool_use",
          usage: { input_tokens: 500, output_tokens: 200 },
        },
      },
    ];
    fs.writeFileSync(
      path,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
    setStale(path, 600_000);
    const status = await parseOutputFileStatus(path, {
      stalenessMs: 300_000,
    });
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.tokensUsed).toEqual({ input: 500, output: 200 });
    }
  });

  it("handles file that only has the interruption marker (nothing useful to deliver)", async () => {
    // Edge case: only interruption, no prior text
    const path = resolve(TMP_BASE, "only-interrupt.jsonl");
    const lines = [
      {
        type: "user",
        agentId: "x",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: "[Request interrupted by user for tool use]",
            },
          ],
        },
      },
    ];
    fs.writeFileSync(
      path,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
    setStale(path, 600_000);
    const status = await parseOutputFileStatus(path, {
      stalenessMs: 300_000,
    });
    // No assistant text content at all → still running (nothing useful)
    expect(status.state).toBe("running");
  });

  it("preserves ordering of text across turns (earlier text first, later text last)", async () => {
    const path = resolve(TMP_BASE, "order.jsonl");
    const lines = [
      {
        type: "assistant",
        agentId: "x",
        message: {
          content: [{ type: "text", text: "ALPHA" }],
          stop_reason: "tool_use",
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
          content: [{ type: "text", text: "BETA" }],
          stop_reason: "tool_use",
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
          content: [{ type: "text", text: "GAMMA" }],
          stop_reason: "tool_use",
        },
      },
    ];
    fs.writeFileSync(
      path,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
    setStale(path, 600_000);
    const status = await parseOutputFileStatus(path, {
      stalenessMs: 300_000,
    });
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      const alphaIdx = status.output.indexOf("ALPHA");
      const betaIdx = status.output.indexOf("BETA");
      const gammaIdx = status.output.indexOf("GAMMA");
      expect(alphaIdx).toBeGreaterThan(-1);
      expect(betaIdx).toBeGreaterThan(alphaIdx);
      expect(gammaIdx).toBeGreaterThan(betaIdx);
    }
  });
});
