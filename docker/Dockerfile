# syntax=docker/dockerfile:1.7
#
# One image, three entry points:
#   node dist/main.api.js      HTTP API (default command)
#   node dist/main.worker.js   sending, receipts, notifications
#   node dist/main.cli.js      admin commands
#
# Debian slim rather than Alpine: glibc keeps native modules and DNS behaviour
# predictable, and the size difference is small once node itself is counted.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    STORAGE_DIR=/data/storage \
    CONFIG_FILE=/config/pecmailer.yaml
WORKDIR /app

# Tini-less: node handles SIGTERM itself (see the shutdown hooks in main.*.ts),
# and the image is meant to run under an orchestrator that sends it properly.
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

RUN mkdir -p /data/storage /config && chown -R node:node /data /config
USER node
EXPOSE 3000
VOLUME ["/data/storage"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.api.js"]
