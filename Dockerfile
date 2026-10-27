FROM node:22-alpine
WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy package files and install production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built application and runtime data (templates, legal sources, prompts)
COPY dist ./dist
COPY public ./public
COPY data ./data
COPY prompts ./prompts

# Environment
ENV PORT=8080
ENV NODE_ENV=production
# Production settings are supplied by cloudrun-env.yaml at deploy time.
# OPENROUTER_API_KEY and the Firebase service-account JSON come from Secret Manager.

EXPOSE 8080

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]