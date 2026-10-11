#!/bin/sh
set -eu
# Explicit administrative task. The Docker socket is never attached to runtime services.
action=${1:?Usage: maintenance.sh backup|restore /private/release.env [archive] [new_database]}
release_env=${2:?Private release.env required}
archive=${3:-}
new_database=${4:-}
case "$action" in backup|restore) ;; *) exit 2;; esac
read_value() { sed -n "s/^$1=//p" "$release_env"; }
maintenance_image=$(read_value COMMERCE_MAINTENANCE_IMAGE)
private_dir=$(read_value COMMERCE_SECRETS_DIR)
assets_dir=$(read_value COMMERCE_PRIVATE_ASSETS_DIR)
printf '%s\n' "$maintenance_image" | grep -Eq '^(sha256:[a-f0-9]{64}|[-a-zA-Z0-9._:/]+@sha256:[a-f0-9]{64})$' || { echo 'Pinned maintenance image required' >&2; exit 2; }
docker image inspect "$maintenance_image" >/dev/null
test -f "$private_dir/backup.env"
test -d "$assets_dir"
if [ -n "${COMMERCE_DEPLOYMENT_ATTEMPT:-}" ]; then
 printf '%s\n' "$COMMERCE_DEPLOYMENT_ATTEMPT" | grep -Eq '^deploy-[a-f0-9]{32}$' || exit 2
 set -- --label "com.commerce-os.deployment-attempt=$COMMERCE_DEPLOYMENT_ATTEMPT" --env "PGAPPNAME=$COMMERCE_DEPLOYMENT_ATTEMPT"
else set --; fi
if [ "$action" = restore ]; then
  archive=${archive:?Encrypted archive required}
  new_database=${new_database:?New commerce_restore_ database required}
  case "$archive" in "$private_dir"/*) ;; *) echo 'Copy the verified archive into the private configuration directory first' >&2; exit 2;; esac
  exec docker run "$@" --rm --network commerce-os_core --user 0:0 --security-opt no-new-privileges:true --env-file "$private_dir/backup.env" -v /var/run/docker.sock:/var/run/docker.sock -v "$private_dir:$private_dir" -v "$assets_dir:$assets_dir" "$maintenance_image" node scripts/restore.mjs "$archive" "$new_database"
fi
# Scheduled and predeploy backups share this host lock. Never run two full dumps
# and asset copies concurrently on the small production server.
exec 9>"$private_dir/maintenance-backup.lock"
flock -w 60 9 || { echo 'Backup already in progress' >&2; exit 75; }
exec docker run "$@" --rm --network commerce-os_core --user 0:0 --security-opt no-new-privileges:true --env-file "$private_dir/backup.env" -v /var/run/docker.sock:/var/run/docker.sock -v "$private_dir:$private_dir" -v "$assets_dir:$assets_dir" "$maintenance_image" node scripts/backup.mjs
