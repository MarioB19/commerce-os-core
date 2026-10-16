-- V7 F2 cutover: Profile-bound personal tokens and business settings (002, 003) plus legacy token scope adoption.
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/002_profile_personal_tokens.sql (source sha256 3af35dd7c738d9ec61f5d98e6068e9493274a93715979cb2ca42ba15723974e4)
-- Isolated transition, NOT an automatic migration. Requires exact profiles and
-- reviewed token scope adoption before the new credential reader can activate.
ALTER TABLE personal_access_tokens ADD COLUMN profile_scopes jsonb;
ALTER TABLE personal_access_tokens ADD CONSTRAINT personal_token_closed_profile_scopes CHECK(
 profile_scopes IS NULL OR CASE WHEN jsonb_typeof(profile_scopes)='array'
 THEN jsonb_array_length(profile_scopes) BETWEEN 1 AND 61 AND profile_scopes <@ '["profiles:read","home:read","employees:read","employees:write","tokens:read","tokens:write","products:read","products:write","variants:read","variants:write","offers:read","offers:write","materials:read","materials:write","flows:read","flows:write","sellers:read","sellers:write","collections:read","collections:write","receipt-rules:read","receipt-rules:write","numbers:read","numbers:write","numbers:connect","assignments:read","assignments:write","warmup:read","warmup:write","conversations:read","conversations:write","orders:read","orders:write","receipts:read","receipts:review","payments:read","payments:write","payments:export","remarketing:read","remarketing:write","campaigns:read","results:read","goals:read","goals:write","tests:read","tests:run","operations:read","alerts:read","alerts:write","help:read","audit:read","audit:export","privacy:read","privacy:write","profile:read","profile:write","usage:read","account:read","account:write","integrations:read","integrations:write"]'::jsonb ELSE false END
);
ALTER TABLE personal_access_tokens ADD CONSTRAINT personal_token_profile_identity UNIQUE(workspace_id,id,user_id);

CREATE TABLE profile_personal_token_routes (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 token_id uuid NOT NULL UNIQUE,
 workspace_id text NOT NULL REFERENCES profiles(id),
 user_id text NOT NULL REFERENCES "user"(id),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 FOREIGN KEY(workspace_id,token_id,user_id) REFERENCES personal_access_tokens(workspace_id,id,user_id) ON DELETE CASCADE
);
REVOKE ALL ON profile_personal_token_routes FROM PUBLIC,commerce_api,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance;

-- Invoker privileges are intentional: a SECURITY DEFINER must never decide
-- whether a caller is allowed to use the one-time legacy adoption exception.
CREATE FUNCTION guard_personal_profile_token_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.id,NEW.workspace_id,NEW.user_id,NEW.token_hash,NEW.allowed_environments,NEW.expires_at)
   IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.user_id,OLD.token_hash,OLD.allowed_environments,OLD.expires_at) THEN
  RAISE EXCEPTION 'PROFILE_TOKEN_IDENTITY_IMMUTABLE';
 END IF;
 IF NEW.profile_scopes IS DISTINCT FROM OLD.profile_scopes AND
   (OLD.profile_scopes IS NOT NULL OR current_user <> (SELECT pg_get_userbyid(relowner)
      FROM pg_class WHERE oid='public.personal_access_tokens'::regclass)) THEN
  RAISE EXCEPTION 'PROFILE_TOKEN_SCOPES_IMMUTABLE';
 END IF;
 IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
  RAISE EXCEPTION 'PROFILE_TOKEN_REVOCATION_IMMUTABLE';
 END IF;
 NEW.version:=OLD.version+CASE WHEN NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
   OR NEW.profile_scopes IS DISTINCT FROM OLD.profile_scopes THEN 1 ELSE 0 END;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_personal_profile_token_identity() FROM PUBLIC;
CREATE TRIGGER guard_personal_profile_token_identity BEFORE UPDATE ON personal_access_tokens
 FOR EACH ROW EXECUTE FUNCTION guard_personal_profile_token_identity();

CREATE FUNCTION sync_personal_profile_token_route() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 INSERT INTO public.profile_personal_token_routes(token_hash,token_id,workspace_id,user_id,expires_at,revoked_at)
 VALUES(NEW.token_hash,NEW.id,NEW.workspace_id,NEW.user_id,NEW.expires_at,NEW.revoked_at)
 ON CONFLICT(token_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at,revoked_at=EXCLUDED.revoked_at
 WHERE profile_personal_token_routes.token_id=EXCLUDED.token_id
   AND profile_personal_token_routes.workspace_id=EXCLUDED.workspace_id
   AND profile_personal_token_routes.user_id=EXCLUDED.user_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_TOKEN_ROUTE_CONFLICT'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sync_personal_profile_token_route() FROM PUBLIC;
CREATE TRIGGER sync_personal_profile_token_route AFTER INSERT OR UPDATE ON personal_access_tokens
 FOR EACH ROW EXECUTE FUNCTION sync_personal_profile_token_route();

-- Existing route metadata is copied without issuing, rotating or extending a
-- token. A missing profile fails the transition rather than choosing a tenant.
INSERT INTO profile_personal_token_routes(token_hash,token_id,workspace_id,user_id,expires_at,revoked_at)
 SELECT token_hash,id,workspace_id,user_id,expires_at,revoked_at FROM personal_access_tokens;

CREATE FUNCTION locate_personal_profile_token(request_hash text)
RETURNS TABLE(token_id uuid,workspace_id text,user_id text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT r.token_id,r.workspace_id,r.user_id FROM public.profile_personal_token_routes r
 WHERE request_hash ~ '^[a-f0-9]{64}$' AND r.token_hash=request_hash
   AND r.revoked_at IS NULL AND r.expires_at>clock_timestamp()
$$;
REVOKE ALL ON FUNCTION locate_personal_profile_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION locate_personal_profile_token(text) TO commerce_api;
-- <<< end 002_profile_personal_tokens.sql

-- >>> promoted from packages/db/profile-transition/003_profile_settings.sql (source sha256 01f9d9b21400499c7d48ea91dcad63b4391c5d88e04f7eeff28b5260ac17b526)
-- Isolated staged schema, not an automatic migration or production cutover.
CREATE OR REPLACE FUNCTION guard_profile_identity() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'PROFILE_IDENTITY_IMMUTABLE'; END IF;
 IF NEW.business_name IS DISTINCT FROM OLD.business_name OR NEW.timezone IS DISTINCT FROM OLD.timezone THEN
  IF current_setting('app.workspace_id',true) IS DISTINCT FROM OLD.id THEN
   RAISE EXCEPTION 'PROFILE_SETTINGS_CONTEXT_REQUIRED';
  END IF;
  NEW.version:=OLD.version+1;
  NEW.updated_at:=clock_timestamp();
 ELSE
  NEW.version:=OLD.version;
  NEW.updated_at:=OLD.updated_at;
 END IF;
 RETURN NEW;
END $$;
GRANT UPDATE(business_name,timezone) ON profiles TO commerce_api;
-- <<< end 003_profile_settings.sql

-- >>> V7 F2: legacy personal token scope adoption.
-- Historical owner PATs carried the full owner capability. They keep exactly
-- that effective authority as the closed owner scope set (every profile scope
-- except interactive profile switching), still intersected with the live
-- membership role at use time. Identity, environments, expiry and revocation
-- are not touched; the one-time NULL->scopes transition is the table owner's.
DO $pat_scopes$
DECLARE before_rows jsonb; after_rows jsonb;
BEGIN
 LOCK TABLE public.personal_access_tokens IN ACCESS EXCLUSIVE MODE;
 SELECT COALESCE(jsonb_agg(to_jsonb(t)-ARRAY['profile_scopes','version'] ORDER BY t.id),'[]') INTO before_rows FROM public.personal_access_tokens t;
 UPDATE public.personal_access_tokens SET profile_scopes='["profiles:read","home:read","employees:read","employees:write","tokens:read","tokens:write","products:read","products:write","variants:read","variants:write","offers:read","offers:write","materials:read","materials:write","flows:read","flows:write","sellers:read","sellers:write","collections:read","collections:write","receipt-rules:read","receipt-rules:write","numbers:read","numbers:write","numbers:connect","assignments:read","assignments:write","warmup:read","warmup:write","conversations:read","conversations:write","orders:read","orders:write","receipts:read","receipts:review","payments:read","payments:write","payments:export","remarketing:read","remarketing:write","campaigns:read","results:read","goals:read","goals:write","tests:read","tests:run","operations:read","alerts:read","alerts:write","help:read","audit:read","audit:export","privacy:read","privacy:write","profile:read","profile:write","usage:read","account:read","account:write","integrations:read","integrations:write"]'::jsonb WHERE profile_scopes IS NULL;
 SELECT COALESCE(jsonb_agg(to_jsonb(t)-ARRAY['profile_scopes','version'] ORDER BY t.id),'[]') INTO after_rows FROM public.personal_access_tokens t;
 IF before_rows IS DISTINCT FROM after_rows OR EXISTS(SELECT 1 FROM public.personal_access_tokens WHERE profile_scopes IS NULL)
  OR (SELECT count(*) FROM public.profile_personal_token_routes)<>(SELECT count(*) FROM public.personal_access_tokens) THEN
  RAISE EXCEPTION 'V7_PERSONAL_TOKEN_ADOPTION_MISMATCH';
 END IF;
END $pat_scopes$;
-- <<< end legacy personal token scope adoption
