-- Operational connection metadata is separate from field-scoped encrypted secrets.
CREATE TABLE integration_settings (
 workspace_id text NOT NULL,
 environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 key text NOT NULL CHECK(key ~ '^(meta|openai|waha|cloud|fulfillment):[A-Za-z][A-Za-z0-9_-]{0,63}$'),
 type text NOT NULL CHECK(type IN('meta','openai','waha','cloud','fulfillment')),
 reference text NOT NULL,
 label text NOT NULL,
 version integer NOT NULL CHECK(version>0),
 enabled boolean NOT NULL DEFAULT false,
 config jsonb NOT NULL DEFAULT '{}',
 secret_fields jsonb NOT NULL DEFAULT '{}',
 updated_by text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,environment,key),
 CHECK(key=type||':'||reference)
);
CREATE TABLE integration_secrets (
 workspace_id text NOT NULL,
 environment text NOT NULL,
 key text NOT NULL,
 type text NOT NULL,
 field text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 ciphertext text NOT NULL,
 PRIMARY KEY(workspace_id,environment,key,field),
 FOREIGN KEY(workspace_id,environment,key) REFERENCES integration_settings(workspace_id,environment,key),
 CHECK(key LIKE type||':%')
);
CREATE TABLE integration_setting_versions (
 workspace_id text NOT NULL,
 environment text NOT NULL,
 key text NOT NULL,
 version integer NOT NULL,
 metadata jsonb NOT NULL,
 actor_id text NOT NULL,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,environment,key,version),
 FOREIGN KEY(workspace_id,environment,key) REFERENCES integration_settings(workspace_id,environment,key)
);
GRANT SELECT ON integration_settings TO commerce_api,commerce_automation,commerce_channel,commerce_ingress;
GRANT INSERT,UPDATE ON integration_settings TO commerce_api;
GRANT SELECT,INSERT ON integration_setting_versions TO commerce_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON integration_secrets TO commerce_api;
GRANT SELECT ON integration_secrets TO commerce_automation,commerce_channel,commerce_ingress;
ALTER TABLE integration_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_secret_api ON integration_secrets TO commerce_api USING(true) WITH CHECK(true);
CREATE POLICY integration_secret_ai ON integration_secrets FOR SELECT TO commerce_automation USING(type='openai' AND field='api_key');
CREATE POLICY integration_secret_channel ON integration_secrets FOR SELECT TO commerce_channel USING((type='waha' AND field IN('api_key','webhook_secret')) OR (type IN('cloud','fulfillment') AND field='token'));
CREATE POLICY integration_secret_ingress ON integration_secrets FOR SELECT TO commerce_ingress USING((type='waha' AND field='webhook_secret') OR (type='cloud' AND field IN('app_secret','verify_token')));
CREATE FUNCTION immutable_integration_settings_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_INTEGRATION_SETTINGS_HISTORY'; END $$;
CREATE TRIGGER immutable_integration_settings_history BEFORE UPDATE OR DELETE ON integration_setting_versions FOR EACH ROW EXECUTE FUNCTION immutable_integration_settings_history();
-- Installer-owned marker prevents stale env values reappearing after an owner clears them in UI.
CREATE TABLE integration_imports (
 workspace_id text NOT NULL,
 import_key text NOT NULL,
 result jsonb NOT NULL,
 completed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,import_key)
);
