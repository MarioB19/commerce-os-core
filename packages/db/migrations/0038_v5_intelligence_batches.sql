ALTER TABLE intelligence_analyses ADD COLUMN evidence_snapshot jsonb, ADD COLUMN analysis_scope jsonb NOT NULL DEFAULT '{}';
CREATE TABLE intelligence_analysis_batches (
 id uuid PRIMARY KEY, analysis_id uuid NOT NULL REFERENCES intelligence_analyses(id), workspace_id text NOT NULL, environment text NOT NULL,
 batch_index integer NOT NULL, evidence jsonb NOT NULL, content_hash text NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED', result jsonb, provider_operation_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(analysis_id,batch_index)
);
GRANT SELECT,INSERT,UPDATE ON intelligence_analysis_batches TO commerce_api,commerce_automation;
