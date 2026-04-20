/**
 * Pure cron-job name/ID resolver and re-entry guard.
 *
 * See test/cron-run-resolver.test.ts for the regressions this closes:
 *   - `/cron run Daily Job Alert` returned "Job not found" because the
 *     old runJobNow only matched on `job.id`. Real IDs are random
 *     base-36 strings, nobody types those.
 *   - Natural-language triggers double-ran jobs because runJobNow
 *     didn't consult the `runningJobs` set.
 *
 * Both helpers are pure (or pure-over-callbacks) so they can be unit-
 * tested without touching the filesystem or the scheduler loop.
 */

import type { CronJob } from "./cron.js";

/**
 * Resolve a user-facing query (name, case-insensitive name, or ID) to
 * a specific job. Priority:
 *   1. Exact ID match
 *   2. Exact name match (case-sensitive)
 *   3. Unique case-insensitive name match
 *   4. null (miss or ambiguous)
 *
 * Trimmed whitespace on the query. Never mutates the input array.
 */
export function resolveJobByNameOrId(
  jobs: CronJob[],
  query: string,
): CronJob | null {
  const q = query.trim();
  if (!q) return null;

  // 1. Exact ID match
  const byId = jobs.find((j) => j.id === q);
  if (byId) return byId;

  // 2. Exact name match
  const byExactName = jobs.find((j) => j.name === q);
  if (byExactName) return byExactName;

  // 3. Unique case-insensitive name match
  const qLower = q.toLowerCase();
  const ciMatches = jobs.filter((j) => j.name.toLowerCase() === qLower);
  if (ciMatches.length === 1) return ciMatches[0];

  // 4. Ambiguous or not found
  return null;
}

export type RunJobNowGuardResult =
  | { status: "ran"; output: string; error?: string }
  | { status: "already-running" };

/**
 * Re-entry guard for runJobNow: only calls `run` when `isRunning`
 * reports the job is idle. Otherwise reports back "already-running"
 * so the caller can tell the user instead of silently double-firing.
 *
 * Kept as a higher-order function so the test doesn't need to stand
 * up the whole cron loop — we mock the two callbacks.
 */
export async function runJobNowGuard(
  id: string,
  isRunning: (id: string) => boolean,
  run: (id: string) => Promise<{ output: string; error?: string }>,
): Promise<RunJobNowGuardResult> {
  if (isRunning(id)) {
    return { status: "already-running" };
  }
  const result = await run(id);
  return { status: "ran", output: result.output, error: result.error };
}
