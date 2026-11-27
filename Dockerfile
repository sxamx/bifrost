# syntax=docker/dockerfile:1
# ==============================================================================
# Stage 1: Build panel (React + Vite PWA) and core (Hono + TypeScript)
# ==============================================================================
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Install panel dependencies
COPY panel/package*.json ./panel/
RUN if [ -f panel/package-lock.json ]; then \
      npm --prefix panel ci; \
    else \
      npm --prefix panel install; \
    fi

# Install core dependencies
COPY core/package*.json ./core/
RUN if [ -f core/package-lock.json ]; then \
      npm --prefix core ci; \
    else \
      npm --prefix core install; \
    fi

# Copy root manifest, JSON schemas, node installer, and sources
COPY package.json ./package.json
COPY schemas ./schemas
COPY nodes/install-node.sh ./nodes/install-node.sh
COPY panel ./panel
COPY core ./core

# Build frontend panel (panel/dist) then backend core (core/dist)
RUN npm --prefix panel run build \
 && npm --prefix core run build \
 && npm --prefix core prune --omit=dev

# ==============================================================================
# Stage 2: Production runtime (non-root user, persistent /data)
# ==============================================================================
FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ARG BIFROST_BUILD_COMMIT=unknown

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    PANEL_DIST_DIR=/app/panel/dist \
    BIFROST_RUNTIME=docker \
    BIFROST_BUILD_COMMIT=$BIFROST_BUILD_COMMIT

WORKDIR /app

RUN mkdir -p /data /app/core /app/panel /app/schemas /app/nodes \
 && chmod 0700 /data \
 && chown -R node:node /data /app

COPY --from=builder --chown=node:node /app/package.json /app/package.json
COPY --from=builder --chown=node:node /app/schemas /app/schemas
COPY --from=builder --chown=node:node /app/nodes/install-node.sh /app/nodes/install-node.sh
COPY --from=builder --chown=node:node /app/panel/dist /app/panel/dist
COPY --from=builder --chown=node:node /app/core/package.json /app/core/package.json
COPY --from=builder --chown=node:node /app/core/node_modules /app/core/node_modules
COPY --from=builder --chown=node:node /app/core/dist /app/core/dist
COPY --chown=node:node scripts/docker-entrypoint.sh /app/docker-entrypoint.sh

RUN chmod 0755 /app/nodes/install-node.sh /app/docker-entrypoint.sh

VOLUME ["/data"]

USER node
WORKDIR /app/core

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/docker-entrypoint.sh"]
