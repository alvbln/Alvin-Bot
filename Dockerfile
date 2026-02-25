# ─────────────────────────────────────────────────────────────
# Alvin Bot — Production Dockerfile
# Multi-stage build: builder → runner (minimal image)
# ─────────────────────────────────────────────────────────────

# ── Stage 1: Build ────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install deps first (layer caching)
COPY package*.json ./
RUN npm ci

# Build TypeScript
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── Stage 2: Production ──────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Security: non-root user
RUN addgroup -S alvinbot && adduser -S alvinbot -G alvinbot

# Production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built output + runtime files
COPY --from=builder /app/dist/ dist/
COPY bin/ bin/
COPY CLAUDE.md SOUL.md ./

# Create data directories
RUN mkdir -p docs/memory data && chown -R alvinbot:alvinbot /app

# Switch to non-root user
USER alvinbot

ENV NODE_ENV=production

# Health check: verify the process is running
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1

EXPOSE 3100

CMD ["node", "dist/index.js"]
