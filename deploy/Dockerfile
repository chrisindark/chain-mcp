# Multi-stage production build for ChainMcp Gateway & Server CLI
FROM node:22-alpine AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/ ./packages/

RUN pnpm install --frozen-lockfile
RUN pnpm -r build

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/ ./packages/

# Drop root privileges per container hardening standards
USER node

EXPOSE 3333

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3333/health || exit 1

ENTRYPOINT ["node", "packages/cli/dist/bin.js"]
CMD ["--help"]
