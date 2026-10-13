"""Closed pgBackRest configuration and retention/capacity assessment, no I/O.

The installer owns physical identities, secret delivery, service roles and all
four locks. This module never changes PostgreSQL or declares production ready.
"""
import re

def need(value,code):
    if not value:raise RuntimeError(code)

def configuration(*,bucket,region,primary_region,cluster_id,pg_user='commerce_owner',pg_database='commerce'):
    need(type(bucket)is str and re.fullmatch(r'commerce-v7-pitr-[a-z0-9-]{3,40}',bucket),'PITR_BUCKET_INVALID')
    need(type(pg_user)is str and re.fullmatch('[a-z_][a-z0-9_]{0,62}',pg_user) and type(pg_database)is str and re.fullmatch('[a-z_][a-z0-9_]{0,62}',pg_database),'PITR_DATABASE_IDENTITY_INVALID')
    need(region in {'us-central1','us-east1','us-west1'} and primary_region in {'us-central1','us-east1','us-west1'} and region!=primary_region,'PITR_OTHER_REGION_REQUIRED')
    need(type(cluster_id)is str and re.fullmatch('[1-9][0-9]{10,19}',cluster_id),'PITR_CLUSTER_ID_INVALID')
    # No arbitrary settings or endpoints. A separate private environment supplies
    # PGBACKREST_REPO1_CIPHER_PASS; this public text must never contain its value.
    return '\n'.join(['[global]','repo1-type=gcs','repo1-gcs-bucket='+bucket,
        'repo1-gcs-key-type=auto','repo1-path=/commerce/'+cluster_id,
        'repo1-cipher-type=aes-256-cbc','repo1-retention-full-type=time',
        'repo1-retention-full=7','repo1-retention-archive-type=full',
        'compress-type=zst','compress-level=3','process-max=1','archive-async=n',
        'archive-check=y','archive-copy=y','start-fast=n','log-level-console=warn',
        'log-level-file=off','lock-path=/var/run/pgbackrest','spool-path=/var/spool/pgbackrest',
        '','[commerce]','pg1-path=/var/lib/postgresql/data','pg1-port=5432',
        'pg1-socket-path=/var/run/postgresql','pg1-user='+pg_user,'pg1-database='+pg_database,''])

def postgres_settings():
    return {'wal_level':'replica','archive_mode':'on','archive_timeout':'60s',
        'archive_command':'pgbackrest --stanza=commerce archive-push %p'}

def validate_effective(settings,pgbackrest):
    """Use readback of running PG and closed effective config, not file intent."""
    need(type(settings)is dict and set(settings)==set(postgres_settings()),'PITR_POSTGRES_READBACK_REQUIRED')
    need(settings==postgres_settings(),'PITR_POSTGRES_SETTINGS_CHANGED')
    need(type(pgbackrest)is dict,'PITR_REPOSITORY_READBACK_REQUIRED')
    for name,expected in {'repo1-type':'gcs','repo1-cipher-type':'aes-256-cbc','repo1-retention-full-type':'time','repo1-retention-full':'7','repo1-retention-archive-type':'full','archive-async':'n','archive-check':'y','compress-type':'zst'}.items():
        need(pgbackrest.get(name)==expected,'PITR_REPOSITORY_SETTING_CHANGED')
    need(not {'archive-push-queue-max','archive-queue-max','repo1-retention-archive'}&set(pgbackrest),'PITR_WAL_LOSS_POLICY_FORBIDDEN')
    need('repo1-cipher-pass'not in pgbackrest,'PITR_SECRET_MUST_NOT_ENTER_EVIDENCE')
    return {'state':'PITR_SETTINGS_VERIFIED_ONLY','restore_verified':False,'production_rpo_proven':False}

def capacity(*,full_backup_bytes,incremental_bytes_per_day,compressed_wal_bytes_per_day,auth_backup_bytes,retained_days,full_interval_days,cross_region_bytes_used,monthly_transfer_reserve_bytes,storage_reserve_bytes):
    fields=locals().copy()
    need(all(type(v)is int and v>=0 for v in fields.values()),'PITR_CAPACITY_INVALID')
    need(retained_days==7 and 1<=full_interval_days<=7,'PITR_RETENTION_REQUIRED')
    # Time retention may need the base preceding the window plus the next full.
    # Keep every full in the window plus its preceding base and the incoming
    # full before expiry completes. Daily fulls require more than two copies.
    # No deletion is inferred from this deliberately conservative bound.
    retained_window=retained_days+full_interval_days
    retained_full_count=(retained_days+full_interval_days-1)//full_interval_days+2
    storage=retained_full_count*full_backup_bytes+retained_window*(incremental_bytes_per_day+compressed_wal_bytes_per_day)+auth_backup_bytes
    # Longest month, full on day1 and each interval, increments every other day.
    full_count=(31+full_interval_days-1)//full_interval_days
    transfer=full_count*full_backup_bytes+(31-full_count)*incremental_bytes_per_day+31*compressed_wal_bytes_per_day
    return {'state':'PITR_CAPACITY_ESTIMATE_ONLY','storage_required_bytes':storage,
        'monthly_cross_region_required_bytes':transfer,'storage_fits':storage<=storage_reserve_bytes,
        'cross_region_fits':cross_region_bytes_used+transfer<=monthly_transfer_reserve_bytes,
        'retained_window_bound_days':retained_window,'retained_full_backup_bound':retained_full_count,'production_authorized':False,
        'representative_measurement_required':True,'delete_allowed':False}
