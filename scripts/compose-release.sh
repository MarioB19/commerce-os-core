#!/bin/sh
# One composition boundary for every install/check/update/rollback command.
# Environment files are data only: never source them or print rendered secrets.
set -eu
release_env=${1:?Usage: compose-release.sh /private/release.env compose-arguments...}
shift
cd "$(dirname "$0")/.."
test -s "$release_env"
read_value() { sed -n "s/^$1=//p" "$2"; }
private_dir=$(read_value COMMERCE_SECRETS_DIR "$release_env")
scope=$(read_value COMMERCE_DEPLOY_SCOPE "$release_env")
# V7 F1 PITR: once scripts/v7_pitr.py enable wrote the marker, PostgreSQL always
# renders with pgBackRest archiving. The overlay goes after every other overlay.
pitr_dir=${COMMERCE_PITR_DIR:-$private_dir/pitr}
if [ -e "$pitr_dir/enabled" ]; then
 test -s "$pitr_dir/pgbackrest.env" && test -s "$pitr_dir/pgbackrest.conf" || { echo 'PITR is enabled but its private configuration is missing.' >&2; exit 2; }
 export COMMERCE_PITR_DIR="$pitr_dir"
 pitr=1
else
 pitr=
fi
case "$scope" in ''|full) [ -z "$pitr" ] || set -- -f infra/compose/postgres-pitr.yaml "$@" ;; api-web)
 test -s "$private_dir/api-web-adoption.json" || { echo 'Adopted API/web state required' >&2; exit 2; }
 # Scope is stored in the protected release environment, including rollback.
 # A pilot overlay cannot silently select consumers on this recovered copy.
 test -z "${COMMERCE_PILOT_RELEASE_ENV:-$(read_value COMMERCE_PILOT_RELEASE_ENV "$release_env")}"
 [ -z "$pitr" ] || set -- -f infra/compose/postgres-pitr.yaml "$@"
 exec docker compose --env-file "$release_env" -f infra/compose/production.yaml -f infra/compose/copy-api-web.yaml "$@"
 ;; copy-runtime)
 test -s "$private_dir/api-web-adoption.json" || exit 2
 [ -z "$pitr" ] || set -- -f infra/compose/postgres-pitr.yaml "$@"
 set -- -f infra/compose/copy-api-web.yaml -f infra/compose/copy-runtime.yaml "$@"
 ;; *) echo 'Invalid deployment scope' >&2; exit 2;; esac
pilot_env=${COMMERCE_PILOT_RELEASE_ENV:-$(read_value COMMERCE_PILOT_RELEASE_ENV "$release_env")}
if [ -z "$pilot_env" ] && [ "$scope" != copy-runtime ]; then
 for candidate in "$private_dir/pilot-release.env" "$private_dir/pilot/pilot-release.env" /opt/commerce-os/pilot/pilot-release.env /opt/commerce-os/gateways/pilot-release.env /opt/commerce-os/gateways/pilot/pilot-release.env; do
  if [ -s "$candidate" ]; then
   [ -z "$pilot_env" ] || [ "$pilot_env" = "$candidate" ] || { echo 'Multiple pilot configurations found; set COMMERCE_PILOT_RELEASE_ENV explicitly.' >&2; exit 2; }
   pilot_env=$candidate
  fi
 done
fi
if [ -n "$pilot_env" ]; then
 test -s "$pilot_env" || { echo 'Configured pilot overlay is missing; refusing to remove gateway wiring.' >&2; exit 2; }
 gateway_dir=$(read_value COMMERCE_GATEWAY_CONFIG_DIR "$pilot_env")
 [ -n "$gateway_dir" ] || { echo 'Pilot overlay needs COMMERCE_GATEWAY_CONFIG_DIR.' >&2; exit 2; }
 for file in waha-01 channel-pilot ingress-pilot; do
  test -s "$gateway_dir/$file.env" || { echo 'Pilot configuration is incomplete; existing gateway wiring must be preserved.' >&2; exit 2; }
 done
 # Optional isolated slots are a canonical private overlay, not a replacement
 # of the pilot or its session. Include their wiring in every future release.
 extra_gateways="$private_dir/additional-gateways.json"
 if [ -e "$extra_gateways" ] || [ -L "$extra_gateways" ]; then
  python3 scripts/additional-gateways.py validate "$extra_gateways" "$gateway_dir" >/dev/null
  set -- -f "$extra_gateways" "$@"
 fi
 # An explicitly prepared offline credential replacement has a stable private override.
 if [ -s "$private_dir/waha-storage-overrides.json" ]; then
  exec docker compose --env-file "$release_env" --env-file "$pilot_env" -f infra/compose/production.yaml -f infra/compose/pilot.yaml -f "$private_dir/waha-storage-overrides.json" --profile waha-pilot "$@"
 fi
 exec docker compose --env-file "$release_env" --env-file "$pilot_env" -f infra/compose/production.yaml -f infra/compose/pilot.yaml --profile waha-pilot "$@"
fi
# Even a stopped gateway owns session storage and must not lose its wiring.
existing_gateway=$(docker ps -aq --filter label=com.docker.compose.project=commerce-os --filter label=com.docker.compose.service=waha-01)
[ -z "$existing_gateway" ] || { echo 'An existing pilot gateway requires COMMERCE_PILOT_RELEASE_ENV; refusing a core-only update.' >&2; exit 2; }
exec docker compose --env-file "$release_env" -f infra/compose/production.yaml "$@"
