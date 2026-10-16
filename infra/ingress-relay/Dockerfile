# V7 F1 durable ingress relay (ADR-V7-08): one dependency-free file.
# Built and pushed to the private Artifact Registry in the maintenance window;
# deployed to Cloud Run (us-east1, min 0 / max 2) with its own identity.
FROM node:24.20.0-bookworm-slim
ARG SOURCE_SHA
LABEL org.opencontainers.image.revision="${SOURCE_SHA}"
ENV NODE_ENV=production
WORKDIR /app
COPY infra/ingress-relay/relay.mjs /app/relay.mjs
USER node
CMD ["node", "/app/relay.mjs"]
