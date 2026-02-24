# 🤖 Mr. Levin — Autonomous AI Telegram Agent

> *Your personal AI assistant on Telegram — powered by Claude, designed to feel human.*

Mr. Levin is an open-source, self-hosted Telegram bot that gives you a fully autonomous AI agent in your pocket. Built on Anthropic's Claude Agent SDK, it can read files, execute commands, browse the web, manage your projects, and remember everything — all through Telegram.

**Created by [Ali Levin](https://github.com/alevbln)**

---

## ✨ What Makes Mr. Levin Special

- **🧠 Persistent Memory** — Remembers across sessions. Learns your preferences, projects, and decisions over time via a self-organizing knowledge base.
- **🔧 Full System Access** — Reads/writes files, runs shell commands, searches the web, spawns sub-agents. Not a chatbot — an autonomous agent.
- **🎙️ Voice In & Out** — Send voice messages, get voice replies. Understands you, speaks back.
- **📸 Vision** — Send photos for analysis. Screenshots, documents, diagrams — Claude sees it all.
- **⚡ Live Streaming** — Responses stream in real-time via Telegram message editing. No waiting for a wall of text.
- **🎛️ Adjustable Thinking** — From quick answers (`/effort low`) to deep analysis (`/effort max`).
- **🔒 Private & Self-Hosted** — Runs on YOUR machine. Your data never touches third-party servers (beyond Anthropic's API).

---

## 🏗️ Current Architecture (v2.0)

```
Telegram ←→ grammY Bot Framework
                ↓
         Claude Agent SDK (query API)
                ↓
         Claude Code CLI (OAuth / Max Subscription)
                ↓
         Tools: Read, Write, Edit, Bash, Glob, Grep,
                WebSearch, WebFetch, Task (Sub-Agents)
```

| Component | Technology |
|-----------|-----------|
| Bot Framework | [grammY](https://grammy.dev) (TypeScript-first) |
| AI Backend | [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| STT (Speech-to-Text) | Groq Whisper API (`whisper-large-v3-turbo`) |
| TTS (Text-to-Speech) | Edge TTS via `node-edge-tts` |
| Process Manager | PM2 |
| Language | TypeScript (tsx dev / tsc build) |

### Project Structure

```
alvin-bot/
├── src/
│   ├── index.ts              # Entry: Bot + middleware + handlers
│   ├── config.ts             # Env vars (BOT_TOKEN, ALLOWED_USERS, etc.)
│   ├── claude.ts             # Agent SDK wrapper with streaming + checkpoints
│   ├── handlers/
│   │   ├── commands.ts       # /start, /new, /dir, /effort, /voice, /status, /cancel
│   │   ├── message.ts        # Text → Claude → streaming response (+ opt. voice)
│   │   ├── photo.ts          # Photo download → Claude vision analysis
│   │   └── voice.ts          # Voice → STT → Claude → response (+ opt. TTS)
│   ├── middleware/
│   │   └── auth.ts           # Telegram user ID whitelist
│   └── services/
│       ├── session.ts        # Per-user session state (in-memory)
│       ├── telegram.ts       # TelegramStreamer: live message editing with throttle
│       └── voice.ts          # STT (Groq Whisper) + TTS (Edge TTS)
├── docs/
│   ├── MEMORY.md             # Agent's long-term memory (curated)
│   └── memory/               # Daily session logs (auto-generated)
├── CLAUDE.md                 # Agent personality + memory instructions
├── .env                      # Secrets (not committed)
├── ecosystem.config.cjs      # PM2 config
└── telegram-agent-setup-prompt.md  # Full setup documentation
```

---

## 🚀 Quick Start

### Prerequisites

- Node.js ≥ 18
- Claude CLI installed and logged in (`npm i -g @anthropic-ai/claude-code && claude login`)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Your Telegram user ID (from [@userinfobot](https://t.me/userinfobot))

### Option A: Quick Setup (Recommended)

```bash
git clone https://github.com/alvbln/alvin-bot.git
cd alvin-bot
npm install
node bin/cli.js setup   # Interactive wizard walks you through everything
npm run dev             # Start in dev mode
```

### Option B: Docker

```bash
git clone https://github.com/alvbln/alvin-bot.git
cd alvin-bot
cp .env.example .env    # Edit with your tokens
docker compose up -d    # Start in background
docker compose logs -f  # View logs
```

### Option C: Manual

```bash
git clone https://github.com/alvbln/alvin-bot.git
cd alvin-bot
npm install
cp .env.example .env
# Edit .env with your tokens

npm run dev             # Development (hot reload)
npm run build && npm start  # Production
pm2 start ecosystem.config.cjs  # Production with auto-restart
```

### Environment Variables

```env
BOT_TOKEN=<Telegram Bot Token>
ALLOWED_USERS=<comma-separated Telegram user IDs>
WORKING_DIR=~/                    # Default working directory
MAX_BUDGET_USD=5.0                # Cost safety limit per session
GROQ_API_KEY=<Groq API Key>      # For voice transcription (free at console.groq.com)
```

> **No `ANTHROPIC_API_KEY` needed** — the SDK uses Claude CLI auth (Max subscription via OAuth).

---

## 📋 Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show status (user ID, session, working dir, costs) |
| `/new` | Fresh session (reset context) |
| `/dir <path>` | Change working directory |
| `/effort <low\|medium\|high\|max>` | Set thinking depth |
| `/voice` | Toggle voice replies on/off |
| `/status` | Current session status |
| `/remind <time> <text>` | Set a reminder (e.g., `/remind 30m Call mom`) |
| `/remind` | List pending reminders |
| `/remind cancel <id>` | Cancel a reminder |
| `/cancel` | Abort running request |
| `/reload` | Hot-reload SOUL.md personality |

---

## 🗺️ Roadmap — The Vision

Mr. Levin aims to become a **fully-featured, human-feeling AI assistant** that anyone can self-host. Here's the plan:

### 🔄 Phase 1: Multi-Model Backend (Next)

**Goal:** Break free from Claude-only. Let users choose their AI engine.

- [x] **Provider abstraction layer** — Unified interface for different LLM backends
- [x] **Supported providers:**
  - Anthropic Claude (current, via Agent SDK)
  - OpenAI GPT-4o / o3 (via API)
  - Google Gemini 2.5/3 Pro (via API)
  - Local models via Ollama (llama, mistral, etc.)
  - NVIDIA NIM (150+ free models, incl. Kimi K2.5)
  - OpenRouter (any model, one API)
- [x] **Fallback chain** — Auto-switch to next provider on failure (like OpenClaw)
- [x] **Per-chat model selection** — `/model gemini` to switch mid-conversation
- [x] **Cost tracking per provider** — Per-provider breakdown in `/status`

### 🧠 Phase 2: Enhanced Memory & Personality

**Goal:** Make Mr. Levin truly remember and grow.

- [x] **Vector-based memory search** — Semantic recall via Google Embeddings (text-embedding-004), cosine similarity, `/recall` + `/remember` + `/reindex`
- [x] **Automatic memory consolidation** — Session summaries auto-written to daily logs on `/new`
- [x] **Personality profiles** — Customizable personality via SOUL.md + `/reload` hot-reload
- [x] **User profiles** — Multi-user support with per-user settings, `/users`, `/note`, auto-tracking
- [x] **Conversation summaries** — Session stats shown on `/new` reset

### 🛠️ Phase 3: Rich Interactions

**Goal:** Go beyond text — make interactions feel natural.

- [x] **Document handling** — Receive and process PDFs, Excel, Word, code files, CSV, JSON, etc.
- [x] **Image generation** — `/imagine` generates images via Gemini (Nano Banana)
- [x] **Video messages** — Process videos + video notes: key frame extraction, audio transcription, AI analysis
- [x] **Browser automation** — `/browse` screenshots, text extraction, PDF generation via Playwright
- [x] **Email integration** — `/email` inbox/read/send/search via himalaya CLI (see Email plugin)
- [x] **Inline keyboards** — Interactive buttons for /model and /effort selection
- [x] **Reactions** — React to messages with emoji (🤔 thinking, 🎧 listening, 👀 looking, 👍 done, 👎 error)
- [x] **Scheduled messages** — `/remind 30m Text` with list, cancel, auto-fire
- [x] **Group chat support** — Responds to @mentions and replies in groups, stays quiet otherwise

### 🔌 Phase 4: Plugin & Tool Ecosystem

**Goal:** Extensible capabilities without core changes.

- [x] **Plugin system** — Drop-in `plugins/` directory, auto-loading, commands + tools + message hooks + lifecycle
- [x] **MCP (Model Context Protocol) support** — stdio transport, `/mcp` status + tool calling, `docs/mcp.json` config
- [x] **Built-in plugins (6):**
  - 🌤️ Weather — wttr.in, `/weather` command + AI tool
  - 💹 Finance — `/stock`, `/crypto`, `/fx` (Yahoo Finance, CoinGecko, Frankfurter)
  - 📝 Notes — `/notes` add/view/search/delete, markdown files
  - 📅 Calendar — `/cal` add/view/delete, natural language dates
  - 📧 Email — `/email` inbox/read/send/search (via himalaya CLI)
  - 🏠 Smart Home — `/home` on/off/brightness/scenes (Hue, webhooks)
- [x] **Custom tool registration** — `/tools` command, `docs/tools.json` config, shell + HTTP tools with parameter templates

### 📦 Phase 5: One-Click Installer

**Goal:** Anyone can set up Mr. Levin in 5 minutes.

- [x] **Interactive setup wizard** (`npx mr-levin setup`)
  - Step-by-step guide through:
    1. Create Telegram bot via BotFather
    2. Install & auth Claude CLI
    3. Configure API keys (Groq, OpenAI, etc.)
    4. Set allowed users
    5. Choose default model & personality
    6. Start bot & verify
  - Auto-detect OS (macOS/Linux/Windows WSL)
  - Auto-install dependencies
- [x] **Docker support** — `docker compose up -d` with Dockerfile + compose
- [x] **Update mechanism** — `mr-levin update` pulls latest + rebuilds
- [x] **Health check** — `mr-levin doctor` validates config, deps, and build
- [x] **Config file** — `mr-levin.config.json` for models, voice, memory settings (example included)

### 🖥️ Phase 6: Local Web Interface

**Goal:** A beautiful, self-hosted dashboard to manage and chat with Mr. Levin.

- [x] **Real-time chat UI** — WebSocket-based, streaming responses, dark theme
- [x] **Session browser** — View active sessions, history, stats per user
- [x] **Memory viewer/editor** — Browse and edit MEMORY.md + daily logs, save from UI
- [x] **Settings panel** — View config, API key status, provider setup
- [x] **File manager** — Browse project files, open + edit + save, directory navigation
- [x] **Activity feed** — Tool use indicators, fallback notifications in chat
- [x] **Cost dashboard** — Per-query cost tracking in chat, dashboard overview
- [x] **Terminal** — Embedded terminal with command history (↑↓), output display, error highlighting
- [x] **Mobile-responsive** — Collapsible sidebar, touch-friendly on phones
- [x] **Auth** — Password-protected login page (WEB_PASSWORD env var)
- [x] **Tech:** Vanilla HTML/CSS/JS (zero build step) + Node.js http + WebSocket (ws)

### 🌐 Phase 7: Multi-Platform

**Goal:** Not just Telegram — reach users where they are.

- [x] **WhatsApp** — via Baileys (@whiskeysockets/baileys), QR code pairing, auto-reconnect
- [x] **Discord** — via discord.js, @mention + reply detection, message chunking (2000 char limit)
- [x] **Signal** — via signal-cli REST API, polling-based, group + DM support
- [x] **Web UI chat** — integrated into Phase 6 dashboard (WebSocket streaming)
- [x] **Platform abstraction** — `PlatformAdapter` interface, auto-detect from env vars, unified message routing

---

## 💡 Feature Ideas (Brainstorm)

These are ideas worth exploring — not committed, just inspiring:

| Idea | Description |
|------|-------------|
| **Wake word** | "Hey Levin" voice activation via always-on mic (opt-in) |
| **Daily briefing** | Proactive morning summary (weather, calendar, emails, news) |
| **Smart notifications** | Filter and prioritize notifications from other apps |
| **Code review** | Send a GitHub PR link, get a review |
| **Expense tracking** | Photo receipt → categorized expense log |
| **Language learning** | Conversation partner that corrects mistakes |
| **Home automation** | "Turn off the lights" via smart home integrations |
| **Travel assistant** | Flight tracking, hotel recommendations, itinerary building |
| **Watchdog mode** | Monitor websites/APIs and alert on changes |
| **Pair programming** | Real-time coding assistance in a Telegram thread |
| **Voice personas** | Different voice characters for different moods (ElevenLabs) |
| **Shared sessions** | Multiple users collaborate in the same agent session |

---

## 🏛️ Design Principles

1. **Privacy first** — Self-hosted, no telemetry, your data stays yours
2. **Human-feeling** — Not robotic. Has opinions, humor, personality
3. **Autonomous** — Doesn't ask permission for every little thing
4. **Transparent** — Shows what it's doing (tool use, costs, thinking)
5. **Resilient** — Graceful fallbacks, crash recovery, persistent memory
6. **Extensible** — Plugin architecture, not monolithic
7. **Simple to start, powerful to scale** — Works out of the box, customizable for power users

---

## 🧑‍💻 Development

```bash
# Dev mode (hot reload)
npm run dev

# Build
npm run build

# PM2 management
pm2 start ecosystem.config.cjs
pm2 logs alvin-bot
pm2 restart alvin-bot
```

### Key Files to Know

| File | Purpose |
|------|---------|
| `src/claude.ts` | Core: Agent SDK integration, streaming, checkpoints |
| `src/services/telegram.ts` | Telegram message streaming with edit throttling |
| `src/services/session.ts` | Per-user session state management |
| `CLAUDE.md` | Agent personality & memory instructions |
| `telegram-agent-setup-prompt.md` | Complete setup documentation & architecture |

---

## 📄 License

MIT — Use it, fork it, make it yours.

---

## 🙏 Acknowledgments

- **[OpenClaw](https://openclaw.ai)** — Inspiration for architecture, memory system, and the "human-feeling AI" philosophy
- **[Anthropic](https://anthropic.com)** — Claude & the Agent SDK that makes this possible
- **[grammY](https://grammy.dev)** — Excellent Telegram bot framework

---

*Mr. Levin is Ali's side project — built with love, caffeine, and a healthy disrespect for the phrase "that's not possible."* 🤖
