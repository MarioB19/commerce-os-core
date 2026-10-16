-- Apply only to a fresh dedicated logical engine database after the 68 canonical
-- migrations and original profile transitions 001, 010 and 012.
-- This file is NOT an application-profile transition and must not run in REAL.
DO $$ DECLARE n text; occupied boolean; BEGIN
 IF current_database() !~ '^commerce_lab_engine_[a-z0-9_]+$' THEN RAISE EXCEPTION 'LAB_ENGINE_DATABASE_REQUIRED'; END IF;
 IF to_regclass('public.continuous_authorizations') IS NULL OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='outbox' AND column_name='continuous_authorization_id') THEN RAISE EXCEPTION 'LAB_ENGINE_CANONICAL_SCHEMA_REQUIRED'; END IF;
 FOREACH n IN ARRAY ARRAY['records','record_versions','commercial_assignments','commercial_assignment_history','physical_chats','operational_settings','manual_controls','timers','outbox','outbox_gate_schedule','commands','domain_events','payment_contributions','commercial_remarketing_cycles','commercial_remarketing_attempts','commercial_buyer_exclusions','operation_authorizations','continuous_authorizations','warmup_states','warmup_pools','warmup_identities','channel_sessions','profiles','memberships','session','integration_settings','integration_secrets'] LOOP
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)',n) INTO occupied;
  IF occupied THEN RAISE EXCEPTION 'LAB_ENGINE_EMPTY_DATABASE_REQUIRED: %',n; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('commerce_lab_engine','commerce_lab_engine_seed','commerce_lab_engine_owner')) THEN RAISE EXCEPTION 'LAB_ENGINE_ROLE_ALREADY_EXISTS'; END IF;
 CREATE ROLE commerce_lab_engine NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 CREATE ROLE commerce_lab_engine_seed NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 CREATE ROLE commerce_lab_engine_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
END $$;
CREATE SCHEMA commerce_number_lab_engine AUTHORIZATION commerce_lab_engine_owner;
REVOKE ALL ON SCHEMA commerce_number_lab_engine FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public,commerce_number_lab_engine TO commerce_lab_engine,commerce_lab_engine_seed;
-- A dedicated empty database must not expose privileged historical entry points.
-- Trigger execution remains canonical; runtime cannot call these functions.
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prosecdef AND p.proname<>'retention_context_valid' LOOP
  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
CREATE TABLE commerce_number_lab_engine.installation(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 installation_id uuid NOT NULL UNIQUE,
 database_name text NOT NULL CHECK(database_name=current_database()),
 engine_sha256 text NOT NULL CHECK(engine_sha256 ~ '^[a-f0-9]{64}$'),
 installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE commerce_number_lab_engine.installation OWNER TO commerce_lab_engine_owner;
CREATE TABLE commerce_number_lab_engine.executions(
 run_id uuid NOT NULL,operation_id uuid NOT NULL,
 workspace_id text NOT NULL CHECK(workspace_id='number-lab:'||run_id::text),
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
 engine_sha256 text NOT NULL CHECK(engine_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN('INTENT','APPLIED','FAILED','UNKNOWN')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days'),
 PRIMARY KEY(run_id,operation_id)
);
ALTER TABLE commerce_number_lab_engine.executions OWNER TO commerce_lab_engine_owner;
CREATE FUNCTION commerce_number_lab_engine.guard_execution() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'LAB_ENGINE_EXECUTION_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'INTENT' OR NEW.created_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp()
    OR NEW.engine_sha256 IS DISTINCT FROM (SELECT engine_sha256 FROM commerce_number_lab_engine.installation WHERE singleton) THEN RAISE EXCEPTION 'LAB_ENGINE_EXECUTION_INVALID'; END IF;
 ELSIF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state<>'INTENT' OR NEW.state='INTENT' THEN
  -- Identical UPDATE of run_id permits a row lock but cannot mint authority.
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'LAB_ENGINE_EXECUTION_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_execution BEFORE INSERT OR UPDATE OR DELETE ON commerce_number_lab_engine.executions
 FOR EACH ROW EXECUTE FUNCTION commerce_number_lab_engine.guard_execution();
REVOKE ALL ON ALL TABLES IN SCHEMA commerce_number_lab_engine FROM PUBLIC;
GRANT SELECT ON commerce_number_lab_engine.installation TO commerce_lab_engine,commerce_lab_engine_seed;
GRANT SELECT,UPDATE(run_id) ON commerce_number_lab_engine.executions TO commerce_lab_engine;
GRANT SELECT,INSERT,UPDATE(state) ON commerce_number_lab_engine.executions TO commerce_lab_engine_seed;
ALTER TABLE commerce_number_lab_engine.executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_number_lab_engine.executions FORCE ROW LEVEL SECURITY;
CREATE POLICY engine_execution_scope ON commerce_number_lab_engine.executions TO commerce_lab_engine,commerce_lab_engine_seed
 USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));

-- Runtime only receives the finite canonical SQL surface used by the lab.
-- No session, credential, authorization, membership, provider or quota grants.
GRANT SELECT ON records,record_versions,commercial_assignments,
 physical_chats,operational_settings,manual_controls,timers,outbox,commands,domain_events,
 payment_contributions,commercial_remarketing_cycles,commercial_remarketing_attempts,commercial_buyer_exclusions TO commerce_lab_engine;
GRANT INSERT ON records,domain_events,outbox,timers,manual_controls,physical_chats TO commerce_lab_engine;
GRANT USAGE ON SEQUENCE outbox_dispatch_sequence_seq TO commerce_lab_engine;
GRANT INSERT,UPDATE ON payment_contributions,commercial_remarketing_cycles,commercial_remarketing_attempts,commercial_buyer_exclusions TO commerce_lab_engine;
GRANT UPDATE(body,version,updated_at) ON records TO commerce_lab_engine;
GRANT UPDATE ON timers,manual_controls,physical_chats TO commerce_lab_engine;
GRANT UPDATE(status,result,updated_at) ON outbox,commands TO commerce_lab_engine;
GRANT UPDATE(id) ON commercial_assignments TO commerce_lab_engine;
GRANT SELECT,INSERT ON records,commercial_assignments,operational_settings,commands TO commerce_lab_engine_seed;
GRANT SELECT ON record_versions TO commerce_lab_engine_seed;
-- Canonical record guards call the boolean retention check. This grants no
-- maintenance role, retained data access or retention-plan execution.
GRANT EXECUTE ON FUNCTION retention_context_valid() TO commerce_lab_engine;

CREATE FUNCTION commerce_number_lab_engine.guard_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.environment<>'SIMULATION' OR NEW.workspace_id IS DISTINCT FROM current_setting('app.workspace_id',true) THEN RAISE EXCEPTION 'LAB_ENGINE_SCOPE_REQUIRED'; END IF;
 -- V7 RF-19.d: a customer's example receipt is conversation evidence, not
 -- configuration: the engine may insert it once, as a private file asset.
 IF current_user='commerce_lab_engine' AND NEW.kind NOT IN('contact','conversation','message','order','receipt','fulfillment','touchpoint','simulation','ai_run')
  AND NOT (TG_OP='INSERT' AND NEW.kind='asset' AND NEW.body->>'purpose'='receipt_evidence' AND NEW.body->>'kind'='file'
   AND NEW.body->>'lab_attachment_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN RAISE EXCEPTION 'LAB_ENGINE_CONFIGURATION_IMMUTABLE'; END IF;
 IF NEW.kind='channel_account' AND NEW.body->>'provider' IS DISTINCT FROM 'simulator' THEN RAISE EXCEPTION 'LAB_ENGINE_SIMULATOR_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_lab_engine_record BEFORE INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION commerce_number_lab_engine.guard_record();
DO $$ DECLARE n text; has_environment boolean; condition text; BEGIN
 FOREACH n IN ARRAY ARRAY['records','record_versions','commercial_assignments','physical_chats','operational_settings','manual_controls','timers','outbox','commands','domain_events','payment_contributions','commercial_remarketing_cycles','commercial_remarketing_attempts','commercial_buyer_exclusions'] LOOP
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=n AND column_name='workspace_id') THEN RAISE EXCEPTION 'LAB_ENGINE_SCOPE_COLUMN_REQUIRED: %',n; END IF;
  SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=n AND column_name='environment') INTO has_environment;
  condition:='workspace_id=current_setting(''app.workspace_id'',true)';
  IF has_environment THEN
   condition:=condition||' AND environment=''SIMULATION''';
   EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT laboratory_environment_only CHECK(environment=''SIMULATION'')',n);
  END IF;
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY lab_scope ON public.%I TO commerce_lab_engine,commerce_lab_engine_seed USING(%s) WITH CHECK(%s)',n,condition,condition);
  EXECUTE format('CREATE POLICY lab_scope_restrictive ON public.%I AS RESTRICTIVE TO commerce_lab_engine,commerce_lab_engine_seed USING(%s) WITH CHECK(%s)',n,condition,condition);
 END LOOP;
END $$;
-- V7 RF-19.d: an approved example receipt recognizes the simulated sale; the
-- canonical totals read this view as the engine role, under its own row scope.
ALTER VIEW receipt_sale_facts SET (security_invoker=true);
GRANT SELECT ON receipt_sale_facts TO commerce_lab_engine;
-- Protected installation marker remains empty until native installation seals it.

-- Canonical commercial readers join historical authority/preparation tables even
-- for SIMULATION. Grant an always-empty projection, never authority or mutation.
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['operation_authorizations','warmup_states','warmup_pools','warmup_identities'] LOOP
  EXECUTE format('GRANT SELECT ON public.%I TO commerce_lab_engine',n);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY lab_empty ON public.%I TO commerce_lab_engine USING(false)',n);
  EXECUTE format('CREATE POLICY lab_empty_restrictive ON public.%I AS RESTRICTIVE TO commerce_lab_engine USING(false) WITH CHECK(false)',n);
 END LOOP;
END $$;

-- The original account trigger materializes simulator metadata. It never
-- installs credentials or an operational session; runtime gets no access.
GRANT SELECT ON channel_sessions TO commerce_lab_engine_seed;
GRANT INSERT(account_id,workspace_id,environment,provider,gateway_id,remote_session_name,expected_identity_fingerprint,archived_at),
 UPDATE(gateway_id,remote_session_name,archived_at,expected_identity_fingerprint) ON channel_sessions TO commerce_lab_engine_seed;
ALTER TABLE channel_sessions ADD CONSTRAINT lab_channel_metadata_only CHECK(
 environment='SIMULATION' AND provider='simulator' AND gateway_id=account_id::text
 AND remote_session_name='default' AND expected_identity_fingerprint IS NULL
 AND desired_state='STOPPED' AND operational_pause=true AND recovery_enabled=false
 AND storage_ref IS NULL AND backup_ref IS NULL AND observed_identity_ciphertext IS NULL
 AND auth_state='UNKNOWN' AND observed_state='UNKNOWN');
ALTER TABLE channel_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY lab_seed_session ON channel_sessions TO commerce_lab_engine_seed
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
CREATE POLICY lab_seed_session_restrictive ON channel_sessions AS RESTRICTIVE TO commerce_lab_engine_seed
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
