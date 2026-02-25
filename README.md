# 🤖 Alvin Bot — Autonomous AI Agent

> Your personal AI assistant — on Telegram, WhatsApp, Discord, Signal, Terminal, and Web.

Alvin Bot is an open-source, self-hosted AI agent that lives where you chat. Built on a multi-model engine with full system access, memory, plugins, and a rich web dashboard. Not just a chatbot — an autonomous agent that remembers, acts, and learns.

---

## ✨ Features

### 🧠 Intelligence
- **Multi-Model Engine** — Claude (Agent SDK with full tool use), OpenAI, Groq, NVIDIA NIM, Google Gemini, OpenRouter, or any OpenAI-compatible API
- **Automatic Fallback** — If one provider fails, seamlessly tries the next
- **Heartbeat Monitor** — Pings providers every 5 minutes, auto-failover after 2 failures, auto-recovery
- **User-Configurable Fallback Order** — Rearrange provider priority via Telegram (`/fallback`), Web UI, or API
- **Adjustable Thinking** — From quick answers (`/effort low`) to deep analysis (`/effort max`)
- **Persistent Memory** — Remembers across sessions via vector-indexed knowledge base
- **Smart Tool Discovery** — Scans your system at startup, knows exactly what CLI tools, plugins, and APIs are available
- **Skill System** — 6 built-in SKILL.md files (code, data analysis, email, docs, research, sysadmin) auto-activate based on message context
- **Self-Awareness** — Knows it IS the AI model — won't call external APIs for tasks it can do itself
- **Automatic Language Detection** — Detects user language (EN/DE) and adapts; learns preference over time

### 💬 Multi-Platform
- **Telegram** — Full-featured with streaming, inline keyboards, voice, photos, documents
- **WhatsApp** — Via WhatsApp Web: self-chat as AI notepad, group whitelist with per-contact access control, full media support (photos, docs, audio, video)
- **WhatsApp Group Approval** — Owner gets approval requests via Telegram (or WhatsApp DM fallback) before the bot responds to group messages. Silent — group members see nothing.
- **Discord** — Server bot with mention/reply detection, slash commands
- **Signal** — Via signal-cli REST API with voice transcription
- **Terminal** — Rich TUI with ANSI colors and streaming (`alvin-bot tui`)
- **Web UI** — Full dashboard with chat, settings, file manager, terminal

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

### Prerequisites

- **Node.js ≥ 18** — [nodejs.org](https://nodejs.org)
- **A Telegram Bot Token** — Get one from [@BotFather](https://t.me/BotFather)
- **Your Telegram User ID** — Get it from [@userinfobot](https://t.me/userinfobot)

That's it. No paid subscriptions required — free AI providers available.

### Setup

```bash
git clone https://github.com/alvbln/alvin-bot.git
cd alvin-bot
npm install
node bin/cli.js setup   # Interactive wizard
npm run dev             # Start in dev mode
```

The setup wizard walks you through:
1. Telegram bot token & user ID
2. **AI provider choice** — Groq (free), NVIDIA NIM (free), Google Gemini (free), OpenAI, OpenRouter, or Claude SDK
3. Optional extras (voice, web password, WhatsApp)

### Docker

```bash
git clone https://github.com/alvbln/alvin-bot.git
cd alvin-bot
cp .env.example .env    # Edit with your tokens
docker compose up -d
```

### Production (PM2)

```bash
npm run build
pm2 start ecosystem.config.cjs
```

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
| `/status` | Current session & cost info |
| `/setup` | Configure API keys & platforms |
| `/system <prompt>` | Set custom system prompt |
| `/fallback` | View & reorder provider fallback chain |
| `/skills` | List available skills & their triggers |
| `/lang <de\|en\|auto>` | Set or auto-detect response language |
| `/cancel` | Abort running request |
| `/reload` | Hot-reload personality (SOUL.md) |

---

## 🏗️ Architecture (v3.0)

```
                    ┌──────────────┐
                    │   Web UI     │ (Dashboard, Chat, Settings)
                    └──────┬───────┘
                           │ HTTP/WS
┌──────────┐  ┌──────────┐ │ ┌──────────┐  ┌──────────┐
│ Telegram │  │ WhatsApp │ │ │ Discord  │  │  Signal  │
└────┬─────┘  └────┬─────┘ │ └────┬─────┘  └────┬─────┘
     │             │       │      │              │
     └─────────────┴───────┴──────┴──────────────┘
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
│   ├── platforms/               # Telegram, WhatsApp, Discord, Signal adapters
│   ├── providers/               # AI provider implementations
│   ├── services/                # Memory, voice, cron, plugins, tool discovery
│   ├── tui/                     # Terminal UI
│   └── web/                     # Web server, APIs, setup wizard
├── web/public/                  # Web UI (HTML/CSS/JS, zero build step)
├── plugins/                     # Plugin directory (6 built-in)
├── docs/
│   ├── tools.json               # Custom tool definitions
│   ├── custom-models.json       # Custom model configurations
│   ├── memory/                  # Daily session logs (auto-generated)
│   └── MEMORY.md                # Long-term memory (curated)
├── SOUL.md                      # Agent personality
├── CLAUDE.md                    # Agent instructions (for Claude SDK)
├── bin/cli.js                   # CLI entry point
└── ecosystem.config.cjs         # PM2 configuration
```

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

# Optional Platforms
WHATSAPP_ENABLED=true           # Enable WhatsApp (needs Chrome)
DISCORD_TOKEN=<token>           # Enable Discord
SIGNAL_API_URL=<url>            # Signal REST API URL
SIGNAL_NUMBER=<number>          # Signal phone number

# Optional
WORKING_DIR=~                   # Default working directory
MAX_BUDGET_USD=5.0              # Cost limit per session
WEB_PORT=3100                   # Web UI port
WEB_PASSWORD=<password>         # Web UI auth (optional)
CHROME_PATH=/path/to/chrome     # Custom Chrome path (for WhatsApp)
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
alvin-bot start     # Start the bot
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
- [ ] **Phase 10** — npm publish (security audit)

---

## 🔒 Security

- **User whitelist** — Only `ALLOWED_USERS` can interact with the bot
- **WhatsApp group approval** — Per-group participant whitelist + owner approval gate via Telegram (with WhatsApp DM / Discord / Signal fallback). Group members never see the approval process.
- **Self-hosted** — Your data stays on your machine
- **No telemetry** — Zero tracking, zero analytics, zero phone-home
- **Web UI auth** — Optional password protection for the dashboard
- **Owner protection** — Owner account cannot be deleted via UI

---

## 📄 License

MIT — See [LICENSE](LICENSE).

---

## 🤝 Contributing

Issues and PRs welcome! Please read the existing code style before contributing.

```bash
git clone https://github.com/alvbln/alvin-bot.git
cd alvin-bot
npm install
npm run dev    # Development with hot reload
```
