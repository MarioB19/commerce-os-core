-- V7 F2 RF-01.5/RF-02: platform administration outside every profile.
-- A platform admin sees one aggregate projection per profile (counts, states,
-- last activity and capacity) and can create a profile, invite its first owner,
-- suspend/reactivate it and adjust its limits. It never reads conversations,
-- contacts, messages, payments or any other profile content, and it is never a
-- member of the profiles it administers. Deleting a profile is not provided.
SELECT public.v7_ensure_reviewed_role('commerce_platform_owner',false);
GRANT USAGE ON SCHEMA public TO commerce_platform_owner;

CREATE TABLE platform_admins(
 user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
 source text NOT NULL CHECK(source IN('CUTOVER_PRINCIPAL_OWNER','INSTALLER')),
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_admins FROM PUBLIC;
GRANT SELECT ON platform_admins TO commerce_platform_owner;
CREATE POLICY platform_admin_reader ON platform_admins FOR SELECT TO commerce_platform_owner USING(true);

-- The first platform admins are the active owners of the principal profile
-- adopted at cutover («Operación Brandon»); a fresh installation has none until
-- its installer grants one explicitly.
INSERT INTO platform_admins(user_id,source)
SELECT m.user_id,'CUTOVER_PRINCIPAL_OWNER' FROM memberships m
 JOIN profile_adoption_receipts r ON r.workspace_id=m.workspace_id AND r.disposition='PRINCIPAL'
 JOIN "user" u ON u.id=m.user_id
 WHERE m.role='owner' AND m.active
ON CONFLICT DO NOTHING;

-- A state change (suspend/reactivate) is a versioned profile change, so a
-- platform CAS on the profile version observes it (0072 versioned only settings).
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
 ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
  NEW.version:=OLD.version+1;
  NEW.updated_at:=clock_timestamp();
 ELSE
  NEW.version:=OLD.version;
  NEW.updated_at:=OLD.updated_at;
 END IF;
 RETURN NEW;
END $$;

-- Durable, idempotent platform operations; also the platform audit trail.
CREATE TABLE platform_operations(
 id uuid PRIMARY KEY,
 actor_id text NOT NULL REFERENCES platform_admins(user_id),
 kind text NOT NULL CHECK(kind IN('CREATE_PROFILE','SET_STATE','SET_LIMITS','INVITE_OWNER')),
 profile_id text NOT NULL REFERENCES profiles(id),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX platform_operations_profile ON platform_operations(profile_id,created_at);
CREATE TRIGGER immutable_platform_operations BEFORE UPDATE OR DELETE ON platform_operations FOR EACH ROW EXECUTE FUNCTION immutable_row();
ALTER TABLE platform_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_operations FROM PUBLIC;
GRANT SELECT,INSERT ON platform_operations TO commerce_platform_owner;
CREATE POLICY platform_operation_owner ON platform_operations TO commerce_platform_owner USING(true) WITH CHECK(true);

-- An owner invitation may be requested by a platform admin instead of a member.
ALTER TABLE profile_invitations ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE profile_invitations ADD COLUMN platform_requested_by text REFERENCES platform_admins(user_id);
ALTER TABLE profile_invitations ADD CONSTRAINT profile_invitation_requester CHECK((requested_by IS NULL)<>(platform_requested_by IS NULL));
ALTER TABLE profile_invitations ADD CONSTRAINT profile_invitation_platform_owner_only CHECK(platform_requested_by IS NULL OR role='owner');

-- Aggregate-only reads: row policies restrict records to non-personal kinds and
-- column grants keep payloads of events, credentials and variants out of reach.
GRANT SELECT,INSERT ON profiles TO commerce_platform_owner;
GRANT UPDATE(state,number_limit,product_limit,daily_conversation_limit,version,updated_at) ON profiles TO commerce_platform_owner;
CREATE POLICY platform_profile_owner ON profiles TO commerce_platform_owner USING(true) WITH CHECK(true);
GRANT SELECT(workspace_id,environment,kind,body) ON records TO commerce_platform_owner;
CREATE POLICY platform_inventory_reader ON records FOR SELECT TO commerce_platform_owner USING(kind IN('channel_account','product','offer'));
GRANT SELECT(workspace_id,environment) ON market_variants TO commerce_platform_owner;
CREATE POLICY platform_variant_reader ON market_variants FOR SELECT TO commerce_platform_owner USING(true);
GRANT SELECT(workspace_id,environment,recorded_at) ON domain_events TO commerce_platform_owner;
CREATE POLICY platform_activity_reader ON domain_events FOR SELECT TO commerce_platform_owner USING(true);
GRANT SELECT(workspace_id,environment,enabled,state) ON ai_credentials TO commerce_platform_owner;
CREATE POLICY platform_credential_state_reader ON ai_credentials FOR SELECT TO commerce_platform_owner USING(true);
GRANT SELECT(max_profiles,max_numbers,daily_conversations) ON profile_quota_policy TO commerce_platform_owner;
CREATE POLICY platform_quota_policy_reader ON profile_quota_policy FOR SELECT TO commerce_platform_owner USING(true);
GRANT SELECT(user_id,workspace_id,role,active) ON memberships TO commerce_platform_owner;
CREATE POLICY platform_owner_count_reader ON memberships FOR SELECT TO commerce_platform_owner USING(role='owner');
GRANT SELECT,INSERT ON profile_invitations,profile_invitation_mail_jobs TO commerce_platform_owner;
CREATE POLICY platform_owner_invitations ON profile_invitations TO commerce_platform_owner USING(role='owner') WITH CHECK(role='owner' AND platform_requested_by IS NOT NULL AND requested_by IS NULL);
CREATE POLICY platform_owner_invitation_jobs ON profile_invitation_mail_jobs TO commerce_platform_owner USING(true) WITH CHECK(true);
DO $grants$
BEGIN
 IF to_regprocedure('public.profile_quota_inventory(text)') IS NULL OR to_regprocedure('public.adopt_profile_quota_inventory(text,text)') IS NULL THEN RAISE EXCEPTION 'PLATFORM_QUOTA_ADOPTION_REQUIRED'; END IF;
END $grants$;
GRANT EXECUTE ON FUNCTION profile_quota_inventory(text),adopt_profile_quota_inventory(text,text) TO commerce_platform_owner;

CREATE FUNCTION platform_admin_actor(native_session text,native_user text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'PLATFORM_OUTSIDE_PROFILE_REQUIRED'; END IF;
 IF native_session IS NULL OR length(native_session)=0 OR native_user IS NULL OR length(native_user)=0 THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 PERFORM 1 FROM public.session s WHERE s.id=native_session AND s."userId"=native_user AND s."expiresAt">clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 PERFORM 1 FROM public.platform_admins a WHERE a.user_id=native_user AND a.active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED'; END IF;
 RETURN native_user;
END $$;
GRANT SELECT(id,"userId","expiresAt"),UPDATE(id) ON session TO commerce_platform_owner;
GRANT UPDATE(user_id) ON platform_admins TO commerce_platform_owner;
CREATE POLICY platform_admin_lock ON platform_admins FOR UPDATE TO commerce_platform_owner USING(true) WITH CHECK(false);

-- One row per profile; no personal or content field leaves this function.
CREATE FUNCTION platform_profile_summaries(native_session text,native_user text)
RETURNS TABLE(id text,business_name text,state text,timezone text,number_limit integer,product_limit integer,daily_conversation_limit integer,version integer,
 owners bigint,numbers_registered bigint,numbers_connected bigint,products bigint,variants bigint,offers bigint,ai_unverified bigint,last_activity_at timestamptz,created_at timestamptz)
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
  (SELECT max(e.recorded_at) FROM public.domain_events e WHERE e.workspace_id=p.id AND e.environment='REAL'),
  p.created_at
 FROM public.profiles p ORDER BY p.business_name,p.id;
END $$;

CREATE FUNCTION platform_capacity(native_session text,native_user text)
RETURNS TABLE(profiles bigint,max_profiles integer,allocated_numbers bigint,max_numbers integer,registered_numbers bigint,daily_conversations integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM public.platform_admin_actor(native_session,native_user);
 RETURN QUERY SELECT (SELECT count(*) FROM public.profiles),q.max_profiles,(SELECT COALESCE(sum(f.number_limit),0) FROM public.profiles f),q.max_numbers,
  (SELECT count(*) FROM public.records r WHERE r.environment='REAL' AND r.kind='channel_account' AND NOT(r.body?'deleted_at')),q.daily_conversations
 FROM public.profile_quota_policy q;
END $$;

-- Replays of the same operation id with the same request are no-effect and
-- return the original result; a different request under the same id fails.
CREATE FUNCTION platform_operation_replay(op uuid,actor text,op_kind text,digest text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE prior public.platform_operations%ROWTYPE;
BEGIN
 IF op IS NULL OR digest IS NULL OR digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PLATFORM_OPERATION_INVALID'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('platform-operation:'||op::text,0));
 SELECT * INTO prior FROM public.platform_operations WHERE id=op;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF prior.actor_id<>actor OR prior.kind<>op_kind OR prior.request_sha256<>digest THEN RAISE EXCEPTION 'PLATFORM_OPERATION_CONTENT_CHANGED'; END IF;
 RETURN prior.result||jsonb_build_object('replayed',true);
END $$;

CREATE FUNCTION platform_create_profile(native_session text,native_user text,op uuid,p_name text,p_timezone text,p_numbers integer,p_products integer,p_daily integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=public.platform_admin_actor(native_session,native_user);digest text;prior jsonb;new_id text;previous text:=current_setting('app.workspace_id',true);result jsonb;
BEGIN
 IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 160 OR p_timezone IS NULL OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_timezone)
  OR p_numbers IS NULL OR p_numbers NOT BETWEEN 0 AND 20 OR p_products IS NULL OR p_products NOT BETWEEN 0 AND 100000 OR p_daily IS NULL OR p_daily NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'PLATFORM_PROFILE_INVALID'; END IF;
 digest:=encode(public.digest(convert_to(jsonb_build_array(btrim(p_name),p_timezone,p_numbers,p_products,p_daily)::text,'UTF8'),'sha256'),'hex');
 prior:=public.platform_operation_replay(op,actor,'CREATE_PROFILE',digest);IF prior IS NOT NULL THEN RETURN prior; END IF;
 new_id:='profile-'||gen_random_uuid()::text;
 PERFORM set_config('app.workspace_id',new_id,true);
 INSERT INTO public.profiles(id,business_name,state,timezone,number_limit,product_limit,daily_conversation_limit) VALUES(new_id,btrim(p_name),'ACTIVE',p_timezone,p_numbers,p_products,p_daily);
 PERFORM public.adopt_profile_quota_inventory(new_id,public.profile_quota_inventory(new_id));
 PERFORM set_config('app.workspace_id',COALESCE(previous,''),true);
 result:=jsonb_build_object('status','CREATED','profile_id',new_id,'version',1);
 INSERT INTO public.platform_operations(id,actor_id,kind,profile_id,request_sha256,result) VALUES(op,actor,'CREATE_PROFILE',new_id,digest,result);
 RETURN result;
END $$;

CREATE FUNCTION platform_update_profile(native_session text,native_user text,op uuid,p_id text,expected_version integer,p_state text,p_numbers integer,p_products integer,p_daily integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=public.platform_admin_actor(native_session,native_user);digest text;prior jsonb;row_ public.profiles%ROWTYPE;op_kind text;previous text:=current_setting('app.workspace_id',true);result jsonb;
BEGIN
 IF p_id IS NULL OR expected_version IS NULL OR expected_version<1 THEN RAISE EXCEPTION 'PLATFORM_PROFILE_INVALID'; END IF;
 IF p_state IS NOT NULL AND (p_numbers IS NOT NULL OR p_products IS NOT NULL OR p_daily IS NOT NULL) THEN RAISE EXCEPTION 'PLATFORM_PROFILE_INVALID'; END IF;
 IF p_state IS NULL AND (p_numbers IS NULL OR p_products IS NULL OR p_daily IS NULL) THEN RAISE EXCEPTION 'PLATFORM_PROFILE_INVALID'; END IF;
 IF p_state IS NOT NULL AND p_state NOT IN('ACTIVE','SUSPENDED') THEN RAISE EXCEPTION 'PLATFORM_PROFILE_INVALID'; END IF;
 IF p_state IS NULL AND (p_numbers NOT BETWEEN 0 AND 20 OR p_products NOT BETWEEN 0 AND 100000 OR p_daily NOT BETWEEN 0 AND 100000) THEN RAISE EXCEPTION 'PLATFORM_PROFILE_INVALID'; END IF;
 op_kind:=CASE WHEN p_state IS NULL THEN 'SET_LIMITS' ELSE 'SET_STATE' END;
 digest:=encode(public.digest(convert_to(jsonb_build_array(p_id,expected_version,p_state,p_numbers,p_products,p_daily)::text,'UTF8'),'sha256'),'hex');
 prior:=public.platform_operation_replay(op,actor,op_kind,digest);IF prior IS NOT NULL THEN RETURN prior; END IF;
 PERFORM set_config('app.workspace_id',p_id,true);
 SELECT * INTO row_ FROM public.profiles WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_PROFILE_NOT_FOUND'; END IF;
 IF row_.version<>expected_version THEN RAISE EXCEPTION 'PLATFORM_PROFILE_CHANGED'; END IF;
 IF op_kind='SET_STATE' THEN
  UPDATE public.profiles SET state=p_state,version=version+1,updated_at=clock_timestamp() WHERE id=p_id;
 ELSE
  UPDATE public.profiles SET number_limit=p_numbers,product_limit=p_products,daily_conversation_limit=p_daily,version=version+1,updated_at=clock_timestamp() WHERE id=p_id;
 END IF;
 PERFORM set_config('app.workspace_id',COALESCE(previous,''),true);
 result:=jsonb_build_object('status','UPDATED','profile_id',p_id,'version',expected_version+1);
 INSERT INTO public.platform_operations(id,actor_id,kind,profile_id,request_sha256,result) VALUES(op,actor,op_kind,p_id,digest,result);
 RETURN result;
END $$;

-- The API encrypts the recipient before calling; this function never sees the
-- address. Only an ACTIVE profile without an active owner may receive one.
CREATE FUNCTION platform_invite_owner(native_session text,native_user text,op uuid,p_id text,invitation uuid,recipient_digest text,recipient_ciphertext text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=public.platform_admin_actor(native_session,native_user);digest text;prior jsonb;f public.profiles%ROWTYPE;previous text:=current_setting('app.workspace_id',true);result jsonb;now_ timestamptz:=clock_timestamp();
BEGIN
 IF p_id IS NULL OR invitation IS NULL OR recipient_digest IS NULL OR recipient_digest !~ '^[a-f0-9]{64}$' OR recipient_ciphertext IS NULL OR length(recipient_ciphertext) NOT BETWEEN 1 AND 4096 THEN RAISE EXCEPTION 'PLATFORM_INVITATION_INVALID'; END IF;
 digest:=encode(public.digest(convert_to(jsonb_build_array(p_id,recipient_digest)::text,'UTF8'),'sha256'),'hex');
 prior:=public.platform_operation_replay(op,actor,'INVITE_OWNER',digest);IF prior IS NOT NULL THEN RETURN prior; END IF;
 PERFORM set_config('app.workspace_id',p_id,true);
 SELECT * INTO f FROM public.profiles WHERE id=p_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_PROFILE_NOT_FOUND'; END IF;
 IF f.state<>'ACTIVE' THEN RAISE EXCEPTION 'PROFILE_SUSPENDED'; END IF;
 IF EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=p_id AND m.role='owner' AND m.active) THEN RAISE EXCEPTION 'PLATFORM_PROFILE_HAS_OWNER'; END IF;
 IF EXISTS(SELECT 1 FROM public.profile_invitations i WHERE i.workspace_id=p_id AND i.recipient_digest=platform_invite_owner.recipient_digest AND i.status='PENDING') THEN RAISE EXCEPTION 'INVITATION_ALREADY_PENDING'; END IF;
 INSERT INTO public.profile_invitations(id,workspace_id,operation_id,requested_by,platform_requested_by,role,recipient_digest,recipient_ciphertext,request_digest,created_at)
 VALUES(invitation,p_id,op,NULL,actor,'owner',platform_invite_owner.recipient_digest,recipient_ciphertext,digest,now_);
 INSERT INTO public.profile_invitation_mail_jobs(id,workspace_id,invitation_id,invitation_version,template,created_at) VALUES(gen_random_uuid(),p_id,invitation,1,'profile-invitation-v1',now_);
 PERFORM set_config('app.workspace_id',COALESCE(previous,''),true);
 result:=jsonb_build_object('status','QUEUED','profile_id',p_id,'invitation_id',invitation);
 INSERT INTO public.platform_operations(id,actor_id,kind,profile_id,request_sha256,result) VALUES(op,actor,'INVITE_OWNER',p_id,digest,result);
 RETURN result;
END $$;

DO $owners$
DECLARE fn text;
BEGIN
 FOREACH fn IN ARRAY ARRAY['platform_admin_actor(text,text)','platform_profile_summaries(text,text)','platform_capacity(text,text)','platform_operation_replay(uuid,text,text,text)',
  'platform_create_profile(text,text,uuid,text,text,integer,integer,integer)','platform_update_profile(text,text,uuid,text,integer,text,integer,integer,integer)',
  'platform_invite_owner(text,text,uuid,text,uuid,text,text)'] LOOP
  EXECUTE format('ALTER FUNCTION public.%s OWNER TO commerce_platform_owner',fn);
  EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC',fn);
 END LOOP;
END $owners$;
GRANT EXECUTE ON FUNCTION platform_admin_actor(text,text),platform_profile_summaries(text,text),platform_capacity(text,text),
 platform_create_profile(text,text,uuid,text,text,integer,integer,integer),platform_update_profile(text,text,uuid,text,integer,text,integer,integer,integer),
 platform_invite_owner(text,text,uuid,text,uuid,text,text) TO commerce_api;
GRANT EXECUTE ON FUNCTION digest(bytea,text),gen_random_uuid() TO commerce_platform_owner;

-- Mail custody for platform owner invitations: the issuer is the platform admin
-- (still active at reservation time) instead of an owner member.
ALTER TABLE profile_invitation_mail_attempts ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE profile_invitation_mail_attempts ADD COLUMN platform_requested_by text REFERENCES platform_admins(user_id);
ALTER TABLE profile_invitation_mail_attempts ADD CONSTRAINT profile_invitation_mail_requester CHECK((requested_by IS NULL)<>(platform_requested_by IS NULL));
CREATE TEMP TABLE v7_platform_patches(fn text,old text,new text) ON COMMIT DROP;
INSERT INTO pg_temp.v7_platform_patches VALUES
 ('public.lock_profile_invitation_mail(text,uuid)',
  ' SELECT role,active INTO author_role,author_active FROM public.memberships WHERE user_id=invitation.requested_by AND workspace_id=p_workspace FOR SHARE;'||chr(10)||' IF author_role IS DISTINCT FROM ''owner'' OR author_active IS DISTINCT FROM true THEN RAISE EXCEPTION ''MAIL_ISSUER_REVOKED''; END IF;',
  ' IF invitation.platform_requested_by IS NOT NULL THEN'||chr(10)||'  IF invitation.role IS DISTINCT FROM ''owner'' OR NOT EXISTS(SELECT 1 FROM public.platform_admins a WHERE a.user_id=invitation.platform_requested_by AND a.active) THEN RAISE EXCEPTION ''MAIL_ISSUER_REVOKED''; END IF;'||chr(10)||' ELSE'||chr(10)||' SELECT role,active INTO author_role,author_active FROM public.memberships WHERE user_id=invitation.requested_by AND workspace_id=p_workspace FOR SHARE;'||chr(10)||' IF author_role IS DISTINCT FROM ''owner'' OR author_active IS DISTINCT FROM true THEN RAISE EXCEPTION ''MAIL_ISSUER_REVOKED''; END IF;'||chr(10)||' END IF;'),
 ('public.reserve_profile_invitation_mail(text,uuid,uuid,text)',
  'invitation_version,requested_by,state,reserved_micro_usd',
  'invitation_version,requested_by,platform_requested_by,state,reserved_micro_usd'),
 ('public.reserve_profile_invitation_mail(text,uuid,uuid,text)',
  'invitation.version,invitation.requested_by,''RESERVED''',
  'invitation.version,invitation.requested_by,invitation.platform_requested_by,''RESERVED''');
DO $patch$
DECLARE definition text; patched text; patch record;
BEGIN
 FOR definition IN SELECT DISTINCT fn FROM pg_temp.v7_platform_patches ORDER BY 1 LOOP
  SELECT pg_get_functiondef(definition::regprocedure) INTO patched;
  FOR patch IN SELECT * FROM pg_temp.v7_platform_patches WHERE fn=definition LOOP
   IF (length(patched)-length(replace(patched,patch.old,'')))<>length(patch.old) THEN RAISE EXCEPTION 'V7_PLATFORM_DEFINITION_DRIFT: %',definition; END IF;
   patched:=replace(patched,patch.old,patch.new);
  END LOOP;
  EXECUTE patched;
 END LOOP;
END $patch$;

-- Invitation acceptance (API) re-checks a platform issuer through this port.
CREATE FUNCTION platform_invitation_issuer_active(issuer text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.platform_admins a WHERE a.user_id=issuer AND a.active);
$$;
ALTER FUNCTION platform_invitation_issuer_active(text) OWNER TO commerce_platform_owner;
REVOKE ALL ON FUNCTION platform_invitation_issuer_active(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_invitation_issuer_active(text) TO commerce_api;
