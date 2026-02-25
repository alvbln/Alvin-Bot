# Changelog

All notable changes to Alvin Bot are documented here.

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
