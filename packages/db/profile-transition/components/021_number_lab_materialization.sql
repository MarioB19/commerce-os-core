-- Dedicated engine database only, after021_number_lab_engine.sql.
DO $$ BEGIN
 IF current_database() !~ '^commerce_lab_engine_[a-z0-9_]+$'
  OR to_regclass('commerce_number_lab_engine.installation') IS NULL THEN
  RAISE EXCEPTION 'LAB_ENGINE_DATABASE_REQUIRED';
 END IF;
END $$;
CREATE TABLE commerce_number_lab_engine.materializations(
 run_id uuid PRIMARY KEY,operation_id uuid NOT NULL,
 workspace_id text NOT NULL UNIQUE CHECK(workspace_id='number-lab:'||run_id::text),
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
 configuration_sha256 text NOT NULL CHECK(configuration_sha256 ~ '^[a-f0-9]{64}$'),
 plan_sha256 text NOT NULL CHECK(plan_sha256 ~ '^[a-f0-9]{64}$'),
 materials_sha256 text NOT NULL CHECK(materials_sha256 ~ '^[a-f0-9]{64}$'),
 engine_sha256 text NOT NULL CHECK(engine_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'SEEDING' CHECK(state IN('SEEDING','READY')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),ready_at timestamptz,
 FOREIGN KEY(run_id,operation_id) REFERENCES commerce_number_lab_engine.executions(run_id,operation_id),
 CHECK((state='SEEDING' AND ready_at IS NULL) OR (state='READY' AND ready_at>=created_at))
);
ALTER TABLE commerce_number_lab_engine.materializations OWNER TO commerce_lab_engine_owner;
ALTER TABLE commerce_number_lab_engine.materializations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_number_lab_engine.materializations FORCE ROW LEVEL SECURITY;
CREATE POLICY materialization_scope ON commerce_number_lab_engine.materializations
 USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
REVOKE ALL ON commerce_number_lab_engine.materializations FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE(state) ON commerce_number_lab_engine.materializations TO commerce_lab_engine_seed;
GRANT SELECT ON commerce_number_lab_engine.materializations TO commerce_lab_engine;
-- Installing this component also closes the older lease reader: an INTENT
-- without the committed matching READY materialization cannot be executed.
CREATE POLICY materialization_ready ON commerce_number_lab_engine.executions AS RESTRICTIVE TO commerce_lab_engine
 USING(EXISTS(SELECT 1 FROM commerce_number_lab_engine.materializations m WHERE m.run_id=executions.run_id
  AND m.workspace_id=executions.workspace_id AND m.snapshot_sha256=executions.snapshot_sha256
  AND m.engine_sha256=executions.engine_sha256 AND m.state='READY'));
CREATE FUNCTION commerce_number_lab_engine.guard_materialization() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE e record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'LAB_MATERIALIZATION_IMMUTABLE';END IF;
 IF NEW.workspace_id IS DISTINCT FROM current_setting('app.workspace_id',true) THEN RAISE EXCEPTION 'LAB_ENGINE_SCOPE_REQUIRED';END IF;
 SELECT * INTO e FROM commerce_number_lab_engine.executions WHERE run_id=NEW.run_id AND operation_id=NEW.operation_id;
 IF NOT FOUND OR e.workspace_id IS DISTINCT FROM NEW.workspace_id OR e.snapshot_sha256 IS DISTINCT FROM NEW.snapshot_sha256
  OR e.engine_sha256 IS DISTINCT FROM NEW.engine_sha256 OR e.state<>'INTENT' OR e.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'LAB_ENGINE_BINDING_REQUIRED';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'SEEDING' OR NEW.ready_at IS NOT NULL THEN RAISE EXCEPTION 'LAB_MATERIALIZATION_INITIAL_STATE';END IF;
  NEW.created_at:=clock_timestamp();
 ELSE
  IF OLD.state<>'SEEDING' OR NEW.state<>'READY' OR (to_jsonb(NEW)-ARRAY['state','ready_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','ready_at']) THEN
   RAISE EXCEPTION 'LAB_MATERIALIZATION_IMMUTABLE';
  END IF;
  NEW.ready_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_materialization BEFORE INSERT OR UPDATE OR DELETE ON commerce_number_lab_engine.materializations
 FOR EACH ROW EXECUTE FUNCTION commerce_number_lab_engine.guard_materialization();
-- Only the three mutable skeleton kinds may be completed, once, in the same
-- SEEDING transaction. Existing canonical version/reference guards still apply.
GRANT UPDATE(body,version,updated_at) ON records TO commerce_lab_engine_seed;
GRANT EXECUTE ON FUNCTION retention_context_valid() TO commerce_lab_engine_seed;
CREATE FUNCTION commerce_number_lab_engine.guard_seed_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_user<>'commerce_lab_engine_seed' THEN RETURN NEW;END IF;
 IF NOT EXISTS(SELECT 1 FROM commerce_number_lab_engine.materializations m
  JOIN commerce_number_lab_engine.executions e ON e.run_id=m.run_id AND e.operation_id=m.operation_id
  WHERE m.workspace_id=NEW.workspace_id AND m.state='SEEDING' AND e.state='INTENT' AND e.expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'LAB_SEED_WINDOW_REQUIRED';
 END IF;
 IF NEW.kind NOT IN('category','product','workflow','offer','agent','bank_profile','receipt_policy','asset','binding','acquisition_campaign','ad_set','ad','channel_account') THEN
  RAISE EXCEPTION 'LAB_SEED_KIND_REQUIRED';
 END IF;
 IF TG_OP='UPDATE' AND (OLD.kind NOT IN('category','product','workflow') OR OLD.body->>'lab_materialization_skeleton' IS DISTINCT FROM 'true'
  OR NEW.body ? 'lab_materialization_skeleton') THEN RAISE EXCEPTION 'LAB_SEED_FINALIZE_REQUIRED';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_lab_seed_record BEFORE INSERT OR UPDATE ON records
 FOR EACH ROW EXECUTE FUNCTION commerce_number_lab_engine.guard_seed_record();
