-- Component of the reviewed 020 cutover. Not an automatic migration.
-- Run only as the schema migration owner, in the same atomic data transition.
CREATE ROLE commerce_profile_bootstrap_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
GRANT USAGE ON SCHEMA public TO commerce_profile_bootstrap_owner;
GRANT SELECT(id,"userId","expiresAt"),UPDATE(id) ON session TO commerce_profile_bootstrap_owner;
GRANT SELECT(user_id,workspace_id,role,active,version),UPDATE(user_id) ON memberships TO commerce_profile_bootstrap_owner;
GRANT SELECT(id,business_name,state,timezone,version),UPDATE(id) ON profiles TO commerce_profile_bootstrap_owner;
GRANT SELECT,INSERT,UPDATE ON profile_session_context TO commerce_profile_bootstrap_owner;
CREATE POLICY profile_bootstrap_membership ON memberships TO commerce_profile_bootstrap_owner USING(true);
CREATE POLICY profile_bootstrap_profile ON profiles TO commerce_profile_bootstrap_owner USING(true);
CREATE POLICY profile_bootstrap_selection ON profile_session_context TO commerce_profile_bootstrap_owner USING(true) WITH CHECK(true);

CREATE FUNCTION list_authenticated_profile_choices(native_session text,native_user text)
RETURNS TABLE(id text,business_name text,state text,timezone text,role text,membership_version integer,selected boolean,selection_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'PROFILE_BOOTSTRAP_OUTSIDE_SCOPE_REQUIRED'; END IF;
 IF native_session IS NULL OR length(native_session)=0 OR native_user IS NULL OR length(native_user)=0 THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 PERFORM 1 FROM public.session s WHERE s.id=native_session AND s."userId"=native_user AND s."expiresAt">clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 IF (SELECT count(*) FROM public.memberships m JOIN public.profiles p ON p.id=m.workspace_id WHERE m.user_id=native_user AND m.active)>3 THEN RAISE EXCEPTION 'PROFILE_BOOTSTRAP_BOUND'; END IF;
 IF EXISTS(SELECT 1 FROM public.memberships m JOIN public.profiles p ON p.id=m.workspace_id WHERE m.user_id=native_user AND m.active AND (m.role NOT IN('owner','operator','viewer') OR m.version<1 OR p.version<1)) THEN RAISE EXCEPTION 'PROFILE_ROLE_ADOPTION_REQUIRED'; END IF;
 RETURN QUERY SELECT p.id,p.business_name,p.state,p.timezone,m.role,m.version,
  COALESCE(c.workspace_id=p.id AND c.membership_version=m.version,false),c.version
 FROM public.memberships m JOIN public.profiles p ON p.id=m.workspace_id
 LEFT JOIN public.profile_session_context c ON c.session_id=native_session AND c.user_id=native_user
 WHERE m.user_id=native_user AND m.active ORDER BY p.business_name,p.id FOR SHARE OF m,p;
 PERFORM 1 FROM public.session s WHERE s.id=native_session AND s."userId"=native_user AND s."expiresAt">clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
END $$;
ALTER FUNCTION list_authenticated_profile_choices(text,text) OWNER TO commerce_profile_bootstrap_owner;
REVOKE ALL ON FUNCTION list_authenticated_profile_choices(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_authenticated_profile_choices(text,text) TO commerce_api;

CREATE FUNCTION select_authenticated_profile(native_session text,native_user text,target_profile text,expected_version integer)
RETURNS TABLE(workspace_id text,version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old_selection public.profile_session_context%ROWTYPE; member_row record; profile_row record;
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'PROFILE_BOOTSTRAP_OUTSIDE_SCOPE_REQUIRED'; END IF;
 IF native_session IS NULL OR length(native_session)=0 OR native_user IS NULL OR length(native_user)=0 THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 IF target_profile IS NULL OR length(target_profile) NOT BETWEEN 1 AND 256 OR expected_version IS NULL OR expected_version<0 OR expected_version>=2147483647 THEN RAISE EXCEPTION 'PROFILE_SELECTION_INVALID'; END IF;
 PERFORM 1 FROM public.session s WHERE s.id=native_session AND s."userId"=native_user AND s."expiresAt">clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 SELECT c.* INTO old_selection FROM public.profile_session_context c WHERE c.session_id=native_session AND c.user_id=native_user FOR UPDATE;
 IF COALESCE(old_selection.version,0)<>expected_version THEN RAISE EXCEPTION 'PROFILE_SELECTION_CHANGED'; END IF;
 SELECT m.role,m.active,m.version INTO member_row FROM public.memberships m WHERE m.user_id=native_user AND m.workspace_id=target_profile FOR SHARE;
 IF NOT FOUND OR member_row.active IS DISTINCT FROM true THEN RAISE EXCEPTION 'PROFILE_MEMBERSHIP_REQUIRED'; END IF;
 IF member_row.role NOT IN('owner','operator','viewer') OR member_row.version<1 THEN RAISE EXCEPTION 'PROFILE_ROLE_ADOPTION_REQUIRED'; END IF;
 SELECT p.state,p.version INTO profile_row FROM public.profiles p WHERE p.id=target_profile FOR SHARE;
 IF NOT FOUND OR profile_row.state NOT IN('ACTIVE','SUSPENDED') OR profile_row.version<1 THEN RAISE EXCEPTION 'PROFILE_UNAVAILABLE'; END IF;
 PERFORM 1 FROM public.session s WHERE s.id=native_session AND s."userId"=native_user AND s."expiresAt">clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 RETURN QUERY INSERT INTO public.profile_session_context AS c(session_id,user_id,workspace_id,membership_version,version)
 VALUES(native_session,native_user,target_profile,member_row.version,1)
 ON CONFLICT(session_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,membership_version=EXCLUDED.membership_version,version=c.version+1,updated_at=clock_timestamp()
 WHERE c.user_id=native_user AND c.version=expected_version RETURNING c.workspace_id,c.version;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SELECTION_CHANGED'; END IF;
 PERFORM 1 FROM public.session s WHERE s.id=native_session AND s."userId"=native_user AND s."expiresAt">clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
END $$;
ALTER FUNCTION select_authenticated_profile(text,text,text,integer) OWNER TO commerce_profile_bootstrap_owner;
REVOKE ALL ON FUNCTION select_authenticated_profile(text,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION select_authenticated_profile(text,text,text,integer) TO commerce_api;
