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

### Install & Run

```bash
git clone https://github.com/alevbln/alvin-bot.git
cd alvin-bot
npm install
cp .env.example .env
# Edit .env with your tokens

# Development
npm run dev

# Production
npm run build
pm2 start ecosystem.config.cjs
pm2 save
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
| `/cancel` | Abort running request |

---

## 🗺️ Roadmap — The Vision

Mr. Levin aims to become a **fully-featured, human-feeling AI assistant** that anyone can self-host. Here's the plan:

### 🔄 Phase 1: Multi-Model Backend (Next)

**Goal:** Break free from Claude-only. Let users choose their AI engine.

- [ ] **Provider abstraction layer** — Unified interface for different LLM backends
- [ ] **Supported providers:**
  - Anthropic Claude (current, via Agent SDK)
  - OpenAI GPT-4o / o3 (via API)
  - Google Gemini 2.5/3 Pro (via API)
  - Local models via Ollama (llama, mistral, etc.)
  - NVIDIA NIM (150+ free models)
  - OpenRouter (any model, one API)
- [ ] **Fallback chain** — Auto-switch to next provider on failure (like OpenClaw)
- [ ] **Per-chat model selection** — `/model gemini` to switch mid-conversation
- [ ] **Cost tracking per provider** — Know what each model costs you

### 🧠 Phase 2: Enhanced Memory & Personality

**Goal:** Make Mr. Levin truly remember and grow.

- [ ] **Vector-based memory search** — Semantic recall instead of just reading files
- [ ] **Automatic memory consolidation** — Periodically distill daily logs into long-term memory
- [ ] **Personality profiles** — Customizable personality via SOUL.md (like OpenClaw)
- [ ] **User profiles** — Multi-user support with separate memory per user
- [ ] **Conversation summaries** — Auto-generate session summaries on `/new`

### 🛠️ Phase 3: Rich Interactions

**Goal:** Go beyond text — make interactions feel natural.

- [ ] **Document handling** — Receive and process PDFs, Excel, Word files
- [ ] **Image generation** — Generate images via DALL-E, Gemini Imagen, or Nano Banana
- [ ] **Video messages** — Process and create short video responses
- [ ] **Browser automation** — Full web browsing via Playwright (scraping, form filling, screenshots, downloads)
- [ ] **Email integration** — Read/send emails via IMAP/SMTP (Apple Mail, Gmail, etc.)
- [ ] **Inline keyboards** — Interactive buttons for common actions
- [ ] **Reactions** — React to messages with emoji (acknowledgment, humor)
- [ ] **Scheduled messages** — Cron-like reminders and proactive check-ins
- [ ] **Group chat support** — Participate in group chats intelligently (speak when relevant, stay quiet when not)

### 🔌 Phase 4: Plugin & Tool Ecosystem

**Goal:** Extensible capabilities without core changes.

- [ ] **Plugin system** — Drop-in skills (like OpenClaw skills)
- [ ] **MCP (Model Context Protocol) support** — Connect to any MCP-compatible tool server
- [ ] **Built-in tools:**
  - 📧 Email (read/send via IMAP/SMTP)
  - 📅 Calendar (Google Calendar, Apple Calendar)
  - 🏠 Smart Home (Hue, Sonos, HomeKit)
  - 💹 Finance (stock prices, portfolio tracking)
  - 🌤️ Weather
  - 📝 Notes (Apple Notes, Obsidian)
- [ ] **Custom tool registration** — Users define their own tools via config

### 📦 Phase 5: One-Click Installer

**Goal:** Anyone can set up Mr. Levin in 5 minutes.

- [ ] **Interactive setup wizard** (`npx mr-levin setup`)
  - Step-by-step guide through:
    1. Create Telegram bot via BotFather
    2. Install & auth Claude CLI
    3. Configure API keys (Groq, OpenAI, etc.)
    4. Set allowed users
    5. Choose default model & personality
    6. Start bot & verify
  - Auto-detect OS (macOS/Linux/Windows WSL)
  - Auto-install dependencies
- [ ] **Docker support** — `docker run mrlevin/bot` with env vars
- [ ] **Update mechanism** — `mr-levin update` to pull latest version
- [ ] **Health check** — `mr-levin doctor` to diagnose issues
- [ ] **Config file** — `mr-levin.config.json` for all settings (models, personality, tools, users)

### 🖥️ Phase 6: Local Web Interface

**Goal:** A beautiful, self-hosted dashboard to manage and chat with Mr. Levin.

- [ ] **Real-time chat UI** — WebSocket-based, streaming responses just like Telegram
- [ ] **Session browser** — View, search, and continue past conversations
- [ ] **Memory viewer/editor** — Browse and edit MEMORY.md + daily logs with a nice UI
- [ ] **Settings panel** — Configure models, personality, tools, users — no config files needed
- [ ] **File manager** — Upload, browse, and manage files the agent works with
- [ ] **Activity feed** — Live view of what the agent is doing (tool calls, web browsing, file edits)
- [ ] **Cost dashboard** — Track spending per model, per day, per session
- [ ] **Terminal** — Embedded terminal to see agent's shell commands live
- [ ] **Mobile-responsive** — Works on phone browsers too
- [ ] **Auth** — Local login with password (no cloud auth needed)
- [ ] **Tech:** React/Next.js or Svelte + WebSocket server + SQLite for history

### 🌐 Phase 7: Multi-Platform

**Goal:** Not just Telegram — reach users where they are.

- [ ] **WhatsApp** (via Baileys/wacli)
- [ ] **Discord**
- [ ] **Signal**
- [ ] **Web UI chat** (integrated into Phase 6 dashboard)
- [ ] **Platform abstraction** — Single bot logic, multiple frontends

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
