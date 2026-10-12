-- V7 F2 cutover: service tokens (V5 automation/MCP credentials) remain in use
-- and are bound to the profile of their historical workspace (FK in 0071).
-- Under FORCE RLS the API cannot search tokens across profiles, so a bearer is
-- located by its complete hash only through this closed port, which returns
-- identity IDs and never scopes, secrets or business data. The request then
-- re-reads and locks the token inside that profile's transaction.
CREATE FUNCTION locate_service_profile_token(request_hash text)
RETURNS TABLE(token_id uuid,workspace_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT t.id,t.workspace_id FROM public.service_tokens t
 WHERE request_hash ~ '^[a-f0-9]{64}$' AND t.token_hash=request_hash
  AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp()
$$;
REVOKE ALL ON FUNCTION locate_service_profile_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION locate_service_profile_token(text) TO commerce_api;

-- A credential never moves to another profile and its secret hash never changes.
CREATE FUNCTION guard_service_token_profile() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.id,NEW.workspace_id,NEW.token_hash,NEW.actor_id) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.token_hash,OLD.actor_id) THEN
  RAISE EXCEPTION 'SERVICE_TOKEN_IDENTITY_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_service_token_profile() FROM PUBLIC;
CREATE TRIGGER guard_service_token_profile BEFORE UPDATE ON service_tokens FOR EACH ROW EXECUTE FUNCTION guard_service_token_profile();

-- Global identity facts used before any profile is selected (sign-in, password
-- reset). They disclose only whether the user still belongs to some profile
-- and never which one. The API cannot read memberships across profiles.
CREATE FUNCTION identity_active_membership(native_user text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'IDENTITY_OUTSIDE_PROFILE_REQUIRED'; END IF;
 IF native_user IS NULL OR length(native_user) NOT BETWEEN 1 AND 256 THEN RETURN false; END IF;
 PERFORM 1 FROM public.memberships m JOIN public.profiles p ON p.id=m.workspace_id WHERE m.user_id=native_user AND m.active FOR SHARE OF m;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION identity_active_membership(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_active_membership(text) TO commerce_api;
-- A password change or reset revokes the user's personal tokens in every
-- profile, as before V7; identity, scopes and expiry are untouched.
CREATE FUNCTION revoke_identity_personal_tokens(native_user text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE revoked integer;
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'IDENTITY_OUTSIDE_PROFILE_REQUIRED'; END IF;
 UPDATE public.personal_access_tokens SET revoked_at=clock_timestamp() WHERE user_id=native_user AND revoked_at IS NULL;
 GET DIAGNOSTICS revoked=ROW_COUNT;
 RETURN revoked;
END $$;
REVOKE ALL ON FUNCTION revoke_identity_personal_tokens(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_identity_personal_tokens(text) TO commerce_api;
