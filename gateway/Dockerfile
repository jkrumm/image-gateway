# syntax=docker/dockerfile:1
# Build context is the REPO ROOT (monorepo — needs shared/ + gateway/ for bun
# workspace resolution). Build with: docker build -f gateway/Dockerfile .
#
# Only `app/package.json` is copied (not its source) so bun can resolve the
# workspace list; `--filter='@image-gateway/gateway'` then installs just the
# gateway + shared dependency graph, skipping the app's (Tauri/React) deps.

FROM oven/bun:1.3-alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
COPY shared/package.json shared/package.json
COPY gateway/package.json gateway/package.json
COPY app/package.json app/package.json
# Cache mount: bun's global install cache (root's HOME here — this stage has no
# USER). It lives outside the layer, so it speeds rebuilds without growing the image.
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --production --ignore-scripts --filter='@image-gateway/gateway'

COPY shared/tsconfig.json shared/tsconfig.json
COPY shared/src shared/src
COPY gateway/tsconfig.json gateway/tsconfig.json
COPY gateway/src gateway/src

FROM oven/bun:1.3-alpine AS runner
WORKDIR /app

RUN apk add --no-cache curl ca-certificates \
  && addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /app/node_modules /app/node_modules
COPY --from=builder --chown=app:app /app/shared /app/shared
COPY --from=builder --chown=app:app /app/gateway /app/gateway
COPY --from=builder --chown=app:app /app/package.json /app/package.json

ENV NODE_ENV=production
EXPOSE 7716

USER app

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:7716/health || exit 1

CMD ["bun", "run", "gateway/src/index.ts"]
