-- V7 F3 (RF-07.a/f, RNF-02.a, RF-01.3): the gateway supervisor is platform
-- infrastructure. It authenticates with a platform token (platform:capacity)
-- and obtains, per profile, a short-lived capacity-agent service token that
-- the reviewed /v1 capacity administration already accepts. The token lives at
-- most 15 minutes, works only in REAL, carries only capacity/channel-read and
-- gateway-integration scopes, and is bound to exactly one profile.
CREATE FUNCTION platform_issue_capacity_agent_token(native_session text,native_user text,p_workspace text,p_id uuid,p_hash text,p_expires_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE live integer;
BEGIN
 PERFORM public.platform_admin_actor(native_session,native_user);
 IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PLATFORM_TOKEN_INVALID_INPUT'; END IF;
 IF p_expires_at IS NULL OR p_expires_at<=clock_timestamp()+interval '1 minute' OR p_expires_at>clock_timestamp()+interval '15 minutes' THEN RAISE EXCEPTION 'PLATFORM_TOKEN_INVALID_INPUT'; END IF;
 PERFORM 1 FROM public.profiles p WHERE p.id=p_workspace FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_PROFILE_NOT_FOUND'; END IF;
 SELECT count(*) INTO live FROM public.service_tokens t WHERE t.workspace_id=p_workspace AND t.actor_id='platform-capacity:'||native_user AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp();
 IF live>=5 THEN RAISE EXCEPTION 'PLATFORM_TOKEN_LIMIT'; END IF;
 INSERT INTO public.service_tokens(id,workspace_id,actor_id,name,token_hash,scopes,expires_at,allowed_environments,resource_ids)
 VALUES(p_id,p_workspace,'platform-capacity:'||native_user,'Supervisor de capacidad',p_hash,
  '["channels:read","channels:capacity","channels:capacity:agent","integrations:read","integrations:write"]'::jsonb,p_expires_at,'["REAL"]'::jsonb,NULL);
 RETURN jsonb_build_object('id',p_id,'workspaceId',p_workspace,'expiresAt',p_expires_at);
END $$;
GRANT SELECT(id,workspace_id,actor_id,revoked_at,expires_at),INSERT ON service_tokens TO commerce_platform_owner;
CREATE POLICY platform_capacity_agent_tokens ON service_tokens TO commerce_platform_owner
 USING(actor_id LIKE 'platform-capacity:%') WITH CHECK(actor_id LIKE 'platform-capacity:%' AND allowed_environments='["REAL"]'::jsonb AND resource_ids IS NULL
  AND scopes='["channels:read","channels:capacity","channels:capacity:agent","integrations:read","integrations:write"]'::jsonb AND expires_at<=clock_timestamp()+interval '15 minutes');
GRANT SELECT(id,state) ON profiles TO commerce_platform_owner;
REVOKE ALL ON FUNCTION platform_issue_capacity_agent_token(text,text,text,uuid,text,timestamptz) FROM PUBLIC;
ALTER FUNCTION platform_issue_capacity_agent_token(text,text,text,uuid,text,timestamptz) OWNER TO commerce_platform_owner;
GRANT EXECUTE ON FUNCTION platform_issue_capacity_agent_token(text,text,text,uuid,text,timestamptz) TO commerce_api;
