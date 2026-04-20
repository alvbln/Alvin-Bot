# Alvin Bot Handbook

> A complete, standalone reference for everything Alvin Bot can do — installation, architecture, providers, sub-agents, cron jobs, plugins, MCP, platforms, security, and troubleshooting. Written for users who want to understand the whole system, not just the quick-start.

---

## Table of contents

1. [What Alvin Bot is](#1-what-alvin-bot-is)
2. [Installation](#2-installation)
3. [First run: the setup wizard](#3-first-run-the-setup-wizard)
4. [Architecture at a glance](#4-architecture-at-a-glance)
5. [AI providers](#5-ai-providers)
6. [The chat session model](#6-the-chat-session-model)
7. [Sub-agents](#7-sub-agents)
8. [Cron jobs](#8-cron-jobs)
9. [Commands reference](#9-commands-reference)
10. [Platforms: Telegram, WhatsApp, Discord, Signal, Web, TUI](#10-platforms)
11. [Plugins and MCP servers](#11-plugins-and-mcp-servers)
12. [Skills](#12-skills)
13. [Security](#13-security)
14. [Running in production](#14-running-in-production)
15. [Troubleshooting](#15-troubleshooting)
16. [Upgrading](#16-upgrading)

---

## 1. What Alvin Bot is

Alvin Bot is a self-hosted AI agent that lives where you chat. Instead of being a single-purpose chatbot, it connects a multi-model engine (Claude, OpenAI, Gemini, Groq, NVIDIA NIM, Ollama, OpenRouter, or any OpenAI-compatible endpoint) to every messaging platform you care about (Telegram, WhatsApp, Discord, Signal, Web UI, terminal), plus a set of superpowers: persistent memory, cron jobs, file access, skill files, MCP tool use, sub-agents for parallel work, and a comprehensive security audit.

The design goal is **"the assistant that actually lives on your machine"**: it has real tool access (not a sandboxed chat), it remembers across sessions, it runs scheduled tasks, and you talk to it through whatever app you already have open.

**Alvin Bot is the bot process.** Your identity — what it calls you, your preferences, long-running context — lives in `~/.alvin-bot/memory/` and is independent of the bot version.

---

## 2. Installation

### 2.1 Quickest path — npm

```bash
npm install -g alvin-bot
alvin-bot setup
alvin-bot start
```

Requirements:
- Node.js 18 or newer
- A Telegram bot token (free from [@BotFather](https://t.me/BotFather))
- Your Telegram user ID (from [@userinfobot](https://t.me/userinfobot))

Everything else — an AI provider key — the setup wizard walks you through.

### 2.2 From source

```bash
git clone https://github.com/alvbln/Alvin-Bot.git
cd Alvin-Bot
npm install
npm run build
node bin/cli.js setup
node bin/cli.js start
```

This is the path if you want to track `main` or apply local patches.

### 2.3 One-line install script

```bash
curl -fsSL https://raw.githubusercontent.com/alvbln/Alvin-Bot/main/install.sh | bash
```

Downloads, builds, and runs the setup wizard in one shot. Linux and macOS only.

### 2.4 Desktop app (macOS)

Download the latest `.dmg` from [GitHub Releases](https://github.com/alvbln/Alvin-Bot/releases). The desktop app wraps the bot in an Electron shell with a system tray icon, auto-updater, and the embedded web UI.

Current build: Apple Silicon (arm64). Windows and Linux desktop builds are on the roadmap.

### 2.5 Docker

```bash
docker compose up -d
```

Use this for headless servers. See `docker-compose.yml` for the expected environment variables.

### 2.6 The data directory

Alvin Bot stores all user data under `~/.alvin-bot/` (overridable via the `ALVIN_DATA_DIR` environment variable):

```
~/.alvin-bot/
├── .env                  # bot token, API keys, config
├── memory/               # long-term memory (vector-indexed)
├── sessions/             # session transcripts
├── cron-jobs.json        # scheduled jobs
├── sub-agents.json       # sub-agent config (maxParallel, visibility)
├── delivery-queue.json   # pending outgoing messages with retry
├── logs/                 # stdout/stderr if running under launchd
├── custom-models.json    # user-added OpenAI-compatible providers
├── users/                # multi-user approval + preferences
└── whatsapp-groups.json  # WhatsApp group allowlist
```

The bot code itself lives wherever you installed it (`/usr/local/lib/node_modules/alvin-bot` for npm-global, or your git clone directory). The data directory is portable: copy it between machines and the bot comes up with the same memories, jobs, and settings.

---

## 3. First run: the setup wizard

Running `alvin-bot setup` walks you through four screens:

1. **AI provider** — pick one of the supported providers. Free options first (Groq, Gemini, NVIDIA NIM, Ollama, Claude Max via the CLI). The wizard validates the API key with a test call before saving.
2. **Telegram bot token** — paste the token from BotFather. The wizard calls `getMe` to confirm it's valid and shows you the bot's handle.
3. **Authorized user ID** — paste your Telegram user ID. Only users listed in `ALLOWED_USERS` can chat with the bot; everyone else gets a silent deny.
4. **Optional platforms** — Slack, WhatsApp, Discord, Signal. Each is configured independently; skip any you don't use.

All values land in `~/.alvin-bot/.env` so you can edit them later.

---

## 4. Architecture at a glance

```
┌─────────────────────────────────────────────────────────────┐
│ Platform layer                                              │
│ Telegram · WhatsApp · Discord · Signal · Slack · TUI · Web  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                     platform-message
                           │
┌──────────────────────────▼──────────────────────────────────┐
│ Handler layer                                               │
│ handleMessage · handleVoice · handlePhoto · handleDocument  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                     Engine.query()
                           │
┌──────────────────────────▼──────────────────────────────────┐
│ Provider registry                                           │
│ Claude SDK · OpenAI-compat · Codex CLI · Ollama · custom... │
│ Heartbeat monitor · fallback chain · retry on transient     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│ Services                                                    │
│ Memory · Sub-agents · Cron · Skills · MCP · Plugins · Queue │
└─────────────────────────────────────────────────────────────┘
```

Everything is wired together in `src/index.ts`. The process boots by:

1. Creating `~/.alvin-bot/` and migrating any legacy data
2. Validating the `.env` against the chosen provider
3. Initializing the provider registry
4. Loading plugins and MCP servers
5. Creating the grammy bot instance and attaching the sub-agent delivery router
6. Starting the web server, cron scheduler, delivery queue, and heartbeat
7. Starting optional platform adapters
8. Beginning Telegram polling

A `shutdown()` function in the same file runs in reverse: cancel all running sub-agents (with Telegram notifications), stop the scheduler, drain the delivery queue, unload plugins, disconnect MCP, tear down provider lifecycles (Ollama, LM Studio), then exit cleanly.

---

## 5. AI providers

Alvin Bot supports a multi-provider registry with a fallback chain. You pick a primary, optionally define fallbacks, and the bot picks the best available provider per request.

### 5.1 Built-in providers

| Registry key | Source | Auth | Cost | Notes |
|---|---|---|---|---|
| `claude-sdk` | Anthropic Claude Code SDK | OAuth (Claude Max) or API key | Max plan or per-token | Full tool use: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Task. Needs the `claude` CLI installed. |
| `codex-cli` | OpenAI Codex CLI | Local CLI | Per-token | Needs the `codex` CLI installed. |
| `google` | Google Gemini 2.5 Flash | `GOOGLE_API_KEY` | Free tier available | Vision + embeddings. |
| `ollama` | Local Ollama daemon | none | Free | Auto-detected. Bot can start/stop the Ollama daemon on demand. |

### 5.2 Custom providers

Any OpenAI-compatible endpoint (Groq, NVIDIA NIM, OpenRouter, LM Studio, vLLM, any self-hosted LLM server) goes into `~/.alvin-bot/custom-models.json`:

```json
[
  {
    "key": "groq",
    "name": "Groq (Llama 3.3 70B)",
    "model": "llama-3.3-70b-versatile",
    "baseUrl": "https://api.groq.com/openai/v1",
    "apiKeyEnv": "GROQ_API_KEY",
    "supportsVision": false,
    "supportsStreaming": true,
    "maxTokens": 32768
  }
]
```

Set `PRIMARY_PROVIDER=groq` in `.env` and add `GROQ_API_KEY`. The setup wizard writes this for you for the common providers.

### 5.3 The fallback chain

`.env` can define a fallback order:

```
PRIMARY_PROVIDER=claude-sdk
FALLBACK_PROVIDERS=google,groq
```

On every query, the registry tries the primary first. If it's unavailable (auth fails, rate-limited, service down), it cascades through the fallback list in order. The registry also learns — a provider that fails twice in a row gets temporarily deprioritized until the heartbeat monitor confirms it's healthy again.

### 5.4 The heartbeat monitor

Every 5 minutes, the heartbeat monitor pings each configured provider with a tiny probe. Providers that fail twice in a row are marked unhealthy and get skipped until they recover. You see the current state in `/status` and in the web UI's Dashboard.

### 5.5 Model switching from chat

`/model` — pick a different provider as your current primary.
`/fallback` — rearrange the fallback chain from Telegram.
`/effort low|medium|high|max` — adjust reasoning depth (where supported).

Switches are session-scoped by default; persist via `/model save` or the web UI.

---

## 6. The chat session model

Alvin Bot separates **sessions** from **users**. Every platform identity maps to a session, and sessions carry:

- Current provider and fallback chain
- Conversation history (bounded — older messages age out)
- Active skills and personality flags
- Working directory (from `/dir`)
- Locale (`/language`)

Session isolation is configurable via the `SESSION_MODE` env var:

- `per-user` (default) — one shared session per authorized user across all their platform identities. `/new` on Telegram wipes the history for the TUI too.
- `per-channel` — each platform gets its own session. `/new` on Telegram leaves the TUI untouched.
- `per-channel-peer` — each platform × user combo gets its own session. Useful when you share a bot between family members.

Memory (the long-term knowledge base at `~/.alvin-bot/memory/`) is **always** per-user, regardless of session mode.

### 6.1 Long-running sessions

Alvin Bot's defining feature is that **he can think for as long as he needs**. There is no absolute timeout on a query — the only cap is an adaptive "stuck" detector that fires if there's no progress (no text, no tool calls) for `ALVIN_STUCK_TIMEOUT_MINUTES` (default: 10). A legitimate 40-minute reasoning run with continuous tool use never gets killed.

This is deliberate and different from most AI chat wrappers. It means Alvin can work overnight on a research task and deliver the answer when you wake up.

### 6.2 Mid-stream abort and resume

If a provider drops the connection mid-stream (network blip, provider restart), the registry silently retries the **same** provider once. If visible text was already streamed to the user, mid-stream failover is disabled — we don't fail over to a different provider mid-answer because that would jumble the response.

---

## 7. Sub-agents

**Sub-agents are parallel isolated workers that run in the background.** Use them when you have multiple independent tasks, when you need to keep a long-running task from blocking your main chat, or when you want to dispatch work from a cron job.

The system distinguishes three sources:

| Source | Origin | Delivery |
|---|---|---|
| `implicit` | Main Claude calls the SDK `Task` tool | Parent stream (no separate delivery) |
| `user` | You ask the bot to spawn a sub-agent | Banner + final to your chat |
| `cron` | Scheduled job uses `ai-query` | Banner + final to `chatId` in the cron job's target |

### 7.1 Spawning

From chat, the easiest way is to ask Main Claude to spawn one:

> *spawne einen sub-agent der mir in einem Wort 'pong' zurückgibt*

Claude invokes the SDK `Task` tool, which runs as `source: "implicit"`. The result streams back into the parent message.

From a cron job of type `ai-query`, the scheduler calls `spawnSubAgent({ source: "cron" })` internally. The cron job's `target.chatId` becomes the `parentChatId` so the delivery lands in the right chat.

### 7.2 The `/subagents` command

| Command | Effect |
|---|---|
| `/subagents` | Show status: max parallel, visibility mode, running list |
| `/subagents max <n>` | Set max parallel (0 = auto = min(cpu, 16)) |
| `/subagents visibility auto\|banner\|silent` | Default delivery mode for new spawns |
| `/subagents list` | Tree view with depth indent and source badges |
| `/subagents cancel <name\|id>` | Cancel a running sub-agent |
| `/subagents result <name\|id>` | Show a completed sub-agent's stored result |

### 7.3 Name-first addressing

Sub-agents are addressable by name, not just UUID. If you spawn three agents called `code-review` in quick succession, they appear as `code-review`, `code-review#2`, `code-review#3` in `/subagents list`. The name-resolver handles collisions automatically.

`/subagents cancel code-review#2` cancels the second one specifically. `/subagents cancel code-review` on an unambiguous base name cancels that one. On an ambiguous base name, the bot replies with a disambiguation list.

### 7.4 Depth cap (F2)

Nested spawning is allowed up to depth 2:

- depth 0 = root (spawned by main thread)
- depth 1 = spawned by a depth-0 agent
- depth 2 = spawned by a depth-1 agent
- depth 3 = rejected

This allows the "scatter-gather" pattern (main → orchestrator → 10 workers) without runaway recursion.

### 7.5 Visibility modes

- `auto` (default) — source-based routing: implicit stays in the parent stream, user and cron get a banner+final delivery.
- `banner` — always send a banner+final, even for implicit spawns.
- `silent` — never send. The result is still stored in the activeAgents map for 30 minutes and pullable via `/subagents result <name>`.
- **`live`** — stream incremental updates into a single Telegram message as the agent thinks. Only applies to `source: "user"` spawns with a `parentChatId`. The live message is plain text (so half-formed markdown during streaming can't break the edit), updates are throttled to 800 ms between edits, and a separate banner message is posted at the end so you get a completion notification. If the bot API doesn't support `editMessageText` or the live setup fails, we fall through to `banner` mode automatically.

### 7.6 Inheritance

Sub-agents inherit from the spawning context:

- **Working directory** — the parent's `cwd` (from `/dir`). Opt out with `inheritCwd: false`.
- **CLAUDE.md** — via the Claude SDK's `settingSources: ["project"]`. Loads automatically if the cwd is inside a project with a CLAUDE.md.
- **Model and tools** — inherited via the provider registry.
- **Conversation history** — **not inherited.** Sub-agents receive only their own prompt. This forces clean, self-describing spawn requests.

### 7.7 Bounded priority queue

When the running pool hits `maxParallel`, new spawn requests land in a bounded queue instead of being rejected immediately.

- **Default cap:** 20 slots. Configure via `/subagents queue <n>` (clamped to 0–200).
- **Disable:** `/subagents queue 0` — restores the old reject-on-full behavior.
- **Priority order on drain:** `user > cron > implicit`. Within each priority class, FIFO.
- **`/subagents list`** shows queued entries with a `#N` suffix indicating their position.
- **Cancel a queued entry** with `/subagents cancel <name>` — it's removed from the queue without ever starting.

Reject is only triggered when the pool **and** the queue are both full. The reject message is priority-aware and names who's holding the slots.

### 7.8 Stats

`/subagents stats` shows a summary of the last 24 hours of sub-agent runs:

- Total runs + total tokens + total wall time
- Runs per source (user / cron / implicit)
- Runs per status (completed / cancelled / timeout / error)

The backing data is an append-only JSON ring buffer at `~/.alvin-bot/subagent-stats.json`. Entries older than 24 hours are pruned automatically. A hard cap of 5000 entries protects against runaway growth on very busy bots.

### 7.9 Shutdown notifications

When you restart the bot (SIGTERM), any still-running sub-agents get a cancellation delivery before the process exits:

> ⚠️ `<name>` cancelled · `<duration>` · 0 in / 0 out
> ⚠️ Agent wurde durch Bot-Restart unterbrochen. Bitte neu triggern.

The shutdown phase is capped at 5 seconds total so a hanging Telegram send can't block the restart.

---

## 8. Cron jobs

Scheduled tasks that run regardless of whether you're chatting with the bot. Use them for daily news digests, weekly reports, periodic health checks, or any recurring automation.

### 8.1 Job types

| Type | Payload | Execution |
|---|---|---|
| `reminder` | `text` | Sends the text to the target chat at the scheduled time |
| `message` | `text` | Same as reminder |
| `shell` | `command` | Runs the shell command, sends the output |
| `http` | `url`, `method`, `headers`, `body` | Fires an HTTP request, sends the response |
| `ai-query` | `prompt` | Spawns a sub-agent with `source: "cron"`, result delivered via I3 |

### 8.2 Scheduling syntax

Supports two formats:

- **Interval** — `30s`, `5m`, `1h`, `6h`, `1d`
- **Cron** — standard 5-field (`MIN HOUR DAY MONTH WEEKDAY`, 0 = Sunday)

### 8.3 Managing jobs

From Telegram:

```
/cron              — list all jobs
/cron add          — create a new one (interactive)
/cron delete <id>  — remove a job
/cron toggle <id>  — enable/disable
/cron run <id>     — trigger a job immediately, outside its schedule
```

From the command line (useful for scripts):

```
node scripts/cron-manage.js add \
  --name "Daily email summary" \
  --type ai-query \
  --schedule "0 8 * * *" \
  --prompt "Check my inbox and summarize unread messages" \
  --chatId <your-telegram-id>

node scripts/cron-manage.js list
node scripts/cron-manage.js delete --id <job-id>
```

The scheduler polls `~/.alvin-bot/cron-jobs.json` every 30 seconds, so hand-edited jobs come into effect at the next tick without a bot restart.

### 8.4 Delivery

ai-query jobs route through the sub-agent delivery router (see §7). Other job types (reminder, shell, http, message) use the legacy delivery-queue path with retry and exponential backoff. Both paths respect the job's `target.platform` and `target.chatId`.

---

## 9. Commands reference

All commands are triggered from any platform that supports commands (Telegram, Discord).

### 9.1 Core

| Command | Purpose |
|---|---|
| `/start` | Show the bot intro |
| `/help` | List all commands |
| `/new` | Start a fresh session (wipes current history) |
| `/status` | Current status: provider, model, session age, token usage |
| `/cancel` | Cancel the currently running request |
| `/dir <path>` | Change the bot's working directory |

### 9.2 AI control

| Command | Purpose |
|---|---|
| `/model` | Switch provider |
| `/model save` | Persist the current provider as default |
| `/fallback` | Rearrange fallback chain |
| `/effort low\|medium\|high\|max` | Set reasoning depth |
| `/voice on\|off` | Toggle voice replies (ElevenLabs or Edge TTS) |
| `/language en\|de\|es\|fr` | Switch session locale |

### 9.3 Memory and history

| Command | Purpose |
|---|---|
| `/remember <text>` | Add something to long-term memory |
| `/recall <query>` | Semantic search across memories |
| `/export` | Export the current conversation to JSON |

### 9.4 Tools

| Command | Purpose |
|---|---|
| `/web <query>` | Quick web search |
| `/imagine <prompt>` | Generate an image (Gemini Nano Banana / Google Imagen) |
| `/remind 30m <text>` | One-shot reminder |

### 9.5 Bot management

| Command | Purpose |
|---|---|
| `/cron` | Manage scheduled jobs |
| `/subagents` | Show sub-agent status |
| `/subagents max <n>` | Set max parallel (0 = auto) |
| `/subagents queue <n>` | Set bounded-queue cap (0 = disabled) |
| `/subagents visibility <auto\|banner\|silent\|live>` | Delivery mode |
| `/subagents list` | List all (queued + running + recent) |
| `/subagents cancel <name\|id>` | Cancel one |
| `/subagents result <name\|id>` | Show a completed result |
| `/subagents stats` | Last 24h run stats (by source + status) |
| `/webui` | Open web UI URL |
| `/setup` | Re-run the setup wizard flow from chat |
| `/restart` | Restart the bot process |
| `/update` | Pull latest, rebuild, restart |
| `/autoupdate on\|off\|status` | Configure auto-update |

### 9.6 CLI commands (from a terminal)

| Command | Purpose |
|---|---|
| `alvin-bot setup` | Initial setup wizard |
| `alvin-bot start` | Start in background (pm2) |
| `alvin-bot start -f` | Start in foreground (for debugging) |
| `alvin-bot stop` | Stop the bot |
| `alvin-bot tui` | Terminal chat UI |
| `alvin-bot doctor` | Health check and diagnostics |
| `alvin-bot audit` | Security audit |
| `alvin-bot search <query>` | Search assets, memories, and skills |
| `alvin-bot update` | Git pull, npm install, rebuild |
| `alvin-bot launchd install` | **macOS only** — install as LaunchAgent (see §14.1) |
| `alvin-bot launchd uninstall` | Remove the LaunchAgent |
| `alvin-bot launchd status` | Show LaunchAgent state + recent logs |
| `alvin-bot version` | Print version |

---

## 10. Platforms

### 10.1 Telegram

The primary platform. Full support: streaming messages, inline keyboards, voice transcription (via OpenAI Whisper or Edge TTS), photo understanding, document ingestion, sticker replies, command autocomplete.

Setup: `BOT_TOKEN` from BotFather + your user ID in `ALLOWED_USERS`.

### 10.2 WhatsApp

Via WhatsApp Web using `whatsapp-web.js`. Two modes:

- **Self-chat** — treat your own WhatsApp number as a personal assistant notepad
- **Group whitelist** — the bot only responds in explicitly allowed groups, with per-contact access control inside those groups

Group messages go through an approval flow: the owner gets a Telegram notification (or WhatsApp DM fallback) before the bot responds, so there's no surprise chatter from the bot in a group.

Setup: scan the QR code printed on bot startup. Session cookies persist in `~/.alvin-bot/.wwebjs_auth/`.

### 10.3 Discord

Bot with mention detection, slash commands, voice channel support. Uses the standard Discord bot token flow.

Setup: `DISCORD_TOKEN` in `.env`, invite the bot to your server with the correct intents (Message Content + Guild Messages).

### 10.4 Signal

Via `signal-cli` REST API. Less feature-rich than the others because of Signal's tight UI model, but text, images, and voice messages work.

### 10.5 Web UI

A full dashboard at `http://localhost:3100` (configurable via `WEB_PORT`). Password-protected via `WEB_PASSWORD`. Features:

- Live chat with streaming
- Dashboard: provider status, heartbeat, resource usage
- Memory manager: browse and edit long-term memories
- File browser: navigate and edit files the bot has access to
- Cron job editor
- Settings and env editor
- Plugin and MCP server manager
- Web terminal (in-browser shell)
- Security audit report

### 10.6 TUI

`alvin-bot tui` starts a terminal chat with ANSI colors and streaming. Useful on remote servers without a browser.

### 10.7 Slack

Uses `@slack/bolt`. Supports DMs and channel mentions.

---

## 11. Plugins and MCP servers

### 11.1 Plugins

JavaScript modules under `plugins/` that register new Telegram commands and extend the bot's capabilities. Each plugin exports:

- `name`
- `version`
- `commands` (array of `{ name, description, handler }`)
- `init(ctx)` — called at startup, gets access to the bot instance
- `unload()` — called at shutdown

Built-in plugins:

| Plugin | Purpose |
|---|---|
| `calendar` | Google Calendar integration |
| `email` | Gmail / IMAP ingest |
| `finance` | Bank account queries |
| `notes` | Apple Notes / Obsidian sync |
| `smarthome` | Home Assistant control |
| `weather` | Weather forecasts |

User plugins go in `~/.alvin-bot/plugins/` and hot-reload on save.

### 11.2 MCP servers

Model Context Protocol servers extend the bot with new tools. Configure them in `~/.mcp.json` or `~/.alvin-bot/mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

The bot auto-discovers MCP tools at startup and makes them available to the AI provider (Claude SDK supports them natively; other providers get the tools as descriptions in the system prompt).

---

## 12. Skills

Skills are Markdown files under `skills/` that teach the AI how to do specific tasks. Each skill is a `SKILL.md` file with:

- Title and description
- When to use it (triggers)
- Step-by-step procedure
- Code templates and examples

Skills auto-activate based on message context. Built-in skills include:

- **apple-notes** — create and search Apple Notes
- **browser-automation** — control Chrome via Playwright
- **code-project** — scaffold, refactor, and test code projects
- **data-analysis** — pandas/jupyter-style data exploration
- **document-creation** — generate PDFs and Word docs
- **email-summary** — triage and summarize email
- **github** — issues, PRs, releases
- **summarize** — generic summarization with citations
- **system-administration** — shell tasks on Linux/macOS
- **weather** — forecast queries
- **web-research** — structured web research with sources

User skills go in `~/.alvin-bot/skills/` and are hot-reloaded.

---

## 13. Security

Security is taken seriously because this bot has real system access.

### 13.1 Authentication

Only users listed in `ALLOWED_USERS` can chat with the Telegram bot. The `authMiddleware` silently drops everyone else.

For WhatsApp groups, each group must be explicitly whitelisted and the owner approves each message before the bot responds.

For the web UI, access is gated by `WEB_PASSWORD`.

### 13.2 Execution sandboxing

The `EXEC_SECURITY` env var controls how shell commands are gated:

- `full` — no restrictions (use only on trusted machines)
- `allowlist` (default) — only whitelisted binaries from `~/.alvin-bot/exec-allowlist.txt` can run
- `deny` — shell execution completely disabled

### 13.3 Security audit

`alvin-bot audit` runs a series of health checks:

- Are secrets in `.env` readable only by you?
- Is the data directory mode `0700`?
- Are there any API keys leaked into version-controlled files?
- Is the bot exposed on a public port?
- Are the allowed users list and exec allowlist intact?

Each check reports `PASS` / `WARN` / `FAIL` with a fix suggestion.

### 13.4 Checkpoints during long runs

Alvin's Claude SDK provider injects a `[CHECKPOINT]` reminder into the prompt every 5 turns once certain thresholds are crossed (10+ messages or 15+ tool calls in a session). The reminder tells Claude to write a checkpoint to its memory file before processing the next request. This protects against context compaction losing progress on long multi-hour sessions.

### 13.5 Git safety

The bot's own code is protected against accidental destruction:

- Never changes user passwords in projects
- Never touches auth functions without explicit instruction
- Never runs `git push --force` on main/master
- Never bypasses pre-commit hooks (`--no-verify`)
- Never amends commits that might be lost

---

## 14. Running in production

### 14.1 macOS: `launchd` (recommended)

On macOS with the Claude Code SDK, you **must** run the bot as a `launchd` user agent, not via pm2. Claude Code stores the OAuth token for the Max subscription in the macOS Keychain under the service `"Claude Code-credentials"`, and only processes running inside the user's GUI login session can access that Keychain without a manual unlock.

Pm2 starts its daemon in a detached launchd context without Keychain access. Result: the bot sees `Not logged in` on every Claude SDK call. Launchd user agents, on the other hand, run inside the GUI session and inherit the unlocked Keychain automatically.

```bash
alvin-bot launchd install
```

This writes `~/Library/LaunchAgents/com.alvinbot.app.plist` with:

- `RunAtLoad true` — starts on login
- `KeepAlive Crashed=true` — auto-restart on crash
- `ThrottleInterval 10` — prevents restart loops
- `PATH` covering Apple Silicon and Intel Homebrew plus `~/.local/bin`
- stdout → `~/.alvin-bot/logs/alvin-bot.out.log`
- stderr → `~/.alvin-bot/logs/alvin-bot.err.log`

Management:

```bash
alvin-bot launchd status       # plist state, PID, last log lines
alvin-bot launchd uninstall    # unload and remove the plist

# Restart:
launchctl kickstart -k gui/$UID/com.alvinbot.app
```

If you'd previously set up the bot via pm2, uninstall the pm2 process first (`pm2 delete alvin-bot; pm2 kill`) before running `launchd install`.

### 14.2 Linux / Windows: pm2

The `alvin-bot start` command wraps pm2:

```bash
alvin-bot start       # start in background, auto-restart on crash
alvin-bot start -f    # start in foreground (for debugging)
alvin-bot stop        # stop the bot
pm2 logs alvin-bot    # live logs
```

For systemd users, you can write a user unit pointing at `node dist/index.js` — see the example in `docs/systemd.md` (if included in your release).

### 14.3 Auto-update

`/autoupdate on` tells the bot to check for updates daily. When an update is found, it runs `git pull`, `npm install`, `npm run build`, and restarts itself. The auto-update flag lives at `~/.alvin-bot/auto-update.flag`.

### 14.4 Environment variables reference

Common env vars (all optional unless marked):

| Variable | Default | Purpose |
|---|---|---|
| `BOT_TOKEN` | — | **Required**. Telegram bot token. |
| `ALLOWED_USERS` | — | **Required**. Comma-separated Telegram user IDs. |
| `PRIMARY_PROVIDER` | `claude-sdk` | Registry key of the default provider. |
| `FALLBACK_PROVIDERS` | — | Comma-separated fallback chain. |
| `GOOGLE_API_KEY` | — | Required if using `google` as provider. |
| `GROQ_API_KEY` | — | For custom Groq provider. |
| `OPENAI_API_KEY` | — | For custom OpenAI provider. |
| `OPENROUTER_API_KEY` | — | For custom OpenRouter provider. |
| `NVIDIA_API_KEY` | — | For custom NVIDIA NIM provider. |
| `ELEVENLABS_API_KEY` | — | Voice synthesis (falls back to Edge TTS). |
| `WEB_PORT` | `3100` | Web UI port. |
| `WEB_PASSWORD` | — | Web UI access password. |
| `SESSION_MODE` | `per-user` | Session isolation mode. |
| `ALVIN_STUCK_TIMEOUT_MINUTES` | `10` | Adaptive stuck-detector window. |
| `MAX_SUBAGENTS` | `0` (auto) | Max parallel sub-agents. |
| `SUBAGENT_TIMEOUT` | `300000` | Per-agent timeout in ms. |
| `COMPACTION_THRESHOLD` | `80000` | Tokens before context compaction triggers. |
| `EXEC_SECURITY` | `allowlist` | Shell execution sandbox mode. |
| `ALVIN_DATA_DIR` | `~/.alvin-bot` | Data directory path. |

---

## 15. Troubleshooting

### 15.1 Bot starts but doesn't respond

1. `alvin-bot doctor` — runs 10+ health checks
2. Check the log: `pm2 logs alvin-bot` (or `~/.alvin-bot/logs/alvin-bot.err.log` under launchd)
3. Verify your provider: `/status` in chat shows the active provider and its health

### 15.2 Claude SDK says "Not logged in"

You're hitting the Keychain problem documented in §14.1. Three paths:

- **Preferred**: switch to `alvin-bot launchd install` on macOS
- **Temporary**: `security unlock-keychain -p '<your-login-password>' ~/Library/Keychains/login.keychain-db`, then restart the bot in the same terminal session
- **Fallback**: run interactively: `claude` (opens the interactive CLI), then `/login`, then re-run the bot

### 15.3 Sub-agent limit reached

Either increase the cap:

```
/subagents max 8
```

Or cancel a stuck agent:

```
/subagents list
/subagents cancel <name>
```

### 15.4 Cron job not firing

- Is it `enabled: true`? `/cron` or `cat ~/.alvin-bot/cron-jobs.json`
- Is the schedule valid? Try `/cron run <id>` to trigger manually
- Check the bot log for `[cron]` lines

### 15.5 Web UI shows "Not authorized"

`WEB_PASSWORD` isn't set or doesn't match. Add `WEB_PASSWORD=<pick-a-password>` to `.env` and restart.

### 15.6 Sub-agent results shown twice

Happens if you upgrade from a version before 4.6.0 and a mid-stream shutdown race fired. Fixed in 4.6.0 — see CHANGELOG §9.2.

### 15.7 Upgrading from 4.5.x

- Run `npm install -g alvin-bot@latest`
- Run `alvin-bot update` from chat (pulls, rebuilds, restarts)
- On macOS, consider switching from pm2 to `alvin-bot launchd install` for the Keychain fix

---

## 16. Upgrading

### 16.1 Data directory compatibility

Alvin Bot follows semver for the **data directory format**. Minor version bumps never break `~/.alvin-bot/`; major bumps might introduce migration scripts that run automatically on first startup.

### 16.2 From 4.5.x to 4.6.0

- Sub-agents: new fields in `sub-agents.json` (`visibility`). Old files auto-upgrade — the loader treats missing fields as defaults.
- Cron jobs: no schema change.
- Memory: no schema change.
- `.env`: no new required variables. `MAX_SUBAGENTS` and `SUBAGENT_TIMEOUT` are optional.

### 16.3 From 4.6.x to 4.7.0

- Sub-agents: new fields in `sub-agents.json` (`queueCap`, defaults to 20). Old files auto-upgrade.
- New file `~/.alvin-bot/subagent-stats.json` — auto-created when the first sub-agent finishes.
- `start`/`stop` now auto-detect the LaunchAgent on macOS. No migration needed; if you previously installed the LaunchAgent in 4.6.0, `alvin-bot start` now correctly reloads it instead of spawning a parallel pm2 process.
- No new required `.env` variables.

### 16.3 From git

```bash
cd ~/path/to/alvin-bot
git pull
npm install
npm run build

# If running under launchd:
launchctl kickstart -k gui/$UID/com.alvinbot.app

# If running under pm2:
alvin-bot start

# If running in foreground:
# Stop with Ctrl+C, then alvin-bot start -f
```

### 16.4 From npm

```bash
npm install -g alvin-bot@latest
alvin-bot stop
alvin-bot start
```

### 16.5 Rollback

```bash
npm install -g alvin-bot@4.5.1
```

Old data in `~/.alvin-bot/` continues to work — nothing is deleted on upgrade.

---

## Feedback and bug reports

- GitHub Issues: <https://github.com/alvbln/Alvin-Bot/issues>
- Pull requests welcome
- Maintained by @alvbln
