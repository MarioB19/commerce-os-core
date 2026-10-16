-- V7 F2 RF-02.c / RF-15: the same platform actions through UI, API and MCP. A
-- platform admin issues a personal platform token (cos_plt_) from an
-- interactive session; it is bound to that admin, carries platform scopes,
-- expires within 90 days and stops working when revoked or when the admin is
-- deactivated. It never grants membership or reads profile content.
CREATE TABLE platform_tokens(
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES platform_admins(user_id),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 scopes text[] NOT NULL CHECK(cardinality(scopes) BETWEEN 1 AND 6 AND scopes <@ ARRAY['platform:profiles','platform:capacity','platform:health','platform:recovery','platform:releases','platform:audit']::text[]),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 version integer NOT NULL DEFAULT 1 CHECK(version IN(1,2)),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '90 days'),
 CHECK((revoked_at IS NULL)=(version=1))
);
CREATE INDEX platform_tokens_user ON platform_tokens(user_id,created_at);
CREATE FUNCTION guard_platform_token() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PLATFORM_TOKEN_IMMUTABLE'; END IF;
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['revoked_at','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','version']) OR OLD.revoked_at IS NOT NULL OR NEW.version<>2) THEN RAISE EXCEPTION 'PLATFORM_TOKEN_IMMUTABLE'; END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER platform_token_guard BEFORE UPDATE OR DELETE ON platform_tokens FOR EACH ROW EXECUTE FUNCTION guard_platform_token();
ALTER TABLE platform_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_tokens FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_tokens FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE(revoked_at,version) ON platform_tokens TO commerce_platform_owner;
CREATE POLICY platform_token_owner ON platform_tokens TO commerce_platform_owner USING(true) WITH CHECK(true);
REVOKE ALL ON FUNCTION guard_platform_token() FROM PUBLIC;

-- A platform credential is either an interactive native session or, when the
-- first argument is 'platform-token:<sha256>', a live token of the same admin.
CREATE OR REPLACE FUNCTION platform_admin_actor(native_session text,native_user text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'PLATFORM_OUTSIDE_PROFILE_REQUIRED'; END IF;
 IF native_session IS NULL OR length(native_session)=0 OR native_user IS NULL OR length(native_user)=0 THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 IF native_session LIKE 'platform-token:%' THEN
  PERFORM 1 FROM public.platform_tokens t WHERE t.token_hash=substr(native_session,16) AND t.user_id=native_user AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_TOKEN_INVALID'; END IF;
 ELSE
  PERFORM 1 FROM public.session s WHERE s.id=native_session AND s."userId"=native_user AND s."expiresAt">clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 END IF;
 PERFORM 1 FROM public.platform_admins a WHERE a.user_id=native_user AND a.active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED'; END IF;
 RETURN native_user;
END $$;

-- Resolves a presented token to its admin and scopes (no secret leaves the DB).
CREATE FUNCTION platform_token_actor(presented_hash text) RETURNS TABLE(user_id text,scopes text[],expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'PLATFORM_OUTSIDE_PROFILE_REQUIRED'; END IF;
 IF presented_hash IS NULL OR presented_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PLATFORM_TOKEN_INVALID'; END IF;
 RETURN QUERY SELECT t.user_id,t.scopes,t.expires_at FROM public.platform_tokens t JOIN public.platform_admins a ON a.user_id=t.user_id AND a.active
  WHERE t.token_hash=presented_hash AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_TOKEN_INVALID'; END IF;
END $$;

-- Only an interactive session issues a token; a token never issues another.
CREATE FUNCTION platform_issue_token(native_session text,native_user text,p_id uuid,p_name text,p_scopes text[],p_expires_at timestamptz,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE row public.platform_tokens%ROWTYPE;
BEGIN
 IF native_session LIKE 'platform-token:%' THEN RAISE EXCEPTION 'PLATFORM_INTERACTIVE_SESSION_REQUIRED'; END IF;
 PERFORM public.platform_admin_actor(native_session,native_user);
 IF (SELECT count(*) FROM public.platform_tokens t WHERE t.user_id=native_user AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp())>=10 THEN RAISE EXCEPTION 'PLATFORM_TOKEN_LIMIT'; END IF;
 IF p_scopes IS NULL OR cardinality(p_scopes)=0 OR (SELECT count(DISTINCT s) FROM unnest(p_scopes) s)<>cardinality(p_scopes) THEN RAISE EXCEPTION 'PLATFORM_TOKEN_INVALID_INPUT'; END IF;
 IF p_expires_at IS NULL OR p_expires_at<=clock_timestamp()+interval '5 minutes' OR p_expires_at>clock_timestamp()+interval '90 days' THEN RAISE EXCEPTION 'PLATFORM_TOKEN_INVALID_INPUT'; END IF;
 INSERT INTO public.platform_tokens(id,user_id,name,token_hash,scopes,expires_at) VALUES(p_id,native_user,btrim(p_name),p_hash,(SELECT array_agg(s ORDER BY s) FROM unnest(p_scopes) s),p_expires_at) RETURNING * INTO row;
 RETURN jsonb_build_object('id',row.id,'name',row.name,'scopes',to_jsonb(row.scopes),'expiresAt',row.expires_at,'createdAt',row.created_at);
END $$;
CREATE FUNCTION platform_list_tokens(native_session text,native_user text) RETURNS TABLE(id uuid,name text,scopes text[],expires_at timestamptz,revoked_at timestamptz,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM public.platform_admin_actor(native_session,native_user);
 RETURN QUERY SELECT t.id,t.name,t.scopes,t.expires_at,t.revoked_at,t.created_at FROM public.platform_tokens t WHERE t.user_id=native_user ORDER BY t.created_at DESC LIMIT 50;
END $$;
CREATE FUNCTION platform_revoke_token(native_session text,native_user text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE row public.platform_tokens%ROWTYPE;
BEGIN
 PERFORM public.platform_admin_actor(native_session,native_user);
 UPDATE public.platform_tokens SET revoked_at=clock_timestamp(),version=2 WHERE id=p_id AND user_id=native_user AND revoked_at IS NULL RETURNING * INTO row;
 IF row.id IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.platform_tokens WHERE id=p_id AND user_id=native_user) THEN RETURN jsonb_build_object('id',p_id,'revoked',true,'changed',false); END IF;
  RAISE EXCEPTION 'PLATFORM_TOKEN_NOT_FOUND';
 END IF;
 RETURN jsonb_build_object('id',row.id,'revoked',true,'changed',true);
END $$;

-- RF-02.b: the aggregate also reports an invalid Meta token (state only).
DROP FUNCTION platform_profile_summaries(text,text);
CREATE FUNCTION platform_profile_summaries(native_session text,native_user text)
RETURNS TABLE(id text,business_name text,state text,timezone text,number_limit integer,product_limit integer,daily_conversation_limit integer,version integer,
 owners bigint,numbers_registered bigint,numbers_connected bigint,products bigint,variants bigint,offers bigint,ai_unverified bigint,meta_invalid boolean,last_activity_at timestamptz,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM public.platform_admin_actor(native_session,native_user);
 RETURN QUERY SELECT p.id,p.business_name,p.state,p.timezone,p.number_limit,p.product_limit,p.daily_conversation_limit,p.version,
  (SELECT count(*) FROM public.memberships m WHERE m.workspace_id=p.id AND m.role='owner' AND m.active),
  (SELECT count(*) FROM public.records r WHERE r.workspace_id=p.id AND r.environment='REAL' AND r.kind='channel_account' AND NOT(r.body?'deleted_at')),
  (SELECT count(*) FROM public.records r WHERE r.workspace_id=p.id AND r.environment='REAL' AND r.kind='channel_account' AND NOT(r.body?'deleted_at') AND r.body->>'status'='WORKING'),
  (SELECT count(*) FROM public.records r WHERE r.workspace_id=p.id AND r.environment='REAL' AND r.kind='product' AND NOT(r.body?'deleted_at')),
  (SELECT count(*) FROM public.market_variants v WHERE v.workspace_id=p.id AND v.environment='REAL'),
  (SELECT count(*) FROM public.records r WHERE r.workspace_id=p.id AND r.environment='REAL' AND r.kind='offer' AND NOT(r.body?'deleted_at')),
  (SELECT count(*) FROM public.ai_credentials c WHERE c.workspace_id=p.id AND c.environment='REAL' AND c.enabled AND c.state<>'VERIFIED'),
  COALESCE((SELECT c.enabled AND c.state='INVALID' FROM public.meta_profile_credentials c WHERE c.workspace_id=p.id),false),
  (SELECT max(e.recorded_at) FROM public.domain_events e WHERE e.workspace_id=p.id AND e.environment='REAL'),
  p.created_at
 FROM public.profiles p ORDER BY p.business_name,p.id;
END $$;
REVOKE ALL ON FUNCTION platform_profile_summaries(text,text),platform_token_actor(text),platform_issue_token(text,text,uuid,text,text[],timestamptz,text),platform_list_tokens(text,text),platform_revoke_token(text,text,uuid) FROM PUBLIC;
ALTER FUNCTION platform_profile_summaries(text,text) OWNER TO commerce_platform_owner;
ALTER FUNCTION platform_admin_actor(text,text) OWNER TO commerce_platform_owner;
ALTER FUNCTION platform_token_actor(text) OWNER TO commerce_platform_owner;
ALTER FUNCTION platform_issue_token(text,text,uuid,text,text[],timestamptz,text) OWNER TO commerce_platform_owner;
ALTER FUNCTION platform_list_tokens(text,text) OWNER TO commerce_platform_owner;
ALTER FUNCTION platform_revoke_token(text,text,uuid) OWNER TO commerce_platform_owner;
GRANT EXECUTE ON FUNCTION platform_profile_summaries(text,text),platform_token_actor(text),platform_issue_token(text,text,uuid,text,text[],timestamptz,text),platform_list_tokens(text,text),platform_revoke_token(text,text,uuid) TO commerce_api;
