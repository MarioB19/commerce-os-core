-- V7 F1 (RNF-03.e): one retention batch of health telemetry. Installation
-- superuser only; scripts/v7_health_retention.py runs it inside its own
-- transaction after setting (set_config(..., true)):
--   commerce.health_retention_mode   'key' (daily) or 'all' (Fase C cut)
--   commerce.health_retention_bound  instant; never later than now − 2 days
--   commerce.health_retention_limit  key: 1..200000 · all: 1..50000000
--   key mode also: app.workspace_id, app.environment,
--   commerce.health_retention_account, commerce.health_retention_dimension
-- A key is (profile, environment, number, dimension). Only health_signal
-- records observed strictly before the bound are deleted, never the latest
-- observation of their key, together with their projection rows and versions.
--
-- How (bulk maintenance, ADR docs/adr-v7-health-retention.md):
-- 1. key mode locks the doomed records FOR UPDATE, so no new row can start
--    referencing them while this transaction lives (an insert that references
--    one waits and then fails its own foreign key check, as usual); the cut
--    locks every referencing table in SHARE mode instead;
-- 2. every foreign key that points at records, record_versions or
--    health_observation_index (except the two rows this batch deletes itself) is
--    checked set-based: any reference aborts the batch;
-- 3. only then, with session_replication_role=replica for these three DELETEs,
--    the rows go without per-row trigger work: no immutable_versions (ADR-005)
--    and no per-row foreign key probes, which on pd-standard cost hours. No
--    table-level lock is taken, so production writers are never blocked;
-- 4. back to origin, the batch verifies that nothing of the doomed set remains
--    in any of the three tables and that the counts agree.
DO $retention$
DECLARE
 mode text:=current_setting('commerce.health_retention_mode');
 bound timestamptz:=current_setting('commerce.health_retention_bound')::timestamptz;
 lim bigint:=current_setting('commerce.health_retention_limit')::bigint;
 ws text; env text; acct text; dim text;
 d bigint; locked bigint; ni bigint; nv bigint; nr bigint; found boolean; ref record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'HEALTH_RETENTION_SUPERUSER_REQUIRED';
 END IF;
 IF mode NOT IN('key','all') OR NOT isfinite(bound) OR bound>now()-interval '2 days'
    OR lim<1 OR lim>(CASE mode WHEN 'key' THEN 200000 ELSE 50000000 END) THEN
  RAISE EXCEPTION 'HEALTH_RETENTION_BOUNDS_INVALID';
 END IF;
 -- The cut belongs to the maintenance window: producers must be stopped.
 IF mode='all' AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid<>pg_backend_pid()
    AND usename IN('commerce_ingress_login','commerce_automation_login','commerce_channel_login')) THEN
  RAISE EXCEPTION 'HEALTH_RETENTION_PRODUCERS_RUNNING';
 END IF;
 DROP TABLE IF EXISTS pg_temp.health_retention_doomed;
 DROP TABLE IF EXISTS pg_temp.health_retention_result;
 CREATE TEMP TABLE health_retention_result(doomed bigint,projection bigint,versions bigint,records bigint) ON COMMIT DROP;
 IF mode='key' THEN
  ws:=current_setting('app.workspace_id'); env:=current_setting('app.environment');
  acct:=current_setting('commerce.health_retention_account'); dim:=current_setting('commerce.health_retention_dimension');
  IF ws='' OR env NOT IN('SIMULATION','REAL') OR acct='' OR dim='' THEN RAISE EXCEPTION 'HEALTH_RETENTION_BOUNDS_INVALID'; END IF;
  CREATE TEMP TABLE health_retention_doomed ON COMMIT DROP AS
   SELECT h.record_id FROM public.health_observation_index h
   WHERE h.workspace_id=ws AND h.environment=env AND h.account_id=acct AND h.dimension=dim
     AND isfinite(h.observed_at) AND h.observed_at<bound
     AND EXISTS(SELECT 1 FROM public.health_observation_index n
                WHERE n.workspace_id=ws AND n.environment=env AND n.account_id=acct AND n.dimension=dim
                  AND isfinite(n.observed_at) AND n.observed_at>=bound)
   ORDER BY h.observed_at LIMIT lim;
 ELSE
  -- Optional profile scope (tests); the Fase C cut leaves it empty.
  ws:=coalesce(current_setting('commerce.health_retention_scope',true),'');
  CREATE TEMP TABLE health_retention_doomed ON COMMIT DROP AS
   SELECT record_id FROM (
    SELECT record_id,observed_at,max(observed_at) OVER(PARTITION BY workspace_id,environment,account_id,dimension) latest
    FROM public.health_observation_index
    WHERE account_id<>'' AND dimension<>'' AND workspace_id<>'' AND isfinite(observed_at) AND environment IN('SIMULATION','REAL')
      AND (ws='' OR workspace_id=ws)) t
   WHERE observed_at<least(bound,latest) LIMIT lim;
 END IF;
 ALTER TABLE pg_temp.health_retention_doomed ADD PRIMARY KEY(record_id);
 ANALYZE pg_temp.health_retention_doomed;
 SELECT count(*) INTO d FROM pg_temp.health_retention_doomed;
 ni:=0; nv:=0; nr:=0;
 IF d>0 THEN
  -- 1. Key mode locks exactly the doomed rows (cheap, never blocks writers).
  --    The Fase C cut (all) runs with producers stopped and instead takes SHARE
  --    locks on every referencing table below: row locks on millions of tuples
  --    would rewrite them once more on pd-standard.
  IF mode='key' OR ws<>'' THEN
   WITH l AS (SELECT r.id FROM public.records r JOIN pg_temp.health_retention_doomed x ON r.id=x.record_id
              WHERE r.kind='health_signal' FOR UPDATE OF r) SELECT count(*) INTO locked FROM l;
  ELSE
   SELECT count(*) INTO locked FROM public.records r JOIN pg_temp.health_retention_doomed x ON r.id=x.record_id WHERE r.kind='health_signal';
  END IF;
  IF locked<>d THEN RAISE EXCEPTION 'HEALTH_RETENTION_NOT_HEALTH_SIGNALS'; END IF;
  -- 2. No foreign reference may point at them (record id column of every key).
  FOR ref IN
   SELECT c.conrelid::regclass AS child,a.attname AS col
   FROM pg_catalog.pg_constraint c
   JOIN pg_catalog.pg_attribute pa ON pa.attrelid=c.confrelid
    AND pa.attname=CASE c.confrelid WHEN 'public.records'::regclass THEN 'id' ELSE 'record_id' END
   JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[array_position(c.confkey,pa.attnum)]
   WHERE c.contype='f'
     AND c.confrelid IN('public.records'::regclass,'public.record_versions'::regclass,'public.health_observation_index'::regclass)
     AND c.conrelid NOT IN('public.record_versions'::regclass,'public.health_observation_index'::regclass)
     AND array_position(c.confkey,pa.attnum) IS NOT NULL
  LOOP
   IF mode='all' AND ws='' THEN EXECUTE format('LOCK TABLE %s IN SHARE MODE',ref.child); END IF;
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s c JOIN pg_temp.health_retention_doomed x ON c.%I=x.record_id)',ref.child,ref.col) INTO found;
   IF found THEN RAISE EXCEPTION 'HEALTH_RETENTION_REFERENCED'; END IF;
  END LOOP;
  IF to_regclass('public.privacy_minimized_records') IS NOT NULL THEN
   EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.privacy_minimized_records m JOIN pg_temp.health_retention_doomed x ON m.record_id=x.record_id)' INTO found;
   IF found THEN RAISE EXCEPTION 'HEALTH_RETENTION_REFERENCED'; END IF;
  END IF;
  -- 3. Bulk delete without per-row triggers (this transaction only).
  PERFORM set_config('session_replication_role','replica',true);
  DELETE FROM public.health_observation_index h USING pg_temp.health_retention_doomed x WHERE h.record_id=x.record_id;
  GET DIAGNOSTICS ni=ROW_COUNT;
  DELETE FROM public.record_versions rv USING pg_temp.health_retention_doomed x WHERE rv.record_id=x.record_id AND rv.kind='health_signal';
  GET DIAGNOSTICS nv=ROW_COUNT;
  DELETE FROM public.records r USING pg_temp.health_retention_doomed x WHERE r.id=x.record_id AND r.kind='health_signal';
  GET DIAGNOSTICS nr=ROW_COUNT;
  PERFORM set_config('session_replication_role','origin',true);
  -- 4. Nothing of the doomed set may remain; counts must agree.
  --    (Versions copy their record's kind; the full re-scan is kept to key mode.)
  IF ni<>d OR nr<>d OR nv<d OR (mode='key' AND (
       EXISTS(SELECT 1 FROM public.record_versions rv JOIN pg_temp.health_retention_doomed x ON rv.record_id=x.record_id)
       OR EXISTS(SELECT 1 FROM public.health_observation_index h JOIN pg_temp.health_retention_doomed x ON h.record_id=x.record_id))) THEN
   RAISE EXCEPTION 'HEALTH_RETENTION_COUNT_MISMATCH';
  END IF;
 END IF;
 INSERT INTO health_retention_result VALUES(d,ni,nv,nr);
END $retention$;
