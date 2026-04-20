#!/usr/bin/env node
/**
 * v4.13 real-world smoke test: actually dispatch a sub-agent, watch its
 * output file, verify our parser recognises completion.
 *
 * Run:   node scripts/smoke-test-dispatch.mjs
 * Pass:  exit code 0
 * Fail:  exit code 1 + error message
 */
import { dispatchDetachedAgent } from "../dist/services/alvin-dispatch.js";
import { parseOutputFileStatus } from "../dist/services/async-agent-parser.js";
import { getSession } from "../dist/services/session.js";
import fs from "fs";

console.log("[smoke] v4.13 dispatch smoke test — starting");

const sessionKey = "smoke-test-" + Date.now();
const session = getSession(sessionKey);
session.pendingBackgroundCount = 0;

console.log(`[smoke] sessionKey=${sessionKey}`);

const result = dispatchDetachedAgent({
  prompt: "Reply with exactly the string 'SMOKE_TEST_OK_v4.13' and nothing else. No preamble, no afterword. Just that string.",
  description: "v4.13 smoke test",
  chatId: 0,
  userId: 0,
  sessionKey,
});

console.log(`[smoke] dispatched: agentId=${result.agentId}, outputFile=${result.outputFile}`);
console.log(`[smoke] session.pendingBackgroundCount=${session.pendingBackgroundCount}`);

if (!result.spawned) {
  console.error("[smoke] ❌ dispatch did not report spawned=true");
  process.exit(1);
}
if (session.pendingBackgroundCount !== 1) {
  console.error(`[smoke] ❌ expected pendingBackgroundCount=1, got ${session.pendingBackgroundCount}`);
  process.exit(1);
}
if (!fs.existsSync(result.outputFile)) {
  console.error(`[smoke] ❌ output file does not exist: ${result.outputFile}`);
  process.exit(1);
}

console.log("[smoke] dispatch + file creation OK — now polling for completion...");

const startedAt = Date.now();
const TIMEOUT_MS = 120_000; // 2 minutes max
const POLL_MS = 2000;

async function pollUntilDone() {
  while (Date.now() - startedAt < TIMEOUT_MS) {
    const status = await parseOutputFileStatus(result.outputFile);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const size = fs.existsSync(result.outputFile) ? fs.statSync(result.outputFile).size : 0;
    console.log(`[smoke] t+${elapsed}s: state=${status.state}, size=${size}`);
    if (status.state === "completed") {
      console.log(`[smoke] ✅ COMPLETED in ${elapsed}s`);
      console.log(`[smoke] output: ${JSON.stringify(status.output).slice(0, 200)}`);
      if (status.tokensUsed) {
        console.log(`[smoke] tokens: in=${status.tokensUsed.input}, out=${status.tokensUsed.output}`);
      }
      if (!status.output.includes("SMOKE_TEST_OK_v4.13")) {
        console.error(`[smoke] ⚠️ output does not contain expected token — but completion detected`);
      }
      return true;
    }
    if (status.state === "failed") {
      console.error(`[smoke] ❌ dispatch reported failure: ${status.error}`);
      return false;
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  console.error(`[smoke] ❌ TIMEOUT after ${TIMEOUT_MS/1000}s — still running`);
  return false;
}

const ok = await pollUntilDone();

// Cleanup — remove test output file
try { fs.unlinkSync(result.outputFile); } catch {}
try { fs.unlinkSync(result.outputFile.replace(/\.jsonl$/, ".err")); } catch {}

process.exit(ok ? 0 : 1);
