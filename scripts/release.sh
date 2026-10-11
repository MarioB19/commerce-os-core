#!/bin/sh
set -eu
# Invoked by the authorized main-branch deployment or a reviewed manual release.
# Private env must define immutable digests, inspected proxy network and protected paths.
action=${1:-check}
release_env=${2:?Usage: release.sh check|deploy|rollback /private/release.env}
case "$action" in check|deploy|rollback) ;; *) exit 2;; esac
if [ -n "${COMMERCE_DEPLOYMENT_ATTEMPT:-}" ]; then
 printf '%s\n' "$COMMERCE_DEPLOYMENT_ATTEMPT" | grep -Eq '^deploy-[a-f0-9]{32}$' || exit 2
fi
docker_run() {
 if [ -n "${COMMERCE_DEPLOYMENT_ATTEMPT:-}" ]; then docker run --label "com.commerce-os.deployment-attempt=$COMMERCE_DEPLOYMENT_ATTEMPT" --env "PGAPPNAME=$COMMERCE_DEPLOYMENT_ATTEMPT" "$@";
 else docker run "$@"; fi
}
# Read fixed data keys without sourcing the file as executable shell code.
read_value() { sed -n "s/^$1=//p" "$release_env"; }
COMMERCE_IMAGE=$(read_value COMMERCE_IMAGE)
COMMERCE_WEB_IMAGE=$(read_value COMMERCE_WEB_IMAGE)
COMMERCE_SECRETS_DIR=$(read_value COMMERCE_SECRETS_DIR)
COMMERCE_PRIVATE_ASSETS_DIR=$(read_value COMMERCE_PRIVATE_ASSETS_DIR)
COMMERCE_PROXY_NETWORK=$(read_value COMMERCE_PROXY_NETWORK)
COMMERCE_ORIGIN=$(read_value COMMERCE_ORIGIN)
scope=$(read_value COMMERCE_DEPLOY_SCOPE)
case "$scope" in ''|full) scope=full;; api-web|copy-runtime) ;; *) echo 'Invalid deployment scope' >&2; exit 2;; esac
if [ -n "${COMMERCE_DEPLOY_SCOPE:-}" ]; then [ "$scope" = "$COMMERCE_DEPLOY_SCOPE" ]; fi
export COMMERCE_IMAGE COMMERCE_WEB_IMAGE COMMERCE_SECRETS_DIR COMMERCE_PRIVATE_ASSETS_DIR COMMERCE_PROXY_NETWORK COMMERCE_ORIGIN
validate_image() {
  image_ref=$1
  printf '%s\n' "$image_ref" | grep -Eq '^(sha256:[a-f0-9]{64}|[-a-zA-Z0-9._:/]+@sha256:[a-f0-9]{64})$' || { echo 'Immutable registry digest or loaded sha256 image ID required' >&2; exit 2; }
  if ! docker image inspect "$image_ref" >/dev/null 2>&1; then
    case "$image_ref" in
      sha256:*) echo 'Pinned image is not loaded; verify the release archive and run docker load first' >&2; exit 2;;
      *) docker pull "$image_ref" >/dev/null;;
    esac
  fi
  image_arch=$(docker image inspect --format '{{.Architecture}}' "$image_ref")
  [ "$image_arch" = amd64 ] || { echo 'Release image must be linux/amd64 for the inspected VPS' >&2; exit 2; }
  image_os=$(docker image inspect --format '{{.Os}}' "$image_ref")
  [ "$image_os" = linux ] || { echo 'Release image must target Linux' >&2; exit 2; }
}
validate_image "$COMMERCE_IMAGE"
validate_image "$COMMERCE_WEB_IMAGE"
# Earlier releases enforce environment flags, so freezing the database cannot
# protect their workers. Reject that downgrade before any process/DB mutation.
if [ "$action" = rollback ]; then
  if ! docker_run --rm --network none --read-only --cap-drop ALL "$COMMERCE_IMAGE" node -e "if(!require('node:fs').existsSync('/app/packages/db/src/warmup.ts'))process.exit(42)"; then
    echo 'Rollback target lacks internal warm-up effect compatibility. Use the first verified compatible base or a newer release; never downgrade after internal effects exist.' >&2
    exit 2
  fi
  if ! docker_run --rm --network none --read-only --cap-drop ALL "$COMMERCE_IMAGE" node -e "if(!require('node:fs').existsSync('/app/packages/db/src/operational-settings.ts'))process.exit(42)"; then
    echo 'Rollback target does not support database operational policy; use a reviewed legacy frozen deployment procedure.' >&2
    exit 2
  fi
fi
compose() { sh scripts/compose-release.sh "$release_env" "$@"; }
compose config --quiet
docker network inspect "$COMMERCE_PROXY_NETWORK" >/dev/null
test -d "$COMMERCE_PRIVATE_ASSETS_DIR"
test -f "$COMMERCE_SECRETS_DIR/admin.env"
for file in api ingress automation channel postgres admin; do test -s "$COMMERCE_SECRETS_DIR/$file.env"; done
# Check the bind mount as the actual runtime UID without mutating application data.
docker_run --rm --network none --read-only --cap-drop ALL --user 1000:1000 -v "$COMMERCE_PRIVATE_ASSETS_DIR:/data/private" "$COMMERCE_IMAGE" node -e "require('node:fs').accessSync('/data/private',require('node:fs').constants.R_OK|require('node:fs').constants.W_OK)"
if [ "$action" = check ]; then
  echo 'Configuration valid. No production changes made. Caddy/TLS, backup and capacity review remain release gates.'
  exit 0
fi
if [ "$scope" = api-web ]; then
 # The controller verified complete migration equality and the frozen/paused
 # baseline under all four locks. This branch performs no SQL maintenance,
 # ownership freeze, bootstrap, legacy import or consumer start.
 [ "${COMMERCE_API_WEB_LOCKS_HELD:-}" = 1 ]
 test -s "$COMMERCE_SECRETS_DIR/api-web-adoption.json"
 test -z "$(compose ps -aq ingress automation-worker channel-worker)"
 compose up -d --no-deps --force-recreate --pull never --wait --wait-timeout 120 api web
 echo 'Selected API/web images started; consumers remain absent.'
 exit 0
fi
if [ "$scope" = copy-runtime ]; then
 [ "${COMMERCE_COPY_RUNTIME_LOCKS_HELD:-}" = 1 ]
 test -s "$COMMERCE_SECRETS_DIR/api-web-adoption.json"
 # The protected controller owns canonical migrations, hold and queue gates.
 # No general migration, roles, freeze, bootstrap or import in this branch.
 case "${COMMERCE_COPY_RUNTIME_PHASE:-}" in
  core) test -z "$(compose ps -aq ingress automation-worker channel-worker)";
   compose up -d --no-deps --force-recreate --pull never --wait --wait-timeout 120 api web;;
  consumers) compose up -d --no-deps --force-recreate --pull never --wait --wait-timeout 120 ingress automation-worker channel-worker;;
  runtime) compose up -d --no-deps --force-recreate --pull never --wait --wait-timeout 120 api web ingress automation-worker channel-worker;;
  *) echo 'Explicit copy-runtime phase required' >&2; exit 2;;
 esac
 echo 'Selected copy phase started. Root verification and CAS remain required.'
 exit 0
fi
install -d -m 700 "$COMMERCE_SECRETS_DIR/ownership-attestations"
export COMMERCE_OWNERSHIP_HISTORY_DIR="$COMMERCE_SECRETS_DIR/ownership-attestations"
ownership_evidence=$(mktemp "$COMMERCE_SECRETS_DIR/ownership-attestations/release-XXXXXXXX.json")
original_capture=
if [ -n "${COMMERCE_DEPLOYMENT_STATE_DIR:-}" ]; then
 test -d "$COMMERCE_DEPLOYMENT_STATE_DIR"
 if [ "$action" = rollback ] && [ -s "$COMMERCE_DEPLOYMENT_STATE_DIR/ownership-before.json" ]; then
  original_capture="$COMMERCE_DEPLOYMENT_STATE_DIR/ownership-before.json"
 elif [ "$action" = deploy ]; then
  test ! -e "$COMMERCE_DEPLOYMENT_STATE_DIR/ownership-before.json"
  rm -f "$ownership_evidence"
  ownership_evidence="$COMMERCE_DEPLOYMENT_STATE_DIR/ownership-before.json"
 fi
fi
export COMMERCE_OWNERSHIP_RECOVERY_CAPTURE="${original_capture:-$ownership_evidence}"
support_action=supports
hold_action=hold
if [ "$action" = rollback ]; then support_action=supports-recovery; hold_action=hold-recovery; fi
continuity=$(python3 scripts/ownership-isolation-receipts.py "$support_action" "$release_env")
# The fresh capture can prove a candidate owner acquired after install. The
# original capture separately preserves a stopped old owner after a long failure.
python3 scripts/ownership-isolation-receipts.py capture "$release_env" "$ownership_evidence"
# The first compatible release uses the old full freeze. Subsequent compatible
# releases install a temporary database hold without changing commercial grants.
if [ "$continuity" = 1 ]; then
  python3 scripts/ownership-isolation-receipts.py "$hold_action" "$release_env"
else
  python3 scripts/ownership-isolation-receipts.py freeze "$release_env"
fi
compose stop api automation-worker channel-worker
if [ "$action" = rollback ]; then
  # Supply the PREVIOUS release.env. Never roll back PostgreSQL schema or restore blindly.
  compose up -d --no-deps --force-recreate --wait --wait-timeout 120 api ingress automation-worker channel-worker web
  python3 scripts/ownership-isolation-receipts.py attest "$release_env" "$ownership_evidence"
  if [ -n "$original_capture" ]; then python3 scripts/ownership-isolation-receipts.py attest "$release_env" "$original_capture"; fi
  if [ "$continuity" = 1 ]; then python3 scripts/ownership-isolation-receipts.py release "$release_env"; fi
  echo 'Previous images started. Verify the REAL hold, policy, ownership and health.'
  exit 0
fi
# Existing POC/Caddy stay untouched. Backup current Commerce DB before a subsequent migration.
# Routine application releases never update/recreate an existing database server.
# A PostgreSQL image/configuration upgrade is a separate maintenance operation.
if [ -z "$(compose ps -aq postgres)" ]; then compose pull postgres; fi
compose up -d --no-recreate --wait postgres
if [ "$continuity" != 1 ]; then python3 scripts/ownership-isolation-receipts.py freeze "$release_env"; fi
docker_run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:size=64m,noexec,nosuid --network commerce-os_core --env-file "$COMMERCE_SECRETS_DIR/admin.env" "$COMMERCE_IMAGE" node --import tsx packages/db/src/migrate.ts
# Initial installation only. File is private because it contains generated login passwords.
if [ -f "$COMMERCE_SECRETS_DIR/runtime-roles.sql" ]; then
  if [ -n "${COMMERCE_DEPLOYMENT_ATTEMPT:-}" ]; then
    compose exec -T --env "PGAPPNAME=$COMMERCE_DEPLOYMENT_ATTEMPT" postgres psql -v ON_ERROR_STOP=1 -U commerce_owner -d commerce < "$COMMERCE_SECRETS_DIR/runtime-roles.sql"
  else compose exec -T postgres psql -v ON_ERROR_STOP=1 -U commerce_owner -d commerce < "$COMMERCE_SECRETS_DIR/runtime-roles.sql"; fi
  mv "$COMMERCE_SECRETS_DIR/runtime-roles.sql" "$COMMERCE_SECRETS_DIR/runtime-roles.applied.private"
fi
docker_run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:size=64m,noexec,nosuid --network commerce-os_core --env-file "$COMMERCE_SECRETS_DIR/admin.env" "$COMMERCE_IMAGE" node --import tsx scripts/bootstrap.ts
docker_run --rm --user 0:0 --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:size=64m,noexec,nosuid --network commerce-os_core --env-file "$COMMERCE_SECRETS_DIR/admin.env" -v "$COMMERCE_SECRETS_DIR:/private:ro" "$COMMERCE_IMAGE" node --import tsx scripts/import-legacy-operational-config.ts --dir /private
compose up -d --no-deps --force-recreate --wait --wait-timeout 120 api ingress automation-worker channel-worker web
python3 scripts/ownership-isolation-receipts.py attest "$release_env" "$ownership_evidence"
if [ "$continuity" = 1 ]; then python3 scripts/ownership-isolation-receipts.py release "$release_env"; fi
echo 'Commerce services started. Verify REAL hold, policy, ownership and health; Caddy installation and TLS are a separate approved step.'
