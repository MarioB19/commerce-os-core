-- Experimental Intelligence. Immutable observations keep competing media as evidence only.
CREATE TABLE intelligence_searches (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('REAL','SIMULATION')),
 version integer NOT NULL DEFAULT 1, name text NOT NULL, query jsonb NOT NULL, fingerprint text NOT NULL,
 tracking_enabled boolean NOT NULL DEFAULT false, daily_budget_minor integer NOT NULL DEFAULT 0 CHECK(daily_budget_minor>=0),
 next_run_at timestamptz, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,environment,fingerprint)
);
CREATE TABLE intelligence_runs (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL,
 search_id uuid NOT NULL REFERENCES intelligence_searches(id), search_version integer NOT NULL, query jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED','UNKNOWN')), coverage text NOT NULL DEFAULT 'UNAVAILABLE' CHECK(coverage IN ('PARTIAL','UNAVAILABLE')),
 origin text NOT NULL DEFAULT 'searchapi', pages jsonb NOT NULL DEFAULT '[]', provider_operations jsonb NOT NULL DEFAULT '[]',
 content_hash text, error_code text, requested_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, expires_at timestamptz,
 UNIQUE(id,workspace_id,environment)
);
CREATE UNIQUE INDEX intelligence_one_pending ON intelligence_runs(search_id) WHERE status IN ('QUEUED','RUNNING');
CREATE INDEX intelligence_runs_history ON intelligence_runs(workspace_id,environment,search_id,created_at DESC);
CREATE TABLE intelligence_offers (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL,
 group_key text NOT NULL, version integer NOT NULL DEFAULT 1, title text NOT NULL, advertiser text, landing_url text,
 correction jsonb NOT NULL DEFAULT '{}', correction_history jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,environment,group_key), UNIQUE(id,workspace_id,environment)
);
CREATE TABLE intelligence_observations (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL,
 run_id uuid NOT NULL, offer_id uuid NOT NULL, ad_id text NOT NULL, creative_hash text NOT NULL, content_hash text NOT NULL, observation jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(run_id,workspace_id,environment) REFERENCES intelligence_runs(id,workspace_id,environment),
 FOREIGN KEY(offer_id,workspace_id,environment) REFERENCES intelligence_offers(id,workspace_id,environment), UNIQUE(run_id,ad_id,content_hash)
);
CREATE INDEX intelligence_offer_observations ON intelligence_observations(workspace_id,environment,offer_id,created_at DESC);
CREATE TABLE intelligence_analyses (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL, offer_id uuid NOT NULL,
 content_hash text NOT NULL, prompt_version text NOT NULL, model text NOT NULL, status text NOT NULL DEFAULT 'QUEUED', result jsonb, provider_operation_id uuid,
 requested_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(offer_id,workspace_id,environment) REFERENCES intelligence_offers(id,workspace_id,environment), UNIQUE(workspace_id,environment,content_hash,prompt_version,model)
);
CREATE TABLE intelligence_opportunities (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL, offer_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1, title text NOT NULL, notes text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'DRAFT', created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(offer_id,workspace_id,environment) REFERENCES intelligence_offers(id,workspace_id,environment)
);
