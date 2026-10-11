-- Preserve existing explicit capabilities; newly issued credentials default to REAL in API.
ALTER TABLE service_tokens ADD COLUMN allowed_environments jsonb NOT NULL DEFAULT '["REAL","SIMULATION"]'::jsonb;
ALTER TABLE service_tokens ADD COLUMN resource_ids jsonb;
ALTER TABLE service_tokens ADD CONSTRAINT service_token_environments CHECK(jsonb_typeof(allowed_environments)='array' AND jsonb_array_length(allowed_environments)>0 AND allowed_environments <@ '["REAL","SIMULATION"]'::jsonb);
ALTER TABLE service_tokens ADD CONSTRAINT service_token_resources CHECK(resource_ids IS NULL OR (jsonb_typeof(resource_ids)='array' AND jsonb_array_length(resource_ids)>0));
-- Proposals are inert drafts. They are deliberately absent from commands/outbox.
CREATE TABLE sales_command_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('REAL','SIMULATION')),
 conversation_id uuid NOT NULL REFERENCES records(id), actor_id text NOT NULL,
 expected_version integer NOT NULL CHECK(expected_version>0), payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status='DRAFT'), created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT ON sales_command_proposals TO commerce_api;
