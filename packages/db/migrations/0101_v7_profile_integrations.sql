-- V7 F2 (RF-01.2, RF-13, RF-14.b, RNF-04.a, RF-11.a/b, RF-04.d): profile integrations.
-- Each business brings its own AI keys and its own Meta system-user token. The
-- API stores only authenticated ciphertext plus the last four characters for
-- display; it never reads a stored secret back. The onboarding state persists
-- only what cannot be derived from facts (Meta explicitly skipped).

-- 1. Masked display of AI keys (RNF-04.a). The ciphertext stays readable only by
-- commerce_ai; the API reads the hint and metadata columns, never the secret.
ALTER TABLE ai_credential_versions ADD COLUMN key_hint text CHECK(key_hint IS NULL OR key_hint ~ '^[\x21-\x7e]{4}$');
GRANT SELECT(workspace_id,environment,credential_id,revision,key_hint,created_at) ON ai_credential_versions TO commerce_api;

-- 2. Profile AI preferences: default provider/model and the monthly limit used to
-- open future budget periods. Periods themselves stay immutable (0082).
CREATE TABLE ai_profile_preferences(
 workspace_id text NOT NULL REFERENCES profiles(id),
 environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 version integer NOT NULL CHECK(version>0),
 default_provider text CHECK(default_provider IN('openai','anthropic','google')),
 default_model text CHECK(default_model ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'),
 monthly_limit_microusd bigint CHECK(monthly_limit_microusd BETWEEN 1000000 AND 100000000000),
 updated_by text NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 256),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment),
 CHECK((default_provider IS NULL)=(default_model IS NULL))
);
CREATE FUNCTION guard_ai_profile_preferences() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 THEN RAISE EXCEPTION 'AI_PREFERENCES_INITIAL_VERSION'; END IF;
 ELSIF (NEW.workspace_id,NEW.environment) IS DISTINCT FROM (OLD.workspace_id,OLD.environment) OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'AI_PREFERENCES_VERSION_CONFLICT';
 END IF;
 NEW.updated_at:=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER ai_profile_preferences_guard BEFORE INSERT OR UPDATE ON ai_profile_preferences FOR EACH ROW EXECUTE FUNCTION guard_ai_profile_preferences();
CREATE TRIGGER ai_profile_preferences_no_delete BEFORE DELETE ON ai_profile_preferences FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- 3. Meta system-user token per profile (D-06): read-only use, own token, never a
-- platform credential. History of revisions is append-only.
CREATE TABLE meta_profile_credentials(
 workspace_id text PRIMARY KEY REFERENCES profiles(id),
 revision integer NOT NULL CHECK(revision>0),
 enabled boolean NOT NULL DEFAULT true,
 state text NOT NULL DEFAULT 'UNVERIFIED' CHECK(state IN('UNVERIFIED','VERIFIED','INVALID')),
 reason text CHECK(reason IS NULL OR reason ~ '^META_[A-Z_]{1,60}$'),
 checked_at timestamptz,
 granted_scopes text[] NOT NULL DEFAULT '{}' CHECK(cardinality(granted_scopes)<=40),
 updated_by text NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 256),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((state='UNVERIFIED')=(checked_at IS NULL)),
 CHECK(state<>'INVALID' OR reason IS NOT NULL)
);
CREATE TABLE meta_profile_credential_versions(
 workspace_id text NOT NULL REFERENCES profiles(id),
 revision integer NOT NULL CHECK(revision>0),
 ciphertext text NOT NULL CHECK(ciphertext ~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$' AND length(ciphertext)<=16384),
 key_hint text NOT NULL CHECK(key_hint ~ '^[\x21-\x7e]{4}$'),
 created_by text NOT NULL CHECK(length(created_by) BETWEEN 1 AND 256),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,revision)
);
CREATE TRIGGER immutable_meta_profile_credential_versions BEFORE UPDATE OR DELETE ON meta_profile_credential_versions FOR EACH ROW EXECUTE FUNCTION immutable_row();
ALTER TABLE meta_profile_credentials ADD CONSTRAINT meta_current_version FOREIGN KEY(workspace_id,revision)
 REFERENCES meta_profile_credential_versions(workspace_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION guard_meta_profile_credential() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.state<>'UNVERIFIED' THEN RAISE EXCEPTION 'META_UNVERIFIED_TOKEN_REQUIRED'; END IF;
 ELSIF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'META_TOKEN_SCOPE_IMMUTABLE';
 ELSIF NEW.revision=OLD.revision+1 THEN
  IF NEW.state<>'UNVERIFIED' THEN RAISE EXCEPTION 'META_TOKEN_REVERIFY_REQUIRED'; END IF;
 ELSIF NEW.revision<>OLD.revision THEN RAISE EXCEPTION 'META_TOKEN_VERSION_CONFLICT';
 END IF;
 NEW.updated_at:=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER meta_profile_credential_guard BEFORE INSERT OR UPDATE ON meta_profile_credentials FOR EACH ROW EXECUTE FUNCTION guard_meta_profile_credential();
CREATE TRIGGER meta_profile_credential_no_delete BEFORE DELETE ON meta_profile_credentials FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- 4. Onboarding facts that cannot be derived (RF-13.c, RF-04.d).
CREATE TABLE profile_onboarding(
 workspace_id text PRIMARY KEY REFERENCES profiles(id),
 version integer NOT NULL CHECK(version>0),
 meta_skipped boolean NOT NULL DEFAULT false,
 dismissed boolean NOT NULL DEFAULT false,
 updated_by text NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 256),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_profile_onboarding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 THEN RAISE EXCEPTION 'ONBOARDING_INITIAL_VERSION'; END IF;
 ELSIF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'ONBOARDING_VERSION_CONFLICT';
 END IF;
 NEW.updated_at:=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER profile_onboarding_guard BEFORE INSERT OR UPDATE ON profile_onboarding FOR EACH ROW EXECUTE FUNCTION guard_profile_onboarding();
CREATE TRIGGER profile_onboarding_no_delete BEFORE DELETE ON profile_onboarding FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- 5. Isolation: same model as 0096/0099 (profile guard and environment guard for
-- the API; no worker global access; owner-only migrations).
DO $integrations$
DECLARE t text;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
 FOREACH t IN ARRAY ARRAY['ai_profile_preferences','meta_profile_credentials','meta_profile_credential_versions','profile_onboarding'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  EXECUTE format('CREATE POLICY v7_integration_profile ON public.%I USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),''''))',t);
  EXECUTE format('CREATE POLICY v7_api_profile_guard ON public.%I AS RESTRICTIVE TO commerce_api USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),''''))',t);
 END LOOP;
 CREATE POLICY v7_api_environment_guard ON public.ai_profile_preferences AS RESTRICTIVE TO commerce_api
  USING(NULLIF(current_setting('app.environment',true),'') IS NULL OR environment=current_setting('app.environment',true))
  WITH CHECK(NULLIF(current_setting('app.environment',true),'') IS NULL OR environment=current_setting('app.environment',true));
END $integrations$;
GRANT SELECT,INSERT,UPDATE(version,default_provider,default_model,monthly_limit_microusd,updated_by,updated_at) ON ai_profile_preferences TO commerce_api;
GRANT SELECT ON ai_profile_preferences TO commerce_ai;
GRANT SELECT,INSERT,UPDATE(revision,enabled,state,reason,checked_at,granted_scopes,updated_by,updated_at) ON meta_profile_credentials TO commerce_api;
GRANT INSERT,SELECT(workspace_id,revision,key_hint,created_by,created_at) ON meta_profile_credential_versions TO commerce_api;
GRANT SELECT,INSERT,UPDATE(version,meta_skipped,dismissed,updated_by,updated_at) ON profile_onboarding TO commerce_api;
REVOKE ALL ON FUNCTION guard_ai_profile_preferences(),guard_meta_profile_credential(),guard_profile_onboarding() FROM PUBLIC;

-- 6. Platform signal (RF-02.b): only the aggregate Meta state, never the token.
GRANT SELECT(workspace_id,enabled,state) ON meta_profile_credentials TO commerce_platform_owner;
CREATE POLICY platform_meta_state_reader ON meta_profile_credentials FOR SELECT TO commerce_platform_owner USING(true);

-- 7. Postcondition: the isolation model still covers every workspace table.
DO $postcondition$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p')
   AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped AND a.attnum>0)
   AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR NOT EXISTS(SELECT 1 FROM pg_policy x WHERE x.polrelid=c.oid AND NOT x.polpermissive
    AND (x.polname='v7_api_profile_guard' OR (x.polroles='{0}'::oid[] AND pg_get_expr(x.polqual,x.polrelid)='false'))))) THEN
  RAISE EXCEPTION 'V7_ISOLATION_MODEL_INCOMPLETE';
 END IF;
END $postcondition$;
