-- Additive creative platform; no WhatsApp outbox or commercial authorization changes.
CREATE TABLE creative_members (
 workspace_id text NOT NULL, user_id text NOT NULL REFERENCES "user"(id),
 scopes text[] NOT NULL DEFAULT '{}', project_ids uuid[], version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE creative_settings (
 workspace_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('REAL','SIMULATION')),
 provider text NOT NULL CHECK(provider IN ('r2','searchapi','openai','elevenlabs','remotion')), version integer NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false, config jsonb NOT NULL DEFAULT '{}', secret_ciphertext text,
 verified_at timestamptz, verified_operation_id uuid, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,environment,provider)
);
CREATE TABLE creative_budgets (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,
 provider text NOT NULL,version integer NOT NULL DEFAULT 1,currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 limit_usd numeric(16,6) NOT NULL CHECK(limit_usd>=0),max_units bigint NOT NULL CHECK(max_units>=0),
 reserved_usd numeric(16,6) NOT NULL DEFAULT 0 CHECK(reserved_usd>=0),spent_usd numeric(16,6) NOT NULL DEFAULT 0 CHECK(spent_usd>=0),
 reserved_units bigint NOT NULL DEFAULT 0 CHECK(reserved_units>=0),spent_units bigint NOT NULL DEFAULT 0 CHECK(spent_units>=0),
 authorization_source text NOT NULL,actor_id text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,environment,provider)
);
CREATE TABLE creative_provider_operations (
 id uuid PRIMARY KEY, workspace_id text NOT NULL,environment text NOT NULL,actor_id text NOT NULL,
 provider text NOT NULL,kind text NOT NULL,operation_key text NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,
 budget_id uuid NOT NULL REFERENCES creative_budgets(id),status text NOT NULL CHECK(status IN('RESERVED','RUNNING','CONFIRMED','FAILED','UNKNOWN')),
 estimated_cost numeric(16,6) NOT NULL,confirmed_cost numeric(16,6),units bigint NOT NULL,confirmed_units bigint,
 currency text NOT NULL DEFAULT 'USD',remote_id text,result jsonb,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,
 UNIQUE(workspace_id,environment,kind,operation_key)
);
CREATE INDEX creative_provider_active ON creative_provider_operations(provider,status,created_at);
CREATE TABLE creative_projects (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,
 title text NOT NULL,product_id uuid NOT NULL,offer_id uuid,brief jsonb NOT NULL DEFAULT '{}',source_opportunity_id uuid,
 version integer NOT NULL DEFAULT 1,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,environment,id)
);
CREATE TABLE creative_recipes (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,project_id uuid NOT NULL,title text NOT NULL,
 version integer NOT NULL DEFAULT 1,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,environment,project_id) REFERENCES creative_projects(workspace_id,environment,id),UNIQUE(workspace_id,environment,id)
);
CREATE TABLE creative_recipe_versions (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,recipe_id uuid NOT NULL,version integer NOT NULL,
 recipe jsonb NOT NULL,sha256 text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,environment,recipe_id) REFERENCES creative_recipes(workspace_id,environment,id),UNIQUE(recipe_id,version)
);
CREATE TABLE creative_conformities (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,recipe_id uuid NOT NULL,recipe_version integer NOT NULL,
 recipe_sha text NOT NULL,decision text NOT NULL CHECK(decision IN('APPROVED','REJECTED')),authority text NOT NULL CHECK(authority IN('HUMAN','DELEGATED_PILOT')),
 actor_id text NOT NULL,reason text NOT NULL,source text NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(recipe_id,recipe_version) REFERENCES creative_recipe_versions(recipe_id,version)
);
CREATE TABLE creative_storage_usage (
 workspace_id text NOT NULL,environment text NOT NULL,limit_bytes bigint NOT NULL DEFAULT 2147483648,
 used_bytes bigint NOT NULL DEFAULT 0 CHECK(used_bytes>=0),reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(workspace_id,environment)
);
CREATE TABLE creative_assets (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,project_id uuid NOT NULL,
 name text NOT NULL,size_bytes bigint NOT NULL CHECK(size_bytes>0 AND size_bytes<=524288000),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 content_type text NOT NULL,purpose text NOT NULL,rights jsonb NOT NULL,status text NOT NULL CHECK(status IN('STAGING','VERIFYING','READY','REJECTED','REVOKED')),
 storage_key text,verification jsonb,created_by text NOT NULL,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,environment,project_id) REFERENCES creative_projects(workspace_id,environment,id),UNIQUE(workspace_id,environment,id)
);
CREATE TABLE creative_uploads (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,asset_id uuid NOT NULL,actor_id text NOT NULL,
 status text NOT NULL CHECK(status IN('INITIATING','UPLOADING','CLOSING','VERIFYING','READY','ABORTING','ABORTED','REJECTED','UNKNOWN')),
 staging_key text NOT NULL,multipart_id text,part_count integer NOT NULL,part_size integer NOT NULL DEFAULT 8388608,
 reserved_bytes bigint NOT NULL,version integer NOT NULL DEFAULT 1,job_id uuid,attempt_id uuid,fence bigint,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),error_code text,
 FOREIGN KEY(workspace_id,environment,asset_id) REFERENCES creative_assets(workspace_id,environment,id)
);
CREATE UNIQUE INDEX creative_one_upload_per_actor ON creative_uploads(workspace_id,environment,actor_id) WHERE status IN('INITIATING','UPLOADING','CLOSING','VERIFYING','UNKNOWN','ABORTING');
CREATE TABLE creative_devices (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,owner_id text NOT NULL,name text NOT NULL,
 platform text NOT NULL CHECK(platform IN('darwin-arm64','win32-x64')),engine_version text NOT NULL,api_version integer NOT NULL DEFAULT 1,
 token_hash text UNIQUE NOT NULL,project_ids uuid[] NOT NULL,capabilities jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'CONNECTED' CHECK(status IN('CONNECTED','PAUSED','REVOKED')),version integer NOT NULL DEFAULT 1,
 last_seen_at timestamptz,resources jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz
);
CREATE TABLE creative_pairings (
 id uuid PRIMARY KEY,user_code_hash text NOT NULL,poll_secret_hash text NOT NULL,name text NOT NULL,platform text NOT NULL,
 engine_version text NOT NULL,api_version integer NOT NULL,capabilities jsonb NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','APPROVED','EXPIRED','CONSUMED')),
 workspace_id text,device_id uuid,token_ciphertext text,version integer NOT NULL DEFAULT 1,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE creative_quotes (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,recipe_id uuid NOT NULL,recipe_version integer NOT NULL,recipe_sha text NOT NULL,
 actor_id text NOT NULL,snapshot jsonb NOT NULL,estimated_cost numeric(16,6) NOT NULL DEFAULT 0,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE creative_jobs (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,project_id uuid NOT NULL,recipe_id uuid NOT NULL,recipe_version integer NOT NULL,recipe_sha text NOT NULL,
 status text NOT NULL CHECK(status IN('QUEUED','RUNNING','RETRY','REVIEW','FAILED','CANCELLED')),quote_id uuid NOT NULL REFERENCES creative_quotes(id),
 authorized_by text NOT NULL,production_authorization jsonb NOT NULL,plan_inputs jsonb NOT NULL,preferred_device_id uuid,active_attempt_id uuid,fence bigint NOT NULL DEFAULT 0,
 version integer NOT NULL DEFAULT 1,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,environment,project_id) REFERENCES creative_projects(workspace_id,environment,id),FOREIGN KEY(recipe_id,recipe_version) REFERENCES creative_recipe_versions(recipe_id,version)
);
CREATE INDEX creative_jobs_claim ON creative_jobs(workspace_id,status,created_at);
CREATE TABLE creative_attempts (
 id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES creative_jobs(id),device_id uuid NOT NULL REFERENCES creative_devices(id),fence bigint NOT NULL,
 status text NOT NULL CHECK(status IN('RUNNING','COMPLETED','FAILED','EXPIRED')),lease_expires_at timestamptz NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,resources jsonb NOT NULL DEFAULT '{}',UNIQUE(job_id,fence)
);
CREATE UNIQUE INDEX creative_one_active_device ON creative_attempts(device_id) WHERE status='RUNNING';
CREATE TABLE creative_steps (
 id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES creative_jobs(id),attempt_id uuid NOT NULL REFERENCES creative_attempts(id),
 step text NOT NULL,status text NOT NULL,progress numeric,detail jsonb NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(attempt_id,step)
);
CREATE TABLE creative_artifacts (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,project_id uuid NOT NULL,job_id uuid NOT NULL REFERENCES creative_jobs(id),
 attempt_id uuid NOT NULL REFERENCES creative_attempts(id),asset_id uuid NOT NULL,kind text NOT NULL,sha256 text NOT NULL,
 qa jsonb NOT NULL,manifest jsonb NOT NULL,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,environment,asset_id) REFERENCES creative_assets(workspace_id,environment,id),UNIQUE(job_id,kind)
);
CREATE TABLE creative_reviews (
 id uuid PRIMARY KEY,artifact_id uuid NOT NULL REFERENCES creative_artifacts(id),artifact_version integer NOT NULL,sha256 text NOT NULL,
 kind text NOT NULL CHECK(kind IN('EDITORIAL','PRODUCTION')),decision text NOT NULL CHECK(decision IN('APPROVED','CHANGES_REQUESTED')),
 actor_id text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
-- Immutable source snapshots and review history; append new rows to change meaning.
CREATE FUNCTION creative_immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CREATIVE_IMMUTABLE'; END $$;
CREATE TRIGGER creative_recipe_immutable BEFORE UPDATE OR DELETE ON creative_recipe_versions FOR EACH ROW EXECUTE FUNCTION creative_immutable_row();
CREATE TRIGGER creative_conformity_immutable BEFORE UPDATE OR DELETE ON creative_conformities FOR EACH ROW EXECUTE FUNCTION creative_immutable_row();
CREATE TRIGGER creative_review_immutable BEFORE UPDATE OR DELETE ON creative_reviews FOR EACH ROW EXECUTE FUNCTION creative_immutable_row();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['creative_members','creative_settings','creative_budgets','creative_provider_operations','creative_projects','creative_recipes','creative_recipe_versions','creative_conformities','creative_storage_usage','creative_assets','creative_uploads','creative_devices','creative_pairings','creative_quotes','creative_jobs','creative_attempts','creative_steps','creative_artifacts','creative_reviews'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_api') THEN EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO commerce_api',t); END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_automation') THEN
  GRANT SELECT,INSERT,UPDATE ON creative_settings,creative_budgets,creative_provider_operations TO commerce_automation;
 END IF;
END $$;
