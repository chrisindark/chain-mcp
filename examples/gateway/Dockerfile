# Multi-stage production build for ChainMcp Dynamic Gateway
FROM node:22-alpine AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/ ./packages/
COPY examples/gateway/ ./examples/gateway/

RUN pnpm install --frozen-lockfile
RUN pnpm -r build

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/ ./packages/
COPY --from=builder /app/examples/gateway/ ./examples/gateway/

WORKDIR /app/examples/gateway

EXPOSE 3333

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3333/health || exit 1

ENTRYPOINT ["node", "dist/server.js"]
