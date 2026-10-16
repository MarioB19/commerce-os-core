-- V7 F1: continuous archiving (pgBackRest) evidence for platform health.
-- scripts/v7_pitr.py (Root, as the cluster owner) records each base backup;
-- the API reads only the bounded status function, never the table.
DO $$BEGIN
 IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'PLATFORM_RECOVERY_OWNER_REQUIRED';
 END IF;
END$$;

CREATE TABLE platform_backup_runs (
 id bigserial PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('PITR_FULL','PITR_DIFF','PITR_INCR')),
 status text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED')),
 label text CHECK (label ~ '^[0-9]{8}-[0-9]{6}F(_[0-9]{8}-[0-9]{6}[DI])?$'),
 started_at timestamptz NOT NULL,
 finished_at timestamptz NOT NULL CHECK (finished_at >= started_at),
 database_bytes bigint CHECK (database_bytes >= 0),
 repository_bytes bigint CHECK (repository_bytes >= 0),
 error text CHECK (length(error) <= 300),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((status = 'SUCCEEDED') = (label IS NOT NULL AND error IS NULL))
);
CREATE INDEX platform_backup_runs_finished ON platform_backup_runs (status, kind, finished_at DESC);
ALTER TABLE platform_backup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_backup_runs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_backup_runs FROM PUBLIC;
REVOKE ALL ON SEQUENCE platform_backup_runs_id_seq FROM PUBLIC;

-- Owner-only writer: a closed record shape, no arbitrary column.
CREATE FUNCTION record_platform_backup_run(p jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'PLATFORM_RECOVERY_OWNER_REQUIRED';
 END IF;
 IF jsonb_typeof(p) <> 'object' OR p->>'status' NOT IN ('SUCCEEDED','FAILED') THEN
  RAISE EXCEPTION 'PLATFORM_BACKUP_RUN_INVALID';
 END IF;
 INSERT INTO public.platform_backup_runs(kind,status,label,started_at,finished_at,database_bytes,repository_bytes,error)
 VALUES (p->>'kind', p->>'status', p->>'label', (p->>'started_at')::timestamptz, (p->>'finished_at')::timestamptz,
  (p->>'database_bytes')::bigint, (p->>'repository_bytes')::bigint, left(p->>'error',300));
END$$;
REVOKE ALL ON FUNCTION record_platform_backup_run(jsonb) FROM PUBLIC;

-- Bounded, content-free recovery status: archiver state, WAL backlog and the
-- latest base backups. SECURITY DEFINER because pg_ls_archive_statusdir needs
-- pg_monitor; it returns timestamps and counts only.
CREATE FUNCTION platform_recovery_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object(
  'archive_mode', current_setting('archive_mode'),
  'archived_count', a.archived_count,
  'failed_count', a.failed_count,
  'last_archived_at', a.last_archived_time,
  'last_failed_at', a.last_failed_time,
  'pending', (SELECT count(*) FROM pg_ls_archive_statusdir() s WHERE s.name LIKE '%.ready'),
  'oldest_pending_age_s', (SELECT extract(epoch FROM now() - min(s.modification))::bigint
                           FROM pg_ls_archive_statusdir() s WHERE s.name LIKE '%.ready'),
  'last_backup_at', (SELECT max(finished_at) FROM public.platform_backup_runs WHERE status='SUCCEEDED'),
  'last_full_at', (SELECT max(finished_at) FROM public.platform_backup_runs WHERE status='SUCCEEDED' AND kind='PITR_FULL'),
  'last_failure_at', (SELECT max(finished_at) FROM public.platform_backup_runs WHERE status='FAILED'),
  'checked_at', now())
 FROM pg_stat_archiver a
$$;
REVOKE ALL ON FUNCTION platform_recovery_status() FROM PUBLIC;
DO $$BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commerce_api') THEN
  GRANT EXECUTE ON FUNCTION platform_recovery_status() TO commerce_api;
 END IF;
END$$;
