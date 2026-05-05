# 🤖 Alvin Bot — Autonomous AI Agent

> Your personal AI assistant — on Telegram, WhatsApp, Discord, Signal, Terminal, and Web.

Alvin Bot is an open-source, self-hosted AI agent that lives where you chat. Built on a multi-model engine with full system access, memory, plugins, and a rich web dashboard. Not just a chatbot — an autonomous agent that remembers, acts, and learns.


---

## 📸 Preview

<table>
<tr>
<td align="center"><b>💬 Chat (Dark Mode)</b><br><img src="docs/screenshots/01-Chat-Dark-Conversation.png" width="400"></td>
<td align="center"><b>📊 Dashboard</b><br><img src="docs/screenshots/03-Dashboard-Overview.png" width="400"></td>
</tr>
<tr>
<td align="center"><b>🤖 AI Models & Providers</b><br><img src="docs/screenshots/04-AI-Models-and-Providers.png" width="400"></td>
<td align="center"><b>🎭 Personality Editor</b><br><img src="docs/screenshots/05-Personality-Editor.png" width="400"></td>
</tr>
<tr>
<td align="center"><b>💬 Telegram</b><br><img src="docs/screenshots/TG.png" width="400"></td>
<td align="center"><b>📱 Messaging Platforms</b><br><img src="docs/screenshots/12-Messaging-Platforms.png" width="400"></td>
</tr>
<tr>
<td align="center"><b>🔧 Custom Tools</b><br><img src="docs/screenshots/10-Custom-Tools.png" width="400"></td>
<td align="center"><b>🩺 Health & Maintenance</b><br><img src="docs/screenshots/15-Maintenance-and-Health.png" width="400"></td>
</tr>
</table>

<details>
<summary><b>🖼️ More Screenshots</b> (click to expand)</summary>
<br>

| Feature | Screenshot |
|---------|-----------|
| Login | <img src="docs/screenshots/00-Login.png" width="500"> |
| Chat (Light) | <img src="docs/screenshots/02-Chat.png" width="500"> |
| Memory Manager | <img src="docs/screenshots/06-Memory-Manager.png" width="500"> |
| Active Sessions | <img src="docs/screenshots/07-Active-Sessions.png" width="500"> |
| File Browser | <img src="docs/screenshots/08-File-Browser.png" width="500"> |
| Scheduled Jobs | <img src="docs/screenshots/09-Scheduled-Jobs.png" width="500"> |
| Plugins & MCP | <img src="docs/screenshots/11-Plugins-and-MCP.png" width="500"> |
| WhatsApp Groups | <img src="docs/screenshots/12.1-Messaging-Platforms-WhatsApp-Groups-List.png" width="500"> |
| WA Group Details | <img src="docs/screenshots/12.2-Messaging-Platforms-WA-Group-Details.png" width="500"> |
| User Management | <img src="docs/screenshots/13-User-Management.png" width="500"> |
| Web Terminal | <img src="docs/screenshots/14-Web-Terminal.png" width="500"> |
| Settings & Env | <img src="docs/screenshots/16-Settings-and-Env.png" width="500"> |
| Telegram Commands | <img src="docs/screenshots/TG-commands.png" width="500"> |
| macOS Installer | <img src="docs/screenshots/_Mac-Installer.png" width="500"> |

</details>

---


## ✨ Features

### 🧠 Intelligence
- **Multi-Model Engine** — Claude (Agent SDK with full tool use), OpenAI, Groq, NVIDIA NIM, Google Gemini, OpenRouter, or any OpenAI-compatible API
- **Automatic Fallback** — If one provider fails, seamlessly tries the next
- **Heartbeat Monitor** — Pings providers every 5 minutes, auto-failover after 2 failures, auto-recovery
- **User-Configurable Fallback Order** — Rearrange provider priority via Telegram (`/fallback`), Web UI, or API
- **Adjustable Thinking** — From quick answers (`/effort low`) to deep analysis (`/effort max`)
- **Persistent Memory** — Remembers across sessions via vector-indexed knowledge base; session state (Claude SDK resume tokens, conversation history, language, effort) survives bot restarts (v4.11.0)
- **Multi-Session Workspaces** — Run multiple parallel, context-isolated sessions on the same bot — one per Slack channel or per Telegram `/workspace` — each with its own working directory, purpose, and persona. Memory, skills, and sub-agents stay globally shared (v4.12.0). [How-to ↓](#-multi-session-workspaces-v4120)
- **Truly Detached Sub-Agents** — Claude dispatches long-running research/audit tasks via the `alvin_dispatch_agent` MCP tool, which spawns independent `claude -p` subprocesses with their own PID + process group. Main session stays fully responsive, user can interrupt freely without killing sub-agents. Results deliver as separate messages. Works identically on Telegram, Slack, Discord, and WhatsApp (v4.13.0+ dispatch, v4.14.0 multi-platform)
- **Smart Tool Discovery** — Scans your system at startup, knows exactly what CLI tools, plugins, and APIs are available
- **Skill System** — 12 built-in SKILL.md files (code, data analysis, email, docs, research, sysadmin, browse, etc.) auto-activate based on message context
- **Self-Awareness** — Knows it IS the AI model — won't call external APIs for tasks it can do itself
- **Automatic Language Detection** — Detects user language (EN/DE/ES/FR) and adapts; learns preference over time

### 💬 Multi-Platform
- **Telegram** — Full-featured with streaming, inline keyboards, voice, photos, documents
- **Slack** — Socket Mode bot via `@slack/bolt`, DMs + @mentions, file attachments, reactions, `assistant.threads.setStatus` typing indicator. **One channel = one isolated workspace.** See [Multi-Session Workspaces](#-multi-session-workspaces-v4120) below.
- **WhatsApp** — Via WhatsApp Web: self-chat as AI notepad, group whitelist with per-contact access control, full media support (photos, docs, audio, video)
- **WhatsApp Group Approval** — Owner gets approval requests via Telegram (or WhatsApp DM fallback) before the bot responds to group messages. Silent — group members see nothing.
- **Discord** — Server bot with mention/reply detection, slash commands
- **Signal** — Via signal-cli REST API with voice transcription
- **Terminal** — Rich TUI with ANSI colors and streaming (`alvin-bot tui`)
- **Web UI** — Full dashboard with chat, settings, file manager, terminal, workspace overview

### 🔧 Capabilities
- **52+ Built-in Tools** — Shell, files, email, screenshots, PDF, media, git, system control
- **Plugin System** — 6 built-in plugins (weather, finance, notes, calendar, email, smarthome)
- **MCP Client** — Connect any Model Context Protocol server
- **Cron Jobs** — Scheduled tasks with AI-driven creation ("check my email every morning")
- **Voice** — Speech-to-text (Groq Whisper) + text-to-speech (Edge TTS)
- **Vision** — Photo analysis, document scanning, screenshot understanding
- **Image Generation** — Via Google Gemini / DALL·E (with API key)
- **Web Browsing** — Fetch and summarize web pages

### 🖥️ Web Dashboard
- **Live Chat** — WebSocket streaming, same experience as Telegram
- **Model Switcher** — Change AI models on the fly
- **Platform Setup** — Configure all messengers and providers via UI, WhatsApp group management inline
- **File Manager** — Browse, edit, create files in the working directory
- **Memory Editor** — View and edit the agent's knowledge base
- **Session Browser** — Inspect conversation history
- **Terminal** — Run commands directly from the browser
- **Maintenance** — Health checks, backups, bot controls

---

## 🚀 Quick Start

```bash
npm install -g alvin-bot
alvin-bot setup
alvin-bot start
```

That's it. The setup wizard validates everything:
- ✅ Tests your AI provider key
- ✅ Verifies your Telegram bot token
- ✅ Confirms the setup works before you start

**Requires:** Node.js 18+ ([nodejs.org](https://nodejs.org)) · Telegram bot token ([@BotFather](https://t.me/BotFather)) · Your Telegram user ID ([@userinfobot](https://t.me/userinfobot))

Free AI providers available — no credit card needed. **Privacy-first?** Pick the 🔒 **Offline — Gemma 4 E4B** option in setup for a fully local LLM via Ollama (macOS/Linux: automated install; Windows: manual).

### 📘 First-time setup walkthroughs

Step-by-step guides with screenshots and screen-for-screen instructions:

| Platform | PDF (printable) |
|---|---|
| 🍎 **macOS** (with `launchd` background service) | [Download PDF](https://github.com/alvbln/Alvin-Bot/releases/latest/download/Alvin-Bot-macOS-Setup-Guide.pdf) |
| 🪟 **Windows** (with Task Scheduler / Startup folder) | [Download PDF](https://github.com/alvbln/Alvin-Bot/releases/latest/download/Alvin-Bot-Windows-Setup-Guide.pdf) |

Both guides cover: Node.js install · Telegram bot creation · first-time `setup` · foreground test · background service · offline Gemma 4 mode · troubleshooting. ~15 min end-to-end for a first-time user.

### macOS: use `launchd` instead of pm2 (recommended)

If you're on macOS and using Claude Code (Max subscription) as your provider, run the bot as a **LaunchAgent** — it inherits the GUI login session so the macOS Keychain stays unlocked and the Claude OAuth token just works without any manual `security unlock-keychain` dance:

```bash
alvin-bot launchd install    # writes ~/Library/LaunchAgents/com.alvinbot.app.plist and starts the agent
alvin-bot launchd status     # show PID + recent stdout/stderr logs
alvin-bot launchd uninstall  # unload + remove the plist
```

Pm2 still works and remains the default on Linux/Windows — but on macOS with Claude Code, `launchd` is the only path that reliably keeps Keychain access over restarts.

### 📖 Handbook

For a full walkthrough of everything Alvin Bot can do — providers, sub-agents, cron jobs, plugins, MCP, security audit, web UI — read **[`docs/HANDBOOK.md`](docs/HANDBOOK.md)**.

### AI Providers

| Provider | Cost | Best for |
|----------|------|----------|
| **Groq** | Free | Getting started fast |
| **Google Gemini** | Free | Image understanding, embeddings |
| **NVIDIA NIM** | Free | Tool use, 150+ models |
| OpenAI | Paid | GPT-4o quality |
| OpenRouter | Paid | 100+ models marketplace |
| Claude SDK | Paid* | Full agent with tool use |

\*Claude SDK requires a [Claude Max](https://claude.ai) subscription ($20/mo) or Anthropic API access. The setup wizard checks this automatically.

### Alternative Installation

<details>
<summary>One-line install script (Linux/macOS)</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/alvbln/Alvin-Bot/main/install.sh | bash
```

Downloads, builds, and runs the setup wizard automatically.
</details>

<details>
<summary>Desktop App (macOS)</summary>

| Platform | Download | Architecture |
|----------|----------|-------------|
| macOS | [DMG](https://github.com/alvbln/Alvin-Bot/releases/latest) | Apple Silicon (M1+) |
| Windows | Coming soon | x64 |
| Linux | Coming soon | x64 |

The desktop app auto-starts the bot and provides a system tray icon with quick controls.
</details>

<details>
<summary>Docker</summary>

```bash
git clone https://github.com/alvbln/Alvin-Bot.git
cd Alvin-Bot
cp .env.example .env    # Edit with your tokens
docker compose up -d
```

Note: Claude SDK is not compatible with Docker (requires interactive CLI login).
</details>

<details>
<summary>From Source (contributors)</summary>

```bash
git clone https://github.com/alvbln/Alvin-Bot.git
cd Alvin-Bot
npm install
npm run build
node bin/cli.js setup   # Interactive wizard
npm run dev             # Start in dev mode
```
</details>

<details>
<summary>Production (PM2)</summary>

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```
</details>

### Troubleshooting

```bash
alvin-bot doctor        # Check configuration & validate connections
```

If your AI provider isn't working, run `doctor` — it tests the actual API connection and shows exactly what's wrong.

---

## 📋 Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/start` | Session status overview |
| `/new` | Fresh conversation (reset context) |
| `/model` | Switch AI model (inline keyboard) |
| `/effort <low\|medium\|high\|max>` | Set thinking depth |
| `/voice` | Toggle voice replies |
| `/imagine <prompt>` | Generate images |
| `/web <query>` | Search the web |
| `/remind <time> <text>` | Set reminders (e.g., `/remind 30m Call mom`) |
| `/cron` | Manage scheduled tasks |
| `/recall <query>` | Search memory |
| `/remember <text>` | Save to memory |
| `/export` | Export conversation |
| `/dir <path>` | Change working directory |
| `/workspaces` | List all configured workspaces (v4.12.0) |
| `/workspace [name]` | Show or switch the active workspace — `/workspace default` resets (v4.12.0) |
| `/status` | Current session & cost info |
| `/setup` | Configure API keys & platforms |
| `/system <prompt>` | Set custom system prompt |
| `/fallback` | View & reorder provider fallback chain |
| `/skills` | List available skills & their triggers |
| `/lang <de\|en\|auto>` | Set or auto-detect response language |
| `/cancel` | Abort running request |
| `/reload` | Hot-reload personality (SOUL.md) |

---

## 🏗️ Architecture

```
                            ┌──────────────┐
                            │   Web UI     │ (Dashboard, Workspaces, Chat, Settings)
                            └──────┬───────┘
                                   │ HTTP/WS
┌──────────┐  ┌───────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ Telegram │  │ Slack │  │ WhatsApp │  │ Discord  │  │  Signal  │
└────┬─────┘  └───┬───┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
     │            │           │             │              │
     └────────────┴───────────┴─────────────┴──────────────┘
                           │
                 ┌─────────┴──────────┐
                 │ Workspace Resolver │ (per-channel context: cwd + persona)
                 └─────────┬──────────┘
                           │
                    ┌──────┴───────┐
                    │   Engine     │ (Query routing, fallback)
                    └──────┬───────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
   ┌──────┴──────┐  ┌─────┴──────┐  ┌──────┴──────┐
   │ Claude SDK  │  │  OpenAI    │  │  Custom     │
   │ (full agent)│  │ Compatible │  │  Models     │
   └─────────────┘  └────────────┘  └─────────────┘
```

### Provider Types

| Provider | Tool Use | Streaming | Vision | Auth |
|----------|----------|-----------|--------|------|
| Claude SDK | ✅ Full (native Bash, Read, Write, Web) | ✅ | ✅ | Claude CLI (OAuth) |
| OpenAI, Groq, Gemini | ✅ Full (Shell, Files, Python, Web) | ✅ | Varies | API Key |
| NVIDIA NIM | ✅ Full (Shell, Files, Python, Web) | ✅ | Varies | API Key (free) |
| OpenRouter | ✅ Full (Shell, Files, Python, Web) | ✅ | ✅ | API Key |
| Other OpenAI-compatible | ⚡ Auto-detect | ✅ | Varies | API Key |

> **Universal Tool Use:** Alvin Bot gives full agent capabilities to *any* provider that supports function calling — not just Claude. Shell commands, file operations, Python execution, web search, and more work across all major providers. If a provider doesn't support tool calls, Alvin Bot automatically falls back to text-only chat mode.

### Project Structure

```
alvin-bot/
├── src/
│   ├── index.ts                 # Entry point
│   ├── engine.ts                # Multi-model query engine
│   ├── config.ts                # Configuration
│   ├── handlers/                # Message & command handlers
│   ├── middleware/              # Auth & access control
│   ├── platforms/               # Telegram, Slack, WhatsApp, Discord, Signal adapters
│   ├── providers/               # AI provider implementations
│   ├── services/                # Memory, voice, cron, plugins, workspaces, tool discovery
│   ├── tui/                     # Terminal UI
│   └── web/                     # Web server, APIs, setup wizard
├── web/public/                  # Web UI (HTML/CSS/JS, zero build step)
├── plugins/                     # Plugin directory (6 built-in)
├── docs/
│   ├── install/                 # Setup guides (macOS, Windows, Slack)
│   └── custom-models.json       # Custom model configurations
├── TOOLS.md                     # Custom tool definitions (Markdown)
├── SOUL.md                      # Agent personality
├── bin/cli.js                   # CLI entry point
└── ecosystem.config.cjs         # PM2 configuration
```

---

## 🧭 Multi-Session Workspaces (v4.12.0)

**Run multiple parallel Alvin sessions on the same bot — one per project, context-isolated, memory shared.** Think Claude Coworker, but on your own machine with your own tools. Each workspace has its own working directory, purpose, and optional persona. Sub-agents spawned in one workspace stay in that workspace. Memory, skills, and the knowledge base are globally shared across all of them.

### Why you'd want this

Without workspaces, Alvin has one big blob of context. If you ask about one project's deployment right after debugging a completely unrelated service, Claude pollutes one context with the other. Workspaces solve this: **Slack channel = session**, or on Telegram, **`/workspace my-project` = session**. Each one has its own Claude SDK `resume` token, history, and current project CLAUDE.md loaded via its working directory.

### How it works

1. **Drop a markdown file** into `~/.alvin-bot/workspaces/<name>.md` with YAML frontmatter.
2. **Alvin hot-reloads** the workspace registry (no restart needed — same pattern as skills).
3. On **Slack**, workspaces resolve by explicit channel ID first, then by channel name match (`#my-project` → `workspaces/my-project.md`, case-insensitive).
4. On **Telegram**, run `/workspace <name>` to switch — next message uses the new persona and cwd.
5. Nothing configured? Alvin falls back to the "default" workspace exactly like pre-v4.12 — **no breaking changes**.

### Example workspace file

Create `~/.alvin-bot/workspaces/my-project.md`:

```markdown
---
purpose: my-project website dev
cwd: ~/Projects/my-project
emoji: "🏢"
color: "#6366f1"
channels: ["C01ABCDEF"]
---
You are focused on the my-project website. Stack: React + Express +
Drizzle + MySQL. Production VPS at your-vps.example.com, deploy via rsync.
Prefer concise, directly actionable answers about features, deployment,
and Stripe integration.
```

The `cwd` auto-loads the project-specific `CLAUDE.md` via Claude SDK's `settingSources: ["user", "project"]`, so each workspace inherits its project's conventions automatically. `channels` is optional — omit it to match by filename.

### Slack setup (5 minutes)

1. Download the setup guide + manifest from the [latest release](https://github.com/alvbln/Alvin-Bot/releases/latest):
   - `slack-setup.md` — step-by-step instructions with screenshots
   - `slack-manifest.json` — copy-paste ready Slack App manifest
2. Create a Slack App from the manifest at https://api.slack.com/apps → **Create New App** → **From an app manifest**
3. Enable Socket Mode, generate an **App-Level Token** (starts with `xapp-`)
4. Install the app to your workspace, copy the **Bot User OAuth Token** (starts with `xoxb-`)
5. Add both to `~/.alvin-bot/.env`:
   ```bash
   SLACK_APP_TOKEN=xapp-1-...
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_ALLOWED_USERS=U01ABCDEF      # optional, comma-separated
   ```
6. Restart Alvin. You should see `💬 Slack connected (Alvin @ YourWorkspace)` in the log.
7. Invite Alvin to channels with `/invite @Alvin`. DMs work without an invite.

### Telegram `/workspace` commands

| Command | Effect |
|---|---|
| `/workspaces` | List all configured workspaces with emojis and purposes (active one marked ✅) |
| `/workspace` | Show the currently active workspace |
| `/workspace <name>` | Switch to `<name>` — next message uses its persona and cwd |
| `/workspace default` | Reset to the default workspace (global cwd, no persona) |

Workspace selection is per Telegram user, persisted across bot restarts via `~/.alvin-bot/state/sessions.json` (v2 envelope format, backwards compatible with v4.11).

### Web UI

The dashboard has a dedicated **🧭 Workspaces** tab (Data section in the sidebar). Each workspace shows as a color-coded card with emoji, purpose, cwd, mapped channels, session count, message count, and cumulative cost. Useful for spotting which project is burning the most tokens.

Or query directly:

```bash
curl -s http://localhost:3100/api/workspaces | jq
```

### Architecture guarantees

- **Memory is global.** Facts Alvin learns in one workspace are visible in every other workspace via the shared `MEMORY.md` and embeddings index. Per-workspace memory layer is on the v4.13 roadmap.
- **Sub-agents are per-session.** Each workspace can dispatch its own detached sub-agents via `alvin_dispatch_agent` — results come back to the originating channel on any platform (Telegram, Slack, Discord, WhatsApp), visible in `/subagents list` (v4.13.0+ dispatch, v4.14.0 cross-platform, v4.14.1 unified list view).
- **Session state survives restart.** Claude SDK `resume` tokens, conversation history, language, effort, and `workspaceName` all persist via `session-persistence.ts` (v4.11.0).
- **Backwards compatible.** If you don't create any workspace files, everything behaves exactly like v4.11. Upgrade is a no-op.

---

## ⚙️ Configuration

### Environment Variables

```env
# Required
BOT_TOKEN=<Telegram Bot Token>
ALLOWED_USERS=<comma-separated Telegram user IDs>

# AI Providers (at least one needed)
# Claude SDK uses CLI auth — no key needed
GROQ_API_KEY=<key>              # Groq (voice + fast models)
NVIDIA_API_KEY=<key>            # NVIDIA NIM models
GOOGLE_API_KEY=<key>            # Gemini + image generation
OPENAI_API_KEY=<key>            # OpenAI models
OPENROUTER_API_KEY=<key>        # OpenRouter (100+ models)

# Provider Selection
PRIMARY_PROVIDER=claude-sdk     # Primary AI provider
FALLBACK_PROVIDERS=nvidia-kimi-k2.5,nvidia-llama-3.3-70b

# Memory backend (v4.22+) — auto-detects based on what keys you have.
# Set to override the default priority: gemini → openai → ollama → fts5.
# fts5 is the zero-config keyword fallback — no key needed, works for everyone.
EMBEDDINGS_PROVIDER=auto                  # auto | gemini | openai | ollama | fts5
OLLAMA_EMBEDDING_MODEL=nomic-embed-text   # only used for ollama provider
MEMORY_INJECT_MODE=auto                   # auto | legacy | sqlite (see CHANGELOG v4.22)

# Optional Platforms
WHATSAPP_ENABLED=true           # Enable WhatsApp (needs Chrome)
DISCORD_TOKEN=<token>           # Enable Discord
SIGNAL_API_URL=<url>            # Signal REST API URL
SIGNAL_NUMBER=<number>          # Signal phone number
SLACK_BOT_TOKEN=xoxb-...        # Slack Bot User OAuth Token (Socket Mode)
SLACK_APP_TOKEN=xapp-1-...      # Slack App-Level Token (connections:write scope)
SLACK_ALLOWED_USERS=U01...      # Optional: comma-separated Slack user IDs allowlist

# Multi-Session (v4.12.0)
SESSION_MODE=per-channel        # per-user (default) | per-channel | per-channel-peer
                                # per-channel gives each Slack channel / group its own isolated session

# Optional
WORKING_DIR=~                   # Default working directory (used when no workspace is resolved)
MAX_BUDGET_USD=5.0              # Cost limit per session
WEB_PORT=3100                   # Web UI port
WEB_PASSWORD=<password>         # Web UI auth (optional)
CHROME_PATH=/path/to/chrome     # Custom Chrome path (for WhatsApp)
MEMORY_EXTRACTION_DISABLED=1    # Opt out of v4.11.0 auto-fact-extraction in compaction
```

### Custom Models

Add any OpenAI-compatible model via `docs/custom-models.json`:

```json
[
  {
    "key": "my-local-llama",
    "name": "Local Llama 3",
    "model": "llama-3",
    "baseUrl": "http://localhost:11434/v1",
    "apiKeyEnv": "OLLAMA_API_KEY",
    "supportsVision": false,
    "supportsStreaming": true
  }
]
```

### Personality

Edit `SOUL.md` to customize the bot's personality. Changes apply on `/reload` or bot restart.

### WhatsApp Setup

WhatsApp uses [whatsapp-web.js](https://github.com/nicholascui/whatsapp-web.js) — the bot runs as **your own WhatsApp account** (not a separate business account). Chrome/Chromium is required.

**1. Enable WhatsApp**

Set `WHATSAPP_ENABLED=true` in `.env` (or toggle via Web UI → Platforms → WhatsApp). Restart the bot.

**2. Scan QR Code**

On first start, a QR code appears in the terminal (and in the Web UI). Scan it with WhatsApp on your phone (Settings → Linked Devices → Link a Device). The session persists across restarts.

**3. Chat Modes**

| Mode | Env Variable | Description |
|------|-------------|-------------|
| **Self-Chat** | *(always on)* | Send yourself messages → bot responds. Your AI notepad. |
| **Groups** | `WHATSAPP_ALLOW_GROUPS=true` | Bot responds in whitelisted groups. |
| **DMs** | `WHATSAPP_ALLOW_DMS=true` | Bot responds to private messages from others. |
| **Self-Chat Only** | `WHATSAPP_SELF_CHAT_ONLY=true` | Disables groups and DMs — only self-chat works. |

All toggles are also available in the Web UI (Platforms → WhatsApp). Changes apply instantly — no restart needed.

**4. Group Whitelist**

Groups must be explicitly enabled. In the Web UI → Platforms → WhatsApp → Group Management:

- **Enable** a group to let the bot listen
- **Allowed Contacts** — Select who can trigger the bot (empty = everyone)
- **@ Mention Required** — Bot only responds when mentioned (voice/media bypass this)
- **Process Media** — Allow photos, documents, audio, video
- **Approval Required** — Owner must approve each message via Telegram before the bot responds. Group members see nothing — completely transparent.

> **Note:** Your own messages in groups are never processed (you ARE the bot on WhatsApp). The bot only responds to other participants. In self-chat, your messages are always processed normally.

**5. Approval Flow** (when enabled per group)

1. Someone writes in a whitelisted group
2. You get a Telegram notification with the message preview + ✅ Approve / ❌ Deny buttons
3. Approve → bot processes and responds in WhatsApp. Deny → silently dropped.
4. Fallback channels if Telegram is unavailable: WhatsApp self-chat → Discord → Signal
5. Unapproved messages expire after 30 minutes.

---

## 🔌 Plugins

Built-in plugins in `plugins/`:

| Plugin | Description |
|--------|-------------|
| weather | Current weather & forecasts |
| finance | Stock prices & crypto |
| notes | Personal note-taking |
| calendar | Calendar integration |
| email | Email management |
| smarthome | Smart home control |

Plugins are auto-loaded at startup. Create your own by adding a directory with an `index.js` exporting a `PluginDefinition`.

---

## 🎯 Skills

Built-in skills in `skills/`:

| Skill | Triggers | Description |
|-------|----------|-------------|
| code-project | code, build, implement, debug, refactor | Software development workflows, architecture patterns |
| data-analysis | analyze, chart, csv, excel, statistics | Data processing, visualization, statistical analysis |
| document-creation | document, report, letter, pdf, write | Professional document creation and formatting |
| email-summary | email, inbox, unread, newsletter | Email triage, summarization, priority sorting |
| system-admin | server, deploy, docker, nginx, ssl | DevOps, deployment, system administration |
| web-research | research, compare, find, review | Deep web research with source verification |

Skills activate automatically when your message matches their trigger keywords. The skill's SKILL.md content is injected into the system prompt, giving the agent specialized expertise for that task.

---

## 🛠️ CLI

```bash
alvin-bot setup     # Interactive setup wizard
alvin-bot tui       # Terminal chat UI ✨
alvin-bot chat      # Alias for tui
alvin-bot doctor    # Health check
alvin-bot update    # Pull latest & rebuild
alvin-bot start     # Start the bot (background via pm2)
alvin-bot start -f  # Start in foreground
alvin-bot stop      # Stop the bot
alvin-bot launchd install    # macOS only: install as LaunchAgent
alvin-bot launchd status     # macOS only: show LaunchAgent state
alvin-bot launchd uninstall  # macOS only: remove LaunchAgent
alvin-bot audit     # Security health check
alvin-bot search    # Search assets/memories/skills
alvin-bot version   # Show version
```

---

## 🗺️ Roadmap

- [x] **Phase 1** — Multi-Model Engine (provider abstraction, fallback chains)
- [x] **Phase 2** — Memory System (vector search, user profiles, smart context)
- [x] **Phase 3** — Rich Interactions (video messages, browser automation, email)
- [x] **Phase 4** — Plugins & Tools (plugin ecosystem, MCP client, custom tools)
- [x] **Phase 5** — CLI Installer (setup wizard, Docker, health check)
- [x] **Phase 6** — Web Dashboard (chat, settings, file manager, terminal)
- [x] **Phase 7** — Multi-Platform (Telegram, Discord, WhatsApp, Signal adapters)
- [x] **Phase 8** — Universal Tool Use *(NEW)* — All providers get agent powers:
  - ✅ Shell execution, file read/write/edit, directory listing
  - ✅ Python execution (Excel, PDF, charts, data processing)
  - ✅ Web fetch & search
  - ✅ Auto-detect function calling support per provider
  - ✅ Graceful fallback to text-only for providers without tool support
- [x] **Phase 9** — Skill System + Self-Awareness + Language Adaptation:
  - ✅ SKILL.md files for specialized domain knowledge (email, data analysis, code, docs, research, sysadmin)
  - ✅ Auto-matching: skill triggers activate contextual expertise on demand
  - ✅ Self-Awareness Core: agent knows it IS the AI (no external LLM calls for text tasks)
  - ✅ Automatic language detection and adaptation (EN default, learns user preference)
  - ✅ Human-readable cron schedules + visual schedule builder in WebUI
  - ✅ Platform Manager refactor: all adapters via unified registration system
  - ✅ Cron notifications for all platforms (Telegram, WhatsApp, Discord, Signal)
  - ✅ PM2 auto-refresh on Maintenance page
  - ✅ WhatsApp group whitelist with per-contact access control
  - ✅ Owner approval gate (Telegram → WhatsApp DM → Discord → Signal fallback)
  - ✅ Full media processing: photos, documents, audio/voice, video across all platforms
  - ✅ File Browser: create, edit, delete files with safety guards
  - ✅ Git history sanitized (personal data removed via git-filter-repo)
- [x] **Phase 10** — Anthropic API Provider + WebUI Provider Management
  - [x] Anthropic API key test case in WebUI (validation endpoint)
  - [x] "Add Provider" flow in WebUI — add new providers post-setup without editing `.env`
  - [x] Claude SDK guided setup from WebUI (install check, login status, step-by-step)
  - [x] `.env.example` update with `ANTHROPIC_API_KEY`
- [x] **Phase 11** — WebUI Professional Redesign
  - [x] Replace emoji icons with Lucide SVG icons (60+ icons, sidebar, pages, buttons)
  - [x] i18n framework (`i18n.js`) — bilingual DE/EN with browser-locale detection (~400 keys)
  - [x] Language toggle in sidebar footer (DE | EN)
  - [x] Typography upgrade (Inter webfont via Google Fonts)
  - [x] Gradient accents + subtle glassmorphism on cards
  - [x] Smooth page transitions (fade animation on page switch)
  - [x] Skeleton loading states + status pulse animations
  - [x] Command Palette (Cmd+K / Ctrl+K) with fuzzy search
- [x] **Phase 12** — Native Installers (Non-Techie Friendly)
  - [x] Electron wrapper (embedded Node.js + WebUI + tray icon)
  - [x] macOS `.dmg` build via electron-builder (arm64)
  - [ ] Windows `.exe` (NSIS) via electron-builder
  - [ ] Linux `.AppImage` + `.deb` via electron-builder
  - [x] Auto-update mechanism (electron-updater)
  - [x] GUI Setup Wizard (provider selection, Telegram token, first-run experience)
  - [ ] Homebrew formula (`brew install alvin-bot`)
  - [ ] Scoop manifest for Windows
  - [ ] One-line install script
  - [x] Docker Compose polish (production-ready `docker-compose.yml`)
- [x] **Phase 13** — npm publish (security audit)
- [x] **Phase 14** — Async Sub-Agents (v4.10.0)
  - [x] `run_in_background: true` system prompt hint for Claude SDK
  - [x] Async-agent watcher polling `outputFile` JSONL, delivering results as separate messages
  - [x] Session-bound sub-agents (each session spawns its own background workers)
- [x] **Phase 15** — Memory Persistence + Smart Loading (v4.11.0)
  - [x] Session persistence across bot restarts (debounced atomic flush, v2 envelope)
  - [x] SDK memory injection (MEMORY.md in every system prompt, not just tool-call dependent)
  - [x] Semantic recall on SDK first-turn via embeddings
  - [x] Layered memory stack (L0 identity / L1 preferences / L2 projects / L3 vector search)
  - [x] Auto-fact extraction during compaction (Mem0-style)
- [x] **Phase 16** — Multi-Session + Slack Interface (v4.12.0)
  - [x] Session-key fix: platform-message.ts routes through `buildSessionKey()`
  - [x] Workspace registry with hot-reload (`~/.alvin-bot/workspaces/*.md`)
  - [x] Workspace resolver in platform handlers (per-channel persona + cwd)
  - [x] Slack adapter polish: progress ticker (`chat.update`), typing status (`assistant.threads.setStatus`), channel name cache
  - [x] Telegram `/workspace` + `/workspaces` commands (feature parity)
  - [x] Per-workspace cost aggregation + Web UI workspace cards
  - [x] Slack setup guide + copy-paste app manifest (in GitHub Release assets)
- [x] **Phase 17** — Truly detached sub-agents + multi-platform dispatch (v4.13.0 – v4.14.2, 2026-04-16)
  - [x] `alvin_dispatch_agent` MCP tool — spawns independent `claude -p` subprocesses that survive parent aborts (v4.13.0)
  - [x] Slack `/alvin` slash command (namespaced parent with subcommands: status / new / effort / help + LLM fallthrough) (v4.13.2)
  - [x] Sub-agent dispatch on Slack, Discord, WhatsApp via platform-aware delivery registry (v4.14.0)
  - [x] `/subagents list` merged view — v4.0.0 bot-level agents + v4.13+ detached dispatches in one list (v4.14.1)
  - [x] Watcher zombie guard — missing outputFile > 10 min delivers as failed instead of 12h timeout (v4.14.2)
  - [x] Staleness-based partial output recovery for interrupted sub-agents (v4.12.4)
  - [ ] SQLite migration of the embeddings index (currently 128 MB JSON)
  - [ ] Per-workspace memory layer (additive over global) — facts learned in one workspace stay there unless explicitly promoted to global
  - [ ] Per-workspace provider override (`provider:` in frontmatter) — e.g. one workspace uses Claude Opus, another uses a cheaper model
  - [ ] Per-workspace skill allowlist — scope Apple Notes to personal workspace, sysadmin only to devops workspace, etc.
  - [ ] Multi-User Slack (real `per-channel-peer` mode) — different users in the same Slack channel get their own sub-sessions
  - [ ] Workspace cloning / templates — `/workspace clone my-project as my-fork` spins up a new workspace from an existing one
  - [ ] Daily log decay / archive — older daily logs move to cold storage after N days
- [ ] **Phase 18** — Security + Platform hardening (from v4.12.1 audit, prioritized)
  - [ ] **P1 — Electron major upgrade** (35 → 41+) — fixes 1 HIGH + 5 MODERATE Electron CVEs in the Desktop-Build path. Major version jump, requires full rebuild + test of `.dmg` flow. Separate release (likely bundled with Windows `.exe` work).
  - [ ] **P1 — Prompt injection defense strategy** — not a single fix but a design debate: heuristic filters vs allow-list vs no-sandbox-accept-the-risk. Currently handled as a documented design-constraint (README security section), not as a code filter. When we decide the policy, implement it across all message entry points.
  - [ ] **P2 — TypeScript 5 → 6 upgrade** — major release, likely breaking changes in strict mode. Needs a dedicated release + test sweep. Low priority since 5.x is still supported.
  - [ ] **P0 for v5.0 — MCP plugin sandboxing** — currently MCP servers run with full Node privileges. Plan: run each MCP in a child process with restricted FS + network policy (similar to deno-permission model). Architectural change, v5.0 territory.

---

## 🔒 Security

> ### ⚠️ Important: Alvin has full shell + filesystem access
>
> Alvin Bot is an **autonomous AI agent** built on the Claude Agent SDK with shell, filesystem, and network access to the machine it runs on. This is by design — it's the point of the project. But it means:
>
> - **Treat the bot like `sudo` access** — only install it on machines where you'd trust Claude Code to run without supervision.
> - **Never expose the Web UI (port 3100) to the internet** without HTTPS, rate limiting, and a strong `WEB_PASSWORD`. It binds to `localhost` by default.
> - **On multi-user systems**, verify `~/.alvin-bot/.env` is chmod `600` (v4.12.2+ enforces this automatically on startup).
> - **`ALLOWED_USERS` is your first line of defense** — v4.12.2+ refuses to start if it's empty and Telegram is enabled.
>
> **Read the full threat model and hardening guide:** [`docs/security.md`](docs/security.md)

### Access control

- **User whitelist** — Only `ALLOWED_USERS` can interact with the bot (hard-enforced at startup since v4.12.2)
- **WhatsApp group approval** — Per-group participant whitelist + owner approval gate via Telegram (with WhatsApp DM / Discord / Signal fallback). Group members never see the approval process.
- **Slack allowlist** — `SLACK_ALLOWED_USERS` restricts who can DM or @mention the bot in Slack
- **DM pairing** — Optional 6-digit code flow for new users via owner approval (`AUTH_MODE=pairing`)

### Execution hardening

- **`EXEC_SECURITY=allowlist`** (default) — Shell commands must match a whitelist of safe binaries and **cannot contain shell metacharacters** (`;`, `|`, `&`, `` ` ``, `$(...)`, redirects). Rejected by v4.12.2's exec-guard metachar filter.
- **Cron shell jobs** go through the same exec-guard (v4.12.2+) — cron is no longer a bypass vector.
- **Sub-agent toolset presets** — spawn sub-agents with `toolset: "readonly"` or `"research"` to restrict what they can do, regardless of the parent's privileges.
- **Timing-safe webhook auth** — `POST /api/webhook` uses `crypto.timingSafeEqual` (v4.12.2+) to prevent timing side-channel token extraction.

### Data hardening

- **Self-hosted** — Your data stays on your machine. No cloud sync, no external logging of prompts or responses.
- **No telemetry** — Zero tracking, zero analytics, zero phone-home.
- **File permissions** — `.env`, `sessions.json`, memory logs, cron jobs, and all sensitive state files are chmod `0o600` on every write and repaired at startup (v4.12.2+).
- **Owner protection** — Owner account cannot be deleted via UI.
- **Encrypted sudo credentials** — If you enable sudo exec, passwords are stored encrypted with an XOR key in a separate file, both chmod `0o600`.

### Known limitations (documented honestly)

- **Prompt injection** cannot be reliably filtered — we document this as a capability tradeoff rather than pretending to solve it. See `docs/security.md` for the full discussion.
- **Not yet hardened for public-internet deployment** — current scope is "on your own machine". VPS deployment works but requires additional reverse-proxy + TLS + rate-limit setup that we don't automate.
- **Electron Desktop build** has known CVEs (Phase 18 roadmap). The primary distribution is npm global install, not Desktop — if you don't use the Desktop wrapper, you're not affected.

---

## 📄 License

MIT — See [LICENSE](LICENSE).

---

## 🤝 Contributing

Issues and PRs welcome! Please read the existing code style before contributing.

```bash
git clone https://github.com/alvbln/Alvin-Bot.git
cd alvin-bot
npm install
npm run dev    # Development with hot reload
```
