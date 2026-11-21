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
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG BIFROST_BUILD_COMMIT=unknown

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    PANEL_DIST_DIR=/app/panel/dist \
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

RUN chmod 0755 /app/nodes/install-node.sh

VOLUME ["/data"]

USER node
WORKDIR /app/core

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Enforce 0700 on DATA_DIR and 0600 on master.key.
# Generate a 32-byte master.key ONLY on a brand-new empty volume; never overwrite or regenerate if bifrost.db already exists.
CMD ["sh", "-c", "DATA_PATH=\"${DATA_DIR:-/data}\" && mkdir -p \"${DATA_PATH}\" && (chmod 0700 \"${DATA_PATH}\" 2>/dev/null || true) && if [ -z \"${BIFROST_MASTER_KEY:-}\" ] && [ ! -e \"${DATA_PATH}/master.key\" ] && [ ! -e \"${DATA_PATH}/bifrost.db\" ] && [ ! -e \"${DATA_PATH}/bifrost.db-wal\" ] && [ ! -e \"${DATA_PATH}/bifrost.db-shm\" ]; then node -e 'const fs=require(\"node:fs\"),crypto=require(\"node:crypto\"),dir=process.env.DATA_DIR||\"/data\",keyFile=dir+\"/master.key\";fs.mkdirSync(dir,{recursive:true,mode:0o700});try{fs.chmodSync(dir,0o700);}catch{}fs.writeFileSync(keyFile,crypto.randomBytes(32),{mode:0o600,flag:\"wx\"});fs.chmodSync(keyFile,0o600);'; elif [ -f \"${DATA_PATH}/master.key\" ]; then chmod 0600 \"${DATA_PATH}/master.key\" 2>/dev/null || true; fi && exec node dist/index.js"]
