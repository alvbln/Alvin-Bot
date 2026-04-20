# Changelog

All notable changes to Alvin Bot are documented here.

## [4.16.0] — 2026-04-20

### 🚀 Feature: bot-owned CDP Chromium — no more hub dependency

**Problem for new users:** The bot's CDP strategy and the `browse` / `social-fetch` skills referenced `~/.claude/hub/SCRIPTS/browser.sh` — a private tooling setup that only the maintainer has. New npm installs silently lacked a working CDP path; the skill-documented commands errored with "file not found". A second failure mode: when a user followed any online guide to start Chrome with `--remote-debugging-port` while their daily Chrome was already running, macOS LaunchServices silently routed the call to the existing instance without applying the flag (log: "Wird in einer aktuellen Browsersitzung geöffnet"), and no CDP endpoint came up.

**Fix — three additions:**

1. **`src/services/cdp-bootstrap.ts` (new):** Spawns Playwright's bundled *Google Chrome for Testing* binary with a distinct bundle ID — zero conflict with the user's daily Chrome. Dynamic binary resolution walks the latest `chromium-NNNN/` cache directory; cross-platform (macOS arm64/x64, Linux, Windows). Idempotent `ensureRunning()` — safe to call from multiple concurrent code paths, serialized via a single-flight lock. Cleans stale PID files, verifies liveness via both process signal and CDP `/json/version` probe, captures Chromium stderr to `~/.alvin-bot/browser/chrome-cdp.log` for diagnosis.

2. **`alvin-bot browser` CLI subcommand (new):** Stable shell interface that works on every install — `start`, `stop`, `status`, `goto`, `shot`, `eval`, `tabs`, `doctor`. Wraps the bootstrap so agents in skills have a single, documented command. Screenshots default to `~/.alvin-bot/browser/screenshots/`.

3. **`browser-manager` rewired:** The `cdp` strategy now calls `cdp-bootstrap.ensureRunning()` first (works for every install), and only falls back to the hub script if present (maintainer-only dev convenience). The whole cascade still works with no hub at all.

**Skills updated:**
- `skills/browse/SKILL.md` — rewritten to use `alvin-bot browser ...` commands; hub-script references removed (kept as "if present" note for dev environments).
- `skills/social-fetch/SKILL.md` — CDP fallback line uses `alvin-bot browser goto/shot`.

**Docs:**
- `CLAUDE.md` — browser automation section switched to `alvin-bot browser` everywhere. Tier 0 (curl/WebFetch) now explicit as the cheapest path. Tier 1 example uses inline `node -e` + Playwright (no hub dependency).
- `src/paths.ts` — `HUB_BROWSER_SH` annotated as dev-only optional. New paths: `CDP_PROFILE_DIR`, `CDP_SCREENSHOTS_DIR`, `CDP_PID_FILE`, `CDP_LOG_FILE` under `~/.alvin-bot/browser/`.

**First-run setup (one-time):**
```bash
npx playwright install chromium
```

**Verified on 2026-04-20 with user's daily Chrome running:**
- `alvin-bot browser start` → PID + endpoint, no LaunchServices hijack
- `alvin-bot browser stop` + immediate `alvin-bot browser shot <url>` → CDP auto-starts, screenshot written (15 KB PNG in `~/.alvin-bot/browser/screenshots/`)
- `alvin-bot browser doctor` → all 4 checks green (binary, endpoint, PID, profile lock)
- `npm test` → 504/504 tests passing

## [4.15.2] — 2026-04-17

### 🐛 Fix: sleep-aware heartbeat prevents false failover after macOS wake

**Problem:** When the Mac goes to sleep, Node.js' `setInterval` pauses completely. After waking up, the first heartbeat probe runs against a CLI + network stack that's still warming up (OAuth token refresh, DNS cache cold, TCP connections stale). The 5s `isAvailable()` timeout is too tight for post-wake latency → probe fails → 2 consecutive failures (the heartbeat fires its backlog) → auto-failover to Ollama → the bot silently answers via Gemma4 instead of Claude, sometimes for hours.

**Evidence:** Logs showed a 7-hour gap (02:02–09:14 UTC) with zero heartbeat activity — the Mac was asleep. Immediately after wake, `claude-sdk: failure 1/2` → `unhealthy` → Ollama boot. The auto-recovery logic was correct but had no chance to fire before a manual restart.

**Fix — three mechanisms in `heartbeat.ts`:**

1. **Sleep detection via wall-clock drift:** If `now - lastHeartbeatRanAt > 2× interval`, the machine was suspended. On detection:
   - 60s grace period where probe failures don't count toward the fail threshold
   - All stale failure counters reset to zero (pre-sleep failures are meaningless)
   - `isAvailable()` caches invalidated (a 7-hour-old "available: false" cache must not survive wake)

2. **Quick recovery probe:** After every failover, schedule an extra heartbeat after 60s (not 5 min). If the primary is already back, recovery happens in ≤60s instead of up to 5 minutes.

3. **Cache invalidation API:** `ClaudeSDKProvider.invalidateAvailabilityCache()` exposed so the heartbeat can clear stale results after sleep.

**Typical post-sleep flow with fix:**
```
[wake]   → 💓 😴 Sleep detected (~420min gap). Grace period 60s
         → reset claude-sdk to healthy, invalidate caches
[+0s]    → 💓 😴 claude-sdk: probe failed during grace period — not counting
[+60s]   → grace expired → normal probe → claude-sdk healthy ✅
```
Without the fix, the same scenario triggered failover at +0s.

---

## [4.15.1] — 2026-04-16

### 🐛 Patch: suppress `fallbackModel` when primary is Haiku

v4.15.0 unconditionally set `fallbackModel: "haiku"` on every Agent SDK call as a rate-limit safety net. When the user switched to `claude-haiku` (via `/model claude-haiku` or a workspace `model: haiku`), the SDK rejected the request:

> *Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.*

The provider registry treated this as a normal failure and cascaded to the next fallback — Ollama — which then had to cold-boot (~45 s for `gemma4:e4b`). Visible symptom: a sudden multi-second latency spike immediately after picking Haiku, followed by the bot answering via the local model instead of Claude.

**Fix:** `src/providers/claude-sdk-provider.ts` now checks whether the resolved primary model contains `"haiku"` and omits `fallbackModel` in that case. Opus / Sonnet / `inherit` still get Haiku as fallback. No other provider paths affected.

### Commits

- `ec205b5` — fix(providers): v4.15.1 — don't set fallbackModel when primary is Haiku

---

## [4.15.0] — 2026-04-16

### ✨ Feature: auto-latest Claude model selection + per-workspace overrides

Alvin now picks up new Claude models (e.g. Opus 4.7 on Max subscription) automatically, and users can switch between Opus / Sonnet / Haiku tiers directly from Telegram — or pin a specific tier per workspace.

#### What's new

**`/model` now lists four Claude entries** (plus any configured custom providers + Ollama):
- `Claude (Agent SDK)` — CLI default (= whatever Anthropic ships as current, currently Opus 4.7)
- `Claude Opus (auto-latest)` — forwards `model: "opus"` to the Agent SDK → latest Opus tier
- `Claude Sonnet (auto-latest)` — same pattern with Sonnet
- `Claude Haiku (auto-latest)` — same pattern with Haiku

The three aliased entries all route through `ClaudeSDKProvider` with different `model:` values. Switching persists to `~/.alvin-bot/.env` (`PRIMARY_PROVIDER=…`), so the choice survives bot restarts.

**Workspaces can pin a model** via an optional YAML frontmatter field:

```yaml
---
purpose: Interview prep
cwd: ~/Documents/Interviews
model: sonnet           # opus | sonnet | haiku | claude-opus-4-7 | ...
---
```

When `model:` is omitted (the default for all existing workspaces), the globally active `/model` choice is used — no behaviour change.

**Fallback on rate limits:** the Agent SDK is now always called with `fallbackModel: "haiku"`. Keeps the bot responsive when the primary tier is throttled.

#### Why this matters

Before v4.15, `claude-opus-4-6` was hardcoded in six places. When Anthropic released Opus 4.7 on the Max plan, the CLI picked it up automatically — but Alvin's `/status` still claimed `claude-opus-4-6`, and there was no way to force a specific tier from Telegram. The Agent SDK's `query()` call wasn't even receiving a `model:` parameter, so whatever lived in `config.model` was dead metadata.

Now:
- The default `"inherit"` means "don't pass model: — let the CLI pick its current default." Fresh installs on Max plans get Opus 4.7 automatically.
- Aliases (`opus` / `sonnet` / `haiku`) resolve to the latest tier each release cycle without any code change.
- Pinning a specific ID (e.g. `claude-opus-4-7`) is supported for reproducibility.

#### Implementation

- `src/providers/claude-sdk-provider.ts` — forwards `model:` and sets `fallbackModel: "haiku"` on every `query()` call. Resolution order: per-query `options.model` → provider `this.config.model` → `"inherit"` (= no model passed).
- `src/providers/registry.ts` — registers three virtual entries (`claude-opus`, `claude-sonnet`, `claude-haiku`) as additional keys all backed by `ClaudeSDKProvider` with different `model:` values.
- `src/services/env-file.ts` — new module extracting the `readEnv` / `writeEnvVar` / `removeEnvVar` helpers from `setup-api.ts` so Telegram command handlers can persist runtime choices.
- `src/handlers/commands.ts` — `switchProviderWithLifecycle` now calls `writeEnvVar("PRIMARY_PROVIDER", targetKey)` on every switch, not just Web UI changes.
- `src/services/workspaces.ts` — `Workspace` type gets optional `model?: string`, the YAML parser picks it up from frontmatter.
- `src/providers/types.ts` — `QueryOptions` gets optional `model?: string` for per-query overrides.
- `src/handlers/message.ts` + `src/handlers/platform-message.ts` — both forward `workspace.model` into `queryOpts` when the active workspace has one defined.

#### Backward compatibility

- Default provider config is `"inherit"` — identical to pre-v4.15 behaviour (no `model:` passed to the Agent SDK, CLI default wins).
- Workspaces without a `model:` field behave exactly as before.
- Stale presets `claude-sonnet-4-20250514` → `claude-sonnet-4-6` and `claude-3-5-haiku-20241022` → `claude-haiku-4-5` updated (previously unused — only affected the REST-API code paths, which nobody referenced).

#### Docs

Workspace guides updated (`docs/install/workspaces-de.html` + `workspaces-en.html`) — the YAML-field reference table now documents the new optional `model:` entry.

### 🐛 Bonus: stale model-ID cleanup

Four hardcoded Claude model IDs replaced with current strings: `claude-sonnet-4-20250514` → `claude-sonnet-4-6`, `claude-3-5-haiku-20241022` → `claude-haiku-4-5`, openai-compat fallback `claude-opus-4` → `claude-opus-4-6`, setup-API defaults likewise. None of these were on active code paths, but they would have shipped confusing display names if anyone had referenced them.

### Commits

- `fed4b91` — feat(providers): v4.15 — auto-latest Claude model selection via /model
- `b2a6e1f` — feat(workspaces): v4.15 — optional per-workspace model override

---

## [4.14.2] — 2026-04-16

### 🐛 Patch: watcher zombie-entry fix (missing outputFile > 10 min = failed)

**Edge case the maintainer caught today:** a pending async-agent entry stuck in `/subagents list` for 3+ hours showing "running" — but the underlying `alvin_dispatch_agent` subprocess had already died (its output file was gone). The entry would have continued haunting the list until the 12-hour `giveUpAt` ceiling fired.

**Root cause:** `async-agent-watcher`'s `pollOnce` handled four states from `parseOutputFileStatus` — `completed` / `failed` / `running` / `missing`. For `missing` (file doesn't exist or is empty), the watcher just kept polling forever, on the assumption that a slow subprocess might eventually write. If the subprocess crashed before writing ANY output, the file never appeared, and we polled for 12 hours before timing out.

**Fix:** when `status.state === "missing"` AND `now - entry.startedAt > MISSING_FILE_FAILURE_MS` (default 10 min, configurable via `ALVIN_MISSING_FILE_FAILURE_MS` env var), deliver as failed with an explicit message:

> *Dispatched subprocess never wrote its output file (N m after start). Likely crashed before initializing, or the file was removed externally.*

10 minutes is well above any legitimate `claude -p` startup variance (normal first-write latency is seconds) and well below the 12-hour hard ceiling.

### What's preserved (regression-guard tested)

- Running agents (file has content but no `end_turn`/`result` yet) are untouched by this path — they still keep polling as before.
- Completed agents (clean `end_turn` or `stream-json result` event) still deliver normally.
- Explicit `failed` state from the parser (if ever used) still delivers error normally.
- v4.12.4's "file is stale but has text → deliver partial" path takes precedence over the new zombie check (the file has content, so not "missing").
- 12-hour `giveUpAt` hard ceiling still applies as the ultimate safety net.
- Session's `pendingBackgroundCount` decrement fires on zombie failure, same as every other delivery path.

### Testing

- **Baseline**: 498 tests (v4.14.1)
- **New**: `test/watcher-zombie-fix.test.ts` — 6 tests:
  - Young missing file (<threshold) stays pending
  - Old missing file (>threshold) delivers failed + removes from pending
  - Default threshold is 10 min when env var unset
  - Running file (has content) is unaffected by zombie check
  - Completed file delivers as completed (regression guard)
  - Session's `pendingBackgroundCount` decrements on zombie delivery
- **Total**: 504 tests, all green, TSC clean

### Files changed

- **Modified**: `src/services/async-agent-watcher.ts` (new `getMissingFileFailureMs()` + zombie branch in `pollOnce`)
- **NEW tests**: `test/watcher-zombie-fix.test.ts`
- **Version**: `package.json` 4.14.1 → 4.14.2

---

## [4.14.1] — 2026-04-16

### 🐛 Patch: `/subagents list` now shows v4.13+ dispatch agents too

**Bug the maintainer caught:** typing `/subagents list` in Telegram while a `alvin_dispatch_agent` sub-agent was actively running returned "no agents running" — even though the user could see the agent finish and deliver a result shortly after. Cross-platform effect too: `/alvin` slash command on Slack had the same display gap.

**Root cause:** two separate registries for sub-agents:
- `src/services/subagents.ts` `activeAgents` Map — used since v4.0.0 for bot-level sub-agents (cron spawns, implicit Task tool children, `/sub-agents spawn` CLI)
- `src/services/async-agent-watcher.ts` `pending` Map — used since v4.13 for detached `alvin_dispatch_agent` subprocesses

`/subagents list` only read from the first map. The entire v4.13+ dispatch path was invisible in the listing.

**Fix:** new `listActiveSubAgents()` helper in subagents.ts that merges both registries. Pending async-agent-watcher entries get synthesized into `SubAgentInfo` shape (status="running", source="cron", depth=0, platform preserved). The `/subagents list` handler and the default-render path both switch to the merged helper. The old `listSubAgents()` function stays pure (unchanged behavior) — cancel/result paths still use it because detached subprocess PIDs aren't tracked.

### Technical details

- `listActiveSubAgents()` is async (lazy dynamic import of the watcher module to keep subagents.ts load order clean) — existing `listSubAgents()` remains sync for the v4.0.0 consumers
- Synthesis mapping: `PendingAsyncAgent.agentId → SubAgentInfo.id`, `description → name`, `startedAt → startedAt`, always `status="running"` (pending by definition), `source="cron"` (matches watcher's delivery banner), `depth=0`
- Platform field preserved so the renderer can show cross-platform context if desired later

### Testing

- **Baseline**: 492 tests (v4.14.0)
- **New**: `test/list-subagents-merged.test.ts` — 6 tests (empty state, single slack agent, multi-platform merge, timestamp preservation, source tag, listSubAgents purity guard)
- **Total**: 498 tests, all green, TSC clean

### Files changed

- **Modified**: `src/services/subagents.ts` (new listActiveSubAgents helper), `src/handlers/commands.ts` (both /subagents list paths switch to merged view)
- **NEW tests**: `test/list-subagents-merged.test.ts`
- **Version**: `package.json` 4.14.0 → 4.14.1

---

## [4.14.0] — 2026-04-16

### ✨ Sub-agent dispatch on Slack, Discord, WhatsApp (Telegram unchanged)

v4.13.0 shipped truly-detached sub-agents via the `mcp__alvin__dispatch_agent` MCP tool, but only Telegram passed the required `alvinDispatchContext` to the provider. Slack/Discord/WhatsApp users couldn't trigger background sub-agents — the tool was visible to Claude but effectively unreachable.

v4.14 wires the same dispatch path through the non-Telegram handler (`src/handlers/platform-message.ts`) and adds a platform-aware delivery router so results come back on the same platform they were dispatched from.

**Telegram is untouched.** The v4.13.0 Telegram pipeline (message.ts → Claude SDK → alvin_dispatch_agent → watcher → grammy-api delivery) is bit-for-bit identical. Only the types widened (`chatId: number | string`, `platform?: ...`), and the new code paths activate only when `platform !== "telegram"`.

### Technical details

**Type widening** (`src/services/async-agent-watcher.ts`, `src/services/alvin-dispatch.ts`, `src/services/alvin-mcp-tools.ts`, `src/providers/types.ts`, `src/services/subagents.ts`):
- `PendingAsyncAgent.chatId` / `userId`: `number` → `number | string`
- `PendingAsyncAgent.platform?: "telegram" | "slack" | "discord" | "whatsapp"` (optional, undefined = telegram)
- `SubAgentInfo.parentChatId`: same widening
- `SubAgentInfo.platform?: ...` new field
- `DispatchInput`, `AlvinDispatchContext`, `QueryOptions.alvinDispatchContext`: same widening + `platform` field

Pre-v4.14 persisted `async-agents.json` entries keep working — missing `platform` field defaults to `telegram`, numeric `chatId` still routes through grammy.

**New module** `src/services/delivery-registry.ts`:
- `registerDeliveryAdapter({ platform, sendText, sendDocument? })` — called by each platform module at startup
- `getDeliveryAdapter(platform)` — watcher lookup
- Tiny surface: sendText + optional sendDocument, string | number chatId, no Markdown or live-stream

**Delivery router** `src/services/subagent-delivery.ts` `deliverSubAgentResult()`:
- Branches on `info.platform ?? "telegram"`:
  - `telegram` → existing grammy path (unchanged Markdown parsing, file uploads, 3800-char chunking)
  - `slack`/`discord`/`whatsapp` → new `deliverViaRegistry()` path — plain text (no Markdown), 3800-char chunks, optional file upload via adapter.sendDocument

**Adapter registration** in `src/platforms/slack.ts`, `src/platforms/discord.ts`, `src/platforms/whatsapp.ts`:
- Each platform's `start()` now calls `registerDeliveryAdapter` at the end
- The adapter's `sendText` wraps the existing platform `sendText` (no duplicate code)

**Handler wiring** `src/handlers/platform-message.ts`:
- When the active provider is SDK, `alvinDispatchContext: { chatId, userId, sessionKey, platform }` is passed in queryOpts — mirrors the Telegram handler's v4.13.0 behavior
- Claude sees the same `mcp__alvin__dispatch_agent` tool and uses it the same way

### Testing

- **Baseline**: 483 tests (v4.13.2)
- **New**:
  - `test/delivery-registry.test.ts` — 4 tests (register/get roundtrip, unregistered returns null, re-register replaces, per-platform isolation)
  - `test/subagent-delivery-platform-routing.test.ts` — 5 tests (slack routes via registry not grammy, telegram defaults still use grammy, discord routes correctly, orphan platform skips gracefully, long output chunks on non-telegram adapters)
- **Total**: 492 tests, all green, TSC clean
- **Telegram regression guard**: the routing test explicitly verifies `info.platform=undefined` still hits grammy, and `info.platform='slack'` never touches grammy. That's the load-bearing invariant.

### Files changed

- **NEW**: `src/services/delivery-registry.ts`, `test/delivery-registry.test.ts`, `test/subagent-delivery-platform-routing.test.ts`
- **Modified**: `src/services/async-agent-watcher.ts` (chatId widening + platform field), `src/services/subagent-delivery.ts` (platform router + plain-text banner variant), `src/services/alvin-dispatch.ts` (type widening), `src/services/alvin-mcp-tools.ts` (context pass-through), `src/services/subagents.ts` (SubAgentInfo.platform + widened parentChatId), `src/providers/types.ts` (QueryOptions.alvinDispatchContext extended), `src/handlers/platform-message.ts` (dispatch context), `src/platforms/slack.ts` / `discord.ts` / `whatsapp.ts` (adapter registration)
- **Version**: `package.json` 4.13.2 → 4.14.0 (minor bump — new public surface: delivery-registry, platform field)

### Known limitations

- **Slack slash command context**: when a user invokes `/alvin <prompt>` in Slack, dispatch works (same codepath), but the sub-agent result delivery lands as a persistent channel message, not an ephemeral slash-command response. If you want ephemeral replies, use DM.
- **Discord/WhatsApp not smoke-tested**: the code paths match Slack, and the adapter registration is symmetric, but I only end-to-end tested Slack. YMMV until you run a real test.

---

## [4.13.2] — 2026-04-16

### ✨ Slack: `/alvin` slash commands + rewritten setup guide

**Bug (carried over from v4.13.1):** Slash commands didn't work on Slack. When a user typed `/status` in a DM with the bot, Slack either hit its built-in `/status` (user status setter) or showed "Not a valid command" — nothing reached the bot. The Slack adapter only registered `message` + `app_mention` event handlers, no `command` handler; the manifest declared no slash commands.

**Why it was a gotcha**: Slack treats slash commands as a separate event type (`command`), not as message text. Apps must explicitly register each command in their manifest AND add a `app.command(...)` handler to receive the events. None of this had been set up.

**Fix**: v4.13.2 introduces a single namespaced command `/alvin` that takes a subcommand argument. Users type `/alvin status`, `/alvin new`, `/alvin effort high`, `/alvin help` — the Slack adapter parses the subcommand from `command.text` and forwards it as a `/status`/`/new`/etc. message through the existing `handlePlatformCommand` pipeline. Unknown subcommands fall through to normal LLM handling so `/alvin what's the weather` also works as a free-form query.

### Technical details

**New parser** `src/platforms/slack-slash-parser.ts`: pure `parseSlackSlashCommand(text)` helper. Empty text → `/help`. Single word → `/<word>`. Word + args → `/<word> <args>`. Lowercases subcommand, preserves arg capitalization, strips defensive leading slash, collapses extra whitespace. 8 unit tests.

**Adapter change** `src/platforms/slack.ts`: new `app.command("/alvin", ...)` registration in `start()` (guarded with `typeof app.command === "function"` for test-mock compat). `ack()` fires immediately to meet Slack's 3-second requirement. New `handleSlashCommand(command)` method synthesizes an `IncomingMessage` with the translated `text` and the command's `channel_id`/`user_id` and forwards to the same `this.handler(...)` path as regular DMs. Response goes back via `chat.postMessage` (persistent, visible in channel history) rather than slash-command-native `respond()` (ephemeral) — matches DM behavior.

**Slack app manifest**: requires a new `features.slash_commands` entry declaring `/alvin` and a new `commands` OAuth scope. Both are in the manifest JSON the setup guide pastes in — no manual per-field config. Existing installations need a one-time re-install to pick up the new `commands` scope (Slack shows a yellow banner after manifest save).

**Setup guide rewrite** `src/web/setup-api.ts` Slack `setupSteps[]`: replaces the old 7-step "click-through every section" sequence with a 9-step manifest-paste flow that actually matches how the bot is currently set up (Messages Tab, Events, Socket Mode, slash commands — all covered in one JSON paste). Includes the full manifest JSON inline. New users get a working Slack app in ~2 minutes instead of hunting through the Slack API UI.

### Testing

- **Baseline**: 475 tests (v4.13.1)
- **New**: `test/slack-slash-command.test.ts` — 8 tests (empty → /help, single word, args preservation, whitespace collapse, case insensitivity on subcommand, case preservation on args, defensive leading slash handling)
- **Total**: 483 tests, all green, TSC clean
- **Live smoke verification**: manifest pushed via Chrome browser automation, reinstall completed, Slack adapter re-registered with `app.command("/alvin")`. Live test of `/alvin status` pending user confirmation.

### Files changed

- **NEW**: `src/platforms/slack-slash-parser.ts`, `test/slack-slash-command.test.ts`
- **Modified**: `src/platforms/slack.ts` (command registration + handler), `src/web/setup-api.ts` (slack setupSteps rewrite), `package.json` (4.13.1 → 4.13.2)

### Known limitations

- **One command namespace only**: we register `/alvin` not individual `/status`/`/new` etc. because `/status` conflicts with Slack's built-in command. Side effect: slightly more typing for users (`/alvin status` vs `/status`). Alternative namespaces considered (`/alvin-status` as multiple commands each) would work too but require more manifest boilerplate; deferred unless users complain.
- **Channel responses are public**: when `/alvin status` is invoked in a channel, the bot's response is a normal `chat.postMessage` visible to the whole channel. If you want private responses there, use DM or switch the sendText call to use Slack's `response_url` (ephemeral). Deferred as enhancement — DM is the primary use case.

---

## [4.13.1] — 2026-04-16

### 🐛 Patch: Slack Test Connection + PM2 → launchd migration for Maintenance UI

Two latent UI bugs surfaced during live Slack setup:

**Bug 1 — `/api/platforms/test-connection` returned "Unknown platform" for Slack.** The handler in `setup-api.ts` only knew about telegram/discord/signal/whatsapp. Users who entered a valid Bot Token (`xoxb-…`) + App Token (`xapp-…`) and clicked Test Connection got a confusing "Unknown platform" error — couldn't tell if their tokens were wrong or the feature was broken.

**Fix:** New `slack` case in the handler. Validates Bot Token via `https://slack.com/api/auth.test` (cheap, ~100ms). For App Token, checks the `xapp-` prefix as the quickest sanity check (Socket Mode can't actually be "pinged" without opening a persistent WebSocket). Returns the authenticated bot user + team name on success, or Slack's own `auth.test` error (e.g. `invalid_auth`, `token_expired`) on failure. Warns if App Token is missing or has wrong prefix even when Bot Token is valid — helps users notice they only configured half the pair.

**Bug 2 — Maintenance section's buttons were broken on macOS launchd installs.** Since v4.8 the macOS install runs under `launchd` (`com.alvinbot.app.plist`), not PM2. But `doctor-api.ts` kept calling `pm2 jlist`/`pm2 restart`/`pm2 stop`/`pm2 logs`. Results: status endpoint returned stale data from ghost PM2 entries (uptime/memory/cpu/restarts all wrong), Stop/Start buttons silently failed, log viewer was empty. The Restart button accidentally worked because it used `scheduleGracefulRestart` (launchd's `KeepAlive` auto-brings-back on exit).

**Fix:** New `src/services/process-manager.ts` abstraction that auto-detects the active supervisor per request:
- **launchd** (macOS) if `launchctl print gui/$UID/com.alvinbot.app` succeeds
- **pm2** (VPS / legacy installs) if `pm2 jlist` lists our process
- **standalone** if neither (fallback — only Restart works, since there's no supervisor to bring the process back)

Each manager implements `getStatus()`, `stop()`, `start()`, `getLogs()` with the right tooling:
- launchd: `launchctl print` + `ps -p <pid> -o %cpu=,%mem=,rss=,etime=` for resource stats, `launchctl bootout` / `bootstrap` for stop/start, `tail` on the known log paths for logs
- pm2: unchanged — `pm2 jlist` / `pm2 stop` / `pm2 start` / `pm2 logs`
- standalone: `process.uptime()` / `process.memoryUsage()` / manual log tailing

The WebUI routes (`/api/pm2/status`, `/api/pm2/action`, `/api/pm2/logs`) keep their names for compat but now dispatch via `detectProcessManager()`. Real-world verified against the running bot: detection returned `launchd`, PID/uptime/memory all correct from the actual launchd-managed process (not a stale PM2 ghost).

### Testing

- **Baseline**: 460 tests (v4.13.0)
- **New**:
  - `test/slack-test-connection.test.ts` — 5 tests (no tokens set, auth.test accepts, auth.test rejects, App Token format warning, unknown platform regression)
  - `test/process-manager.test.ts` — 10 tests (detection order, each manager's status parsing, stop/start command dispatch)
- **Total**: 475 tests, all green, TSC clean
- **Live verification**: ran `detectProcessManager().getStatus()` against the actual running bot → returned `launchd`, PID 4767 (matches `launchctl print pid = 4767`), uptime 655s, memory 76MB — all real data, not stale PM2 cache

### Files changed

- **NEW**: `src/services/process-manager.ts`, `test/slack-test-connection.test.ts`, `test/process-manager.test.ts`
- **Modified**: `src/web/setup-api.ts` (+slack case in test-connection), `src/web/doctor-api.ts` (routes use process-manager abstraction), `package.json` (4.13.0 → 4.13.1)

### Known limitations (deferred to v4.14)

- **Slack subagent support**: v4.13.0's `mcp__alvin__dispatch_agent` tool only activates on the Telegram handler (passes `alvinDispatchContext`). Slack users can receive normal replies but can't trigger background sub-agents yet. Requires extending `PendingAsyncAgent.chatId` to `number | string`, adding `platform` to the watcher's pending record, and making `subagent-delivery.ts` platform-aware. Tracked for v4.14.

---

## [4.13.0] — 2026-04-16

### ✨ Major: truly detached sub-agent dispatch via `alvin_dispatch_agent` MCP tool

**Background.** v4.12.1 → v4.12.3 tried three progressively more complex fixes for the "bot freezes while sub-agent runs" problem, all of which depended on Claude Agent SDK's built-in `Task(run_in_background: true)` tool. All three iterations missed the same architectural reality: the SDK's background task stays tied to the parent SDK subprocess lifecycle. When v4.12.3's bypass path aborted the parent to unblock the user, the abort cascaded into killing the in-flight sub-agent mid-work. v4.12.4 worked around this at the delivery layer (recovering partial output after a 5-min staleness window), but the fundamental architecture was still wrong.

v4.13 fixes the architecture. Instead of using the SDK's built-in Task tool for background work, we register our own MCP tool — `mcp__alvin__dispatch_agent` — which spawns a **completely independent** `claude -p` subprocess (its own PID, its own process group, unreferenced from the parent's event loop). Aborting the parent has zero effect on the dispatched subprocess. It continues to write its stream-json output to its own file and runs to completion. The async-agent-watcher polls the output file and delivers the result as a separate message when ready.

Empirically verified with a standalone survival test (`scripts/smoke-test-abort-survival.mjs`): dispatch an agent that needs 20+ seconds of work, kill the parent Node process 100ms later, watch the subprocess keep writing to its output file and complete cleanly with the expected result.

### What changed for the user

- **Before v4.13** (with Task tool): the bot shows "typing…" for the entire duration of the sub-agent's work (5, 20, 60 minutes). New messages sit in a queue and don't get processed. If the user interrupts via v4.12.3's bypass, the sub-agent dies mid-work and hours later the user gets a `720m timeout · (empty output)` message.
- **After v4.13** (with `alvin_dispatch_agent`): the bot's turn completes within seconds of dispatch. The user sees "🤖 Dispatched 2 background agents — I'll send the results when ready." and can immediately chat about anything else. The background subprocesses finish cleanly and deliver their full results as separate messages.

This matches the OpenClaw experience the user was asking about — except it's built natively into Claude Agent SDK's MCP-tool mechanism, not a wholesale replacement.

### Technical details

**New module** `src/services/alvin-dispatch.ts`
- `dispatchDetachedAgent(input)` — spawns `claude -p <prompt> --output-format stream-json` via `child_process.spawn({ detached: true, stdio: ["ignore", outFd, errFd] })` + `.unref()`
- Synchronous return: `{ agentId, outputFile, spawned: true }`
- Side effects: registers with `async-agent-watcher`, increments `session.pendingBackgroundCount`
- Unique agent IDs via `crypto.randomBytes(12).toString("hex")` (collision-safe for parallel dispatch)
- Cleans `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` from env to prevent nested-session errors

**New module** `src/services/alvin-mcp-tools.ts`
- `buildAlvinMcpServer(ctx)` — creates an SDK MCP server bound to this turn's `{ chatId, userId, sessionKey }` context via closure
- Exposes `dispatch_agent` tool (zod-validated input: `{ prompt: string, description: string }`)
- Tool handler calls `dispatchDetachedAgent` and returns `agentId + outputFile` to Claude
- Uses SDK's `createSdkMcpServer` + `tool` builders (the SDK's native inline-tool API — no separate MCP server process needed)

**Provider integration** (`src/providers/claude-sdk-provider.ts`)
- New `QueryOptions.alvinDispatchContext` field — when set, provider registers `mcpServers: { alvin: buildAlvinMcpServer(ctx) }` + appends `mcp__alvin__dispatch_agent` to the default `allowedTools` list
- When unset, the MCP server is not registered and Claude falls back to the built-in Task tool only
- Non-SDK providers ignore the new field entirely

**Handler integration** (`src/handlers/message.ts`)
- Passes `alvinDispatchContext: { chatId, userId, sessionKey }` on every SDK turn
- No other handler changes — the bypass path, the staleness parser, and the pending-count decrement are all reused from v4.12.3/v4.12.4

**Parser extension** (`src/services/async-agent-parser.ts`)
- New first-pass scan for `{"type":"result"}` events — the completion marker used by `claude -p --output-format stream-json` (different from the SDK-internal sub-agent format that uses `message.stop_reason: "end_turn"`)
- When found, uses the `result.result` field as authoritative output when present, falls back to aggregating all assistant text blocks
- Preserves backward compat with the existing `end_turn`-based path (tested by the old test suite)

**System prompt update** (`src/services/personality.ts`)
- `BACKGROUND_SUBAGENT_HINT` rewritten to strongly prefer `mcp__alvin__dispatch_agent` over `Task(run_in_background: true)` on Telegram/WhatsApp/Slack/Discord
- Explicit decision tree, concrete example prompts, parallel-dispatch guidance
- Built-in Task tool remains available but deprecated for long-running work; reserved for the rare case where Claude needs a result in the same turn

### Known limitations

- **First-turn only for now**: the MCP server is bound to `{ chatId, userId, sessionKey }` at query construction time. If the session's underlying SDK session ID changes mid-conversation (rare), the tool context goes stale. Defensive: a new MCP server is built on each handler invocation, so any next turn picks up the correct context.
- **Non-Telegram platforms**: `src/handlers/platform-message.ts` (Slack/Discord/WhatsApp) doesn't pass `alvinDispatchContext` yet. Deferred to follow-up — the Telegram path is the primary use case and the one the user explicitly requested.
- **Parallel dispatch not smoke-tested**: the system prompt guides Claude to call `dispatch_agent` multiple times in one turn for parallel work, but I only end-to-end tested single dispatch. Should work (no shared state in the handler), but YMMV until battle-tested.

### Testing

- **Baseline**: 447 tests (v4.12.4)
- **New**:
  - `test/alvin-dispatch.test.ts` — 6 tests (spawn flags, unique IDs, watcher registration, session counter, stdio redirect, env cleanup)
  - `test/async-agent-parser-streamjson.test.ts` — 7 tests (result-event detection, token extraction, error state, running state, multi-text aggregation, `result.result` precedence, minimal fields)
- **Total**: 460 tests, all green, TSC clean
- **Real-world smoke tests** (NOT in CI — run via `node scripts/smoke-test-dispatch.mjs` and `node scripts/smoke-test-abort-survival.mjs`):
  - `smoke-test-dispatch`: dispatches a real `claude -p` subprocess, polls to completion (~10s), verifies exact output `"SMOKE_TEST_OK_v4.13"`. **PASS**.
  - `smoke-test-abort-survival`: dispatches a subprocess that needs ~25s of work, kills the parent Node process ~100ms later, polls the output file. Subprocess survives and completes cleanly. **PASS**.

### Files changed

- **NEW**: `src/services/alvin-dispatch.ts`, `src/services/alvin-mcp-tools.ts`, `scripts/smoke-test-dispatch.mjs`, `scripts/smoke-test-abort-survival.mjs`
- **NEW tests**: `test/alvin-dispatch.test.ts`, `test/async-agent-parser-streamjson.test.ts`
- **Modified**: `src/paths.ts` (SUBAGENTS_DIR), `src/services/async-agent-parser.ts` (stream-json detection), `src/providers/claude-sdk-provider.ts` (MCP server registration + allowedTools), `src/providers/types.ts` (QueryOptions.alvinDispatchContext), `src/handlers/message.ts` (pass dispatch context), `src/services/personality.ts` (BACKGROUND_SUBAGENT_HINT rewrite)
- **Version**: `package.json` 4.12.4 → 4.13.0 (minor bump — new public surface: MCP tool)

---

## [4.12.4] — 2026-04-16

### 🐛 Patch: recover partial output from interrupted background sub-agents

**The bug the maintainer saw:** Two Telegram messages appeared hours apart: `⏱️ Background agent a5bf8c74 timeout · 720m 3s · 0 in / 0 out` and `... ab9372d4 timeout · 720m 1s · 0 in / 0 out`, both with `(empty output)`. Three more agents were still pending, all interrupted mid-execution with hundreds of KB of real work sitting on disk.

**Root cause:** v4.12.3's bypass-abort calls `session.abortController.abort()`, which propagates through `claude-sdk-provider.ts`'s `internalAbortController` into the SDK's CLI subprocess, which in turn propagates into any in-flight `Agent(run_in_background: true)` tool executions. Evidence from the disk:

- `agent-a03ce829...jsonl`: 116 lines, last event = literally `"[Request interrupted by user for tool use]"` mid-Bash-tool-use
- `agent-af61fa6e...jsonl`: 81 lines, last assistant text = `"Ich habe jetzt genug Daten für den vollständigen Audit. Hier ist der Report:"` — interrupted while streaming the final report
- `agent-ac47c4a2...jsonl`: 131 lines, last assistant text = `"## Perseus Audit — Ergebnis\n### Kritische Bugs"` — interrupted a few words into the payoff

None of them reached `stop_reason: "end_turn"`. The pre-v4.12.4 `parseOutputFileStatus` only recognized `end_turn` as a completion signal, so these agents sat in the pending list for 12h until `giveUpAt` elapsed, then got delivered as `(empty output)` while their real work was still on disk.

**The fix:** `parseOutputFileStatus` now has a staleness fallback. When no `end_turn` is present BUT the outputFile hasn't been written to in `stalenessMs` (default 5 min, configurable via `ALVIN_SUBAGENT_STALENESS_MS`) AND there is usable assistant text content in the tail, the parser:

1. Aggregates ALL text blocks across all assistant turns in the tail (not just the last one — bias toward delivering more context)
2. Prepends a clear banner: `⚠️ _Sub-Agent wurde unterbrochen — hier ist der partielle Output:_`
3. Returns `state: "completed"` so the watcher delivers it instead of continuing to poll

Result: on the next `pollOnce()` after v4.12.4 ships, the three stuck agents get delivered with their real partial output (combined ~1.2MB of text across the three). Future interrupts recover within 5 minutes instead of hanging 12 hours.

### Behavioral notes

- **Clean `end_turn` sub-agents are unchanged** — the staleness fallback is a *fallback only*. The existing strict path runs first and takes precedence.
- **`stalenessMs: 0` disables the fallback entirely** — strict end_turn-only mode for callers that prefer it.
- **Thinking blocks are still filtered out** of the partial delivery — same as with clean completion.
- **Files with no assistant text at all** (only tool_use) stay in `running` state — nothing useful to deliver.
- **Tokens are surfaced when available** — the last assistant event's `usage.input_tokens`/`output_tokens` flow through to the delivery banner.

### Known limitations (carried over from v4.12.3, deferred to v4.13)

- The bypass-abort mechanism in `message.ts` still propagates to the SDK subprocess and kills in-flight sub-agents. v4.12.4 works around this at the delivery layer (recovering partial output); a true fix requires either architectural replacement of the SDK's `Task` tool with our own detached-subprocess dispatch, or SDK support for per-task-branch abort signals. Tracked for v4.13.
- Users may still experience the bot's "typing…" indicator when Claude is thinking in the main turn (before dispatching any background agent). Bypass only fires once `pendingBackgroundCount > 0`. For interrupt before dispatch, use `/cancel`.

### Testing

- **Baseline**: 436 tests (v4.12.3)
- **New**: `test/async-agent-parser-staleness.test.ts` — 11 tests covering: clean `end_turn` still wins over staleness, fresh-interrupted file stays running, stale-interrupted file delivers partial with banner, no-text file stays running, `stalenessMs: 0` disables, aggregation across multiple turns, thinking-block filtering, token extraction, interrupt-only file with no useful content, and ordering preservation.
- **Total**: 447 tests, all green, TSC clean.

### Files changed

- **Modified**: `src/services/async-agent-parser.ts` — staleness fallback in `parseOutputFileStatus`, `DEFAULT_STALENESS_MS` constant, `INTERRUPTED_BANNER` prefix.
- **NEW tests**: `test/async-agent-parser-staleness.test.ts`.
- **Version**: `package.json` 4.12.3 → 4.12.4.

---

## [4.12.3] — 2026-04-15

### 🐛 Patch: Background sub-agent no longer blocks the main Telegram session

**The bug the maintainer reported:** After launching an async sub-agent (`run_in_background: true`), sending any follow-up message to the bot silently stalled for 2+ minutes before being processed. v4.12.1/v4.12.2 attempted a prompt-hint mitigation but did NOT address the architectural root cause.

**Root cause (re-diagnosed with live SDK event logs):** The Claude Agent SDK's CLI subprocess stays alive for the full duration of a background task so it can inject the `<task-notification>` inline into the NEXT assistant turn. While that subprocess idles, Alvin's query iterator is still being drained, `session.isProcessing` stays `true`, and every new user message gets pushed into the 3-slot queue — which doesn't auto-drain. From the user's perspective: send "A" → nothing happens for 2 minutes.

**The fix (architectural workaround):** New session field `pendingBackgroundCount` tracks the number of background agents currently in-flight. When a new message arrives while `isProcessing=true` AND the counter is `>0`, the handler:

1. **Aborts the blocked query** instead of queueing. The old SDK subprocess dies; the background task's own detached subprocess keeps writing to its `output_file`.
2. **Starts a fresh SDK session** (`resume: null`) for the new message so it doesn't inherit the block. Recent conversation history is carried forward via the bridge preamble so Claude retains context.
3. **Relies on the existing `async-agent-watcher` (v4.10.0)** to poll the background task's `output_file` and deliver the result as a separate Telegram message via `subagent-delivery.ts`. The watcher decrements the counter when it delivers, so subsequent messages go back to normal SDK-resume behavior.

**Net effect:** Sending "A" during a 5-minute research task now gets processed in ~200ms instead of after 5 minutes. The background research still delivers its result via a separate message when ready.

### Technical details

**New module** `src/handlers/background-bypass.ts` — pure state-machine helpers:
- `shouldBypassQueue(state)` — returns true when `isProcessing=true`, `pendingBackgroundCount>0`, and an unaborted `abortController` exists
- `shouldBypassSdkResume(state)` — returns true when `pendingBackgroundCount>0`, signalling the next query should pass `sessionId=null`
- `waitUntilProcessingFalse(session, timeoutMs, tickMs)` — poll-waits for the old handler's `finally` block to flip the flag before the new query starts

**`src/services/session.ts`** — new field `pendingBackgroundCount: number` (default 0, reset on `/new`). Not persisted across restarts — the watcher re-hydrates its own state file and delivery still works, and starting a fresh counter after restart avoids stale drift.

**`src/services/async-agent-watcher.ts`** — `PendingAsyncAgent` gets an optional `sessionKey` field. On every delivery path (completed/failed/timeout), a new `decrementPendingCount(sessionKey)` helper clamps the counter at 0 using `Math.max`. Missing/unknown session keys are a no-op (backwards compatible with pre-v4.12.3 persisted state files).

**`src/handlers/async-agent-chunk-handler.ts`** — `TurnContext` gets `sessionKey`. When `registerPendingAgent` is called, the counter is incremented in the same function.

**`src/handlers/message.ts`** (Telegram):
- Computes `sessionKey` once at the top of the handler and passes it everywhere
- `if (session.isProcessing)` branch now checks `shouldBypassQueue` first — if true, aborts + waits for cleanup + falls through to process the new message. If false, queues as before.
- When queueing, the handler now sends a text reply (`"⏳ Eine Anfrage läuft gerade. Deine Nachricht ist in der Warteschlange..."`) in addition to the 📝 reaction, so the user sees what happened (reactions alone were too subtle)
- New `bypassResume` variable controls whether `queryOpts.sessionId` is `null` (fresh session) or `session.sessionId` (normal resume)
- Bridge preamble now has two modes: the existing "SDK recovery" mode that bridges fallback turns, plus a new "bypass" mode that bridges the last 10 turns when starting a fresh session mid-conversation
- New `_bypassAbortFired` session flag + `bypassAborted` local flag ensure that the old handler silently absorbs the abort error instead of showing a confusing "request cancelled" reply, and the fresh handler's finalize/broadcast/👍 reaction path is skipped for the aborted turn

### Known limitations

- **Platform coverage**: bypass path is Telegram-only in v4.12.3. Slack/Discord/WhatsApp handlers (`src/handlers/platform-message.ts`) don't currently handle `tool_result` chunks at all, so async agents can't be registered on those platforms. That's a pre-existing limitation that will be fixed in a future release.
- **SDK behavior dependency**: the fix assumes the background task's own subprocess is detached from the parent SDK query's `AbortController`. Empirically this holds (the watcher delivers results even after bypass-abort), but if a future SDK release changes this we'd need to either stop using `run_in_background` and rely on a pure Alvin-side background dispatch (bigger change) or add a targeted `process.kill` for the parent only, keeping the child alive.
- **Restart mid-flight**: if the bot restarts while a background agent is pending, the session's counter starts at 0 on restart. The watcher re-hydrates its own state file and still delivers the result correctly, but the session's "is this blocked?" signal is lost, so the first post-restart message might use SDK resume on the old (possibly-blocked) session ID. Minor cosmetic issue, not a data loss.

### Testing

- **Baseline**: 396 tests (v4.12.2)
- **New tests**: +40
  - `test/session-pending-background.test.ts` — 4 tests (counter wiring, reset, clamp)
  - `test/watcher-pending-count.test.ts` — 6 tests (decrement on delivery/timeout/failure, missing sessionKey, multi-agent)
  - `test/async-agent-chunk-flow.test.ts` — +3 tests (sessionKey propagation, counter stacking, non-async no-op)
  - `test/background-bypass.test.ts` — 12 tests (pure helpers: shouldBypassQueue, shouldBypassSdkResume, waitUntilProcessingFalse)
  - `test/background-bypass-integration.test.ts` — 6 tests (full lifecycle, stress, session isolation)
  - `test/background-bypass-stress.test.ts` — 9 tests (100 parallel sessions, 200 churn cycles, extreme drift, /new during pending, ephemeral session, mixed rollout, timing edge cases, high load 50×4 agents)
- **Total**: 436 tests, all green, TSC clean

### Files changed

- **NEW**: `src/handlers/background-bypass.ts`
- **NEW tests**: `test/session-pending-background.test.ts`, `test/watcher-pending-count.test.ts`, `test/background-bypass.test.ts`, `test/background-bypass-integration.test.ts`, `test/background-bypass-stress.test.ts`
- **Modified**: `src/handlers/message.ts` (bypass wiring + visible queue reply), `src/handlers/async-agent-chunk-handler.ts` (sessionKey + counter increment), `src/services/async-agent-watcher.ts` (sessionKey in PendingAsyncAgent + decrement on delivery), `src/services/session.ts` (pendingBackgroundCount field + _bypassAbortFired flag), `src/services/session-persistence.ts` (counter not persisted — reset on restart), `test/async-agent-chunk-flow.test.ts` (new assertions)
- **Version**: `package.json` 4.12.2 → 4.12.3

---

## [4.12.2] — 2026-04-15

### 🔒 Security patch: file permissions, ALLOWED_USERS hard-fail, exec-guard hardening, CVE updates

This is the first **formal security release** of Alvin Bot, motivated by a comprehensive audit after v4.12.1 production deployment. The audit surfaced real issues that needed fixing before the bot could be safely installed on multi-user dev servers or shared by external users. All fixes are additive and backwards-compatible — existing single-user installs see no behavior change except improved security.

#### CRITICAL CVE — axios 1.14.0 → 1.15.0 (CVSS 10.0)

Transitive dependency via `@slack/bolt`. Two CVEs closed:
- GHSA-fvcv-3m26-pcqx — Cloud Metadata Exfiltration via Header Injection Chain (CVSS 10.0)
- GHSA-3p68-rc4w-qgx5 — NO_PROXY Hostname Normalization Bypass → SSRF

Fix: `npm update @slack/bolt` (4.6.0 → 4.7.0) + `package.json overrides: axios ^1.15.0` to force transitive updates in `@slack/web-api` and `@whiskeysockets/baileys`. Post-fix `npm audit` shows **0 critical, 2 high remaining** (`basic-ftp` HIGH — never invoked by Alvin, `electron` HIGH — devDep only, tracked as Phase 18).

Also updated `@anthropic-ai/claude-agent-sdk` 0.2.97 → 0.2.109 (MODERATE: GHSA-5474-4w2j-mq4c Path Validation Sandbox Escape).

#### CRITICAL — File permissions on sensitive files (0o600)

Pre-v4.12.2 `~/.alvin-bot/.env`, `state/sessions.json`, memory logs, cron-jobs.json were written with the default umask — typically 0o644 on Linux/macOS, meaning any other user on the same machine could read BOT_TOKEN + all API keys, full conversation history, cron prompts, and encrypted sudo credentials.

**Fix**: new `src/services/file-permissions.ts` with `writeSecure()`, `ensureSecureMode()`, `auditSensitiveFiles()`. All `.env` writes in setup-api, doctor-api, server, fallback-order, session-persistence now use `writeSecure()`. Startup audit in `index.ts` chmod-repairs the full sensitive-file list idempotently on every boot.

#### CRITICAL — ALLOWED_USERS startup hard-fail

Pre-v4.12.2 Alvin started with BOT_TOKEN set but ALLOWED_USERS empty with only a console.warn — leaving the bot "configured but unguarded".

**Fix**: new pure gate function `src/services/allowed-users-gate.ts`. `src/index.ts` refuses to start with a clear error message. Two explicit escape hatches: `AUTH_MODE=open` or `ALVIN_INSECURE_ACKNOWLEDGED=1`.

#### HIGH — Webhook bearer token timing-safe comparison

`src/web/server.ts` POST /api/webhook previously used naive `authHeader !== "Bearer " + token` leaking comparison position via timing side-channel.

**Fix**: new `src/services/timing-safe-bearer.ts` wraps `crypto.timingSafeEqual` with strict "Bearer <token>" format, empty-expected rejection, length-mismatch dummy comparison.

#### HIGH — Exec-guard shell metacharacter rejection

`checkExecAllowed()` only inspected the first word — `echo safe; rm -rf /` passed as "echo". Trivially bypassable via `&&`, `|`, `` ` ``, `$(...)`, redirects.

**Fix**: allowlist mode rejects any command containing `;`, `&`, `|`, `` ` ``, `$(...)`, `{...}`, `<`, `>`. Operators who need shell pipelines set `EXEC_SECURITY=full` explicitly.

#### HIGH — Cron shell-job execGuard integration

Pre-v4.12.2 cron `type: "shell"` bypassed the exec-guard entirely. **Fix**: cron.ts case "shell" now calls `checkExecAllowed()` before `execSync()` and sends a blocked-notification on deny.

#### MEDIUM — Sub-agent toolset allowlist (readonly, research)

`SubAgentConfig.toolset` widened from `"full"` to `"full" | "readonly" | "research"`:
- `readonly` → Read, Glob, Grep only (no write, shell, network)
- `research` → readonly + WebSearch, WebFetch
- `full` → unchanged default

New `QueryOptions.allowedTools?: string[]` honored by `claude-sdk-provider`. Other providers ignore it.

#### NEW — `docs/security.md` threat model + hardening guide (279 lines)

First formal security documentation covering: TL;DR safety table, capability surface, attacker model, trust boundaries, hardening step-by-step, shell execution policy, file permissions list, sub-agent presets, prompt injection honesty section, Phase 18 pending work, security issue reporting, incident response playbook. Public doc, shipped with the repo.

#### NEW — README Security section rewrite

Replaced thin bullet list with a boxed warning ("Alvin has full shell + filesystem access") and four sub-sections: access control, execution hardening, data hardening, known limitations. Links to docs/security.md.

#### Testing

**396 tests total** (350 baseline from v4.12.1 + 46 new). All green. Build clean.

- 10 `test/file-permissions.test.ts`
- 7 `test/allowed-users-gate.test.ts`
- 10 `test/timing-safe-bearer.test.ts`
- 13 `test/exec-guard-metachars.test.ts`
- 4 `test/subagent-toolset-allowlist.test.ts`
- 2 extended `test/subagents-toolset.test.ts` (readonly + research)

#### Phase 18 (deferred, tracked in README Roadmap)

- Electron 35 → 41+ upgrade (Desktop build, 6 CVEs)
- Prompt injection defense strategy (design debate, not code filter)
- TypeScript 5 → 6 upgrade
- MCP plugin sandboxing (architectural v5.0)

---

## [4.12.1] — 2026-04-15

### 🐛 Patch: Sync sub-agent timeout + workspace command menu

Three issues from v4.12.0 production use, fixed:

- **Fix (Bug 1)**: `Task`/`Agent` tool calls without `run_in_background: true` were false-aborted after 10 minutes. The Claude Agent SDK runs synchronous sub-agents entirely inside the tool call — the parent stream emits no intermediate chunks during that time, so the flat 10-minute stuck-timer fired on legitimate long-running work. The new task-aware stuck timer detects sync Task/Agent tool calls (tracked by `toolUseId`) and automatically escalates the idle timeout to 120 minutes (configurable via `ALVIN_SYNC_AGENT_IDLE_TIMEOUT_MINUTES`). Once the matching `tool_result` arrives, the timer reverts to the normal 10-minute idle detection for genuine SDK hangs.

- **Mitigation (Bug 2)**: The `BACKGROUND_SUBAGENT_HINT` in `src/services/personality.ts` was rewritten with `⚠️ CRITICAL` framing, a concrete decision-tree structure, an aggressive ~30 second threshold (down from "2 minutes"), and an explicit warning about the Telegram session-blocking consequence. The goal is to get Claude to reliably set `run_in_background: true` when sub-agents will take more than a few seconds, so the main Telegram session doesn't stay blocked while the sub-agent works. This is defense-in-depth on top of the Bug 1 fix — the timer prevents false aborts regardless of Claude's compliance; the strengthened hint reduces how often main-session blocking happens in the first place. Compliance is monitored empirically via logs.

- **Fix (Bug 3)**: `/workspace` and `/workspaces` were registered as Telegram command handlers in v4.12.0 but not added to the `bot.api.setMyCommands` array, so they didn't appear in Telegram's auto-complete menu (the list that pops up when you type `/`). Added both, plus a new "🧭 Workspaces" block in the `/help` text.

#### Architecture details

**NEW `src/handlers/stuck-timer.ts`**: Pure state machine `createStuckTimer({normalMs, extendedMs, onTimeout})` returning `{reset, enterSync, exitSync, cancel}`. Testable in isolation without grammy/session/provider mocks via `vi.useFakeTimers()`. 8 unit tests cover normal fire, enterSync extends, exitSync returns, multi-pending, unknown-id no-op, cancel, reset-while-extended, idempotent enterSync.

**Protocol change in `src/providers/types.ts` + `claude-sdk-provider.ts`**: `StreamChunk` gains a new additive optional field `runInBackground?: boolean`. The provider extracts it from `block.input.run_in_background` **before** the existing 500-char JSON truncation on `toolInput` — this is load-bearing because for long prompts the serialized input can exceed 500 chars, and naive post-truncation parsing would lose the flag and misclassify sync tasks as async. `toolUseId` is now also yielded on `tool_use` chunks (previously only on `tool_result`) so the consumer can correlate tool_use → tool_result for sync tracking. 4 contract-pin tests mock `@anthropic-ai/claude-agent-sdk` with scripted assistant messages to verify the extraction logic.

**Critical ordering in `message.ts`**: State mutation of the pending-sync-task set (`stuckTimer.enterSync` / `stuckTimer.exitSync`) happens **before** `stuckTimer.reset()` in the for-await loop, so the timer arms with the post-mutation state. Inline comment added documenting this invariant.

#### Known limitation (not fixed in v4.12.1)

A Nanosecond-race where the stuck timer fires the same moment a `tool_result` arrives (fundamentally unfixable without `check-before-fire` semantics in `setTimeout`). With the 120-minute extended window the race requires the tool_result to arrive at exactly 120:00:00.000 — practically irrelevant. A proper fix would require rewriting the timer as a state machine with a pre-fire check, deferred to v4.13.0 if it ever matters.

#### Testing

**350 tests total** (330 baseline from v4.12.0 + 20 new). All green, TSC clean.

- 8 `test/stuck-timer.test.ts` — pure state-machine unit tests
- 4 `test/claude-sdk-tool-use-id.test.ts` — contract pins for `toolUseId` + `runInBackground` on tool_use chunks
- 3 new assertions in `test/system-prompt-background-hint.test.ts` (CRITICAL framing, Telegram blocking, 30-second threshold)
- 5 `test/sync-task-timeout.test.ts` — integration tests over realistic timing scales + regression guard for the pre-fix flat-timeout behavior

Live verification after release: local bot restart, Telegram `/` auto-complete shows `/workspace` + `/workspaces`, `curl https://api.telegram.org/bot$TOKEN/getMyCommands` returns the new entries.

#### Files changed

- **NEW**: `src/handlers/stuck-timer.ts`
- **NEW tests**: `test/stuck-timer.test.ts`, `test/claude-sdk-tool-use-id.test.ts`, `test/sync-task-timeout.test.ts`
- **Modified**: `src/providers/types.ts` (`StreamChunk.runInBackground`), `src/providers/claude-sdk-provider.ts` (extract `runInBackground` before truncation, yield `toolUseId` on tool_use), `src/handlers/message.ts` (`createStuckTimer` integration + task-aware flow), `src/services/personality.ts` (`BACKGROUND_SUBAGENT_HINT` rewrite), `src/handlers/commands.ts` (setMyCommands + `/help`), `test/system-prompt-background-hint.test.ts` (3 new assertions)

---

## [4.12.0] — 2026-04-13

### 🧭 Multi-Session + Slack Interface — parallel contexts, per-channel workspaces

A colleague's feature request the same day v4.11.0 shipped: *"Multiple Session und Interface über Slack — wie bei OpenClaw. Du hast mehrere parallele Sessions, die den jeweiligen Kontext voneinander nicht kennen aber in sich einen bestimmten Kontext und Zweck haben. Sie hatten dabei Zugriff auf das gesamte Knowledge (Skills + Memory). Und konnten bei Bedarf eigene agents starten."*

The ultra-analysis revealed Alvin was already ~80% built for this: the Slack adapter existed (355 LOC with `@slack/bolt@4.6.0`), the platform abstraction was clean, `buildSessionKey()` already supported `per-channel` mode, `session.workingDir` was already per-session, sub-agents were already async and session-isolated (v4.10.0), and memory/skills were already globally shared. **The single blocker: one line in `platform-message.ts` that bypassed `buildSessionKey` with a naive `hashUserId(userId)`, collapsing every non-Telegram channel from the same user into one session.**

This release adds a thin workspace layer on top plus Slack polish. **No breaking changes** — if no workspaces are configured, pre-v4.12 behavior is preserved exactly.

#### P0 #1 — Session-Key Fix (`src/handlers/platform-message.ts`)

`handlePlatformMessage` now routes through `buildSessionKey(msg.platform, msg.chatId, msg.userId)` instead of `hashUserId(msg.userId)`. On Slack with `SESSION_MODE=per-channel`, each channel gets its own session. Cross-channel isolation is automatic.

`buildSessionKey` signature widened from `userId: number` to `userId: string | number` so Slack user IDs (`U01ABC...`) pass through unchanged.

**6 unit tests** covering per-channel / per-channel-peer / per-user modes, cross-channel isolation, cross-platform isolation, and backwards compat with numeric Telegram user IDs.

#### P0 #2 — Workspace Registry (`src/services/workspaces.ts`, NEW)

Loads `~/.alvin-bot/workspaces/*.md` markdown files with YAML frontmatter. Each workspace has: `name`, `purpose`, `cwd`, optional `color`/`emoji`, explicit `channels: []` array for ID-based mapping, and a markdown body that becomes the system prompt override.

Hot-reload via `fs.watch()` with 500 ms debounce — same pattern as `src/services/skills.ts`. Changes to workspace files are picked up without a bot restart.

Public API: `loadWorkspaces`, `reloadWorkspaces`, `listWorkspaces`, `getWorkspace`, `getDefaultWorkspace`, `matchWorkspaceForChannel`, `resolveWorkspaceOrDefault`, `initWorkspaces`, `startWorkspaceWatcher`, `stopWorkspaceWatcher`.

**13 unit tests** covering default fallback, single/multi-workspace load, `~` expansion in cwd, channel-ID match, channel-name match, hot-reload, non-`.md` file skipping, malformed frontmatter resilience, missing directory graceful handling.

#### P0 #3 — Workspace Resolver Integration (`src/handlers/platform-message.ts`, `src/handlers/message.ts`)

Both the platform handler (Slack/Discord/WhatsApp) and the Telegram main handler now resolve the incoming message to a workspace before building the system prompt. If the session's `workspaceName` changed vs. the previous turn, `workingDir` is updated and persisted via `session-persistence` (v4.11.0).

`buildSystemPrompt` and `buildSmartSystemPrompt` gained a new optional `workspacePersona` parameter that injects a `## Workspace Persona` section into the system prompt. Empty string = no-op (default workspace).

`UserSession` gained a new `workspaceName: string | null` field. Persisted across restarts via the new v2 envelope format in `sessions.json` (backwards compatible with v4.11 flat format — the loader auto-detects).

#### P0 #4 — Slack Setup Documentation (`docs/install/slack-setup.md`, `docs/install/slack-manifest.json`)

Step-by-step guide: create Slack App from manifest → Socket Mode → App-Level Token → Bot Token → `~/.alvin-bot/.env` → restart → invite bot → create workspace files. Covers troubleshooting for common issues. The `slack-manifest.json` is copy-paste-ready: pre-configured bot user, all required scopes, event subscriptions, Socket Mode enabled. Both files are gitignored (the maintainer's docs/install/ convention) and ship via GitHub Release assets.

#### P1 #1 — Slack Progress Ticker (`src/platforms/slack.ts`)

`SlackAdapter.sendText()` now returns the message `ts` so callers can hold on to it. New `SlackAdapter.editMessage(chatId, messageId, newText)` wraps `chat.update`. Fail-silent: if Slack API errors, the ticker degrades gracefully and the full message still arrives at query end.

`PlatformAdapter` interface: `sendText` return type widened from `void` to `string | void`, optional `editMessage` method added. Existing adapters (Telegram, WhatsApp, Discord, Signal) that don't implement `editMessage` are unaffected.

**3 unit tests** with mocked `@slack/bolt` covering `chat.update` call, `sendText` ts return, and graceful failure handling.

#### P1 #2 — Slack Typing Status + Channel Name Resolution (`src/platforms/slack.ts`)

`SlackAdapter.setTyping()` now calls `assistant.threads.setStatus` so Slack shows "Alvin is thinking…" under the message during long queries. Silently no-ops in channels where the assistant scope isn't granted.

New `SlackAdapter.getChannelName(channelId)` resolves + caches channel names via `conversations.info`. `platform-message.ts` detects this helper via duck-typing on the adapter and passes the resolved name to `resolveWorkspaceOrDefault` — enabling channel-name matching (`#my-project` → `workspaces/my-project.md`) without hardcoding the Slack type in the platform handler.

#### P1 #3 — Telegram `/workspace` + `/workspaces` Commands

Feature parity for Telegram. `/workspaces` lists all configured workspaces with emojis, purposes, and the active one marked ✅. `/workspace <name>` switches the active workspace for the Telegram user; next message uses the new persona and cwd. `/workspace default` resets.

New `session.ts` exports: `getTelegramWorkspace(userId)` / `setTelegramWorkspace(userId, name)` + a module-level `telegramWorkspaces` map persisted via a new v2 envelope format in `sessions.json` (backwards compatible with v4.11 flat format).

**5 new unit tests** covering getter/setter/null-clear, persistence roundtrip, and v4.11 flat-format backwards compat.

#### P1 #4 — Per-Workspace Cost Aggregation (`src/services/session.ts`)

New `getCostByWorkspace()` helper aggregates `session.totalCost` by `session.workspaceName` across all active sessions in memory. Returns per-workspace totals for cost, session count, message count, and tool use count. Used by the Web UI workspace cards.

Sessions with `workspaceName === null` aggregate under `"default"` in the breakdown.

#### P1 #5 — Web UI Workspace Cards (`src/web/server.ts`, `web/public/index.html`, `web/public/js/app.js`)

New `GET /api/workspaces` endpoint returns the workspace registry merged with `getCostByWorkspace()`. Dashboard SPA gains a "🧭 Workspaces" page in the Data section of the sidebar (between Sessions and Files). Cards show emoji, name, purpose, cwd, channel mappings, session count, message count, and cumulative cost — color-coded via workspace frontmatter `color` field.

Default workspace is always included even when no user configs exist, so the UI always shows at least one card.

#### Architecture Decisions

- **Workspace is channel-scoped, not thread-scoped.** Slack channel = workspace. Threads within a channel are continuations of the same session.
- **Memory stays global.** All workspaces share `MEMORY.md`, the Hub memory, and the embeddings index.
- **Provider stays global.** Per-workspace provider override deferred to v4.13.
- **`@slack/bolt@^4.6.0`** is a regular dep, already in `package.json` from a previous branch.
- **Backwards compat is absolute.** If no workspaces exist, `resolveWorkspaceOrDefault` returns the default workspace with empty persona + global cwd. v4.11 flat-format `sessions.json` files still load without migration.
- **v2 envelope format**: `sessions.json` is now `{ version: 2, sessions: {...}, telegramWorkspaces: {...} }`. Loader auto-detects and handles both legacy flat format and new envelope.

#### Testing

**330 tests total** (292 baseline from v4.11 + 38 new). All green. TSC clean.

- 6 platform-session-key unit tests
- 14 workspaces unit + integration tests
- 3 slack-progress-ticker tests (mocked @slack/bolt)
- 5 telegram-workspace-command tests
- 10 multi-session end-to-end stress tests

**Live verified** via `tmp/live-multi-session.mjs` probe against the real `dist/`: 5 parallel workspaces, 5 simulated Slack channels, full persistence roundtrip with v2 envelope, cost aggregation, hot-reload picking up new workspace files, channel-name fallback, telegramWorkspaces map persistence. **All 7 phases passed.**

#### Files changed

- **NEW code:** `src/services/workspaces.ts`
- **NEW tests:** `test/platform-session-key.test.ts`, `test/workspaces.test.ts`, `test/slack-progress-ticker.test.ts`, `test/telegram-workspace-command.test.ts`, `test/multi-session-stress.test.ts`
- **NEW docs (gitignored, in Release assets):** `docs/install/slack-setup.md`, `docs/install/slack-manifest.json`
- **Modified:** `src/handlers/platform-message.ts`, `src/handlers/message.ts`, `src/handlers/commands.ts`, `src/platforms/slack.ts`, `src/platforms/types.ts`, `src/services/session.ts`, `src/services/session-persistence.ts`, `src/services/personality.ts`, `src/paths.ts`, `src/index.ts`, `src/web/server.ts`, `web/public/index.html`, `web/public/js/app.js`
- **Plan:** `docs/superpowers/plans/2026-04-13-multi-session-slack.md`

---

## [4.11.0] — 2026-04-13

### 🧠 Memory Persistence + Smart Loading — sessions survive restart, memory is layered

A colleague asked the same day v4.10.0 shipped: *"Memory after session restart is also a bit fiddly. I installed mempalace as a workaround — maybe build something like that natively."* He was right. Alvin had a hand-curated `MEMORY.md`, a 128 MB embeddings vector index, and an AI-powered compaction service — but **the in-memory `sessions Map` was wiped on every bot restart**. Claude SDK then started a fresh conversation on the next user message, behaving like a goldfish despite all that memory infrastructure on disk.

This release fixes that with **five complementary tasks**, all bundled into v4.11.0. Three core fixes (P0) plus two structural improvements (P1) inspired by mempalace's L0–L3 stack and Mem0's auto-extraction pattern.

#### P0 #1 — Session Persistence (`src/services/session-persistence.ts`, NEW)

The core fix. The `sessions Map` in `src/services/session.ts` was in-memory only; every `launchctl kickstart` wiped every user's `sessionId`, history, language, effort, voiceReply, and tracking counters.

- **Debounced flush** (1.5 s coalesce window) writes a sanitized snapshot of `getAllSessions()` to `~/.alvin-bot/state/sessions.json` via atomic tmp+rename.
- **`loadPersistedSessions()`** rehydrates the Map at bot startup; `flushSessions()` flushes synchronously on graceful shutdown (SIGINT/SIGTERM).
- **`attachPersistHook()` / `markSessionDirty()`** in `session.ts` give handlers a callback to trigger persist after direct mutations (`/lang`, `/effort`, `/voice`). `addToHistory()` and `trackProviderUsage()` trigger it automatically.
- History is capped at `MAX_PERSISTED_HISTORY = 50` per session so the file stays small.
- Runtime-only fields (`abortController`, `isProcessing`, `messageQueue`) are stripped before persisting.
- Schema drift is handled: missing fields fall back to defaults; corrupt JSON loads zero sessions; null root rejected gracefully.
- **9 unit tests** + **18 stress tests** covering 100-session burst, 1000-mutate debounce coalescing, unicode (RTL/ZWJ/astral plane), atomic write recovery from stale `.tmp`, schema drift, hostile JSON, read-only filesystem, simulated bot restart.

#### P0 #2 — MEMORY.md Auto-Inject for SDK (`src/services/personality.ts`)

Before v4.11.0, only non-SDK providers (Groq, Gemini, NVIDIA) got `buildMemoryContext()` injected into their system prompt. The Claude SDK was *expected* to read memory files via tools, but in practice rarely did unless the user's first message specifically prompted it.

- Drops the `!isSDK` guard around `buildMemoryContext()` and asset-index injection.
- SDK now gets the same compact memory context (MEMORY.md + today + yesterday daily logs) at every turn — the same context non-SDK providers had since 4.0.
- **3 unit tests** verifying SDK includes the memory section, non-SDK regression, and graceful behavior when MEMORY.md is missing.

#### P0 #3 — Semantic Recall on SDK First Turn (`src/services/personality.ts`, `src/handlers/message.ts`, `src/handlers/platform-message.ts`)

`buildSmartSystemPrompt()` now accepts an `isFirstTurn` flag. For SDK providers it runs the embeddings-based `searchMemory()` only on the first turn (`session.sessionId === null` — meaning Claude hasn't given us a resume token yet for this session). After the first turn Claude carries the recalled context inside the SDK session via resume, so spamming the embeddings API on every subsequent turn is wasted work. Non-SDK providers still run the search on every turn (no resume mechanism).

- `handlers/message.ts` and `handlers/platform-message.ts` updated to compute `isFirstSDKTurn = isSDK && session.sessionId === null` and pass it through.
- The bare `buildSystemPrompt` calls on the SDK paths are gone — `buildSmartSystemPrompt` is the single entry point.
- **5 mocked-search tests** covering call-count semantics for SDK first/later turns, non-SDK every turn, missing `userMessage` skip, and graceful failure when `searchMemory` throws.

#### P1 #4 — Layered Memory Loader (`src/services/memory-layers.ts`, NEW)

Inspired by mempalace's L0–L3 stack. Replaces the monolithic `MEMORY.md → System Prompt` injection with a structured, token-budgeted layered loader:

- **L0** `~/.alvin-bot/memory/identity.md` — always loaded, ~200 tokens (core user facts: name, location, family, contact)
- **L1** `~/.alvin-bot/memory/preferences.md` — always loaded (communication style, do's and don'ts)
- **L1** `~/.alvin-bot/memory/MEMORY.md` — backwards-compat: existing curated knowledge (full content if no split files exist; truncated to 1500 chars when split files coexist)
- **L2** `~/.alvin-bot/memory/projects/*.md` — loaded only when the user's incoming query mentions the project topic (substring or first-200-char keyword overlap)
- **L3** daily logs — still handled by `embeddings.ts` vector search (unchanged)

The split is **opt-in**: if `identity.md` and `preferences.md` don't exist, the loader falls back to monolithic MEMORY.md exactly like before. No migration required for existing users. Users who want the cleaner layout can split MEMORY.md manually and the loader picks it up automatically. Token budget: L0+L1 capped at 5000 chars (~1300 tokens), L2 capped at 3000 chars total (~750 tokens, max 1500 per matched project file). New `query` parameter on `buildSystemPrompt()` and `buildMemoryContext()` propagates the user message all the way through. **9 unit tests** + 2 layered-context stress tests.

#### P1 #5 — Auto-Fact-Extraction in Compaction (`src/services/memory-extractor.ts`, NEW)

Inspired by Mem0's auto-extraction. When `compactSession()` archives old messages, it now runs an additional extraction pass that pulls structured facts (`user_facts`, `preferences`, `decisions`) out of the archived chunk via the active AI provider and appends them to MEMORY.md.

- **`parseExtractedFacts(text)`** — tolerates JSON wrapped in markdown code fences, surrounding prose, null/undefined fields, non-string entries.
- **`appendFactsToMemoryFile(facts)`** — exact-string dedup against existing MEMORY.md content, structured under `## Auto-extracted (YYYY-MM-DD)` header with `### User Facts` / `### Preferences` / `### Decisions` sub-sections.
- **`extractAndStoreFacts(chunk)`** — safe wrapper, never throws. Opt-out via `MEMORY_EXTRACTION_DISABLED=1` env var. Uses effort=low for cost minimization. Skips short input (<50 chars). Provider failures are swallowed; compaction always continues.
- Wired into `compactSession()` after the daily-log flush, before the AI summary generation.
- Marked **experimental** in v4.11.0. Semantic dedup (vs current exact-string match) deferred to v4.12+.
- **11 unit tests** covering JSON parsing edge cases, dedup, opt-out, short-input skip, garbage input, non-string filtering, graceful provider-failure handling.

#### Architecture decisions

- **mempalace as MCP server: rejected.** Considered installing mempalace as a Python MCP service. Rejected because (1) Alvin is all-TypeScript and adding a 2nd Python service to launchd is operational complexity, (2) Alvin already has an embeddings vector index — mempalace would be a parallel duplicate, (3) mempalace's MCP tools are only consumed by the SDK; cron jobs, sub-agents, and non-SDK providers wouldn't see them. Conclusion: **adopt the patterns natively** (L0–L3 layering, AAAK-style structured extraction) rather than running a second service.
- **SQLite migration deferred.** The 128 MB JSON embeddings index is a known performance issue and is already noted in `~/.claude/projects/-Users-alvin-de/memory/project_alvinbot_sqlite_migration.md` for v4.12+. Orthogonal to the "frickelig nach Restart" UX problem this release targets.
- **Multi-user isolation deferred.** Memories are still global per data dir. Single-user use case, not a privacy concern for the maintainer's setup.
- **Decay/aging deferred.** Daily logs grow monotonically. Will be addressed alongside SQLite migration.

#### Testing

**292 tests total** (237 baseline + 55 new). All green. TSC clean.

- 9 session-persistence unit tests
- 8 SDK memory-injection tests (3 base + 5 smart-prompt mocked-search)
- 9 memory-layers tests (loader + topic match + token budget)
- 11 memory-extractor tests (parse + append + extract pipeline)
- 18 stress tests (100 sessions, schema drift, unicode, atomic recovery, hostile JSON, simulated restart)

**Live verification:**
- `tmp/live-stress-memory.mjs` — 50 fake sessions against the built `dist/`, real ~/.alvin-bot/memory/MEMORY.md as the L1 source, simulated restart via Map clear + reload. Result: 215 KB state file, 1 ms flush, 1 ms reload, 50/50 perfect round-trip.
- `tmp/live-edge-cases.mjs` — 7 hostile scenarios: all-null fields, 1000-burst debounce (2 ms), 20 concurrent flushes, extreme unicode (RTL + ZWJ + astral plane), 4-layer memory with project topic match, atomic write recovery from stale .tmp, empty project file skipping. All passed.

#### Files changed

- **NEW:** `src/services/session-persistence.ts`, `src/services/memory-layers.ts`, `src/services/memory-extractor.ts`
- **NEW tests:** `test/session-persistence.test.ts`, `test/memory-sdk-injection.test.ts`, `test/memory-layers.test.ts`, `test/memory-extractor.test.ts`, `test/memory-stress-restart.test.ts`
- **Modified:** `src/services/session.ts` (persist hook), `src/services/personality.ts` (SDK injection + isFirstTurn), `src/services/memory.ts` (use layered loader), `src/services/compaction.ts` (extractor hook), `src/handlers/message.ts` + `src/handlers/platform-message.ts` (smart prompt wiring), `src/handlers/commands.ts` (`markSessionDirty` calls), `src/index.ts` (load + flush wiring), `src/paths.ts` (4 new constants)
- **Plan:** `docs/superpowers/plans/2026-04-13-memory-persistence.md`

---

## [4.10.0] — 2026-04-13

### 🚀 Async sub-agents — main session no longer blocks during long tasks

The big architecture upgrade: Claude can now delegate long-running work (SEO audits, multi-page research, full-repo analyses) to **background** sub-agents. The main Telegram session ends quickly, the user can keep chatting, and the sub-agent's final report arrives as a separate message when ready.

A colleague flagged the underlying problem on 2026-04-13 via WhatsApp voice note: *"It's weird that the main routine crashes when the sub-agents are still running. It should just run in the background, and that should have zero impact on the main routine."* He was right. OpenClaw had this years ago because back then the SDK didn't support async; today's `@anthropic-ai/claude-agent-sdk@0.2.97` already ships `run_in_background: true` on the Agent tool — Alvin just wasn't using it.

This release closes that gap in two complementary stages, both bundled into the same v4.10.0:

#### Stage 1 — System prompt teaches Claude when to use `run_in_background`

- New `BACKGROUND_SUBAGENT_HINT` constant in `src/services/personality.ts`, injected only into SDK sessions (non-SDK providers don't have an Agent tool).
- The hint tells Claude: for audits / multi-page research / >2 min tasks → ALWAYS set `run_in_background: true`. After launching, end the turn promptly. The bot delivers the result automatically when done.
- Net effect: Claude's main turn ends in ~5 s instead of 10+ minutes. `session.isProcessing` flips to `false` quickly so the user can keep chatting.

#### Stage 2 — Async-agent watcher polls and delivers

The hard part. Three new pure modules + one new wired-up service:

- **`src/services/async-agent-parser.ts`** (NEW, pure) — two helpers:
  - `parseAsyncLaunchedToolResult(text)` extracts `agentId` + `output_file` from the SDK's plain-text `Async agent launched successfully…` tool-result. **Important**: the `.d.ts` type in the SDK package claims this is a JSON object with `outputFile: string`. The runtime actually emits plain text with `output_file` (snake_case). Captured live via probe — see the parser test fixtures.
  - `parseOutputFileStatus(path)` tail-reads (64 KB) the JSONL `output_file` and detects completion by finding the most-recent `assistant` message with `stop_reason: "end_turn"`. Concatenates `content[].text` blocks for the final answer. Token usage extracted from the `usage` field. Survives partial last lines, garbage lines, and tail-cuts on huge files. **19 unit tests** including a 200 KB tail-test.
- **`src/services/async-agent-watcher.ts`** (NEW) — the polling service. `Map<agentId, PendingAsyncAgent>` in memory, persisted to `~/.alvin-bot/state/async-agents.json` for restart catch-up (same pattern as v4.9.0 cron scheduler). Public API: `startWatcher` / `stopWatcher` / `registerPendingAgent` / `pollOnce` / `listPendingAgents`. Polls every 15 s, gives up after 12 h per-agent (timeout banner). On completion → builds a `SubAgentInfo + SubAgentResult` and hands off to the existing `subagent-delivery.ts` from v4.9.x. **7 integration tests** including bot-restart catch-up.
- **`src/handlers/async-agent-chunk-handler.ts`** (NEW) — bridge between provider stream chunks and the watcher. Inspects `tool_result` chunks for the async_launched payload, extracts the `description` from the immediately preceding `tool_use` chunk, registers with the watcher. **4 unit tests**.
- **`src/providers/claude-sdk-provider.ts`** — extended to surface `tool_result` blocks from SDK `user` messages as a new `tool_result` chunk type. Previously the provider only emitted `text` and `tool_use` chunks.
- **`src/providers/types.ts`** — `StreamChunk` gets two new optional fields: `toolUseId` and `toolResultContent`.
- **`src/handlers/message.ts`** — captures `lastAgentToolUseInput` from each `tool_use` chunk and consumes it on the immediately-following `tool_result` chunk. Tool-name match also extended from `"Task"` → `"Task" | "Agent"` (the SDK renamed it in v2.1.63).
- **`src/index.ts`** — `startAsyncAgentWatcher()` after the cron scheduler, `stopAsyncAgentWatcher()` in the shutdown handler.
- **`src/paths.ts`** — new `ASYNC_AGENTS_STATE_FILE` constant under `~/.alvin-bot/state/`.

#### Investigation artifacts (gitignored, maintainer-local)

- `docs/superpowers/plans/2026-04-13-async-subagents.md` — full TDD plan
- `docs/superpowers/specs/sdk-async-agent-outputfile-format.md` — live-captured SDK format spec; documents the `.d.ts` mismatch that ate ~30 minutes of debugging time

#### Testing

**237 tests total** (201 baseline + 36 new). All green. TSC clean.

- 6 system-prompt-hint tests (Stage 1)
- 19 parser tests (8 plain-text format + 11 JSONL format including 200 KB tail-test)
- 7 watcher integration tests (register, deliver, persistence, restart catch-up, timeout, concurrent agents)
- 4 chunk-handler unit tests

Live-verified via isolated SDK probe (`node sdk-probe.mjs` inside the repo) which confirmed the real `output_file` path and JSONL format match the parser's expectations.

#### What you'll see as a user

Send: *"Make a SEO audit of example.com and example.com in parallel"*

- **0 s** — Claude responds: *"Starting both audits in the background — I'll send the reports when done."* Main session **unlocks**.
- **1–10 min later** — You can chat about anything else. The bot answers immediately.
- **~13 min** (when each agent finishes) — Two separate banner messages arrive: *"✅ SEO audit example.com completed · 13m 17s · 2.6M in / 28k out"* + the full report body, delivered via the v4.9.3 Markdown→plain-text fallback path.

#### Non-goals

- No session-mutex refactor (Stage 3 from the analysis, out of scope here)
- No replacement for Alvin's existing cron `spawnSubAgent` system (different use case)
- No SDK upgrade beyond `0.2.97`

#### Compatibility

- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in `.env` disables background mode at the SDK level → Stage 1 hint becomes inert, watcher idles; foreground behavior is restored

## [4.9.4] — 2026-04-13

### 🔌 Web UI fully decoupled from main bot — port conflicts no longer crash anything

Colleague feedback (WhatsApp voice note, 2026-04-13):
> *"The gateway binds to port 3100 like OpenClaw. When the bot restarts,
> the port is often still held → catastrophic crash. I ended up
> decoupling the gateway process completely, because the actual bot
> runs independently of the gateway — it can still answer Telegram
> even if the web endpoint isn't reachable yet. It's weird that the
> main routine crashes when the port is busy. It should just run in
> the background, watch for the port to become free, and connect
> then. Zero impact on the main routine."*

He was right. My v4.9.0 `stopWebServer()` fix was *prevention* — it stopped the bot itself from holding 3100 across restarts. But it didn't cover the *resilience* side: a foreign process holding 3100 (another dev server, an OpenClaw-style orphan, a TIME_WAIT race after SIGKILL) still crashed the boot, because `startWebServer()` was synchronous and the `uncaught exception` from `server.listen()` escaped to the main event loop.

**Complete rewrite of the bind loop:**

- **`src/web/bind-strategy.ts` (new) — pure decision helper.** `decideNextBindAction(err, attempt, opts)` returns either `{type: "retry-port", port, attempt}` (climb the ladder) or `{type: "retry-background", delayMs, port}` (back off, retry the original port in 30 s). EADDRINUSE with attempts remaining → ladder. EADDRINUSE exhausted → background. Any other error → background. 8 unit tests covering every branch + purity.

- **`src/web/server.ts` startWebServer — non-blocking, fresh-server-per-attempt.** Returns `void` synchronously, NEVER throws, NEVER blocks on bind. Each attempt creates a new `http.Server` (no state-recycling bugs) and attaches its own error handler. On failure, cleans up and calls `decideNextBindAction` to decide the next move. If the ladder is exhausted, schedules a 30 s background retry at the original port — the Telegram bot keeps running the whole time, the web UI just isn't reachable yet.

- **`src/web/server.ts` WebSocketServer attached POST-bind.** The `ws` library's `WebSocketServer` constructor installs its own event plumbing on the underlying `http.Server` and — crucially — causes EADDRINUSE errors to escape as uncaught exceptions when attached pre-listen. Debugging this chewed an hour on 2026-04-13. Fix: only `new WebSocketServer({ server })` AFTER `listen()` has fired its callback. The unit-test `test/web-server-integration.test.ts "when the primary port is taken"` pins this behaviour.

- **`src/web/server.ts` error handler: `on` not `once`.** Previous version used `.once("error", handler)` and a node edge case where a single bind failure emits TWO error events left the second one uncaught. Handler is now `on` with a `handled` guard — idempotent, and a post-bind quiet logger replaces it on success.

- **`src/web/server.ts` defensive try/catch around `server.listen()`.** In the wild Node sometimes throws synchronously for edge-case binds (already-listening, invalid backlog, kernel race). The catch funnels sync throws through the same `handleBindFailure` path as async error events.

- **`src/web/server.ts` `closeHttpServerGracefully(server)` + `stopWebServer()`.** The old `stopWebServer(server)` took an explicit server arg; it's been split into a low-level helper (`closeHttpServerGracefully(server)`, exported for tests) and a stateful top-level (`stopWebServer()`, no args, cleans up `currentServer` + `wsServerRef` + `bindRetryTimer`). Safe to call before start, safe to call twice, cancels pending background retries.

- **`src/index.ts` call sites adjusted.** `const webServer = startWebServer()` → `startWebServer()`. `stopWebServer(webServer)` → `stopWebServer()`. The comment above the call explains the decoupling so nobody accidentally re-couples it in a future "clean up" refactor.

**Testing: 186 → 201 (+15 new).**

- `test/web-server-resilience.test.ts` — 8 unit tests for `decideNextBindAction`
- `test/web-server-integration.test.ts` — 7 real-server integration tests: startWebServer returns void, binds, stops, is idempotent, survives primary-port conflict by climbing the ladder, closes servers with hanging sockets.
- **Live-verified on the maintainer's machine**: `launchctl unload` + dual-stack Node hog on port 3100 + `launchctl load` → bot booted cleanly → out.log contained `[web] port 3100 busy (EADDRINUSE) — trying 3101` → `🌐 Web UI: http://localhost:3101   (Port 3100 was busy, using 3101 instead)` → Telegram responsive throughout. Exactly what the colleague described.

**Non-goals / intentionally unchanged:**
- Timeouts stay unlimited (v4.8.8 behaviour preserved).
- The primary port is still `WEB_PORT || 3100` — no config schema change.
- When the bot binds on a non-primary port (e.g. 3101), the README permalink still points at 3100. Users hitting a ladder-climbed bot should check the startup log; this is rare and temporary.

## [4.9.3] — 2026-04-11

### 🛠 Two UX bugs found in production after v4.9.2 — now closed

the maintainer triggered `/cron run Daily Job Alert` after the v4.9.2 deploy and saw 13 minutes of chat silence followed by nothing. Forensics on the live bot revealed two distinct problems on top of an already-successful run:

**1. `subagent-delivery` has been silently dropping every banner for days.** Err.log: `GrammyError: Call to 'sendMessage' failed! (400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 2636)`. The daily-job-alert sub-agent produces markdown-dense output (`|` tables, `**bold**`, `\|` escapes, mixed asterisks). Telegram's Markdown parser refuses it, `api.sendMessage(..., parse_mode: "Markdown")` throws, and the bare try/catch in `deliverSubAgentResult` logs + bails. **Result: the user has never seen a sub-agent-delivery banner, even when the underlying run succeeded perfectly and emailed the HTML report correctly.**

Fix in `src/services/subagent-delivery.ts`: new `sendWithMarkdownFallback()` helper that detects the "can't parse entities" pattern and retries the SAME text without `parse_mode`. All three code paths (file-upload case, single-message case, chunked case) now flow through the helper. 3 new tests drive the happy path, non-parse errors, and the chunked path.

**2. `/cron run` had zero proof-of-life for 13 minutes.** The handler used to `await runJobNow(...)` synchronously and reply only when finished. Telegram's typing indicator expires after 5s. Users saw: command sent → typing indicator blip → nothing → nothing → (much later, if at all) result. For cron jobs that take 10-15 min (daily job alert, Perseus health, Polyseus P&L), this is indistinguishable from a dead bot.

Fix — new handler flow:

```
bot:  🚀 Started *Daily Job Alert* — working…          ← instant ack
bot:  🔄 Running *Daily Job Alert* · 1m 0s elapsed…    ← edit every 60s
bot:  🔄 Running *Daily Job Alert* · 2m 0s elapsed…    ← edit
...
bot:  ✅ Done — *Daily Job Alert* · 13m 17s             ← final edit
bot:  ✅ *Daily Job Alert* completed · 13m · 2.6M/28k  ← subagent-delivery
       [full report body, Markdown-safe with plain-text fallback]
```

The ticker uses a single `editMessageText` call per minute on the same message — zero notification spam, clean visual progress. Every edit is wrapped with `isHarmlessTelegramError` so the inevitable "message is not modified" races stay silent. The ack itself falls back to plain text if the first `reply` hits a parse error, and the final edit falls back to a fresh plain message if the edit fails.

New module: `src/handlers/cron-progress.ts` with pure helpers — `formatElapsed`, `escapeMarkdown`, `buildTickerText`, `buildDoneText`. 8 tests cover the formatting rules and markdown-safety escapes so future cron jobs with weird names (`weird_job*name`) can't break the ticker.

**186 tests total** (+11 new). All green. Timeouts remain unlimited.

**What you see after this upgrade:**
- Instant "🚀 Started" ack on `/cron run`
- Live elapsed-time ticker every minute
- Final "✅ Done" when the sub-agent finishes
- A separate banner+body message with the full report — **this time actually delivered**, even when the body contains broken Markdown

## [4.9.2] — 2026-04-11

### 🔍 Post-review polish: three edge cases from the strict audit

A self-audit of the v4.9.0 + v4.9.1 batch surfaced three real-but-rare edge cases. None of them are user-visible on the happy path, but all three are two-line defensive fixes that make the stability story airtight. Verified under a live stress test: 4 back-to-back `launchctl kickstart -k` restarts produced clean beacon accounting (`crashCount=3/10, daily=5/20`), zero EADDRINUSE, zero false brake, 3.8 ms Web UI response after every boot. **175 tests total (9 new stress scenarios).**

**Issue A — watchdog brake must always halt the boot, even if `writeAlert` silently fails**
`src/services/watchdog.ts`. The old brake path called `writeAlert(...)` then `checkCrashLoopBrake()`, and the latter only exits if the alert file exists. If `writeAlert` hit a disk-full or permission error, the alert file wasn't created, `checkCrashLoopBrake` returned as a no-op, and the startup code continued past the brake — exactly the wrong behaviour for the one code path where we know the bot is in a bad state. Added an unconditional `process.exit(3)` after `checkCrashLoopBrake` so the brake is now a hard guarantee.

**Issue B — `bot.stop()` must be awaited so Telegram offset-commits actually fire**
`src/index.ts`. The shutdown handler called `if (bot) bot.stop();` without `await`, then raced `stopWebServer` in parallel and `process.exit(0)`'d. Grammy's `bot.stop()` commits the pending Telegram update-offset before resolving — without the await, the next boot could reprocess the last batch of messages. Now awaited with a catch-and-log wrapper so shutdown doesn't hang on a grammy-internal error either.

**Issue C — `runJobNow` defensive belt around `executeJob`**
`src/services/cron.ts`. `executeJob` has its own try/catch that converts every error into `{output, error}`, so in practice `runJobNow` never sees a throw. But a future refactor could remove that inner catch, and a leaked throw here would skip `runningJobs.delete` and permanently wedge the guard for that job. Added an inner try/catch in `runJobNow` that catches any thrown `executeJob` error and surfaces it as `{status: "ran", error}`, preserving the typed contract the `commands.ts` handler relies on. Two new tests (`cron-runjobnow-throw.test.ts`) verify both the error-propagation and the guard-cleanup invariants.

**Stress scenarios added** (`test/stress-scenarios.test.ts`, 9 tests):
1. **Port churn** — 20 open/close cycles with 5 hanging clients each, all <2s, port reusable afterward.
2. **Scheduler catchup chain** — 50-job mixed list (10 interrupted, 10 completed, 10 stale, 10 disabled, 10 fresh). `handleStartupCatchup` rewinds exactly the 10 interrupted, no false positives.
3. **Watchdog daily-cap escalation** — 19 crashes spaced 70 min apart (outside short window, inside 24h). The 20th crash trips the daily brake even though the short window is clean.
4. **Concurrent runJobNow guard** — 5 parallel async calls → 1 "ran" + 4 "already-running", never double-fire.
5. **Telegram error filter cross-check** — 7 benign patterns + 10 real errors, no false positives / false negatives, grammy `description` field handled.
6. **Cron resolver ambiguity** — exact-case wins over CI collision, ID wins over name collision, mixed case with 2 CI matches returns null.

## [4.9.1] — 2026-04-11

### 🐛 `/cron run <name>` accepts the job name, not just the opaque ID

Reported via screenshot: `/cron run Daily Job Alert` replied with `❌ Job not found.` because `runJobNow(id)` only matched against `job.id` — the random base-36 string (`mn90rrsndzto`) that nobody types. Worse, when Claude tried to trigger the same job through a natural-language request in an earlier session, it retried with different variants until one happened to succeed — and the absence of a re-entry guard in `runJobNow` meant the retries sometimes spawned a second parallel sub-agent, producing the "ups… wurde doppelt ausgeführt" message.

**Fix — pure resolver + guard, wired into the public API:**

- **`src/services/cron-resolver.ts` (new).** Two pure helpers:
  - `resolveJobByNameOrId(jobs, query)` — priority: exact ID > exact name > unique case-insensitive name > `null` on miss/ambiguous.
  - `runJobNowGuard(id, isRunning, run)` — higher-order re-entry check, testable without the scheduler loop.
- **`src/services/cron.ts` runJobNow**. Now returns a typed outcome (`not-found` | `already-running` | `ran`), consults the `runningJobs` set (previously only the scheduler loop did), and — when it actually runs — persists `lastAttemptAt` / `lastRunAt` / `runCount` / `lastResult` / `lastError` exactly like the scheduler path, so manual triggers show up in the timeline instead of vanishing.
- **`src/handlers/commands.ts /cron run`**. Matches against name OR ID, prints a helpful "Available:" list on miss, and announces the already-running case instead of silently double-firing.
- **10 new tests** (`test/cron-run-resolver.test.ts`) covering exact ID, exact name, case-insensitive, trimmed input, miss, ambiguity, ID-over-name preference, and both guard branches. **164 tests total.**

**What this also quietly fixes:** natural-language triggers ("Alvin, run the daily job alert"). When Claude invokes `/cron run Daily Job Alert` via its own turn, the command now succeeds on the first try — no retry cascade, no double execution.

## [4.9.0] — 2026-04-11

### 🛡 Stability batch: crash-loop eliminated, cron jobs restart-resistant, cleaner logs

Production users reported a daily-job-alert that "kept crashing" — the cron job triggered at 08:00, died mid-execution, and the next scheduled run silently disappeared until the next day. Root cause was not a single bug but a chain of four: the HTTP Web UI never released its port on shutdown → `EADDRINUSE :::3100` uncaught crash-loop → the cron scheduler persisted `nextRunAt = null` pre-execution → restart rewrote it to "tomorrow 08:00" → the run was lost. In parallel, sub-agents that ended on a tool call reported "completed" with only the pre-tool text as output, and grammy's "message is not modified" races leaked into Telegram replies as `Fehler: Call to 'editMessageText' failed!`.

This release closes the whole chain, adds the Tier 0 of the browser fallback, and installs timestamped logs so future forensics don't need timestamp-free grep archaeology.

**Pure functions extracted for isolated testing** (36 new tests, 154 total):

- `src/services/cron-scheduling.ts` — `prepareForExecution(job, now)` and `handleStartupCatchup(jobs, now, graceMs)`. The old scheduler set `nextRunAt = null` before `await executeJob(job)` and only recomputed after completion. A crash mid-execution left `nextRunAt = null`; the next boot recomputed it from the current time → always landed on tomorrow's trigger. Now `prepareForExecution` persists the NEXT regular trigger BEFORE running, and stamps `lastAttemptAt`. If `lastAttemptAt > lastRunAt` at boot and the attempt is ≤ 6 h old, `handleStartupCatchup` rewinds `nextRunAt` to `now` so the next tick picks it up. New `CronJob.lastAttemptAt` field (`number | null`).
- `src/services/watchdog-brake.ts` — `decideBrakeAction(prev, now, opts)` and `shouldResetCrashCounter(uptimeMs, opts)`. The old brake reset `crashCount` after 5 minutes of clean uptime, which was shorter than the typical sub-agent lifetime — chronic crashes with 5–10 min gaps passed the brake indefinitely. New policy: **1 h clean uptime required for reset**, plus a hard **20 crashes / 24 h** daily cap alongside the existing 10 crashes / 10 min short-window cap. Both counters persist in the beacon.
- `src/util/debounce.ts` — trailing-edge debounce for fs.watch coalescing.
- `src/util/console-formatter.ts` — `installConsoleFormatter()`: monkey-patches `console.log/warn/info/error` to prefix every line with an ISO timestamp, and drops libsignal "Closing session" multi-line SessionEntry dumps + `[claude] Native binary` spam that were pushing tens of KB per day into `alvin-bot.out.log` / `alvin-bot.err.log`.
- `src/util/telegram-error-filter.ts` — `isHarmlessTelegramError(err)`: single source of truth for benign grammy races (`message is not modified`, `query is too old`, `message to edit not found`, `MESSAGE_ID_INVALID`, …).
- `src/services/browser-webfetch.ts` — `webfetchNavigate(url, opts)` + `parseTitle(html)` + `WebfetchFailed`: Tier 0 of the browser fallback chain. Plain `fetch()` instead of Playwright for static pages.
- `src/platforms/whatsapp-auth-helpers.ts` — `makeResilientSaveCreds(authDir, inner)`: wraps baileys' `saveCreds` so an ENOENT from a vanished auth dir transparently recreates the directory and retries once.

**Fixes wired into the existing modules:**

- **`src/web/server.ts` — new `stopWebServer(server)`.** Closes WebSocket clients, calls `closeIdleConnections()` + `closeAllConnections()` (Node 18.2+) so long-poll clients can't stall the shutdown, then awaits `server.close()`. Called from `shutdown()` in `src/index.ts`. Before this fix, launchd restarted the bot → new process tried `server.listen(3100)` → `EADDRINUSE` → uncaught exception → exit → launchd again. Classic crash-loop. **This single fix stops the chain.**
- **`src/services/cron.ts`** — scheduler rewired to call `prepareForExecution` pre-execution and `handleStartupCatchup` at boot. `lastResult` truncation bumped from 500 → 4000 chars so post-mortem is possible without running the job again.
- **`src/services/watchdog.ts`** — beacon schema extended with `dailyCrashCount` + `dailyCrashWindowStart`; `startWatchdog` now delegates the brake decision to the pure `decideBrakeAction`. Recovery timer still fires, but only resets the counter if `shouldResetCrashCounter` agrees (≥ 1 h uptime).
- **`src/services/subagents.ts`** — `runSubAgent` now reads `finalText` from the `done` chunk as the authoritative final output (was ignored before), preserves buffered text when the stream emits an `error` chunk, and — most importantly — keeps `finalText` when the catch handler fires (was `output: ""`, throwing away multi-minute runs). Variable scope moved outside the try block. New `error` status branch for mid-stream provider failures.
- **`src/services/subagent-delivery.ts`** — `buildBanner` now renders `⚠️ completed · empty output` for the "successful run with zero text" case so truncated runs are immediately visible instead of hiding behind a green tick.
- **`src/services/skills.ts`** — `fs.watch` callbacks wrapped in `debounce(…, 300)` so macOS FSEvents duplicates coalesce into one reload.
- **`src/services/browser-manager.ts`** — new `webfetch` tier added as default for non-interactive tasks. `resolveStrategy` cascade is now `webfetch → hub-stealth → cdp → gateway → cli`. `navigate()` has an error-based fallback: if `webfetch` throws (403, 5xx, content-type mismatch), it transparently upgrades to `hub-stealth` then `cli` before giving up.
- **`src/platforms/whatsapp.ts`** — `saveCreds` wrapped in `makeResilientSaveCreds` so a vanished auth dir self-heals instead of becoming an unhandled rejection.
- **`src/handlers/message.ts`, `src/services/telegram.ts`, `src/index.ts` (bot.catch + streaming finalize)** — all three call sites that used to ship the raw grammy error to users now route through `isHarmlessTelegramError`. The `Fehler: Call to 'editMessageText' failed!` noise that 2-3 users per day were seeing is gone.

**What is NOT changed:**

- **Timeouts.** The v4.8.8 `defaultTimeoutMs = -1` (unlimited) behavior is preserved. Sub-agents and cron jobs can still run as long as they need.
- **The cron job `payload.prompt`s.** Users' existing cron definitions keep working unchanged.
- **The beacon file format back-compat.** Old beacons without the daily counters are read correctly; the new fields are seeded to 0/now on first boot.

**How to verify after update:**

1. `launchctl unload ~/Library/LaunchAgents/com.alvinbot.app.plist && launchctl load ~/Library/LaunchAgents/com.alvinbot.app.plist`
2. Tail `~/.alvin-bot/logs/alvin-bot.out.log` — every line should now carry an ISO timestamp and libsignal SessionEntry dumps should be gone.
3. Check `~/.alvin-bot/state/watchdog.json` — should contain `dailyCrashCount` / `dailyCrashWindowStart` within a minute.
4. Send `/cron run Daily Job Alert` — subagent-delivery banner should render fully, `~/.alvin-bot/cron-jobs.json` should show `lastAttemptAt` and a post-execution `lastRunAt`.
5. Trigger a deliberate edit race (double-tap an inline button quickly) — no `Fehler: Call to 'editMessageText' failed!` reply should land in the chat.

## [4.8.9] — 2026-04-11

### 🐛 Browser automation: dead `browse-server.cjs` path removed, 3-tier router now the source of truth

The `browse` skill used to instruct the agent to start `node scripts/browse-server.cjs` on port 3800 for every browser task. That file was deleted in an earlier cleanup (see `20283c9` for the original 577-line version — now gone), but `skills/browse/SKILL.md` was never updated. Result: any browser-related user message on Telegram — or any cron job that hit the skill — got a system-prompt injection telling it to call a gateway that didn't exist, producing half-failed runs like the "Daily Job Alert" cron that couldn't load LinkedIn or StepStone.

**What changed:**

- **`skills/browse/SKILL.md` — full rewrite.** Now documents the hub 3-tier router at `~/.claude/hub/SCRIPTS/browser.sh`:
  - **Tier 0** — WebFetch / `curl` for static pages and APIs
  - **Tier 1** — `browser.sh stealth <url>` (Playwright + stealth plugin, headless, Cloudflare-masking)
  - **Tier 2** — `browser.sh cdp {start|goto|shot|tabs|stop}` (real Chrome with persistent profile at `~/.claude/hub/BROWSER/profile/`, login cookies survive restarts)
  - **Tier 3** — Claude-in-Chrome extension via MCP tools (interactive CLI only)
  - Explicit escalation ladder (WebFetch → stealth → CDP → ask the maintainer to log in) and a `NIEMALS browse-server.cjs nutzen` anti-rule.
  - Concrete working targets (StepStone ✅, Michael Page ✅, LinkedIn ✅ with login, Indeed ❌) so the agent knows what to try where.

- **`src/services/browser-manager.ts` — hardened fallback chain.** The multi-strategy manager already had the right *shape* (`gateway → cdp → hub-stealth → cli`) but several ops silently broke or hung:
  - **`gatewayRequest` now has a 15 s timeout** (`req.destroy` on elapse). Previously a hung gateway would wedge the caller forever.
  - **CDP fallback for interactive ops.** `click`, `fill`, `type`, `press`, `scroll`, `evaluate`, `info`, and `getTree` used to hard-throw `"requires gateway"` when `browse-server.cjs` wasn't running. They now try the gateway first, then a short-lived `chromium.connectOverCDP()` via a new `withCdpPage()` helper that reuses the maintainer's live Chrome on port 9222. Refs are interpreted as CSS selectors when gateway is absent.
  - **Explicit PNG extension** on auto-generated screenshot filenames (`shot_<ts>.png`) so Playwright's format inference is unambiguous.
  - **Better error messages** — every "needs interactive" throw now includes the exact command to start CDP Chrome (`~/.claude/hub/SCRIPTS/browser.sh cdp start headless`).

- **`src/paths.ts` — `HUB_BROWSER_SH` constant.** New absolute path to `~/.claude/hub/SCRIPTS/browser.sh` so the manager can shell out without hard-coding `os.homedir()` inline.

**Why this matters:** `browser-manager.ts` is still not wired into any bot code path (it's future-proofing), so the production fix for user-interactive flows is `SKILL.md`. The manager hardening ensures that when it does eventually get wired into a sub-agent tool, it won't hang on missing gateways or lose all interactive capability when only CDP is available.

**Testing:** Tier 1 stealth end-to-end against `stepstone.de/jobs/it-delivery-director` → 1.2 MB HTML, title parsed. Module-level integration test: `navigate('https://example.com')` via auto-selected hub-stealth → correct title/URL. `resolveStrategy('gateway')` → cascades to CDP with visible warning. `info()` via CDP fallback → returns live Chrome state without throwing. Skills reload picks up the new SKILL.md (5977 chars), `matchSkills("browse linkedin")` hits the browse skill, `buildSkillContext("open stepstone.de")` injects the 3-tier guidance block.

## [4.8.8] — 2026-04-11

### ✨ Unlimited sub-agent & cron timeouts (user-configurable)

Sub-agents and `ai-query` cron jobs used to hard-cap at 5 minutes (`SUBAGENT_TIMEOUT=300000` default), and `shell` cron jobs at 60 s. Long-running research, deep-dive audits, or anything that crossed the threshold got killed mid-stream with `status: "timeout"`. 4.8.8 flips the default to **unlimited** and lets the user override both globally and per job.

**What changed:**

- **Default is now infinite.** `src/config.ts` seeds `subAgentTimeout` from `SUBAGENT_TIMEOUT` env or falls back to `-1` (unlimited). The runtime value lives in `~/.alvin-bot/sub-agents.json` as `defaultTimeoutMs` and is changeable at runtime without restart.
- **New `/subagents timeout` command.** `/subagents timeout` shows the current value; `/subagents timeout 3600` sets 1 h; `/subagents timeout off` (or `-1`, `0`, `unlimited`, `infinite`) disables the cap entirely. The default-status output now includes a `⏱ Timeout` line.
- **Per-job override on cron.** `/cron add 1h ai-query "deep audit" --timeout off` gives this one job no timeout. `/cron add 5m shell "pm2 ls" --timeout 30` caps this shell at 30 s. Omitting `--timeout` inherits the current global default. Same flag exists on `scripts/cron-manage.js add --timeout <sec|off>`.
- **`CronJob.timeoutMs` field.** Optional number in `cron-jobs.json`. Undefined = inherit global default. Value ≤ 0 = unlimited.
- **Semantics.** `spawnSubAgent` now only arms the `setTimeout(abort)` when `timeout > 0`. At ≤ 0, no abort timer is created, existing `if (timeoutId) clearTimeout(…)` call sites are null-safe, and the agent runs until it finishes, is cancelled via `/subagents cancel`, or the process dies.
- **Shell cron unchanged behaviour preserved.** If the shell job has no `timeoutMs`, `execSync` is called without a `timeout` option, which Node treats as infinite — same effect as before was *meant* to provide, but the old hard-coded 60 s removed that freedom.

**ENV var still works but is seed-only.** `SUBAGENT_TIMEOUT=600000` at startup still seeds the config on first load, but the persisted value in `sub-agents.json` wins after that.

### 🐛 Silenced harmless `message is not modified` Telegram errors

Occasionally the maintainer would see a red banner at the bottom of an Alvin message:

> Error: Call to 'editMessageText' failed! (400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message)

It never broke anything, but it polluted logs and showed up as an "internal error" reply to the user. Root cause: Telegram's Bot API refuses `editMessageText` when the new content + reply markup are byte-identical to the existing message. This happens legitimately in callback handlers — e.g. tapping a cron-toggle button twice, re-rendering a sudo/keys/platforms menu, language-switch callbacks that render the same content, or stream flushes where the throttled partial hasn't changed since the last edit.

**Fix**: `bot.catch()` in `src/index.ts` now filters out this specific error early. Two regex patterns (`/message is not modified/i` and `/specified new message content.*exactly the same/i`) cover both variants Telegram sends. Real errors (network, SDK, provider failures) still log and still surface the "internal error" reply to the user — only this one harmless class gets dropped.

### 📝 CLAUDE.md: PM2 references updated to launchd

The project `CLAUDE.md` still said *"PM2: `alvin-bot` Prozess, Config in `ecosystem.config.cjs`"* — outdated since the 4.8.6 switch to launchd. Updated to reflect the actual process manager (`~/Library/LaunchAgents/com.alvinbot.app.plist`, `KeepAlive=true`, `RunAtLoad=true`), the log paths, and a note that `watchdog.ts` only brakes process crash-loops — it does **not** kill long-running sessions or sub-agents. `ecosystem.config.cjs` is now labelled legacy.

The global `~/.claude/CLAUDE.md` was also corrected: `alvin-bot` was removed from the VPS PM2-process list (it runs locally, not on the VPS) and the cron-hub note now correctly says "als **launchd LaunchAgent**".

## [4.8.7] — 2026-04-11

### 🐛 `/update` now detects stale-runtime (rebuild without restart)

Caught immediately after publishing 4.8.6 on the Mac mini: `/update` reported "Already up to date — no new commits" even though the running process was on **v4.8.5** while the disk was already built at **v4.8.6**. The user could see the version mismatch in `/status` (v4.8.5) but `/update` refused to acknowledge it.

**Root cause**: The updater only compared **git commits** (or **npm registry version**) against the local install. It never checked whether the **running process's in-memory version** was older than the **on-disk built version**. This is the dev/CI loop scenario:

1. You edit src/, bump package.json, commit + push
2. `npm run build` regenerates dist/ at the new version
3. The running process has the OLD code in memory
4. You run `/update` in Telegram
5. git: HEAD == origin/main (just pushed) → 0 commits behind → "up to date"
6. Process never restarts → keeps running OLD code

**Fix**: New `isRuntimeStale()` check at the very start of `runUpdate()`. Compares `BOT_VERSION` (in-memory at process start) against `package.json.version` from disk via the existing semver compare. If disk is newer, returns success with `requiresRestart=true` immediately — skip the git/npm fetch entirely, just signal a restart so the fresh code takes effect.

After 4.8.7, running `/update` after a manual rebuild will correctly say *"Disk is already built at vX, running vY. Restarting to pick up the new code..."* and trigger the restart.

### ✨ Internal watchdog with crash-loop brake (`src/services/watchdog.ts`)

the maintainer asked for "derbe persistent" — already 95% there with `KeepAlive: true` from 4.8.6, but the missing piece was a brake to stop the bot from infinite-restart-looping if a deterministic crash happens (corrupt state file, missing dependency, broken upgrade).

**New module**: `src/services/watchdog.ts`. Two responsibilities:

**1. Liveness beacon**. Every 30 s the bot writes `~/.alvin-bot/state/watchdog.json` with `{lastBeat, pid, bootTime, crashCount, crashWindowStart, version}`. Fast disk write, no I/O blocking.

**2. Crash-loop brake**. On every fresh boot, the watchdog reads the previous beacon:

- If the previous beacon is **less than 90 s old** → the previous process exited very recently → that's a crash (or a deliberate restart, treated the same way for the brake's purpose). Increment `crashCount`.
- If the previous beacon is **older than 90 s** → previous process had clean uptime → reset counter to 0.
- The crash window is **10 minutes**. Crashes within this window accumulate; older ones don't count.
- If `crashCount` reaches **10**, the brake engages:
  - Writes `~/.alvin-bot/state/crash-loop.alert` with the timestamp, version, error log path, and recovery steps
  - Tries to `launchctl unload -w` its own LaunchAgent so launchd stops retrying (otherwise `KeepAlive: true` would keep burning CPU forever)
  - Exits with code 3

**3. Recovery**. After **5 minutes of clean uptime**, the watchdog auto-resets the crash counter to 0. So a healthy bot that occasionally has a transient hiccup doesn't slowly accumulate toward the brake over days.

**4. Brake check at startup**. `checkCrashLoopBrake()` runs in `index.ts` **before** any expensive init — if the alert file already exists, the bot exits cleanly with code 3 and tries to unload itself again. This prevents launchd from spinning the bot up just to write the same alert over and over.

**Recovery from a tripped brake**:

```bash
# 1. Investigate the error log
cat ~/.alvin-bot/logs/alvin-bot.err.log

# 2. Fix whatever was wrong
# 3. Remove the alert file
rm ~/.alvin-bot/state/crash-loop.alert

# 4. Reload the LaunchAgent
alvin-bot launchd install
```

**What this catches**:

- Process crashes (segfault, OOM kill) → exit non-zero → brake increments
- `process.exit()` from unhandled rejection → similar
- Tight crash loops → brake engages at 10 within 10 min
- Corrupted state files that crash on read → brake engages eventually

**What this does NOT catch (yet)**:

- Event-loop deadlocks where the process is alive but completely frozen. The watchdog beacon needs the event loop to be alive, so it can't detect freeze. A future release will add an external sister LaunchAgent (`com.alvinbot.watchdog`) that runs every 2 minutes via `StartInterval` and kills the main bot if its beacon file is too stale. Tracked as a follow-up.

**Telemetry surface**: `alvin-bot status` could read the beacon file in a future release to show "crash count: X in last Y minutes" — for now, the alert file is the main user-facing signal.

### 🛡 LaunchAgent: ProcessType + LimitLoadToSessionType

Two small plist hardening tweaks:

- **`ProcessType: Background`** — explicit hint to launchd that this is a long-running background service. macOS treats Background processes with friendlier scheduling and is less likely to kill them under memory pressure (vs `Standard` which is the default for unlabeled jobs).
- **`LimitLoadToSessionType: Aqua`** — only loads in user GUI sessions. Prevents the LaunchAgent from accidentally loading in non-GUI contexts (e.g. SSH login session) where it would not have Keychain access. Defensive: matches our existing assumption that the bot needs the GUI keychain unlocked for Claude SDK OAuth.

These don't change behaviour for normal use, but they're explicit about our intent. macOS will treat the bot as a proper background service rather than a generic foreground job.

### Tests

87 still passing — no test changes (the stale-runtime check is a fast-path branch that doesn't disturb the existing git/npm logic).

## [4.8.6] — 2026-04-11

### 🐛 LaunchAgent: `/restart` left the bot down forever

Caught on the Mac mini production bot: running `/restart` in Telegram killed the bot cleanly but the process never came back, leaving the bot dead until manual intervention.

**Root cause**: The 4.6.0 LaunchAgent plist template hardcoded a conditional `KeepAlive`:

```xml
<key>KeepAlive</key>
<dict>
    <key>SuccessfulExit</key>
    <false/>   <!-- don't restart on normal exit -->
    <key>Crashed</key>
    <true/>    <!-- only restart on crash -->
</dict>
```

That meant launchd would only auto-restart on **crashes**, not on normal exits. But `/restart` (and `/update`) work by calling `process.exit(0)` — a deliberate clean exit — and relying on the process manager to bring the bot back up. With pm2 this always worked because pm2's default is "restart on any exit". With launchd's conditional KeepAlive, `process.exit(0)` was the ONE exit code that guaranteed the bot stayed down.

**Fix**: Plist template now uses `<key>KeepAlive</key><true/>` — unconditional restart on any exit. Matches pm2's default behavior. `ThrottleInterval` dropped from 10s to 5s so recovery is quicker.

**Migration for existing installs**: re-run `alvin-bot launchd install` to get the new plist. The install script unloads the old plist, writes the new one, and reloads it — existing data and running state are preserved.

Also removed the stale "(PM2)" suffix from the `/restart` Telegram command description — it's just "Restart the bot" now, since the command works identically with both pm2 and launchd.

## [4.8.5] — 2026-04-11

### 🐛 `/update` now works for npm-global installs

Caught on the test MacBook: `/update` reported *"Already up to date — no new commits"* even though npm had a newer version published. Root cause was two separate bugs feeding into each other.

**Bug 1 — false git-repo detection**. `isGitRepo()` used `git rev-parse --is-inside-work-tree` which walks up the directory tree looking for any ancestor `.git` folder. On the test MacBook, `alvin-bot` was installed at `/opt/homebrew/lib/node_modules/alvin-bot/` which has no `.git` itself — but Homebrew stores its formula tree at `/opt/homebrew/` as a git repo. So `git rev-parse` walked up, found Homebrew's `.git`, and returned `true`. The updater then dutifully fetched Homebrew's upstream (which was up-to-date), found 0 new commits, and reported "Already up to date" — about the wrong repository.

**Fix**: `isOwnGitRepo()` now does a strict check for `PROJECT_ROOT/.git` directly, no directory walk. False positives from ancestor git repos are impossible.

**Bug 2 — no update path for npm-global installs**. Even with a correct `isGitRepo()` check, the updater would return *"Not in a git repo — update only supported for source installs."* for npm-global installs. That meant you could never update an npm-installed alvin-bot from within the bot itself.

**Fix**: New `runNpmUpdate()` path that kicks in when `PROJECT_ROOT` looks like a `node_modules/alvin-bot` install (covers Homebrew node, plain npm, nvm, volta). It:

1. Reads the local version from `package.json`
2. Queries `npm view alvin-bot version` for the latest published version
3. Compares via a tiny semver compare
4. If newer: runs `npm install -g alvin-bot@latest --no-audit --no-fund` (5 minute timeout)
5. Signals the caller to restart so the new code takes effect
6. Detects `EACCES` and suggests `sudo` explicitly instead of a cryptic error

Also improved the git path: falls back to `npm install` + `npm run build` when `pnpm-lock.yaml` doesn't exist (previously hard-coded pnpm).

After 4.8.5, `/update` on the test MacBook will correctly detect the npm install, see that v4.8.4 is the latest, fetch it, and restart. No more false-positive "up to date" when a newer release is out.

## [4.8.4] — 2026-04-11

### 🐛 WhatsApp self-chat detection for the new `@lid` identity format

the maintainer reported that the WhatsApp bot wasn't responding to "Hi" in his self-chat even after enabling both `Self-chat only` and `Reply to private messages` in the Web UI. Debug logging showed the bot receiving the message correctly and detecting `fromMe=true`, but then hitting the "skip: own message in group/DM" branch because `isSelfChat()` was returning `false`.

**Root cause**: WhatsApp has rolled out a new privacy feature that replaces phone-number JIDs in self-chats (and some groups) with a **LID — Linked Identity**. Instead of `4917661236656@s.whatsapp.net`, messages in a self-chat now arrive with `jid = "162805718225143@lid"` — a completely opaque identifier that looks nothing like the phone number.

Our `isSelfChat(jid)` compared the incoming JID against `sock.user.id` (the traditional phone-number format `4917661236656:22@s.whatsapp.net`), stripped the device suffix, and compared the bare numbers. But the LID has a completely different number (`162805718225143`), so the match failed and every self-chat message fell through to the "own message in DM" skip branch.

**Fix**: `isSelfChat()` now checks **both** identity formats:

- **Traditional phone JID** via `sock.user.id` (legacy path, still matches on older WhatsApp clients)
- **LID** via `sock.user.lid` (baileys ≥ 6.7 exposes this) with `@lid` suffix matching

Either match wins. The check short-circuits on groups (`@g.us`) so the new code never misclassifies a group as self-chat.

Caught on the Mac mini production bot after midnight — WhatsApp connected, QR scanned, user sending "Hi", bot silent. Debug logging revealed the actual incoming JID (`162805718225143@lid`) which immediately pointed at the LID format as the culprit.

### 🧹 Dual-bot session collision (root cause of WhatsApp reconnect flapping)

While debugging the `@lid` issue above, the test revealed a deeper problem: two `node dist/index.js` processes were running simultaneously on the Mac mini (PID 47744 from an earlier `launchctl kickstart` that didn't cleanly kill the old instance, plus PID 49153 from a new `launchd install`). Both processes were trying to hold the same WhatsApp Multi-Device session at the same time, causing:

- WhatsApp `Reconnecting in 3s` every few seconds (each process would claim the session, the other would be kicked)
- Baileys `Closing session` dumps to the log
- Signal session state corruption → "Warte auf diese Nachricht" (waiting-to-decrypt) messages appearing spontaneously in the self-chat

**Short-term workaround**: explicit `pkill -9 -f 'node.*alvin-bot/dist/index'` before `launchctl kickstart` to ensure only one process is running.

**Session wipe procedure** (when the corruption is already baked in):

1. `launchctl unload -w ~/Library/LaunchAgents/com.alvinbot.app.plist`
2. `pkill -9 -f "node.*alvin-bot/dist/index"`
3. `rm -rf ~/.alvin-bot/data/whatsapp-auth`
4. Remove the zombie linked-device from your phone (iPhone Settings → Linked Devices → remove all "Alvin Bot" entries)
5. `launchctl load -w ~/Library/LaunchAgents/com.alvinbot.app.plist`
6. Re-scan the QR code

A future release should add a proper `alvin-bot wa reset` command to automate this and a startup check that refuses to boot if another instance is already running.

## [4.8.3] — 2026-04-11

### 🐛 Critical: Claude SDK heartbeat false-positive "unavailable"

Caught in production on the Mac mini: the heartbeat monitor was marking `claude-sdk` as unhealthy every 5 minutes, triggering failover to Ollama, even though `claude -p "ping"` from the same user's terminal worked perfectly. After 9 consecutive heartbeat failures, the main Telegram bot was stuck serving responses via Gemma 4 instead of Claude Max.

**Root cause**: `isAvailable()` in the Claude SDK provider used `claude -p "ping" --output-format text` as an auth probe. That command spawns a full SDK query, takes **6-10 seconds warm** (longer on cold starts), and my timeout was only **10 seconds**. Under load or on cold starts it crossed the timeout threshold, was killed by Node, and execFileAsync rejected → caught by the outer try/catch → cached as "unavailable" for 60 seconds → next heartbeat re-probed and failed the same way.

**Fix**: Replaced the `-p "ping"` probe with `claude auth status`. This is a purpose-built Claude CLI command that:

- Completes in ~150 ms (vs 6-10 s)
- Returns structured JSON with an explicit `loggedIn` boolean
- Consumes zero tokens
- Doesn't touch the SDK or model init path

The new code parses the JSON and returns `true` only when `loggedIn === true`. A fallback path keeps the old `-p "ping"` sniff for older Claude CLI versions that don't support `auth status` as JSON.

Before/after the fix:

```
Before: 6800ms warm probe, 10s timeout, consumed tokens,
        failed under load → 9 consecutive false-positive "unavailable"
After:  150ms probe, 5s timeout, no tokens, structured JSON check
```

### ✨ New CLI command: `alvin-bot status`

Offline-friendly status command — no running bot required. Prints:

- **Version**: `Alvin Bot vX.Y.Z` + Node version + platform/arch
- **Data dir**: path + whether `.env` exists + configured `PRIMARY_PROVIDER`
- **Runtime state**:
  - On macOS: LaunchAgent plist installed? PID from `launchctl list`?
  - On Linux/Windows: `pm2 jlist` check for the `alvin-bot` process
- **Live info** (when the bot is running with the web UI on :3100): Uptime, active model

Answers the maintainer's request: *"alvin-bot status im Terminal soll auch die Version anzeigen"*. The command prominently features the version at the top so it's the first thing you see.

Example:

```
🤖 Alvin Bot v4.8.3
   Node v25.9.0 · darwin/arm64

📁 Data dir:  /Users/alvin_de/.alvin-bot
   .env:      ✅ present
   Provider:  claude-sdk

🚀 LaunchAgent: installed
   Running:    ✅ yes (PID 43589)
   Uptime:     0h 55m
   Model:      Gemma 4 E4B (Ollama)
```

### Tests

2 new test cases in `test/claude-sdk-provider.test.ts` cover the new flow:

- `claude auth status` returning `{loggedIn: true}` → `isAvailable()` returns `true`
- `claude auth status` returning `{loggedIn: false}` → `isAvailable()` returns `false`
- Older CLI where `auth status` throws → fall back to `-p "ping"` path (preserves old behavior)

87 tests passing (up from 85).

## [4.8.2] — 2026-04-11

### 🐛 Offline setup: wait long enough for Ollama's first-run init

Second follow-up to 4.8.0's offline-gemma4 wizard. The 4.8.1 brew path successfully installs Ollama, but the subsequent `ensureOllamaServe()` was reporting "Could not start Ollama daemon" because it only waited **2 seconds** after spawning the server.

What actually happens on first run:

1. `nohup ollama serve &` spawns the server process
2. Server generates a fresh SSH keypair at `~/.ollama/id_ed25519` (~1 s)
3. Server discovers GPUs — on Apple Silicon this initializes Metal (~5 s)
4. Server starts the runner subprocess (~1 s)
5. Server begins listening on `127.0.0.1:11434`

Total cold-start time: **5–15 seconds**. The old 2-second wait was racing ahead of GPU discovery and failing the next `ollama list` call.

Fix: `ensureOllamaServe()` now polls `ollama list` every second for up to **30 seconds**. On success it reports which attempt worked (for visibility). On failure it dumps the last 15 lines of `/tmp/ollama-setup.log` so users can see what Ollama itself said.

Caught during the second run of the setup wizard on the fresh test MacBook — brew install succeeded, daemon was actually running (PID confirmed via pgrep), but the wizard bailed out anyway because it gave up too soon.

## [4.8.1] — 2026-04-11

### 🐛 Offline setup: Homebrew preferred on macOS

Caught during the first real run of the new offline setup wizard on a fresh test MacBook: the official Ollama `install.sh` script on macOS wants to drop `Ollama.app` into `/Applications` and start it as a GUI app. That requires a real user session with sudo and completely breaks over SSH or any non-interactive context. The install downloads the 25 MB .app, then fails at `Unable to find application named 'Ollama'` and drops the wizard back to the fallback provider picker.

Fix in `bin/cli.js` `installOllama()`:

- **macOS preferred path**: if Homebrew is available (`brew --version` succeeds), use `brew install ollama`. Brew installs `/opt/homebrew/bin/ollama` as a CLI binary with no sudo prompt, no /Applications drop, no GUI dependency — works over SSH and in any CI/non-interactive context.
- **Fallback**: if brew is not installed or `brew install` itself fails, fall through to the official `install.sh` with an explicit heads-up that the installer may prompt for admin password and may only work in a local terminal.
- **Better error messaging**: on macOS install failure, suggest `brew install ollama` or the `.dmg` from ollama.com/download as alternatives. On Linux, unchanged.

Linux always uses `install.sh` — systemd user units work non-interactively there.

## [4.8.0] — 2026-04-11

### ✨ Offline mode — Gemma 4 E4B via Ollama in the setup wizard

Fresh installs on a machine without any AI-provider key can now pick **Offline mode** as the first option in the setup wizard. It runs **Google Gemma 4 E4B** locally via Ollama — no API key, zero running cost, works 100% offline once downloaded.

New in `bin/cli.js`:

- `PROVIDERS[0]` is now `offline-gemma4`, labeled prominently with the `~10 GB one-time download` so users can't miss the size.
- `setupOfflineGemma4()` helper walks the user through:
  1. **Warning** about download size (15–70 min depending on connection) and on-disk footprint (~10 GB in `~/.ollama/models`)
  2. **Confirmation prompt** — if the user declines, the wizard loops back to the normal provider picker (no dead ends)
  3. **Ollama install** via the official `curl -fsSL https://ollama.com/install.sh | sh` if the `ollama` binary is missing
  4. **Daemon check** — ensures Ollama is listening, spawns it in the background if not
  5. **Cache check** — if `gemma4:e4b` is already pulled, skips the download
  6. **Model pull** with a second confirmation before the 10 GB actually starts, streaming progress output so the user sees every layer land
- `.env` gets `PRIMARY_PROVIDER=ollama`. The registry's Ollama preset in `src/providers/types.ts` already defaults to `gemma4:e4b`, so no extra environment variable is needed.

macOS + Linux only. Windows users get pointed at https://ollama.com/download.

### ✨ `/version` command + version display in `/status`

- New `/version` command in both **Telegram** and **TUI**. Shows `Alvin Bot vX.Y.Z · Node vN · platform/arch`. Registered in `setMyCommands` so Telegram shows it in the autocomplete menu.
- `/status` header on Telegram now reads `🤖 Alvin Bot vX.Y.Z` instead of just `Alvin Bot Status`.
- TUI `/status` header also carries the version.
- **Bug fix**: `/api/status` used to hard-code `version: "3.0.0"` (a leftover from v3). It now reads `BOT_VERSION` dynamically, so the TUI and Web UI see the actual running version.

Implementation: new `src/version.ts` module reads `package.json` once at module load, exports `BOT_VERSION` as a const. Path resolution uses `import.meta.url` so the cwd can't break it.

### 🐛 `alvin-bot launchd install` preserves other pm2 projects

The initial 4.7.0 release called `pm2 kill` during `launchd install` to stop the pm2 daemon. That's wrong for users who have **other** pm2-managed projects (e.g. `polyseus`) alongside `alvin-bot` — their other work would go down with the switch.

New behavior in `bin/cli.js`:

- Parse `pm2 jlist` JSON to detect (a) whether `alvin-bot` is pm2-managed and (b) whether any other pm2 projects exist.
- Only run `pm2 delete alvin-bot` — never `pm2 kill`. The daemon keeps running for the other projects.
- Post-install hint is smarter:
  - **pm2 now empty** → *"pm2 now has zero managed processes. Remove it with: `npm uninstall -g pm2`"*
  - **pm2 still has other projects** → *"pm2 still has other projects running — leaving it installed."*

Caught immediately after 4.7.0 shipped when the maintainer pointed out his Mac mini has `polyseus` in pm2 alongside `alvin-bot` and didn't want it touched.

## [4.7.0] — 2026-04-11

### ✨ Sub-Agents Stufe 2 — live-stream, bounded queue, 24h stats

Stufe 2 of the sub-agents refinement spec lands alongside the same-day 4.6.0 release. Everything here builds on the Stufe 1 foundation and is fully unit-tested (85 passing tests).

#### A4 Live-Stream for user-spawns

`/subagents visibility live` enables a new delivery mode where user-spawned sub-agents stream their text incrementally into a single Telegram message, then post a completion banner as a separate message.

Implementation in `src/services/subagent-delivery.ts`:

- `LiveStream` class with `start()` / `update()` / `finalize()`
- `start()` posts an initial `⏳ <name> thinking…` placeholder and records its `message_id`
- `update()` is called on every text chunk from the agent's generator; it coalesces rapid updates via a throttle window of **800 ms** so we never exceed Telegram's edit rate limit. Multiple `update()` calls within the window collapse into a single edit with the latest accumulated text.
- `finalize()` flushes any pending text, replaces the `thinking…` header with the final body, then sends a new banner message so the user gets a completion notification (edits don't trigger push notifications).
- The live-stream message uses **plain text** (no `parse_mode`) so half-formed markdown during streaming can never cause an edit to be rejected. The final banner does use markdown.

Wiring in `runSubAgent`:

- Detects `effectiveVisibility === "live"` AND `source === "user"` AND `parentChatId`. Cron and implicit spawns are never live-streamed — cron because there's no interactive watcher, implicit because the parent Claude stream already shows everything inline.
- Creates the `LiveStream` via `createLiveStream()` before the for-await loop.
- Calls `liveStream.update(chunk.text)` on every text chunk.
- Calls `liveStream.finalize(info, result)` after the loop and marks `entry.delivered = true` so `spawnSubAgent.finally()` skips the regular `deliverSubAgentResult` path. If finalize fails, the `delivered` flag stays false and the normal banner delivery fires as a fallback.
- Falls back to `"banner"` mode transparently if the bot API doesn't support `editMessageText` (e.g. during tests or if `attachBotApi` was never called).

Tests added in `test/subagent-delivery.test.ts`:

- `start` posts an initial placeholder and stores the message_id
- `update` coalesces rapid calls into a single throttled edit within the 800 ms window
- `finalize` posts a banner as a new message
- `createLiveStream` returns `null` when `editMessageText` is missing

#### D3 Bounded priority queue

Previously, hitting `maxParallel` returned a hard reject. Now spawn requests that don't fit run into a **bounded priority queue**:

- Default cap: **20** slots (configurable via `/subagents queue <n>`, clamped to 0–200)
- Setting cap to 0 disables the queue entirely and restores the old reject-on-full behavior
- Priority order on drain: **user > cron > implicit**
- FIFO within each priority class
- Drains automatically when a running agent finishes — the `runSubAgent.finally()` now calls `drainQueue()` after cleanup

New fields:

- `SubAgentsConfig.queueCap: number` — persisted in `~/.alvin-bot/sub-agents.json`
- `SubAgentInfo.status: "queued"` — new valid state
- `SubAgentInfo.queuePosition?: number` — 1-based position in the queue, shown in `/subagents list` as `#N`

Functions in `subagents.ts`:

- `getQueueCap()` / `setQueueCap(n)` — public config accessors
- `drainQueue()` — called from `runSubAgent.finally()`, pops in priority order and transitions entries from `queued` to `running`
- `popHighestPriorityQueued()` — internal FIFO-per-priority scan
- `reindexQueue()` — keeps `SubAgentInfo.queuePosition` in sync after pop/cancel
- `cancelSubAgent()` now handles queued entries by removing them from the queue without starting `runSubAgent` at all
- `cancelAllSubAgents()` clears the pending queue before cancelling running agents, so shutdown doesn't spawn anything new
- `spawnSubAgent()` is split: queue decision first (run immediately vs queue vs reject), then `startRun()` helper starts the background loop

Reject messages stay priority-aware (D4) but now mention queue saturation:

- `user` spawn + pool full + cron/implicit in pool + queue full → *"Alle Slots belegt (N/M), davon X cron/implicit im Hintergrund. Queue voll (Q/C). /subagents list für Details …"*
- `user` spawn + pool full + user in pool + queue full → *"Alle Slots belegt (N/M) mit eigenen user-Spawns. Queue voll (Q/C). /subagents cancel <name> oder warten."*
- Non-user spawns + pool + queue full → *"Sub-agent limit reached (N running, Q/C queued). Wait for a running agent to finish or cancel one."*

Tests added in `test/subagents-queue.test.ts`:

- Default cap is 20
- Clamping (negative → 0, above 200 → 200, fractional floors)
- Round-trip through disk
- Third spawn at full pool lands as `status: "queued"` with `queuePosition: 1`
- Queue drains automatically when a running agent finishes
- Priority order: user spawns drain before cron at the same moment
- `cancelSubAgent` removes a queued entry

The existing priority-reject tests now explicitly set `queueCap = 0` to test the old reject path, and a new "queue enabled" test fills both pool and queue before asserting the reject message.

#### H3 24-hour run stats

New module `src/services/subagent-stats.ts` — a simple append-only JSON ring buffer persisted to `~/.alvin-bot/subagent-stats.json`. Each completed sub-agent run appends one entry:

```ts
{
  completedAt: number;
  name: string;
  source: "user" | "cron" | "implicit";
  status: "completed" | "timeout" | "error" | "cancelled";
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}
```

On every load or append, entries older than 24 hours are pruned. A hard cap of 5000 entries protects against unbounded growth on high-frequency bots.

Accessors:

- `recordSubAgentRun(info, result)` — called from `runSubAgent.finally()` as a non-blocking side effect. Errors are logged but don't affect delivery.
- `getSubAgentStats()` — returns a `StatsSummary` with totals, per-source breakdown, and per-status counts.

New Telegram command **`/subagents stats`** renders the summary:

```
📊 Sub-Agent Stats — last 24h

Total: 44 runs · 165k in / 89k out · 12m

By source:
  👤 user:     12 runs · 45k in / 22k out
  ⏰ cron:      8 runs · 31k in / 15k out
  🔗 implicit: 24 runs · 89k in / 52k out

By status:
  ✅ completed: 42
  ⚠️ cancelled: 1
  ⏱️ timeout:   0
  ❌ error:     1
```

The JSON backing file is a deliberate short-term choice. When the SQLite migration lands (already scoped in a separate memory entry as `project_alvinbot_sqlite_migration.md`), we swap the backend without touching `getSubAgentStats()` or `recordSubAgentRun()` — both are designed as a narrow interface.

Tests added in `test/subagent-stats.test.ts`:

- Fresh install returns zeros
- Recording 3 runs updates totals + per-source breakdown
- Persistence + reload round-trip
- Entries older than 24h are pruned on load
- `byStatus` tracks cancelled/error/timeout separately

### 🖥 CLI: `alvin-bot start` / `stop` now auto-detect LaunchAgent

The `start` and `stop` commands previously always went through pm2. That created a conflict after `alvin-bot launchd install`: the LaunchAgent ran the bot, but `alvin-bot start` would happily spawn a second instance via pm2, and `alvin-bot stop` would try to stop a pm2 process that didn't exist.

Now both commands check for `~/Library/LaunchAgents/com.alvinbot.app.plist` on macOS and switch transparently:

- **`alvin-bot start`** with a LaunchAgent present → `launchctl kickstart -k gui/$UID/com.alvinbot.app` (or `launchctl load -w` if not loaded yet). No pm2 involvement.
- **`alvin-bot stop`** with a LaunchAgent present → `launchctl unload -w` (doesn't remove the plist, just stops the daemon).
- **`alvin-bot start`** on macOS without a LaunchAgent → pm2 path + a helpful tip: *"💡 Tip: on macOS with Claude Code, switch to launchd for automatic Keychain access: alvin-bot launchd install"*.

Linux and Windows users are unaffected — they always get the pm2 path.

### 🐛 Other

- `/subagents queue` is registered in the usage string for en/de/es/fr.
- `/subagents stats` is registered in the usage string for en/de/es/fr.
- `/subagents visibility` usage now lists `live` as a valid mode.
- Removed the leftover `alvin-bot-4.5.1.tgz` from the repo root.

## [4.6.0] — 2026-04-11

### ✨ Sub-Agents Stufe 1 — context-aware delivery, name-first addressing, shutdown notifications

**The big one.** Stufe 1 of the SubAgents refinement spec (9 design axes, two-stage rollout) is complete. Everything here is live-validated on a remote test MacBook via `@Alvin_testbot_bot` over Telegram with Claude Agent SDK + Max OAuth.

#### A4 + I3 — Source-aware delivery router

New module `src/services/subagent-delivery.ts`. Every completed sub-agent routes through a single entry point that picks its delivery path based on `SubAgentInfo.source`:

- `implicit` (Main-Claude calling the SDK `Task` tool) → **no-op**, the parent stream already shows the result.
- `user` (explicit user spawn) → **banner + final** to `parentChatId` in the originating chat.
- `cron` (scheduled job) → **banner + final** to the `chatId` from the cron job's target.

The banner format is fixed: `{icon} *{name}* {status} · {duration} · {input_tokens} in / {output_tokens} out` followed by the agent output. Status icons: ✅ completed, ⚠️ cancelled, ⏱️ timeout, ❌ error. Duration is human-formatted (`42s`, `3m 12s`). Token counts collapse at 1000 (`4.2k`).

Output chunking:
- ≤3800 chars → single message `banner + body`
- 3800–20000 chars → banner alone, then body chunks of 3800 chars each
- \>20000 chars → banner + the body as a `.md` file upload (via `grammy`'s `InputFile`)

The bot API is attached lazily at startup via `attachBotApi()` so `subagent-delivery.ts` stays free of a circular import on `index.ts`. Test hook `__setBotApiForTest()` lets Vitest inject a fake.

#### New command: `/subagents visibility <auto|banner|silent>`

Per-install persistent visibility setting, written to `~/.alvin-bot/sub-agents.json`. `silent` suppresses the delivery entirely — the result is still stored in the `activeAgents` map and pullable via `/subagents result <name>`. `auto` is the default and falls through to the source-based routing described above.

#### B2 — Name-first addressing with automatic `#N` collision suffixes

`/subagents cancel <name|id>` and `/subagents result <name|id>` now accept names, not just UUIDs. When a new spawn collides with an existing name, the resolver appends `#2`, `#3`, … using the smallest free index. Example: three parallel `review` spawns appear as `review`, `review#2`, `review#3` in `/subagents list`.

Resolution order:
1. Explicit `#N` suffix (e.g. `review#2`) → exact match wins, never falls through to ambiguity
2. Base name with a single sibling → that sibling
3. Base name with multiple siblings **and** `ambiguousAsList: true` opt-in → disambiguation reply listing all candidates
4. Base name with multiple siblings, no opt-in → first sibling
5. No name match → UUID prefix (back-compat)

#### C3 — Parent inheritance

Sub-agents now inherit `workingDir` (with `inheritCwd: false` opt-out), `CLAUDE.md` (via `settingSources: ["project"]`), and the registry's provider/model. Conversation history is **not** inherited — the sub-agent reads only its own prompt, which forces clean, self-describing spawn requests and keeps parallel agents from colliding on shared context.

#### D4 — Priority-aware reject messages

Pool is still strictly capped (no preemption), but the error message when it's full now depends on who holds the slots:
- User spawn + background (cron/implicit) hold slots → message points at `/subagents list` so the user knows the pool isn't stuck on another interactive task
- User spawn + other user spawns → suggests cancel-or-wait with command hints
- Cron/implicit rejects → generic "limit reached" (those callers handle retry themselves)

#### E2 — Shutdown notifications

`cancelAllSubAgents(notify: true)` is now async and fires a delivery to each still-running agent before the process exits. Each notification is a synth `cancelled` result with the body `⚠️ Agent wurde durch Bot-Restart unterbrochen. Bitte neu triggern.` and routes through the normal I3 delivery path. Total delivery phase is capped at 5s so a hanging Telegram send can't block shutdown.

The shutdown hook in `src/index.ts` now `await`s `cancelAllSubAgents(true)` before stopping the grammy bot and tearing down plugins.

#### F2 — Depth cap (hard limit = 2)

`SubAgentConfig.depth` is a new optional field (defaults to 0 = root). `spawnSubAgent` rejects any depth > 2 with a clear error. The depth shows in `/subagents list` as `d0` / `d1` / `d2` with 2-space indentation per level, so nested scatter-gather runs are visually nested.

#### G1 — Toolset preset infrastructure

New `SubAgentConfig.toolset` field with a single valid value `"full"`. Runtime validation rejects any other string. This is purely infrastructure for future `"readonly"` / `"research"` presets — no behavior change today, but adding a preset later is a one-line diff.

#### H2 — Per-run token accounting in the banner

Every completed sub-agent's banner carries the input/output token counts it actually consumed. No aggregation (H3) — that comes later with the SQLite migration. For now, you can see "this agent cost me 4.2k/2.1k" right next to the result.

#### Tests

67 passing Vitest tests across 12 files. New test files added for this release:
- `test/claude-sdk-provider.test.ts` — auth probe + `isAuthErrorOutput` helper
- `test/subagents-depth.test.ts` — depth cap (F2)
- `test/subagents-inheritance.test.ts` — cwd inheritance (C3)
- `test/subagents-toolset.test.ts` — toolset literal (G1)
- `test/subagents-name-resolver.test.ts` — `findSubAgentByName` including regression for exact-match vs ambiguity
- `test/subagents-commands.test.ts` — `cancelSubAgentByName`/`getSubAgentResultByName` helpers
- `test/subagent-delivery.test.ts` — I3 delivery router (all 5 source/visibility paths)
- `test/subagents-shutdown.test.ts` — E2 notify=true / notify=false + regression for shutdown double-delivery
- `test/subagents-priority-reject.test.ts` — D4 priority-aware reject messages
- `test/subagents-config.test.ts` — expanded with visibility config round-trip

### 🖥 New CLI: `alvin-bot launchd install|uninstall|status` (macOS only)

**Why this matters.** Claude Code 2.x stores the Max-subscription OAuth token in the macOS Keychain, service `"Claude Code-credentials"`. Accessing the token requires:
1. A Keychain ACL that permits the `claude` binary (granted via the "Always Allow" dialog on first GUI invocation)
2. An *unlocked* Keychain in the calling process's security context

Processes started via SSH, pm2, or `nohup` run in a detached launchd session that does **not** inherit the GUI user's unlocked-Keychain state. Even a manual `security unlock-keychain -p '...'` only unlocks the current SSH session — the pm2 daemon running in its own context stays locked out. Result: the Bot saw `Not logged in · Please run /login` on every sub-agent query, and the fix in 4.6.0's Phase 0 exposes that as a clean error instead of leaking it as chat text.

**The fix**: run the bot as a **launchd user agent**. LaunchAgents run inside the GUI login session and inherit the unlocked Keychain automatically. No SSH dance, no pm2 drama, no manual unlocks on every restart.

```
alvin-bot launchd install    — Write ~/Library/LaunchAgents/com.alvinbot.app.plist,
                                unload any existing instance, launchctl load -w.
alvin-bot launchd uninstall  — Unload and rm the plist.
alvin-bot launchd status     — Plist existence, PID from `launchctl list`,
                                tail of ~/.alvin-bot/logs/alvin-bot.{out,err}.log.
```

Plist details:
- `KeepAlive` → auto-restart on crash, not on successful exit
- `RunAtLoad` → starts on login
- `ThrottleInterval 10` → prevents rapid restart loops
- `PATH` covers `~/.local/bin`, `/opt/homebrew/bin` (Apple Silicon), `/usr/local/bin` (Intel Homebrew)
- stdout → `~/.alvin-bot/logs/alvin-bot.out.log`
- stderr → `~/.alvin-bot/logs/alvin-bot.err.log`

macOS users should migrate from `alvin-bot start` (pm2) to `alvin-bot launchd install`. Pm2 still works and remains the Linux/Windows default.

### 🐛 Bug fixes

- **`ClaudeSDKProvider.isAvailable()` now actually probes authentication.** The old check only ran `claude --version`, which succeeds whether or not the CLI has a valid OAuth token. A locked-out CLI would be reported as available, and the `Not logged in` response would leak into the chat as a normal assistant message. New behavior: `claude --version` for the binary check, then `claude -p "ping"` to verify auth. If the output matches the "Not logged in" pattern, the provider reports `false` and the registry falls through to the next provider.

- **`ClaudeSDKProvider.query()` surfaces `Not logged in` as an error chunk.** Even in code paths where `isAvailable()` returned stale cache, a runtime failure during the stream would emit `Not logged in · Please run /login` as text. The query loop now detects the auth pattern on the first text chunk and yields a typed `error` chunk with a clear "Run `claude login`" message, instead of pretending it's a normal response.

- **`/subagents cancel|result <name#N>` now hits the exact entry.** Regression caught during the remote test: asking for `test-ping#2` returned the "Mehrdeutig — welchen meinst du?" ambiguity reply instead of the specific `#2` entry, because `findSubAgentByName` checked base-name siblings before the exact-name match when `ambiguousAsList: true` was set. Explicit `#N` queries now always win.

- **Shutdown double-delivery race fixed.** If the bot received SIGTERM while a sub-agent was mid-stream, Telegram saw two messages: a "completed · (empty output)" banner from `runSubAgent.finally()` (because the test generator exited gracefully after the abort), followed by the "cancelled · Bot-Restart" banner from `cancelAllSubAgents`. Fixed with a `delivered: boolean` flag on each `activeAgents` entry — whoever posts first sets it, the other skips.

- **`providerKeyMap` alignment in `src/index.ts`.** The pre-flight provider-key warning used `gemini-2.5-flash` as the map key, but the registry registers Google Gemini under `google`. Users who set `PRIMARY_PROVIDER=google` never saw the "GOOGLE_API_KEY missing" warning. Fixed by canonical `google → GOOGLE_API_KEY`; legacy custom-model aliases stay for rollback safety.

- **`cron.ts` ai-query triple-notification cleanup.** A single failed ai-query cron job was sending three legacy error messages (`slow-fox: cancelled — cancelled`, `AI-Query Error (slow-fox)`, `Cron Error (slow-fox)`) because the failure path fired `notifyCallback` in the inner `if`, the inner `catch`, and the outer `catch`. The I3 delivery router already posts the cancellation banner for ai-query jobs, so all three legacy notify calls are now skipped and ai-query errors propagate via the outer catch for bookkeeping only. Other job types (reminder, shell, http, message) keep the legacy notify path.

- **`/subagents` now shows up in Telegram's command autocomplete.** The grammy handler was registered from v4.0.0 but `setMyCommands` never listed it, so users had to know the exact spelling. Added.

### 📚 Documentation

- New English-language handbook at `docs/HANDBOOK.md` — covers installation, architecture, all providers, the sub-agents system, cron jobs, platform adapters, security audit, and the web UI. Written to be readable standalone without cross-referencing the README.
- README.md updated with a pointer to the handbook and the new `launchd` command.

## [4.5.1] — 2026-04-09

### 🐛 TUI Header Rendering Hotfix

**The header was appearing inline in the middle of the conversation after scrolling** — a follow-up bug to the 4.5.0 TUI fix. Reported from a live 4.5.0 Test MacBook session where the header popped up right after a long bot response.

**Root cause**: `redrawHeader()` in 4.5.0 used `\x1b[H` (move to top-left) + `\x1b[s`/`\x1b[u` (save/restore cursor) to update the header in place when cost/model/target changed. But `\x1b[H` resolves to the **current viewport top**, not the document top — and once the terminal has scrolled past the original header, the "viewport top" is somewhere in the middle of the conversation. So the header got re-rendered inline in the middle of the bot's output.

**Fix**: removed all `redrawHeader()` calls from mid-session code paths:
- `ws.on("open")` (connect): no redraw, header was already drawn at startup
- `ws.on("close")` (disconnect): no redraw, just the error message
- `case "done"` (after each bot response): no redraw (this was the primary bug site — it fired after every message)
- `case "model"` (model switch): no redraw, just a success info line
- `case "target tui|telegram"` (target switch): no redraw, just an info line
- `process.stdout.on("resize")`: no redraw, just re-renders the prompt line

The only remaining `redrawHeader()` call is inside `/clear`, which calls `console.clear()` first to wipe the whole buffer — the only context where an in-place redraw is safe.

The trade-off: the header no longer reflects live cost/model/target updates mid-session. You'll see the up-to-date values after the next `/clear` or on the next TUI start. In exchange, the conversation flow stays clean. A future release could add a proper status-line region using terminal scrolling regions if this becomes annoying.

## [4.5.0] — 2026-04-09

### 🐛 TUI Bug Fixes (critical — the old TUI was effectively unusable)

**Double-character echo fixed** — Every keystroke in `alvin-bot tui` appeared twice (typing `hello` showed as `hheelllloo`). Root cause: `src/tui/index.ts` called `process.stdin.setRawMode(false)` alongside `readline.createInterface({ terminal: true })`. readline with `terminal: true` already controls the tty mode for its own line editor; forcing cooked mode on top of that makes both the terminal AND readline echo every keystroke. Removed the explicit `setRawMode(false)` call and let readline manage the tty state itself.

**Cursor chaos fixed** — The old `redrawHeader()` function wrote `\x1b7` / `\x1b8` (save/restore cursor) escape sequences that raced with readline's internal cursor tracking, producing garbled output mid-stream. The header redraw is now a no-op during active streaming and uses readline's own `cursorTo`/`clearLine` helpers otherwise — cooperating with readline instead of fighting it.

**Prompt state machine consolidated** — `showPrompt()` was called at ~7 different places, each re-rendering the prompt at potentially racy moments. It is now the single source of truth and no-ops during streaming. Every helper (`printUser`, `printAssistantStart`, `printInfo`, `printError`, `printSuccess`, `printTool`) calls `clearCurrentLine()` first, so the input line is always cleanly wiped before output is written above it.

**Terminal resize handling** — Added `process.stdout.on("resize", …)` so the header redraws correctly when the user resizes the window (when safe).

### ✨ New Feature: Parallel Observation + Session Routing

**The big one.** Before 4.5.0, the TUI/Web-UI shared the exact same session as the Telegram bot (both keyed to `config.allowedUsers[0]`). That meant `/new` in the TUI wiped the Telegram history, and the TUI had no visibility into live Telegram activity. This release cleanly separates the two and adds live mirroring in both directions.

#### New in-process broadcast bus — `src/services/broadcast.ts`

A tiny typed `EventEmitter` with four event types:
- `user_msg` — a user sent a message on a platform (Telegram, WhatsApp, etc.)
- `response_start` — the bot started generating a response
- `response_delta` — a streaming text chunk
- `response_done` — the response is complete

Fire-and-forget, zero backpressure, no history retention. The Telegram handler (`src/handlers/message.ts`) emits these events around its normal processing. The web server subscribes once at module load and fan-outs to every connected WebSocket client as `mirror:*` messages. Platform-agnostic signature so WhatsApp/Signal can plug in later without architectural changes.

#### TUI session isolation

The TUI now owns its own session key, completely separate from the Telegram user's session:

- **Default**: `alvin-bot tui` → fresh ephemeral session `tui:ephemeral:<timestamp>`. Every TUI start is a clean slate.
- **Persistent**: `alvin-bot tui --resume` → resumes `tui:local`, a long-lived session that survives TUI restarts.

Your Telegram conversation and your TUI conversation no longer overwrite each other's history. `/new` in the TUI only resets the TUI session.

#### `/target tui|telegram` — remote-control the Telegram session from TUI

New TUI command to switch where your typed messages go:

- **`/target tui`** (default) — Your messages go into the TUI's isolated session. Responses are rendered in the TUI only.
- **`/target telegram`** — Your messages enter the Telegram session (shared memory with whoever messages your bot on Telegram). The bot responds **both** in the TUI (via the open WebSocket) **and** in the actual Telegram chat (via the existing delivery queue). The active target is shown in the header as `→ Telegram` or `TUI session`.

Note: Telegram bot API does not allow bots to forge user messages, so your original prompt stays in the TUI — only the bot's response lands in Telegram. This is the closest possible equivalent to "remote typing into Telegram".

#### `/observe on|off` — mirror Telegram activity into the TUI

When observer mode is on (default), every Telegram user message and streaming bot response is mirrored into the TUI with distinct dim + `📱 Tel` styling. You can watch a live conversation happen from the TUI while running your own independent session in parallel. Toggle off with `/observe off` if the mirror noise gets in the way.

### 🧠 Architecture / Design Note

This feature deliberately does **not** go through the Claude Agent SDK or touch the `pathToClaudeCodeExecutable` flow. The broadcast bus is a pure observation layer in alvin-bot's own process, and session routing is just a different `sessionKey` lookup in the existing `getSession()` map. The bot's 1st-party auth behavior (CLI-backed session routing) is preserved exactly as before.

### 📦 Compatibility

This is a minor release (new feature), not a patch. No breaking changes to existing commands, existing behavior, or existing API endpoints. Old clients that don't send a `target` field continue to work exactly as before (falling back to the primary Telegram user's session).

```bash
npm update -g alvin-bot
alvin-bot tui               # fresh TUI session, observer on by default
alvin-bot tui --resume      # resume persistent tui:local session
```

Once inside TUI:
- `/target telegram` — route your messages into the Telegram session (responses land in both TUI and Telegram chat)
- `/target tui`      — switch back to isolated TUI session (default)
- `/observe off`     — stop mirroring Telegram activity
- `/observe on`      — resume mirroring

## [4.4.7] — 2026-04-09

### 🔐 Security / Dependencies

**6 of 9 npm audit vulnerabilities fixed (non-breaking)** — Ran `npm audit fix` to patch the transitive `@xmldom/xmldom` XML injection, `basic-ftp` CRLF command injection, and `brace-expansion` DoS vulnerabilities. Also upgraded the direct dependency `@anthropic-ai/claude-agent-sdk` from `0.2.92` to `0.2.97` (latest, non-breaking patch release with no changes to the `query()` API surface Alvin-Bot uses).

Remaining unaddressed (by design, require breaking upgrades or overrides):
- `@anthropic-ai/sdk` Memory Tool sandbox escape — **not exploitable** in Alvin-Bot because the `Memory` tool is not listed in `allowedTools` (we only use `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Task`).
- `electron` (17 advisories) — waiting for a planned breaking upgrade to `electron@41.x`.

### ✨ Stability Improvements

**Session memory hygiene (`src/services/session.ts`)** — The in-memory `sessions` Map grew unbounded: every user that ever messaged the bot kept a full session object (including conversation history, cost breakdown, abort controller) forever. On a single-user bot like the maintainer's this is a non-issue; on any multi-user deployment it's a steady leak.

New behavior:
- **Conservative 7-day TTL**: a session is only eligible for cleanup after 7 full days of complete inactivity. Configurable via `ALVIN_SESSION_TTL_DAYS` env var.
- **Never touches active sessions**: the cleanup loop explicitly skips any session with `isProcessing === true`.
- **`lastActivity` touched on every `getSession()` call**: any interaction at all keeps the session alive indefinitely.
- **Orphaned `abortController` cleanup** before removal (defensive).
- Runs hourly; logs a message when it actually purges something.

This is memory hygiene only — it cannot reduce Alvin-Bot's capabilities, permissions, or responsiveness. Active users see zero behavioral change.

**MAX_BUDGET_USD tracking (`src/services/session.ts:trackProviderUsage`)** — The `MAX_BUDGET_USD` config was declared but never read anywhere. Now it's tracked as a **soft warning** (never a block):
- When a session's cumulative cost crosses 80% of the configured budget, a `⚠️  Session budget 80% consumed` message is logged.
- When it crosses 100%, a `💸 Session budget exceeded … bot continues (no hard limit enforced)` message is logged.
- **The bot never blocks** — the warnings exist purely as operator signals. `/new` resets the warning flags so subsequent sessions get fresh thresholds.
- `session.totalCost` is now correctly incremented (previously declared in the interface but never written to).

### 📦 Compatibility

No breaking changes. User-facing behavior is identical — same commands, same permissions, same response patterns. The only visible change is new log messages for cleanup events and budget thresholds.

```bash
npm update -g alvin-bot
```

## [4.4.6] — 2026-04-09

### 🐛 Bug Fixes

**`alvin-bot audit` now reads `.env` from `DATA_DIR`** — Before this release, `audit` was a subprocess that never loaded the bot's config: it only inspected `process.env`, which for an ad-hoc CLI invocation is the shell environment, not the bot's actual runtime state. Result: `ALLOWED_USERS` and `WEB_PASSWORD` were always reported as "not set" even when the bot was correctly configured and running. `audit` now calls `dotenv.config({ path: ENV_FILE })` at the start of `runAudit()` so its output matches `alvin-bot doctor` and the actual engine.

**`alvin-bot doctor` no longer hangs indefinitely on missing `.env`** — The CLI's `readline` interface was created eagerly at module load, which made `stdin` readable for the entire process lifetime. Commands like `doctor`, `audit`, `version` that have no interactive prompts would therefore never terminate — even though the `doctor()` function correctly early-returned when `.env` was missing, `node` refused to exit because the event loop still saw stdin as a live resource. Readline is now lazy-created only when `ask()` is actually called. Measured improvement: **doctor with missing .env terminates in 82 ms** (previously: 20+ second hang, often requiring Ctrl+C).

**`validateProviderKey("claude-sdk", …)` no longer false-negatives on Agent SDK auth** — The CLI's Claude check ran `claude auth status` and hard-failed on `loggedIn: false`. But the Claude Agent SDK has multiple auth paths that the CLI doesn't see: `ANTHROPIC_API_KEY` env var, Claude Code IDE sessions, and native-binary session cookies. Real-world example: a bot that was actively answering Telegram messages correctly was reported as "❌ Claude CLI not authenticated" by `doctor`. The validation is now:
- `ANTHROPIC_API_KEY` set → `ok: true` (immediate pass, CLI irrelevant)
- `claude` binary present + `auth status: loggedIn: true` → `ok: true`
- `claude` binary present + `auth status: loggedIn: false` → `ok: true` with a **warning** (the Agent SDK may still work via session / env var; user is advised to run `claude auth login` only if the bot fails to respond)
- `claude` binary missing → `ok: false` (hard error with install hint)

`doctor` now renders the warning as ⚠️ instead of ❌, making the output match actual behavior.

### ✨ New Feature

**`alvin-bot setup --non-interactive` for CI, Docker, and scripted installs** — The interactive setup wizard was the only way to write `~/.alvin-bot/.env`, which blocked automated provisioning. Now supports flag-driven, non-interactive setup:

```bash
alvin-bot setup --non-interactive \
  --bot-token=123456789:AAE... \
  --allowed-users=12345,67890 \
  --primary-provider=claude-sdk \
  --fallback-providers=ollama \
  --groq-key=gsk_... \
  --google-key=AIza... \
  --openai-key=sk-... \
  --nvidia-key=nvapi-... \
  --anthropic-key=sk-ant-... \
  --openrouter-key=sk-or-... \
  --web-password=... \
  --platform=telegram \
  --skip-validation   # optional, skips the live Telegram getMe call
```

- Refuses to overwrite an existing `.env` (exits 1 with a clear message).
- Writes with mode `0600`.
- Validates `--bot-token` format and `--allowed-users` numeric format before writing.
- Optionally pings Telegram `getMe` unless `--skip-validation` is passed.

`-y` and `--yes` work as aliases for `--non-interactive`.

## [4.4.5] — 2026-04-09

### 🔐 Security / Information Disclosure

**`BACKLOG.md` removed from published tarball** — The project's internal roadmap was listed in `.gitignore` but not in `.npmignore`, so every `npm install -g alvin-bot` shipped an 8.7 KB file containing the full list of open P0/P1 issues, including known-but-unpatched security weaknesses (WebSocket auth gap, tool-executor sandbox gaps, Web UI HTTP-only, etc.). A published backlog of known vulnerabilities is effectively an attack roadmap for anyone inspecting the package.

`BACKLOG.md` is now listed in `.npmignore` alongside `CLAUDE.md`, `SOUL.md`, and `TOOLS.md`. Verified with `npm pack --dry-run`: the file no longer appears in the tarball.

Users on `4.4.4` or earlier should update:
```bash
npm update -g alvin-bot
```

## [4.4.4] — 2026-04-09

### 🔐 Security / Data Layout

**`.env` now lives only in `DATA_DIR`** — The `ENV_FILE` path constant in `src/paths.ts` has been moved from `BOT_ROOT/.env` to `DATA_DIR/.env` (e.g. `~/.alvin-bot/.env`). This fixes a latent drift bug affecting 6 code sites in `web/server.ts`, `web/setup-api.ts`, `web/doctor-api.ts`, and `services/fallback-order.ts`: before this release, the Web UI's Settings tab, the setup wizard, the doctor repair flow, and the `/fallback` sync were all writing to `BOT_ROOT/.env`, while the bot's config loader in `src/config.ts` reads from `DATA_DIR/.env` first. Changes made through any of those tools were silently written to a file the bot never reads (for globally-installed users, `BOT_ROOT` is inside `node_modules/alvin-bot/` and gets wiped on `npm update -g`).

Why this also matters for security: keeping `.env` inside the code repo is defense-in-depth weak. `.gitignore` can be edited, editors create swap files (`.env.swp`, `.env~`), `git add -f` bypasses ignores, backup tools sync whole project folders, and screensharing shows project directories. Secrets belong physically outside the repo.

**Automatic migration for legacy installs** — `src/migrate.ts` now copies a legacy `BOT_ROOT/.env` to `DATA_DIR/.env` on first run (only if the destination doesn't exist) and enforces `0600` mode regardless of the source permissions. `hasLegacyData()` now recognizes a stray `BOT_ROOT/.env` as a migration trigger. No action is required from existing users — the bot migrates itself.

### 📦 Compatibility

No breaking changes. Existing installs upgrade in place and are auto-migrated.

```bash
npm update -g alvin-bot
```

## [4.4.3] — 2026-04-09

### 🔐 Security
- **Sudo password storage** — Fixed a vulnerability where the sudo password was passed to `/usr/bin/security` as a command-line argument, making it briefly visible in `ps aux` output during keychain writes. Password is now piped via stdin using the documented `-w` prompt mode (must be the last option, and the password is supplied twice for the interactive prompt + confirmation). Byte-exact round-trip verified for arbitrary special characters.

### 🛠 Providers
- **Gemini auto-registration narrowed** — The Google Gemini chat provider is no longer registered automatically just because `GOOGLE_API_KEY` is set. It is now registered only when `google` is referenced as the primary provider or in the fallback chain. The environment variable is still used for other Google-powered features (e.g. `/imagine` image generation) without forcing Gemini onto the chat provider list.

### 🧰 Tooling
- `package-lock.json` now tracks `package.json` version correctly.

## [2.2.0] — 2026-02-24

### 🔐 Security
- **Group approval system** — New groups must be approved by admin before bot responds
- `/groups` — Manage all groups with approve/block inline buttons
- `/security` — Toggle forwarded messages, auto-approve settings
- Blocked groups completely ignored (zero response)
- `data/access.json` persists approvals (gitignored)

### 🤖 Multi-Model
- **Provider abstraction layer** with unified interface
- **Fallback chain**: Claude SDK → Kimi K2.5 → Llama 3.3 70B (all via NVIDIA NIM)
- `/model` — Switch models with inline keyboard buttons
- **Cost tracking per provider** in `/status`
- **Fallback notifications** — User sees ⚡ when provider switches

### 🧠 Memory
- **SOUL.md** — Customizable personality file, hot-reloadable via `/reload`
- **Memory service** — Auto-writes session summaries to daily logs on `/new`
- Non-SDK providers get memory context injected into system prompt
- `/memory` — View memory stats

### 🎨 Rich Interactions
- **Emoji reactions**: 🤔 thinking, 🎧 listening, 👀 looking, 👍 done, 👎 error
- **Inline keyboards** for `/model`, `/effort`, `/lang`
- **Document handling** — PDFs, Word, Excel, code files, CSV, JSON (30+ types)
- **Image generation** — `/imagine` via Gemini API
- **Reply threading** — Bot responses are replies to the original message
- **Reply context** — Quoted messages included as context
- **Forward handling** — Forwarded messages analyzed with sender context
- **Group chat** — Responds to @mentions and replies only

### 📦 Tools & Commands
- `/help` — Complete command overview
- `/web` — DuckDuckGo instant search
- `/remind` — Set, list, cancel reminders
- `/export` — Download conversation as markdown
- `/system` — System info (OS, CPU, RAM, Node)
- `/lang` — Switch DE/EN with inline buttons
- `/ping` — Health check with latency
- `/status` — Enhanced with provider stats, memory, uptime

### 🛠 Infrastructure
- **Dockerfile** + `docker-compose.yml` for containerized deployment
- **CLI**: `npx alvin-bot setup` (wizard), `doctor`, `update`, `version`
- **Markdown sanitizer** — Fixes unbalanced markers for Telegram
- **Graceful shutdown** with 5s grace period
- **Error resilience** — Uncaught exceptions logged, not crashed
- `alvin-bot.config.example.json` for all configurable options

## [2.0.0] — 2026-02-24

### Initial Release
- grammY + Claude Agent SDK integration
- Streaming responses with live message editing
- Voice (Groq Whisper STT + Edge TTS)
- Photo analysis (Claude vision)
- Session management (in-memory)
- PM2 ecosystem config
