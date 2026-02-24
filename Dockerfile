# Mr. Levin — Autonomous AI Telegram Agent
# Multi-stage build for minimal image size

FROM node:22-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── Production image ──────────────────────────────
FROM node:22-slim

WORKDIR /app

# Install Claude CLI (needed for SDK provider)
RUN npm i -g @anthropic-ai/claude-code 2>/dev/null || true

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY bin/ bin/
COPY CLAUDE.md SOUL.md ./
COPY .env.example ./

# Create memory directories
RUN mkdir -p docs/memory

# Non-root user for security
RUN groupadd -r mrlevin && useradd -r -g mrlevin mrlevin
RUN chown -R mrlevin:mrlevin /app
USER mrlevin

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
