#!/bin/sh
# Add only the approved Commerce site; preserve the mounted file inode and an exact rollback copy.
set -eu
[ "$(id -u)" = 0 ]
cd "$(dirname "$0")/.."
proxy=vibe-conversa-caddy-1
source_path=$(docker inspect "$proxy" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')
[ -f "$source_path" ]
[ -f infra/caddy/commerce.Caddyfile ]
backup_dir=/opt/commerce-os/private/caddy-backups
install -d -m 700 "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$backup_dir/Caddyfile.$stamp"
staged="$backup_dir/combined.$stamp"
python3 - "$source_path" "$backup" "$staged" <<'PY'
from pathlib import Path
import sys,shutil
source,backup,staged=map(Path,sys.argv[1:])
old=source.read_bytes()
if b'commerce-os.inovaris.online' in old:
 raise SystemExit('Commerce site already present: inspect it before changing, refusing duplicate')
shutil.copy2(source,backup)
backup.chmod(0o600)
staged.write_bytes(old.rstrip()+b'\n\n'+Path('infra/caddy/commerce.Caddyfile').read_bytes())
staged.chmod(0o600)
PY
docker cp "$staged" "$proxy:/tmp/commerce-candidate.Caddyfile"
docker exec "$proxy" caddy validate --config /tmp/commerce-candidate.Caddyfile --adapter caddyfile
# Keep the bind-mounted inode. A rename would leave the old inode mounted in the running container.
cat "$staged" > "$source_path"
if ! docker exec "$proxy" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
 cat "$backup" > "$source_path"
 docker exec "$proxy" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
 echo 'Reload failed; previous Caddy configuration restored' >&2
 exit 1
fi
printf '%s\n' "$backup" > /opt/commerce-os/private/caddy-rollback-path
chmod 600 /opt/commerce-os/private/caddy-rollback-path
docker exec "$proxy" rm /tmp/commerce-candidate.Caddyfile
printf '%s\n' 'Commerce HTTPS site added; previous POC configuration preserved. Verify external TLS.'
