# syntax=docker/dockerfile:1.7
#
# One image, two entry points:
#   node dist/main.js       the container: one tenant, one mailbox (default command)
#   node dist/main.cli.js   admin and development commands
#
# Debian slim rather than Alpine: glibc keeps DNS behaviour predictable (the
# PEC recipient check resolves MX records), and the size difference is small
# once node itself is counted.

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
    HEALTH_PORT=3001
WORKDIR /app

# No init process: node handles SIGTERM itself (see main.ts), and the image is
# meant to run under an orchestrator that sends it properly.
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Nothing is written to disk: no volume, and the file system can be read-only.
USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||3001)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
