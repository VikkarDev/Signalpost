# syntax=docker/dockerfile:1
# Signalpost production image. Builds on amd64 and arm64.

ARG NODE_IMAGE=node:24.21.0-alpine3.24

# ---- dependencies (production only, from the lockfile) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# ---- runtime ----
FROM ${NODE_IMAGE}
# iputils-ping: ping checks (uses unprivileged ICMP sockets, no root needed)
# tzdata: correct local day boundaries for uptime history
RUN apk add --no-cache iputils-ping tzdata \
 && mkdir -p /data \
 && chown node:node /data

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src
COPY --chown=root:root public ./public

USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -T 4 -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

STOPSIGNAL SIGTERM
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
