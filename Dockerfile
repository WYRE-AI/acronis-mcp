# Multi-stage build for efficient container size.
# Build with: docker build --platform linux/amd64 -t acronis-mcp .
FROM node:26-alpine AS builder

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

WORKDIR /app

COPY package*.json ./

# All dependencies (including the pinned @acronis-platform/mcp) come from the
# public npm registry; no registry auth is needed. npm ci checks every tarball
# against the integrity in package-lock.json.
# --ignore-scripts prevents lifecycle scripts from running before source is copied.
RUN npm ci --ignore-scripts

COPY . .

RUN npm run build

# Prune dev dependencies in the builder so the production stage copies a
# runtime-only node_modules (no re-install, no registry auth needed).
RUN npm prune --omit=dev && npm cache clean --force

# Supply chain (WYREAI-711): fail the build unless the upstream package that
# ships (the node_modules copied below, so checked AFTER the prune) is byte for
# byte the pinned one: version, lockfile integrity, and the sha256 of every file
# it can run, including bin/cli.js, which is what the pool executes.
RUN node scripts/verify-upstream.mjs

# Production stage
FROM node:26-alpine AS production

# Node >= 22 is required by the pinned upstream @acronis-platform/mcp.
RUN apk -U upgrade --no-cache

RUN addgroup -g 1001 -S acronis && \
    adduser -S acronis -u 1001 -G acronis

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
# Preloaded into every upstream child (src/upstream-pool.ts).
COPY --from=builder /app/child-egress-guard.cjs ./child-egress-guard.cjs
COPY --from=builder /app/node_modules ./node_modules

# Remove the npm CLI from the production image — the runtime only needs `node`,
# and npm's bundled dependencies regularly trip vulnerability scanners.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# /app stays owned by root and is not writable by the app user (WYREAI-711).
# The upstream children run as the same uid as the wrapper, so a hostile bundle
# could otherwise rewrite the pinned bundle, the egress guard or the wrapper
# itself for the next spawn. Nothing under /app is written at runtime: each
# child gets a throwaway HOME under the temp directory. This does not stop a
# child reading its siblings' /proc/<pid>/environ (README "Supply chain").
RUN chmod -R a-w,a+rX /app && chown -R root:root /app

USER acronis

EXPOSE 8080

# stdio mode serves no HTTP, so the probe only runs for MCP_TRANSPORT=http.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD [ "$MCP_TRANSPORT" != "http" ] || wget --no-verbose --tries=1 --spider "http://localhost:${MCP_HTTP_PORT:-8080}/health" || exit 1

ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
# All interfaces inside the container. Startup still refuses to listen without
# a real CONDUIT_S2S_SECRET. MCP_ALLOW_INSECURE_DEV=1 binds 127.0.0.1 only, so
# this 0.0.0.0 default does not apply to the insecure bypass.
ENV MCP_HTTP_HOST=0.0.0.0
# Gateway mode reads credentials from the X-Acronis-* headers and does not
# fall back to ACRONIS_* environment variables.
ENV AUTH_MODE=gateway

CMD ["node", "dist/index.js"]

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

LABEL maintainer="engineering@wyre.ai"
LABEL version="${VERSION}"
LABEL org.opencontainers.image.title="acronis-mcp"
LABEL org.opencontainers.image.description="Hosted Model Context Protocol wrapper for Acronis Cyber Protect Cloud"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/WYRE-AI/acronis-mcp"
LABEL org.opencontainers.image.documentation="https://github.com/WYRE-AI/acronis-mcp/blob/main/README.md"
LABEL org.opencontainers.image.url="https://github.com/WYRE-AI/acronis-mcp/pkgs/container/acronis-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# MCP Registry ownership annotation (must match `name` in server.json)
LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/acronis-mcp"
