# Build stage
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci --no-audit --no-fund

COPY src ./src

# Runtime stage
FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/src ./src
COPY tsconfig.json ./

RUN groupadd --gid 1001 nodejs && \
    useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home nodejs

RUN mkdir -p /app/.cache /app/data && \
    chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["npx", "tsx", "src/server.ts"]
