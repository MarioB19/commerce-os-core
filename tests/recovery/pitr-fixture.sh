#!/usr/bin/env bash
# Synthetic only. No production endpoints, mounts, passwords or cloud access.
set -euo pipefail
umask 077
base=/tmp/commerce-pitr-fixture
mkdir "$base"
mkdir "$base/repo" "$base/socket" "$base/log" "$base/lock"
export PGBACKREST_REPO1_CIPHER_PASS
PGBACKREST_REPO1_CIPHER_PASS="$(openssl rand -hex 32)"
export PGBACKREST_CONFIG="$base/pgbackrest.conf"
cat > "$PGBACKREST_CONFIG" <<EOF
[global]
repo1-type=posix
repo1-path=$base/repo
repo1-cipher-type=aes-256-cbc
repo1-retention-full-type=time
repo1-retention-full=7
repo1-retention-archive-type=full
compress-type=zst
compress-level=3
process-max=1
archive-async=n
archive-check=y
archive-copy=y
start-fast=y
log-level-console=error
log-level-file=off
lock-path=$base/lock
[commerce]
pg1-path=$base/primary
pg1-socket-path=$base/socket
pg1-user=fixture
pg1-database=postgres
EOF
initdb -D "$base/primary" -U fixture --auth=trust --no-locale > "$base/log/init.log"
cat >> "$base/primary/postgresql.conf" <<EOF
listen_addresses = ''
unix_socket_directories = '$base/socket'
wal_level = replica
archive_mode = on
archive_timeout = 60
archive_command = 'pgbackrest --stanza=commerce archive-push %p'
max_wal_size = '64MB'
shared_buffers = '32MB'
EOF
cleanup(){
 for directory in primary restored latest broken broken-chain;do
  if [[ -f "$base/$directory/postmaster.pid" ]];then pg_ctl -D "$base/$directory" -m immediate -w stop > /dev/null 2>&1 || true;fi
 done
 unset PGBACKREST_REPO1_CIPHER_PASS
}
trap cleanup EXIT
pg_ctl -D "$base/primary" -l "$base/log/primary.log" -w start > /dev/null
psql=(psql -X -v ON_ERROR_STOP=1 -h "$base/socket" -U fixture -d postgres -At)
pgbackrest --stanza=commerce stanza-create
pgbackrest --stanza=commerce check
"${psql[@]}" -c 'CREATE TABLE payments(id integer PRIMARY KEY, amount_cents bigint NOT NULL); INSERT INTO payments VALUES(1,10000);' > /dev/null
pgbackrest --stanza=commerce --type=full backup
full_label=$(pgbackrest --stanza=commerce --output=json info | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["backup"][-1]["label"])')
"${psql[@]}" -c 'INSERT INTO payments VALUES(2,20000);' > /dev/null
"${psql[@]}" -c "SELECT pg_create_restore_point('commerce_fixture_before_delete');" > /dev/null
target_wal=$("${psql[@]}" -c 'SELECT pg_walfile_name(pg_current_wal_lsn());')
"${psql[@]}" -c 'DELETE FROM payments;' > /dev/null
"${psql[@]}" -c 'SELECT pg_switch_wal();' > /dev/null
pgbackrest --stanza=commerce check
pgbackrest --stanza=commerce --type=incr backup
[[ $("${psql[@]}" -c 'SELECT count(*) FROM payments') == 0 ]]
pg_ctl -D "$base/primary" -m fast -w stop > /dev/null
pgbackrest --stanza=commerce --pg1-path="$base/restored" --set="$full_label" --type=name --target=commerce_fixture_before_delete --target-action=pause restore
pg_ctl -D "$base/restored" -l "$base/log/restored.log" -o "-c archive_mode=off" -w start > /dev/null
# Wait for the named recovery target, not merely socket readiness.
for ((n=0;n<60;n++));do
 state=$("${psql[@]}" -c 'SELECT pg_is_wal_replay_paused()' 2>/dev/null || true)
 [[ "$state" == t ]] && break
 sleep 1
done
[[ "$state" == t ]]
[[ $("${psql[@]}" -c "SELECT string_agg(id::text,',' ORDER BY id)||':'||sum(amount_cents) FROM payments") == '1,2:30000' ]]
pg_ctl -D "$base/restored" -m fast -w stop > /dev/null
# Latest incremental recovers the later destructive synthetic transaction.
pgbackrest --stanza=commerce --pg1-path="$base/latest" --type=immediate --target-action=promote restore
pg_ctl -D "$base/latest" -l "$base/log/latest.log" -o "-c archive_mode=off" -w start > /dev/null
[[ $("${psql[@]}" -c 'SELECT count(*) FROM payments') == 0 ]]
pg_ctl -D "$base/latest" -m fast -w stop > /dev/null
# Wrong-key authentication/readback must fail before writing a restored cluster.
if PGBACKREST_REPO1_CIPHER_PASS=synthetic-wrong-key pgbackrest --stanza=commerce --pg1-path="$base/broken" restore > "$base/log/wrong-key.log" 2>&1;then exit 61;fi
[[ ! -e "$base/broken/PG_VERSION" ]]
# Removing a required synthetic WAL must never produce a writable successful
# recovery, even though the base backup itself remains authenticated.
python3 - "$base" "$target_wal" <<'WAL'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]);wal=sys.argv[2];assert re.fullmatch('[A-F0-9]{24}',wal)
files=[q for q in (p/'repo/archive').rglob(wal+'-*')if q.is_file()];assert len(files)==1
(p/'quarantine').mkdir();files[0].rename(p/'quarantine'/files[0].name)
WAL
pgbackrest --stanza=commerce --pg1-path="$base/broken-chain" --set="$full_label" --type=name --target=commerce_fixture_before_delete --target-action=pause restore
pg_ctl -D "$base/broken-chain" -l "$base/log/broken-chain.log" -o "-c archive_mode=off" -t 15 -w start > "$base/log/broken-chain-start.log" 2>&1 || true
for ((n=0;n<20;n++));do
 if ! pg_ctl -D "$base/broken-chain" status > /dev/null 2>&1;then break;fi
 sleep 1
done
if pg_ctl -D "$base/broken-chain" status > /dev/null 2>&1;then exit 62;fi
python3 - "$base/log/broken-chain.log" <<'CHAIN'
import pathlib,sys
raw=pathlib.Path(sys.argv[1]).read_bytes();assert len(raw)<=65536
assert b'recovery ended before configured recovery target was reached' in raw
CHAIN
# Repository payload is compressed+encrypted, not a plaintext table dump.
python3 - "$base" <<'PY'
import hashlib,json,pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1]);files=[q for q in (p/'repo').rglob('*')if q.is_file()]
info=json.loads(subprocess.check_output(['pgbackrest','--stanza=commerce','--output=json','info']))[0]
assert info['cipher']=='aes-256-cbc'
assert len(info['backup'])==2 and {x['type']for x in info['backup']}=={'full','incr'}
print(json.dumps({'state':'SYNTHETIC_POSTGRES_PITR_VERIFIED','postgres':subprocess.check_output(['postgres','--version'],text=True).strip(),'pgbackrest':subprocess.check_output(['pgbackrest','version'],text=True).strip(),'full_and_incremental':True,'named_target_money_cents':30000,'named_target_ids':[1,2],'latest_after_delete_rows':0,'wrong_key_rejected_before_cluster_write':True,'missing_required_wal_rejects_target_recovery':True,'repository_cipher':info['cipher'],'repository_files':len(files),'repository_bytes':sum(q.stat().st_size for q in files),'production_data':False,'cloud_effects':0,'production_rpo_or_rto_proven':False}))
PY
