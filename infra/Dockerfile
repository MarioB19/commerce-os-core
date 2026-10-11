# Build off the VPS. All runtime services are independently executable from the same immutable release.
FROM node:24.20.0-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.34.5
# Dependency downloads survive ordinary source edits in the BuildKit cache.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm typecheck && pnpm build
RUN node scripts/stage-runtime.mjs /runtime-source
# Only production server dependencies reach the VPS. Production belongs to the independent Codex factory.
RUN pnpm --filter commerce-os deploy --legacy --prod /runtime-server

FROM node:24.20.0-bookworm-slim AS runtime
ARG SOURCE_SHA
LABEL org.opencontainers.image.revision="${SOURCE_SHA}"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /runtime-server/node_modules ./node_modules
COPY --from=build --chown=node:node /runtime-source/packages ./packages
COPY --from=build --chown=node:node /runtime-source/apps/api ./apps/api
COPY --from=build --chown=node:node /runtime-source/apps/automation-worker ./apps/automation-worker
COPY --from=build --chown=node:node /runtime-source/apps/channel-worker ./apps/channel-worker
COPY --from=build --chown=node:node /runtime-source/apps/ingress ./apps/ingress
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /runtime-source/scripts ./scripts
USER node
CMD ["node", "dist/apps/api/index.js"]

FROM caddy:2.11.4-alpine AS web
ARG SOURCE_SHA
LABEL org.opencontainers.image.revision="${SOURCE_SHA}"
# Static port 8080 needs no privileged bind; file capabilities conflict with cap_drop ALL.
RUN setcap -r /usr/bin/caddy
COPY --from=build /app/apps/web/dist /srv
COPY infra/caddy/static.Caddyfile /etc/caddy/Caddyfile

# Invoked only for explicit maintenance; never runs as an application service.
FROM docker:29.8.0-cli AS docker-cli
FROM runtime AS maintenance
ARG SOURCE_SHA
LABEL org.opencontainers.image.revision="${SOURCE_SHA}"
USER root
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN docker --version
CMD ["node", "scripts/backup.mjs"]
