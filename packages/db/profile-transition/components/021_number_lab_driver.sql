-- Dedicated engine database only, after the two reviewed engine components.
DO $$ BEGIN
 IF current_database() !~ '^commerce_lab_engine_[a-z0-9_]+$'
  OR to_regclass('commerce_number_lab_engine.materializations') IS NULL THEN
  RAISE EXCEPTION 'LAB_ENGINE_DATABASE_REQUIRED';
 END IF;
END $$;
-- First canonical inbound checks the historical MCL scope before attaching
-- its simulation. The dedicated engine sees no legacy authority at all.
GRANT SELECT ON public.mcl_test_scopes TO commerce_lab_engine;
ALTER TABLE public.mcl_test_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcl_test_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY lab_driver_empty ON public.mcl_test_scopes TO commerce_lab_engine USING(false);
CREATE POLICY lab_driver_empty_guard ON public.mcl_test_scopes AS RESTRICTIVE TO commerce_lab_engine USING(false) WITH CHECK(false);
CREATE FUNCTION commerce_number_lab_engine.valid_driver_cipher(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT (jsonb_typeof(v)='object' AND v-ARRAY['version','iv','tag','ciphertext']='{}'::jsonb
 AND v->'version'='1'::jsonb AND jsonb_typeof(v->'iv')='string' AND v->>'iv' ~ '^[A-Za-z0-9+/]{16}$'
 AND jsonb_typeof(v->'tag')='string' AND v->>'tag' ~ '^[A-Za-z0-9+/]{22}==$'
 AND jsonb_typeof(v->'ciphertext')='string' AND length(v->>'ciphertext') BETWEEN 4 AND 11184812
 AND v->>'ciphertext' ~ '^[A-Za-z0-9+/]+={0,2}$') IS TRUE
$$;
CREATE TABLE commerce_number_lab_engine.driver_receipts(
 run_id uuid NOT NULL,operation_id uuid NOT NULL,
 workspace_id text NOT NULL CHECK(workspace_id='number-lab:'||run_id::text),
 stage text NOT NULL CHECK(stage IN('ACTION_APPLIED','SETTLED')),
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
 action_sha256 text NOT NULL CHECK(action_sha256 ~ '^[a-f0-9]{64}$'),
 result_ciphertext jsonb NOT NULL CHECK(commerce_number_lab_engine.valid_driver_cipher(result_ciphertext)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,operation_id,stage),
 FOREIGN KEY(run_id,operation_id) REFERENCES commerce_number_lab_engine.executions(run_id,operation_id)
);
ALTER TABLE commerce_number_lab_engine.driver_receipts OWNER TO commerce_lab_engine_owner;
ALTER TABLE commerce_number_lab_engine.driver_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_number_lab_engine.driver_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY driver_receipt_scope ON commerce_number_lab_engine.driver_receipts
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
REVOKE ALL ON commerce_number_lab_engine.driver_receipts FROM PUBLIC;
GRANT SELECT,INSERT ON commerce_number_lab_engine.driver_receipts TO commerce_lab_engine;
GRANT SELECT ON commerce_number_lab_engine.driver_receipts TO commerce_lab_engine_seed;
CREATE FUNCTION commerce_number_lab_engine.guard_driver_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE e record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'LAB_DRIVER_RECEIPT_IMMUTABLE';END IF;
 SELECT * INTO e FROM commerce_number_lab_engine.executions
  WHERE run_id=NEW.run_id AND operation_id=NEW.operation_id FOR SHARE;
 IF NOT FOUND OR e.workspace_id IS DISTINCT FROM NEW.workspace_id
  OR NEW.workspace_id IS DISTINCT FROM current_setting('app.workspace_id',true)
  OR e.snapshot_sha256 IS DISTINCT FROM NEW.snapshot_sha256 OR e.state<>'INTENT'
  OR e.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'LAB_ENGINE_BINDING_REQUIRED';END IF;
 IF NEW.stage='SETTLED' AND NOT EXISTS(SELECT 1 FROM commerce_number_lab_engine.driver_receipts p
  WHERE p.run_id=NEW.run_id AND p.operation_id=NEW.operation_id AND p.stage='ACTION_APPLIED'
   AND p.snapshot_sha256=NEW.snapshot_sha256 AND p.action_sha256=NEW.action_sha256) THEN
  RAISE EXCEPTION 'LAB_DRIVER_STAGE_REQUIRED';END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER driver_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON commerce_number_lab_engine.driver_receipts
 FOR EACH ROW EXECUTE FUNCTION commerce_number_lab_engine.guard_driver_receipt();
GRANT INSERT ON public.commands TO commerce_lab_engine;
CREATE FUNCTION commerce_number_lab_engine.guard_driver_command() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_user<>'commerce_lab_engine' THEN RETURN NEW;END IF;
 IF TG_OP='INSERT' AND (NEW.environment<>'SIMULATION'
  OR NEW.workspace_id IS DISTINCT FROM current_setting('app.workspace_id',true)
  -- V7 RF-19.d: the customer's receipt and the tester's decision on it are
  -- canonical receipt commands of the same operation.
  OR NOT (NEW.kind IN('simulation_start','simulation_advance','receipt_review') OR (NEW.kind='conversation_command' AND NEW.payload->>'type'='receipt_received')) OR NEW.status<>'PENDING'
  OR NEW.actor_id<>'number-laboratory'
  OR NOT EXISTS(SELECT 1 FROM commerce_number_lab_engine.executions e
   WHERE e.operation_id=NEW.id AND e.workspace_id=NEW.workspace_id AND e.state='INTENT'
    AND e.expires_at>clock_timestamp())) THEN RAISE EXCEPTION 'LAB_DRIVER_COMMAND_REQUIRED';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER driver_command_guard BEFORE INSERT ON public.commands
 FOR EACH ROW EXECUTE FUNCTION commerce_number_lab_engine.guard_driver_command();
