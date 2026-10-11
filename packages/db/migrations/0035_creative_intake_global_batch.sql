CREATE TABLE creative_global_budgets (
 workspace_id text PRIMARY KEY, version integer NOT NULL DEFAULT 1,
 limit_usd numeric(16,6) NOT NULL CHECK(limit_usd>=0), currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 external_status text NOT NULL DEFAULT 'NONE' CHECK(external_status IN('NONE','KNOWN','UNKNOWN')),
 external_reserved_usd numeric(16,6) NOT NULL DEFAULT 0 CHECK(external_reserved_usd>=0),
 external_source text, external_expires_at timestamptz,
 authorization_source text NOT NULL, actor_id text NOT NULL, expires_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(external_status<>'KNOWN' OR (external_source IS NOT NULL AND external_expires_at IS NOT NULL))
);
CREATE TABLE creative_playbook_receipts (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,project_id uuid NOT NULL,
 receipt jsonb NOT NULL,sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,environment,project_id) REFERENCES creative_projects(workspace_id,environment,id),
 UNIQUE(workspace_id,environment,id)
);
CREATE TRIGGER creative_playbook_receipt_immutable BEFORE UPDATE OR DELETE ON creative_playbook_receipts FOR EACH ROW EXECUTE FUNCTION creative_immutable_row();
-- A pilot can bind one exact recipe before the approved master is expanded to 18 variants.
CREATE TABLE creative_recipe_intakes (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,project_id uuid NOT NULL,
 recipe_id uuid NOT NULL,recipe_version integer NOT NULL,recipe_sha256 text NOT NULL CHECK(recipe_sha256~'^[a-f0-9]{64}$'),
 receipt_id uuid NOT NULL,variant_id text NOT NULL CHECK(variant_id~'^A0[1-6]-h[1-3]$'),
 created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,environment,project_id) REFERENCES creative_projects(workspace_id,environment,id),
 FOREIGN KEY(workspace_id,environment,receipt_id) REFERENCES creative_playbook_receipts(workspace_id,environment,id),
 FOREIGN KEY(recipe_id,recipe_version) REFERENCES creative_recipe_versions(recipe_id,version)
);
CREATE TRIGGER creative_recipe_intake_immutable BEFORE UPDATE OR DELETE ON creative_recipe_intakes FOR EACH ROW EXECUTE FUNCTION creative_immutable_row();
CREATE TABLE creative_batches (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,project_id uuid NOT NULL,
 title text NOT NULL,version integer NOT NULL DEFAULT 1,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,environment,project_id) REFERENCES creative_projects(workspace_id,environment,id)
);
CREATE TABLE creative_batch_versions (
 id uuid PRIMARY KEY,batch_id uuid NOT NULL REFERENCES creative_batches(id),version integer NOT NULL,
 receipt_id uuid NOT NULL REFERENCES creative_playbook_receipts(id),manifest jsonb NOT NULL,sha256 text NOT NULL,
 created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(batch_id,version)
);
CREATE TRIGGER creative_batch_version_immutable BEFORE UPDATE OR DELETE ON creative_batch_versions FOR EACH ROW EXECUTE FUNCTION creative_immutable_row();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_api') THEN
  GRANT SELECT,INSERT,UPDATE ON creative_global_budgets,creative_batches TO commerce_api;
  GRANT SELECT,INSERT ON creative_playbook_receipts,creative_recipe_intakes,creative_batch_versions TO commerce_api;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_automation') THEN
  GRANT SELECT ON creative_global_budgets,creative_playbook_receipts,creative_recipe_intakes,creative_batches,creative_batch_versions TO commerce_automation;
 END IF;
END $$;
