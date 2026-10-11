CREATE TABLE intelligence_corpus_evaluations (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK(environment='REAL'), actor_id text NOT NULL,
 operation_key text NOT NULL, request_hash text NOT NULL, corpus_version text NOT NULL, corpus_hash text NOT NULL, oracle_hash text NOT NULL,
 model text NOT NULL, profile_version integer NOT NULL, max_cost_usd numeric NOT NULL CHECK(max_cost_usd>0 AND max_cost_usd<=.10), estimate jsonb NOT NULL,
 status text NOT NULL CHECK(status IN('RUNNING','COMPLETED','PARTIAL','FAILED','UNKNOWN')), outcomes jsonb NOT NULL DEFAULT '{}',
 started_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(workspace_id,environment,actor_id,operation_key), UNIQUE(workspace_id,environment,corpus_hash,profile_version)
);
CREATE INDEX corpus_evaluations_context ON intelligence_corpus_evaluations(workspace_id,environment,started_at DESC);
GRANT SELECT,INSERT,UPDATE ON intelligence_corpus_evaluations TO commerce_api;
