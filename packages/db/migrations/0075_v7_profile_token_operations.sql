-- V7 F2 cutover: Personal token management operations (009).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/009_profile_token_operations.sql (source sha256 66c946e00cd438ab55aa7720586146caa2f303738b462bb1433379a04277fab3)
-- Prepared transition only; 008 belongs to the market variants increment.
CREATE TABLE profile_token_operations (
 workspace_id text NOT NULL REFERENCES profiles(id),
 operation_id uuid NOT NULL,
 actor_id text NOT NULL,
 action text NOT NULL CHECK(action IN ('create','rotate','revoke')),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 token_id uuid NOT NULL,
 token_user_id text NOT NULL,
 token_version integer NOT NULL CHECK(token_version>0),
 replaced_token_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,operation_id),
 FOREIGN KEY(actor_id,workspace_id) REFERENCES memberships(user_id,workspace_id),
 FOREIGN KEY(workspace_id,token_id,token_user_id) REFERENCES personal_access_tokens(workspace_id,id,user_id),
 FOREIGN KEY(workspace_id,replaced_token_id,token_user_id) REFERENCES personal_access_tokens(workspace_id,id,user_id),
 CHECK((action='rotate')=(replaced_token_id IS NOT NULL))
);
ALTER TABLE profile_token_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_token_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_token_operation_scope ON profile_token_operations
 USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
REVOKE ALL ON profile_token_operations FROM PUBLIC,commerce_api,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance;
GRANT SELECT,INSERT ON profile_token_operations TO commerce_api;
-- Identity/scopes/expiry stay immutable under transition002's trigger.
REVOKE UPDATE ON personal_access_tokens FROM commerce_api;
GRANT UPDATE(revoked_at) ON personal_access_tokens TO commerce_api;
-- <<< end 009_profile_token_operations.sql
