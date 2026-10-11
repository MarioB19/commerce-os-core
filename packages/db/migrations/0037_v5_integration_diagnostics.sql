CREATE TABLE integration_diagnostics (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK (environment IN ('REAL','SIMULATION')),
 profile_key text NOT NULL, profile_version integer NOT NULL, actor_id text NOT NULL,
 operation_key text NOT NULL, request_hash text NOT NULL, capability text NOT NULL, model text,
 status text NOT NULL CHECK (status IN ('RUNNING','VERIFIED','PARTIAL','FAILED','UNKNOWN','STALE')),
 authenticated boolean NOT NULL DEFAULT false, inference_verified boolean NOT NULL DEFAULT false,
 estimated_cost_usd numeric(18,8) NOT NULL DEFAULT 0, confirmed_cost_usd numeric(18,8), budget_id uuid,
 reserved_units bigint NOT NULL DEFAULT 0, usage jsonb, result jsonb NOT NULL DEFAULT '{}', error_code text,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,environment,actor_id,profile_key,operation_key)
);
CREATE INDEX integration_diagnostics_profile ON integration_diagnostics(workspace_id,environment,profile_key,started_at DESC);

GRANT SELECT,INSERT,UPDATE ON integration_diagnostics TO commerce_api;

-- The provider broker reads reservations under the limited automation role.
GRANT SELECT ON integration_diagnostics TO commerce_automation;
