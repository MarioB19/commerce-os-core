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
