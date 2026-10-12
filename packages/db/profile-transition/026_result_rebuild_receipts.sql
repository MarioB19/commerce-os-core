-- Derived-data rebuild receipts. Requires022; no business or erasure grants.
CREATE TABLE result_rebuild_receipts(
 workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 operation_id uuid NOT NULL,generation_before bigint NOT NULL CHECK(generation_before>0),
 generation_after bigint NOT NULL CHECK(generation_after=generation_before+1),
 canonical_sha256 text NOT NULL CHECK(canonical_sha256 ~ '^[a-f0-9]{64}$'),
 grain_count integer NOT NULL CHECK(grain_count>=0),
 phase text NOT NULL CHECK(phase IN('READY','PENDING')),source_watermark timestamptz,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,operation_id)
);
ALTER TABLE result_rebuild_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_rebuild_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY result_rebuild_scope ON result_rebuild_receipts USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
CREATE POLICY result_rebuild_scope_guard ON result_rebuild_receipts AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
REVOKE ALL ON result_rebuild_receipts FROM PUBLIC,commerce_api,commerce_results,commerce_automation,commerce_ingress,commerce_channel;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_results_reader') THEN REVOKE ALL ON result_rebuild_receipts FROM commerce_results_reader;END IF;END $$;
GRANT SELECT,INSERT ON result_rebuild_receipts TO commerce_results;
CREATE TRIGGER immutable_result_rebuild_receipts BEFORE UPDATE OR DELETE ON result_rebuild_receipts FOR EACH ROW EXECUTE FUNCTION immutable_row();
