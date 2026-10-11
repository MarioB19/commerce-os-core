#!/bin/sh
# Install an approved release; preserve the previous configuration and back up before updates.
set -eu
umask 077
owner_email=${1:?Usage: install-vps.sh owner-email [/private/pilot-release.env]}
phase=${COMMERCE_INSTALL_PHASE:-all}
case "$phase" in all|prepare|activate) ;; *) echo 'Invalid install phase' >&2; exit 2;; esac
scope=${COMMERCE_DEPLOY_SCOPE:-full}
case "$scope" in full) ;; api-web)
 [ "$phase" != all ] && [ -s /opt/commerce-os/private/api-web-adoption.json ]
 [ -s /opt/commerce-os/private/release.env ]
 if [ "$phase" = activate ]; then [ "${COMMERCE_API_WEB_LOCKS_HELD:-}" = 1 ]; fi
 ;; copy-runtime)
 [ "$phase" != all ] && [ -s /opt/commerce-os/private/api-web-adoption.json ]
 [ -s /opt/commerce-os/private/release.env ]
 if [ "$phase" = activate ]; then [ "${COMMERCE_COPY_RUNTIME_LOCKS_HELD:-}" = 1 ]; fi
 ;; *) echo 'Invalid deployment scope' >&2; exit 2;; esac
if [ -n "${COMMERCE_DEPLOYMENT_ATTEMPT:-}" ]; then
 printf '%s\n' "$COMMERCE_DEPLOYMENT_ATTEMPT" | grep -Eq '^deploy-[a-f0-9]{32}$' || exit 2
fi
docker_run() {
 if [ -n "${COMMERCE_DEPLOYMENT_ATTEMPT:-}" ]; then docker run --label "com.commerce-os.deployment-attempt=$COMMERCE_DEPLOYMENT_ATTEMPT" --env "PGAPPNAME=$COMMERCE_DEPLOYMENT_ATTEMPT" "$@";
 else docker run "$@"; fi
}
backup_env=
cleanup_backup_env() {
  if [ -n "$backup_env" ]; then
    rm -f "$backup_env"
  fi
}
trap cleanup_backup_env EXIT
# Explicit pilot path is persisted for all future compose operations.
if [ -n "${2:-}" ]; then export COMMERCE_PILOT_RELEASE_ENV=$2; fi
[ "$(id -u)" = 0 ] || { echo 'Run as root on the approved VPS' >&2; exit 2; }
cd "$(dirname "$0")/.."
[ -s images.tar.gz ] && [ -s images.sha256 ] && [ -s PACKAGE.sha256 ]
sha256sum --check PACKAGE.sha256
sha256sum --check images.sha256
[ "$(uname -m)" = x86_64 ]
if [ "$scope" = api-web ] || [ "$scope" = copy-runtime ]; then
 proxy=$(sed -n 's/^COMMERCE_PROXY_NETWORK=//p' /opt/commerce-os/private/release.env)
 [ -n "$proxy" ]
 docker network inspect "$proxy" >/dev/null
else
 docker network inspect vibe-conversa_default >/dev/null
fi
test -f scripts/maintenance.sh
if [ "$phase" != activate ]; then docker load --input images.tar.gz; fi
runtime=$(docker image inspect commerce-os:release --format '{{.Id}}')
web=$(docker image inspect commerce-os-web:release --format '{{.Id}}')
maintenance=$(docker image inspect commerce-os-maintenance:release --format '{{.Id}}')
for img in "$runtime" "$web" "$maintenance"; do
  [ "$(docker image inspect "$img" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64 ]
done
if [ "$phase" != activate ] && [ -s /opt/commerce-os/private/release.env ]; then
  sh scripts/compose-release.sh /opt/commerce-os/private/release.env config --quiet
  # Back up with the candidate maintenance image so a backup-boundary fix can
  # safely bootstrap itself. Loading the image does not change running services.
  backup_env=$(mktemp /opt/commerce-os/private/predeploy-backup.XXXXXX.env)
  python3 - /opt/commerce-os/private/release.env "$backup_env" "$maintenance" <<'PY'
from pathlib import Path
import re
import sys

source = Path(sys.argv[1])
target = Path(sys.argv[2])
image = sys.argv[3]
if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
    raise SystemExit('Pinned candidate maintenance image required')
lines = source.read_text().splitlines()
matches = [index for index, line in enumerate(lines) if line.startswith('COMMERCE_MAINTENANCE_IMAGE=')]
if len(matches) != 1:
    raise SystemExit('Existing release needs exactly one maintenance image setting')
lines[matches[0]] = 'COMMERCE_MAINTENANCE_IMAGE=' + image
target.write_text('\n'.join(lines) + '\n')
target.chmod(0o600)
PY
  # The installed scheduler already uses this lock, including releases before
  # maintenance.sh gained its own lock. Preserve the same lock acquisition order.
  exec 8>/opt/commerce-os/private/backup-schedule.lock
  flock -w 60 8 || { echo 'Scheduled backup already in progress' >&2; exit 75; }
  sh scripts/maintenance.sh backup "$backup_env"
  flock -u 8
  exec 8>&-
  rm -f "$backup_env"
  backup_env=
  install -d -m 700 /opt/commerce-os/private/release-history
  previous=/opt/commerce-os/private/release-history/release-$(date -u +%Y%m%dT%H%M%SZ).env
  cp /opt/commerce-os/private/release.env "$previous"
  chmod 600 "$previous"
fi
# Preparation cannot change configuration or stop/recreate application services.
# The deploy controller only enables runtime rollback after this boundary.
if [ "$phase" = prepare ]; then exit 0; fi
install -d -m 700 /opt/commerce-os/private
if [ ! -s /opt/commerce-os/private/release.env ]; then
 [ "$scope" = full ]
 docker_run --rm --user 0:0 --read-only --cap-drop ALL --network none \
  -v /opt/commerce-os/private:/opt/commerce-os/private "$runtime" \
  node scripts/prepare-production.mjs /opt/commerce-os/private https://commerce-os.inovaris.online vibe-conversa_default
fi
if [ "$scope" != copy-runtime ] || [ "${COMMERCE_COPY_RUNTIME_PHASE:-}" != consumers ]; then
python3 - "$runtime" "$web" "$maintenance" "$owner_email" RELEASE.json <<'PY'
from pathlib import Path
import json,re,sys,os
base=Path('/opt/commerce-os/private')
def update(file,changes):
 p=base/file
 data=dict(line.split('=',1) for line in p.read_text().splitlines() if line and not line.startswith('#'))
 if file=='release.env' and data.get('COMMERCE_ORIGIN')!='https://commerce-os.inovaris.online':
  raise SystemExit('Refusing an unexpected existing origin')
 data.update(changes)
 p.write_text(''.join(k+'='+v+'\n' for k,v in data.items()))
 p.chmod(0o600)
metadata=json.loads(Path(sys.argv[5]).read_text())
source_sha=str(metadata.get('source_sha',''))
if not re.fullmatch(r'[a-f0-9]{40}',source_sha): raise SystemExit('Exact release source SHA required')
run_id=str(metadata.get('run_id') or 'manual')
if not re.fullmatch(r'[A-Za-z0-9._-]{1,80}',run_id): raise SystemExit('Safe release run id required')
release_id='ci-'+run_id+'-'+source_sha[:10]
release_changes=dict(zip(('COMMERCE_IMAGE','COMMERCE_WEB_IMAGE','COMMERCE_MAINTENANCE_IMAGE'),sys.argv[1:4]))
release_changes.update({'COMMERCE_RELEASE_SHA':source_sha,'COMMERCE_RELEASE_ID':release_id})
if os.environ.get('COMMERCE_PILOT_RELEASE_ENV'):
 pilot=Path(os.environ['COMMERCE_PILOT_RELEASE_ENV'])
 if not pilot.is_absolute() or not pilot.is_file(): raise SystemExit('An existing absolute pilot-release.env path is required')
 release_changes['COMMERCE_PILOT_RELEASE_ENV']=str(pilot)
update('release.env',release_changes)
update('api.env',{'COMMERCE_DEPLOYMENT_STATUS':'DEPLOYING'})
p=base/'admin.env'
if os.environ.get('COMMERCE_DEPLOY_SCOPE','full')=='full' and 'BOOTSTRAP_EMAIL=REPLACE_WITH_OWNER_EMAIL' in p.read_text():
 if '@' not in sys.argv[4] or any(x in sys.argv[4] for x in '\n\r '): raise SystemExit('Valid owner email required')
 update('admin.env',{'BOOTSTRAP_EMAIL':sys.argv[4]})
for p in base.iterdir():
 if p.is_file(): p.chmod(0o600)
if os.environ.get('COMMERCE_DEPLOY_SCOPE','full')=='full':
 assets=base/'assets'
 assets.mkdir(exist_ok=True)
 os.chown(assets,1000,1000)
 assets.chmod(0o700)
PY
fi
sh scripts/release.sh check /opt/commerce-os/private/release.env
sh scripts/release.sh deploy /opt/commerce-os/private/release.env
if [ "$scope" != copy-runtime ] || [ "${COMMERCE_COPY_RUNTIME_PHASE:-}" != consumers ]; then
python3 - <<'PY'
from pathlib import Path
p=Path('/opt/commerce-os/private/api.env')
data=dict(line.split('=',1) for line in p.read_text().splitlines() if line and not line.startswith('#'))
data['COMMERCE_DEPLOYMENT_STATUS']='DEPLOYED'
data.setdefault('COMMERCE_EXTERNAL_MONITOR_STATUS','NOT_INSTALLED')
p.write_text(''.join(k+'='+v+'\n' for k,v in data.items()))
p.chmod(0o600)
PY
sh scripts/compose-release.sh /opt/commerce-os/private/release.env up -d --no-deps --wait --wait-timeout 120 api
fi
# Preserve successful release location; Caddy/DNS are applied only after health verification.
if [ "$scope" = api-web ] || [ "$scope" = copy-runtime ]; then
 python3 - "$PWD" <<'PY'
from pathlib import Path
import os,tempfile
base=Path('/opt/commerce-os')
with tempfile.TemporaryDirectory(prefix='.api-web-current-',dir=base) as directory:
 link=Path(directory)/'current'
 link.symlink_to(Path(__import__('sys').argv[1]),target_is_directory=True)
 os.replace(link,base/'current')
 descriptor=os.open(base,os.O_RDONLY|os.O_DIRECTORY)
 try: os.fsync(descriptor)
 finally: os.close(descriptor)
PY
else
 ln -sfn "$PWD" /opt/commerce-os/current
fi
printf '%s\n' 'Core installed. Verify REAL hold, policy, per-number ownership, backup, Caddy and HTTPS.'
