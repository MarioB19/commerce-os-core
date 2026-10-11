CREATE TABLE provider_diagnostics (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK(environment='REAL'),
 profile_key text NOT NULL, profile_version integer NOT NULL, actor_id text NOT NULL,
 operation_key text NOT NULL, request_hash text NOT NULL, capability text NOT NULL,
 status text NOT NULL CHECK(status IN ('RUNNING','VERIFIED','PARTIAL','FAILED','UNKNOWN')),
 provider_operation_id uuid REFERENCES creative_provider_operations(id), result jsonb NOT NULL DEFAULT '{}',
 reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0), error_code text,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(workspace_id,environment,actor_id,profile_key,operation_key)
);
CREATE INDEX provider_diagnostics_profile ON provider_diagnostics(workspace_id,environment,profile_key,started_at DESC);
GRANT SELECT,INSERT,UPDATE ON provider_diagnostics TO commerce_api;
