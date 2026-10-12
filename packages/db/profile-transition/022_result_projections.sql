-- Anonymous metrics and restricted source deduplication. Not an executable
-- retention policy: no conversation/content is erased by this transition.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_results') THEN RAISE EXCEPTION 'RESULT_ROLE_ALREADY_EXISTS';END IF;
 CREATE ROLE commerce_results NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
END $$;
GRANT USAGE ON SCHEMA public TO commerce_results;
CREATE FUNCTION result_counters_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE names text[]:=ARRAY['started','responded','offered','collection_sent','receipt_received','payment_approved','revenue_minor','sales','attributed_revenue_minor','attributed_sales','response_ms_sum','response_samples','sale_ms_sum','sale_samples','ai_cost_microusd','ai_cost_unknown_attempts','ai_input_tokens','ai_output_tokens','ai_cache_read_tokens','ai_cache_write_tokens','ai_audio_input_tokens','ai_tokens_unknown_attempts']; k text;
BEGIN
 IF v IS NULL OR jsonb_typeof(v)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>cardinality(names) THEN RETURN false;END IF;
 FOREACH k IN ARRAY names LOOP
  IF NOT(v ? k) OR jsonb_typeof(v->k)<>'string' OR v->>k !~ '^(0|[1-9][0-9]{0,29})$' THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE FUNCTION result_grain_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE k text; dimensions jsonb; d date;
BEGIN
 IF v IS NULL OR jsonb_typeof(v)<>'object' OR NOT(v ?& ARRAY['day','currency','timezone','dimensions']) OR
  (SELECT count(*) FROM jsonb_object_keys(v))<>(CASE WHEN v ? 'ai_unattributed' THEN 5 ELSE 4 END) OR
  (v ? 'ai_unattributed' AND v->'ai_unattributed'<>'true'::jsonb) THEN RETURN false;END IF;
 IF jsonb_typeof(v->'day')<>'string' OR v->>'day' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR
  jsonb_typeof(v->'currency')<>'string' OR v->>'currency' !~ '^[A-Z]{3}$' OR
  jsonb_typeof(v->'timezone')<>'string' OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=v->>'timezone') THEN RETURN false;END IF;
 d:=(v->>'day')::date;IF NOT isfinite(d) OR d::text<>v->>'day' THEN RETURN false;END IF;
 dimensions:=v->'dimensions';
 IF jsonb_typeof(dimensions)<>'object' OR NOT(dimensions ?& ARRAY['family_id','variant_id','market','account_id','campaign_id','ad_id','touch']) OR
  (SELECT count(*) FROM jsonb_object_keys(dimensions))<>7 THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['family_id','variant_id','account_id'] LOOP
  IF jsonb_typeof(dimensions->k)<>'null' AND (jsonb_typeof(dimensions->k)<>'string' OR
    dimensions->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') THEN RETURN false;END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['campaign_id','ad_id'] LOOP
  IF jsonb_typeof(dimensions->k)<>'null' AND (jsonb_typeof(dimensions->k)<>'string' OR dimensions->>k !~ '^[0-9]+$') THEN RETURN false;END IF;
 END LOOP;
 IF jsonb_typeof(dimensions->'market')<>'null' AND (jsonb_typeof(dimensions->'market')<>'string' OR length(dimensions->>'market')>160) THEN RETURN false;END IF;
 IF jsonb_typeof(dimensions->'touch')<>'string' OR dimensions->>'touch' NOT IN('FIRST_CONTACT','REMARKETING','UNKNOWN') THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION result_facts_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE f jsonb;
BEGIN
 IF v IS NULL OR jsonb_typeof(v)<>'array' OR jsonb_array_length(v)>1000 THEN RETURN false;END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(v) LOOP
  IF jsonb_typeof(f)<>'object' OR NOT(f ?& ARRAY['grain','counters']) OR (SELECT count(*) FROM jsonb_object_keys(f))<>2 OR
   NOT public.result_grain_valid(f->'grain') OR NOT public.result_counters_valid(f->'counters') THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION result_counters_valid(jsonb),result_grain_valid(jsonb),result_facts_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION result_counters_valid(jsonb),result_grain_valid(jsonb),result_facts_valid(jsonb) TO commerce_results,commerce_api;
CREATE TABLE result_metric_daily(
 workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 grain_hash text NOT NULL CHECK(grain_hash ~ '^[a-f0-9]{64}$'),grain jsonb NOT NULL CHECK(result_grain_valid(grain)),
 counters jsonb NOT NULL CHECK(result_counters_valid(counters)),
 PRIMARY KEY(workspace_id,environment,grain_hash)
);
CREATE INDEX result_metric_daily_period ON result_metric_daily(workspace_id,environment,(grain->>'currency'),(grain->>'day'));
-- Sealed totals contain the same anonymous shape, never a source/client ID.
CREATE TABLE result_metric_sealed(LIKE result_metric_daily INCLUDING ALL);
ALTER TABLE result_metric_sealed ADD FOREIGN KEY(workspace_id) REFERENCES profiles(id);
CREATE TABLE result_projection_sources(
 workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 kind text NOT NULL CHECK(kind IN('COHORT','FINANCIAL','AI')),source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 revision bigint NOT NULL CHECK(revision>0),fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 facts jsonb, sealed_at timestamptz,
 PRIMARY KEY(workspace_id,environment,kind,source_digest),
 CHECK((sealed_at IS NULL AND facts IS NOT NULL AND result_facts_valid(facts)) OR (sealed_at IS NOT NULL AND facts IS NULL))
);
CREATE TABLE result_projection_state(
 workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 phase text NOT NULL DEFAULT 'PENDING' CHECK(phase IN('PENDING','READY')),
 source_watermark timestamptz,completed_at timestamptz,source_count bigint CHECK(source_count>=0),
 PRIMARY KEY(workspace_id,environment),CHECK((source_watermark IS NULL)=(completed_at IS NULL)),
 CHECK(source_watermark<=completed_at)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['result_metric_daily','result_metric_sealed','result_projection_sources','result_projection_state'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY result_projection_scope ON %I USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'') WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'')',t);
  EXECUTE format('CREATE POLICY result_projection_scope_guard ON %I AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'') WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'')',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,commerce_api,commerce_ingress,commerce_channel,commerce_automation',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO commerce_results',t);
 END LOOP;
END $$;
GRANT SELECT ON result_metric_daily,result_projection_state TO commerce_api;
CREATE POLICY result_ready_reader ON result_metric_daily AS RESTRICTIVE FOR SELECT TO commerce_api
 USING(EXISTS(SELECT 1 FROM result_projection_state s WHERE s.workspace_id=result_metric_daily.workspace_id
  AND s.environment=result_metric_daily.environment AND s.phase='READY'));
-- A committed partial worker batch can never retain the previous READY marker.
-- SQL triggers cover direct worker DML as well as the TypeScript port.
CREATE FUNCTION invalidate_result_projection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE w text:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
BEGIN
 INSERT INTO public.result_projection_state(workspace_id,phase) VALUES(w,'PENDING')
  ON CONFLICT(workspace_id,environment) DO UPDATE SET phase='PENDING';
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION invalidate_result_projection() FROM PUBLIC;
CREATE TRIGGER result_daily_pending AFTER INSERT OR UPDATE OR DELETE ON result_metric_daily FOR EACH ROW EXECUTE FUNCTION invalidate_result_projection();
CREATE TRIGGER result_sealed_pending AFTER INSERT OR UPDATE OR DELETE ON result_metric_sealed FOR EACH ROW EXECUTE FUNCTION invalidate_result_projection();
CREATE TRIGGER result_source_pending AFTER INSERT OR UPDATE OR DELETE ON result_projection_sources FOR EACH ROW EXECUTE FUNCTION invalidate_result_projection();

-- Goals and their immutable command receipts have always been REAL-only.
-- Defaults preserve existing insert contracts, scoped FKs prevent future drift.
ALTER TABLE result_goals ADD CONSTRAINT result_goal_environment_identity UNIQUE(workspace_id,environment,id);
ALTER TABLE result_goal_events ADD COLUMN environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL');
ALTER TABLE result_goal_events ADD CONSTRAINT result_goal_event_environment FOREIGN KEY(workspace_id,environment,goal_id) REFERENCES result_goals(workspace_id,environment,id);
ALTER TABLE result_goal_operations ADD COLUMN environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL');
