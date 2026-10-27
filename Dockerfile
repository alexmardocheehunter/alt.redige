# ──────────────────────────────────────────────────────────────────────
# Multi-stage build for LexCanvas
# Stage 1: build (compile TS, copy assets, inject frontend)
# Stage 2: runtime (production deps + built artifacts only)
# ──────────────────────────────────────────────────────────────────────

# ─── Build stage ──────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install build tools
RUN apk add --no-cache dumb-init

# Copy package files first (for layer caching)
COPY package*.json ./

# Install ALL dependencies (including devDependencies for tsc, vitest, etc.)
RUN npm ci

# Copy source files needed for build
COPY src ./src
COPY scripts ./scripts
COPY tsconfig*.json ./
COPY public ./public
COPY data ./data
COPY prompts ./prompts

# Build: compile TS → dist/, copy assets, inject app-api.js into index.html
RUN npm run build

# ─── Runtime stage ────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy package files and install PRODUCTION dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built application and runtime assets from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/data ./data
COPY --from=builder /app/prompts ./prompts

# Environment (runtime values come from Cloud Run env vars / Secret Manager)
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]