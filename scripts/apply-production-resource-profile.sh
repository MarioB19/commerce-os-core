#!/bin/sh
# Apply the reviewed n1-standard-4 resource profile during an authorized maintenance window.
set -eu
umask 077

release_env=${1:?Usage: apply-production-resource-profile.sh /private/release.env}
[ "$(id -u)" = 0 ] || { echo 'Run as root on the approved VPS' >&2; exit 2; }
cd "$(dirname "$0")/.."
test -s "$release_env"

cpu_count=$(getconf _NPROCESSORS_ONLN)
memory_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
[ "$cpu_count" -ge 4 ] || { echo 'RESOURCE_PROFILE_REQUIRES_4_VCPU' >&2; exit 2; }
[ "$memory_kib" -ge 14000000 ] || { echo 'RESOURCE_PROFILE_REQUIRES_14GB_RAM' >&2; exit 2; }
[ "$(df -Pk /opt/commerce-os | awk 'NR==2 {print $4}')" -ge 4194304 ] || { echo 'RESOURCE_PROFILE_REQUIRES_4GB_FREE_DISK' >&2; exit 2; }

compose() { sh scripts/compose-release.sh "$release_env" "$@"; }
restart_on_failure=0
recover_services() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$restart_on_failure" -eq 1 ]; then
    compose up -d --no-deps api ingress automation-worker channel-worker >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap recover_services EXIT
compose config --quiet
for service in postgres api ingress automation-worker channel-worker; do
  [ -n "$(compose ps -aq "$service")" ] || { echo "RESOURCE_PROFILE_MISSING_SERVICE:$service" >&2; exit 2; }
done

evidence_dir=$(sed -n 's/^COMMERCE_SECRETS_DIR=//p' "$release_env")/ownership-attestations
[ -d "$evidence_dir" ] || { echo 'RESOURCE_PROFILE_EVIDENCE_DIRECTORY_MISSING' >&2; exit 2; }
evidence=$(mktemp "$evidence_dir/resource-profile-XXXXXXXX.json")
python3 scripts/ownership-isolation-receipts.py capture "$release_env" "$evidence" >/dev/null
python3 scripts/ownership-isolation-receipts.py freeze "$release_env" >/dev/null

# PostgreSQL keeps its named volume. The app and workers remain stopped while its
# runtime limits and shared-memory setting are replaced from the reviewed Compose.
compose stop api ingress automation-worker channel-worker
restart_on_failure=1
compose up -d --no-deps --force-recreate --wait --wait-timeout 120 postgres
compose up -d --no-deps --force-recreate --wait --wait-timeout 120 api ingress automation-worker channel-worker
python3 scripts/ownership-isolation-receipts.py attest "$release_env" "$evidence" >/dev/null

for service in postgres api ingress automation-worker channel-worker; do
  state=$(compose ps --format json "$service" | python3 -c 'import json,sys; raw=sys.stdin.read().strip(); value=json.loads(raw); rows=value if isinstance(value,list) else [value]; print(rows[0].get("Health",rows[0].get("State","")) if len(rows)==1 else "")')
  case "$state" in healthy|running) ;; *) echo "RESOURCE_PROFILE_UNHEALTHY_SERVICE:$service" >&2; exit 2;; esac
done

restart_on_failure=0
echo 'Production resource profile applied. REAL remains frozen; renew owner authorization separately.'
