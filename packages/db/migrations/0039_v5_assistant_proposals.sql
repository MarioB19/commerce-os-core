CREATE TABLE product_assistant_proposals (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,product_id uuid NOT NULL REFERENCES records(id),actor_id text NOT NULL,
 version integer NOT NULL DEFAULT 1,expected_version integer NOT NULL,kind text NOT NULL,request_text text NOT NULL,changes jsonb NOT NULL DEFAULT '{}',context_snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_assistant_context ON product_assistant_proposals(workspace_id,environment,product_id,created_at DESC);
GRANT SELECT,INSERT,UPDATE ON product_assistant_proposals TO commerce_api;
