-- V7 RF-01.5: deleting a profile requires a readable export and Brandon's
-- specific confirmation. The owner exports the profile's own data (the platform
-- admin never reads profile content, 0100); the export leaves only a receipt
-- (hash, rows, bytes). The platform admin then requests the deletion of a
-- SUSPENDED profile by typing its exact business name, citing a receipt from
-- the last 7 days. The request keeps the profile suspended (it cannot be
-- reactivated while pending) and is the input of the D-18 erasure window; this
-- migration erases nothing.

CREATE TABLE profile_data_exports(
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES profiles(id),
 environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 actor_id text NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 row_count bigint NOT NULL CHECK(row_count>=0),
 byte_count bigint NOT NULL CHECK(byte_count>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id)
);
CREATE INDEX profile_data_exports_recent ON profile_data_exports(workspace_id,created_at DESC);
CREATE TRIGGER immutable_profile_data_exports BEFORE UPDATE OR DELETE ON profile_data_exports FOR EACH ROW EXECUTE FUNCTION immutable_row();
ALTER TABLE profile_data_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_data_exports FORCE ROW LEVEL SECURITY;
REVOKE ALL ON profile_data_exports FROM PUBLIC;
CREATE POLICY profile_scope ON profile_data_exports USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
GRANT SELECT,INSERT ON profile_data_exports TO commerce_api;
-- The platform sees the receipt only (no content exists in this table).
GRANT SELECT(id,workspace_id,sha256,row_count,byte_count,created_at) ON profile_data_exports TO commerce_platform_owner;
CREATE POLICY platform_export_receipts ON profile_data_exports FOR SELECT TO commerce_platform_owner USING(true);

CREATE TABLE platform_profile_deletions(
 id uuid PRIMARY KEY,
 profile_id text NOT NULL REFERENCES profiles(id),
 export_id uuid NOT NULL,
 requested_by text NOT NULL REFERENCES platform_admins(user_id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 8 AND 500),
 status text NOT NULL CHECK(status IN('PENDING_ERASURE','CANCELLED')),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 cancelled_by text REFERENCES platform_admins(user_id),
 cancelled_at timestamptz,
 cancel_reason text CHECK(cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 8 AND 500),
 CHECK((status='CANCELLED')=(cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL)),
 -- Composed by profile: a request can only cite an export of the same profile.
 FOREIGN KEY(profile_id,export_id) REFERENCES profile_data_exports(workspace_id,id)
);
CREATE UNIQUE INDEX platform_profile_deletions_pending ON platform_profile_deletions(profile_id) WHERE status='PENDING_ERASURE';
ALTER TABLE platform_profile_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_profile_deletions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_profile_deletions FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE(status,cancelled_by,cancelled_at,cancel_reason) ON platform_profile_deletions TO commerce_platform_owner;
CREATE POLICY platform_deletion_owner ON platform_profile_deletions TO commerce_platform_owner USING(true) WITH CHECK(true);

ALTER TABLE platform_operations DROP CONSTRAINT platform_operations_kind_check;
ALTER TABLE platform_operations ADD CONSTRAINT platform_operations_kind_check
 CHECK(kind IN('CREATE_PROFILE','SET_STATE','SET_LIMITS','INVITE_OWNER','REQUEST_DELETION','CANCEL_DELETION'));

-- A pending deletion keeps the profile out of operation.
CREATE FUNCTION guard_profile_deletion_pending() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state<>'SUSPENDED'
    AND EXISTS(SELECT 1 FROM public.platform_profile_deletions d WHERE d.profile_id=OLD.id AND d.status='PENDING_ERASURE') THEN
  RAISE EXCEPTION 'PROFILE_DELETION_PENDING';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION guard_profile_deletion_pending() OWNER TO commerce_platform_owner;
REVOKE ALL ON FUNCTION guard_profile_deletion_pending() FROM PUBLIC;
CREATE TRIGGER guard_profile_deletion_pending BEFORE UPDATE OF state ON profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_deletion_pending();

CREATE FUNCTION platform_profile_deletion_state(native_session text,native_user text,p_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=public.platform_admin_actor(native_session,native_user);p public.profiles%ROWTYPE;e jsonb;d jsonb;
BEGIN
 SELECT * INTO p FROM public.profiles WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_PROFILE_NOT_FOUND'; END IF;
 SELECT jsonb_build_object('id',x.id,'sha256',x.sha256,'rows',x.row_count,'bytes',x.byte_count,'created_at',x.created_at,
   'usable',x.created_at>clock_timestamp()-interval '7 days') INTO e
  FROM public.profile_data_exports x WHERE x.workspace_id=p_id ORDER BY x.created_at DESC LIMIT 1;
 SELECT jsonb_build_object('id',x.id,'status',x.status,'requested_at',x.requested_at,'export_id',x.export_id) INTO d
  FROM public.platform_profile_deletions x WHERE x.profile_id=p_id ORDER BY x.requested_at DESC LIMIT 1;
 RETURN jsonb_build_object('profile_id',p.id,'state',p.state,'version',p.version,'last_export',e,'deletion',d);
END $$;

CREATE FUNCTION platform_request_profile_deletion(native_session text,native_user text,op uuid,p_id text,expected_version integer,confirmation text,p_export uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=public.platform_admin_actor(native_session,native_user);digest text;prior jsonb;p public.profiles%ROWTYPE;x_sha text;x_at timestamptz;deletion uuid;result jsonb;
BEGIN
 IF p_id IS NULL OR expected_version IS NULL OR p_export IS NULL OR confirmation IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 8 AND 500 THEN RAISE EXCEPTION 'PLATFORM_DELETION_INVALID'; END IF;
 digest:=encode(public.digest(convert_to(jsonb_build_array(p_id,expected_version,confirmation,p_export,p_reason)::text,'UTF8'),'sha256'),'hex');
 prior:=public.platform_operation_replay(op,actor,'REQUEST_DELETION',digest);IF prior IS NOT NULL THEN RETURN prior; END IF;
 SELECT * INTO p FROM public.profiles WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_PROFILE_NOT_FOUND'; END IF;
 IF p.version<>expected_version THEN RAISE EXCEPTION 'PLATFORM_PROFILE_CHANGED'; END IF;
 IF p.state<>'SUSPENDED' THEN RAISE EXCEPTION 'PLATFORM_DELETION_REQUIRES_SUSPENDED'; END IF;
 IF btrim(confirmation)<>p.business_name THEN RAISE EXCEPTION 'PLATFORM_DELETION_CONFIRMATION_MISMATCH'; END IF;
 SELECT x.sha256,x.created_at INTO x_sha,x_at FROM public.profile_data_exports x WHERE x.id=p_export AND x.workspace_id=p_id;
 IF NOT FOUND OR x_at<=clock_timestamp()-interval '7 days' THEN RAISE EXCEPTION 'PLATFORM_DELETION_EXPORT_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM public.platform_profile_deletions WHERE profile_id=p_id AND status='PENDING_ERASURE') THEN RAISE EXCEPTION 'PROFILE_DELETION_PENDING'; END IF;
 deletion:=gen_random_uuid();
 INSERT INTO public.platform_profile_deletions(id,profile_id,export_id,requested_by,reason,status) VALUES(deletion,p_id,p_export,actor,btrim(p_reason),'PENDING_ERASURE');
 result:=jsonb_build_object('status','DELETION_REQUESTED','profile_id',p_id,'deletion_id',deletion,'export_sha256',x_sha,'erased',false);
 INSERT INTO public.platform_operations(id,actor_id,kind,profile_id,request_sha256,result) VALUES(op,actor,'REQUEST_DELETION',p_id,digest,result);
 RETURN result;
END $$;

CREATE FUNCTION platform_cancel_profile_deletion(native_session text,native_user text,op uuid,p_id text,p_deletion uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=public.platform_admin_actor(native_session,native_user);digest text;prior jsonb;result jsonb;
BEGIN
 IF p_id IS NULL OR p_deletion IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 8 AND 500 THEN RAISE EXCEPTION 'PLATFORM_DELETION_INVALID'; END IF;
 digest:=encode(public.digest(convert_to(jsonb_build_array(p_id,p_deletion,p_reason)::text,'UTF8'),'sha256'),'hex');
 prior:=public.platform_operation_replay(op,actor,'CANCEL_DELETION',digest);IF prior IS NOT NULL THEN RETURN prior; END IF;
 UPDATE public.platform_profile_deletions SET status='CANCELLED',cancelled_by=actor,cancelled_at=clock_timestamp(),cancel_reason=btrim(p_reason)
  WHERE id=p_deletion AND profile_id=p_id AND status='PENDING_ERASURE';
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_DELETION_NOT_PENDING'; END IF;
 result:=jsonb_build_object('status','DELETION_CANCELLED','profile_id',p_id,'deletion_id',p_deletion);
 INSERT INTO public.platform_operations(id,actor_id,kind,profile_id,request_sha256,result) VALUES(op,actor,'CANCEL_DELETION',p_id,digest,result);
 RETURN result;
END $$;

DO $owners$
DECLARE fn text;
BEGIN
 FOREACH fn IN ARRAY ARRAY['platform_profile_deletion_state(text,text,text)','platform_request_profile_deletion(text,text,uuid,text,integer,text,uuid,text)',
  'platform_cancel_profile_deletion(text,text,uuid,text,uuid,text)'] LOOP
  EXECUTE format('ALTER FUNCTION public.%s OWNER TO commerce_platform_owner',fn);
  EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC',fn);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO commerce_api',fn);
 END LOOP;
END $owners$;
