CREATE TABLE personal_access_tokens (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 user_id text NOT NULL REFERENCES "user"(id),
 name text NOT NULL,
 token_hash text NOT NULL UNIQUE,
 allowed_environments jsonb NOT NULL CHECK (
   jsonb_typeof(allowed_environments)='array' AND
   jsonb_array_length(allowed_environments) BETWEEN 1 AND 2 AND
   allowed_environments <@ '["REAL","SIMULATION"]'::jsonb
 ),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(expires_at>created_at)
);
CREATE INDEX personal_access_tokens_workspace ON personal_access_tokens(workspace_id,user_id);
REVOKE ALL ON personal_access_tokens FROM PUBLIC,commerce_ingress,commerce_automation,commerce_channel;
GRANT SELECT,INSERT,UPDATE ON personal_access_tokens TO commerce_api;
