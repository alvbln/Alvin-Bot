#!/usr/bin/env node
/**
 * v4.13 — critical survival test. Dispatch an agent, then simulate
 * bypass-abort (SIGTERM on the parent Node process). Verify the
 * dispatched subprocess SURVIVES and completes successfully.
 *
 * This is the property that v4.12.3's bypass-abort destroyed:
 * when using Task(run_in_background: true), the SDK subprocess's
 * abort cascaded and killed the sub-agent mid-work. With v4.13's
 * dispatchDetachedAgent we expect complete isolation.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { resolve } from "node:path";

console.log("[survival] v4.13 abort-survival test");

// Spawn the parent dispatcher as a child of OUR process.
// The parent's script dispatches and then exits ~immediately.
// Meanwhile the real dispatched subprocess should keep running.
const REPO_DIR = process.cwd();
const parentScript = `
import { dispatchDetachedAgent } from "${REPO_DIR}/dist/services/alvin-dispatch.js";
import { getSession } from "${REPO_DIR}/dist/services/session.js";

const session = getSession("survival-test");
session.pendingBackgroundCount = 0;

const result = dispatchDetachedAgent({
  prompt: "Reply with exactly 'SURVIVAL_OK' after pausing. Use Bash tool: run 'sleep 8 && echo done', then reply with just 'SURVIVAL_OK'.",
  description: "v4.13 survival test",
  chatId: 0,
  userId: 0,
  sessionKey: "survival-test",
});

console.log(JSON.stringify({ agentId: result.agentId, outputFile: result.outputFile }));

// Parent exits IMMEDIATELY — we deliberately abandon the dispatched child.
// If child was tied to our lifecycle, it would die here. If truly detached, survives.
process.exit(0);
`;

const parentFile = "/tmp/alvin-survival-parent.mjs";
fs.writeFileSync(parentFile, parentScript);

const parent = spawn("node", [parentFile], {
  cwd: process.cwd(),
  stdio: ["inherit", "pipe", "inherit"],
});

let parentOutput = "";
parent.stdout.on("data", d => { parentOutput += d; });

await new Promise(resolve => parent.on("exit", resolve));

const match = parentOutput.match(/\{.*\}/);
if (!match) {
  console.error("[survival] ❌ parent did not print result JSON");
  process.exit(1);
}
const { agentId, outputFile } = JSON.parse(match[0]);
console.log(`[survival] parent exited. dispatched agentId=${agentId}`);
console.log(`[survival] outputFile=${outputFile}`);
console.log(`[survival] parent is DEAD now. waiting for detached subprocess to complete...`);

// Now poll the output file. If the subprocess died with the parent,
// we'll see no growth. If it survived, we'll see a completion marker.
const TIMEOUT_MS = 120_000;
const startedAt = Date.now();

async function pollOnce() {
  if (!fs.existsSync(outputFile)) return { state: "missing" };
  const content = fs.readFileSync(outputFile, "utf-8");
  const lines = content.split("\n").filter(l => l.length > 0);
  // Scan for a result event (stream-json format)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.type === "result") return { state: "completed", result: e.result };
    } catch {}
  }
  return { state: "running", size: content.length };
}

while (Date.now() - startedAt < TIMEOUT_MS) {
  const s = await pollOnce();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[survival] t+${elapsed}s: ${JSON.stringify(s).slice(0, 100)}`);
  if (s.state === "completed") {
    console.log(`[survival] ✅ SUBPROCESS SURVIVED parent death and completed in ${elapsed}s`);
    console.log(`[survival] result: ${s.result?.slice(0, 120)}`);
    // Cleanup
    try { fs.unlinkSync(outputFile); } catch {}
    try { fs.unlinkSync(outputFile.replace(/\.jsonl$/, ".err")); } catch {}
    try { fs.unlinkSync(parentFile); } catch {}
    process.exit(0);
  }
  await new Promise(r => setTimeout(r, 2000));
}

console.error(`[survival] ❌ TIMEOUT after ${TIMEOUT_MS/1000}s — subprocess did not complete`);
console.error(`[survival] this likely means the detach didn't work`);
try { fs.unlinkSync(parentFile); } catch {}
process.exit(1);
