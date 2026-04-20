/**
 * Fix #13 — `/cron run` must resolve a job by name OR ID, and must
 * reject a second concurrent run of the same job.
 *
 * Regressions this closes:
 *   (a) `/cron run Daily Job Alert` returned "❌ Job not found."
 *       because runJobNow() only matched against `job.id`. Real job
 *       IDs look like `mn90rrsndzto` — nobody types those.
 *   (b) Natural-language triggers through Claude ended up running the
 *       job twice because the main message handler retried after the
 *       first "Job not found" / parallel path succeeded. runJobNow()
 *       didn't consult `runningJobs`, so two concurrent calls both
 *       spawned sub-agents.
 *
 * Contract — pure resolver (tested here), side-effectful runner
 * (integration-tested via runJobNowGuard below):
 *
 *   resolveJobByNameOrId(jobs, query)
 *     - exact `job.id` match wins
 *     - exact `job.name` match wins next
 *     - case-insensitive `job.name` match third
 *     - returns `null` on ambiguous case-insensitive match or miss
 *
 *   runJobNowGuard(id, isRunning, run)
 *     - calls `run(id)` only when `isRunning(id)` is false
 *     - returns `{ status: "already-running" }` otherwise
 */
import { describe, it, expect, vi } from "vitest";
import {
  resolveJobByNameOrId,
  runJobNowGuard,
} from "../src/services/cron-resolver.js";
import type { CronJob } from "../src/services/cron.js";

function makeJob(overrides: Partial<CronJob>): CronJob {
  return {
    id: "abc123",
    name: "Test Job",
    type: "ai-query",
    schedule: "0 8 * * *",
    oneShot: false,
    payload: { prompt: "x" },
    target: { platform: "telegram", chatId: "1" },
    enabled: true,
    createdAt: 0,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    nextRunAt: null,
    runCount: 0,
    createdBy: "test",
    ...overrides,
  };
}

describe("resolveJobByNameOrId (Fix #13)", () => {
  const jobs = [
    makeJob({ id: "mn90rrsndzto", name: "Daily Job Alert" }),
    makeJob({ id: "abc123", name: "Weekly Stock Report" }),
    makeJob({ id: "def456", name: "Perseus Health Check" }),
  ];

  it("matches by exact ID", () => {
    const j = resolveJobByNameOrId(jobs, "mn90rrsndzto");
    expect(j?.name).toBe("Daily Job Alert");
  });

  it("matches by exact name", () => {
    const j = resolveJobByNameOrId(jobs, "Daily Job Alert");
    expect(j?.id).toBe("mn90rrsndzto");
  });

  it("matches case-insensitive on name", () => {
    const j = resolveJobByNameOrId(jobs, "daily job alert");
    expect(j?.id).toBe("mn90rrsndzto");
  });

  it("matches trimmed input", () => {
    const j = resolveJobByNameOrId(jobs, "  Daily Job Alert  ");
    expect(j?.id).toBe("mn90rrsndzto");
  });

  it("returns null on miss", () => {
    expect(resolveJobByNameOrId(jobs, "Nothing Like That")).toBeNull();
  });

  it("returns null on ambiguous case-insensitive match", () => {
    const dupes = [
      makeJob({ id: "a", name: "test job" }),
      makeJob({ id: "b", name: "Test Job" }),
      makeJob({ id: "c", name: "TEST JOB" }),
    ];
    // Exact-case match wins over ambiguous siblings
    expect(resolveJobByNameOrId(dupes, "Test Job")?.id).toBe("b");
    // Ambiguous query (no exact-case match) returns null
    expect(resolveJobByNameOrId(dupes, "TeSt JoB")).toBeNull();
  });

  it("prefers ID match over an accidental name collision", () => {
    const collision = [
      makeJob({ id: "Daily Job Alert", name: "Something Else" }),
      makeJob({ id: "mn90rrsndzto", name: "Daily Job Alert" }),
    ];
    const j = resolveJobByNameOrId(collision, "Daily Job Alert");
    expect(j?.id).toBe("Daily Job Alert"); // ID match wins
  });
});

describe("runJobNowGuard (Fix #13)", () => {
  it("runs when the job is not already running", async () => {
    const run = vi.fn(async () => ({ output: "ok" }));
    const result = await runJobNowGuard("job-1", () => false, run);
    expect(run).toHaveBeenCalledWith("job-1");
    expect(result.status).toBe("ran");
  });

  it("rejects when the job is already running", async () => {
    const run = vi.fn(async () => ({ output: "ok" }));
    const result = await runJobNowGuard("job-1", () => true, run);
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe("already-running");
  });

  it("passes through the inner result on the ran path", async () => {
    const run = vi.fn(async () => ({ output: "done", error: undefined }));
    const result = await runJobNowGuard("job-1", () => false, run);
    if (result.status === "ran") {
      expect(result.output).toBe("done");
    } else {
      throw new Error("expected ran");
    }
  });
});
