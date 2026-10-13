# Production PostgreSQL 17 with pgBackRest (V7 F1 PITR). Same base as the
# running service (postgres:17.11-bookworm, multi-arch index digest) plus one
# pinned PGDG package. Built on the host during the maintenance window by
# scripts/v7_pitr.py build-image; the previous image stays for rollback.
FROM postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
ARG PGBACKREST_VERSION=2.59.3-1.pgdg12+1
RUN apt-get update \
    && apt-get install -y --no-install-recommends "pgbackrest=${PGBACKREST_VERSION}" ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o postgres -g postgres -m 0750 /var/run/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest \
    && install -d -o root -g postgres -m 0750 /etc/pgbackrest \
    && rm -f /etc/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf \
    && pgbackrest version
LABEL org.opencontainers.image.title="commerce-os-postgres-pitr" \
      com.inovaris.commerce.pgbackrest="${PGBACKREST_VERSION}"
