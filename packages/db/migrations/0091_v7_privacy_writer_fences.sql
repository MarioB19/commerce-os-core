-- V7 F2 cutover: Privacy writer fences and selection authority (030).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/030_privacy_writer_fences.sql (source sha256 a6cd3312063600a945d7447bcb1beab0970e972f1473a761cfd96686e896a12b)
-- V7 F2: 1 role-existence refusal(s) and 2 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- Closed fencing port. Install generated scoped triggers before any D18 job.
DO $$ BEGIN

 PERFORM public.v7_ensure_reviewed_role('commerce_privacy_fence_owner',false);
 PERFORM public.v7_ensure_reviewed_role('commerce_privacy_fence_worker',false);
END $$;
GRANT USAGE ON SCHEMA public TO commerce_privacy_fence_owner,commerce_privacy_fence_worker;
CREATE TABLE privacy_writer_epochs(
 workspace_id text PRIMARY KEY REFERENCES profiles(id),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0)
);
INSERT INTO privacy_writer_epochs(workspace_id) SELECT id FROM profiles;
CREATE TABLE privacy_writer_leases(
 id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES privacy_writer_epochs(workspace_id),
 backend_pid integer NOT NULL,
 acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),valid_until timestamptz NOT NULL,
 epoch bigint NOT NULL CHECK(epoch>0),released_at timestamptz,
 CHECK(valid_until>acquired_at AND valid_until<=acquired_at+interval '30 seconds'),
 CHECK(released_at IS NULL OR released_at>=acquired_at)
);
CREATE UNIQUE INDEX privacy_writer_backend_live ON privacy_writer_leases(id,backend_pid);
ALTER TABLE privacy_writer_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_writer_epochs FORCE ROW LEVEL SECURITY;
ALTER TABLE privacy_writer_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_writer_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_epoch_owner_scope ON privacy_writer_epochs TO commerce_privacy_fence_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY privacy_lease_owner_scope ON privacy_writer_leases TO commerce_privacy_fence_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
REVOKE ALL ON privacy_writer_epochs,privacy_writer_leases FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON privacy_writer_epochs,privacy_writer_leases TO commerce_privacy_fence_owner;
CREATE FUNCTION privacy_writer_key(w text) RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT hashtextextended('commerce-privacy-writer-v1:'||w,0) $$;
REVOKE ALL ON FUNCTION privacy_writer_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_writer_key(text) TO commerce_privacy_fence_owner;
CREATE FUNCTION privacy_writer_lock_held(w text) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock' AND objsubid=1 AND classid=((public.privacy_writer_key(w)>>32)&4294967295)::oid AND objid=(public.privacy_writer_key(w)&4294967295)::oid)
$$;
REVOKE ALL ON FUNCTION privacy_writer_lock_held(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_writer_lock_held(text) TO commerce_privacy_fence_owner;
CREATE FUNCTION privacy_writer_fence_acquire(w text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r bigint;token uuid:=gen_random_uuid();observed timestamptz;deadline timestamptz;
BEGIN
 IF w IS NULL OR length(w) NOT BETWEEN 1 AND 256 OR w IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'PRIVACY_FENCE_CONTEXT';END IF;
 IF to_regclass('pg_temp.privacy_writer_session') IS NOT NULL THEN RAISE EXCEPTION 'PRIVACY_FENCE_SESSION_ALREADY_USED';END IF;
 IF public.privacy_writer_lock_held(w) THEN RAISE EXCEPTION 'PRIVACY_FENCE_ALREADY_HELD';END IF;
 IF NOT pg_try_advisory_lock(public.privacy_writer_key(w)) THEN RAISE EXCEPTION 'PRIVACY_WRITERS_BUSY';END IF;
 BEGIN
  SELECT revision INTO STRICT r FROM public.privacy_writer_epochs WHERE workspace_id=w FOR SHARE;
  CREATE TEMP TABLE privacy_writer_session(lease_id uuid PRIMARY KEY) ON COMMIT PRESERVE ROWS;
  REVOKE ALL ON pg_temp.privacy_writer_session FROM PUBLIC;
  INSERT INTO pg_temp.privacy_writer_session VALUES(token);
  observed:=clock_timestamp();deadline:=observed+interval '30 seconds';
  INSERT INTO public.privacy_writer_leases(id,workspace_id,backend_pid,acquired_at,valid_until,epoch) VALUES(token,w,pg_backend_pid(),observed,deadline,r);
 EXCEPTION WHEN OTHERS THEN PERFORM pg_advisory_unlock(public.privacy_writer_key(w));RAISE;END;
 RETURN jsonb_build_object('lease_id',token,'workspace_id',w,'epoch',r::text,'valid_until',deadline);
END $$;
ALTER FUNCTION privacy_writer_fence_acquire(text) OWNER TO commerce_privacy_fence_owner;
REVOKE ALL ON FUNCTION privacy_writer_fence_acquire(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_writer_fence_acquire(text) TO commerce_privacy_fence_worker;
CREATE FUNCTION privacy_writer_fence_assert(token uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');lease public.privacy_writer_leases%ROWTYPE;r bigint;
BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION 'PRIVACY_FENCE_CONTEXT';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE relname='privacy_writer_session' AND relnamespace=pg_my_temp_schema() AND relpersistence='t' AND relkind='r' AND relowner='commerce_privacy_fence_owner'::regrole) THEN RAISE EXCEPTION 'PRIVACY_FENCE_SESSION_INVALID';END IF;
 IF (SELECT lease_id FROM pg_temp.privacy_writer_session) IS DISTINCT FROM token THEN RAISE EXCEPTION 'PRIVACY_FENCE_SESSION_INVALID';END IF;
 SELECT * INTO lease FROM public.privacy_writer_leases WHERE id=token AND workspace_id=w;
 IF NOT FOUND OR lease.backend_pid<>pg_backend_pid() OR lease.released_at IS NOT NULL OR lease.valid_until<=clock_timestamp() OR NOT public.privacy_writer_lock_held(w) THEN RAISE EXCEPTION 'PRIVACY_FENCE_INVALID';END IF;
 SELECT revision INTO STRICT r FROM public.privacy_writer_epochs WHERE workspace_id=w FOR SHARE;
 IF r IS DISTINCT FROM lease.epoch THEN RAISE EXCEPTION 'PRIVACY_FENCE_EPOCH_CHANGED';END IF;
 RETURN r;
END $$;
ALTER FUNCTION privacy_writer_fence_assert(uuid) OWNER TO commerce_privacy_fence_owner;
REVOKE ALL ON FUNCTION privacy_writer_fence_assert(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_writer_fence_assert(uuid) TO commerce_privacy_fence_worker;
CREATE FUNCTION privacy_writer_fence_advance(token uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r bigint;w text:=NULLIF(current_setting('app.workspace_id',true),'');
BEGIN
 r:=public.privacy_writer_fence_assert(token);
 UPDATE public.privacy_writer_epochs SET revision=revision+1 WHERE workspace_id=w AND revision=r RETURNING revision INTO r;
 IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_FENCE_EPOCH_CHANGED';END IF;
 UPDATE public.privacy_writer_leases SET released_at=clock_timestamp() WHERE id=token AND workspace_id=w;
 RETURN r;
END $$;
ALTER FUNCTION privacy_writer_fence_advance(uuid) OWNER TO commerce_privacy_fence_owner;
REVOKE ALL ON FUNCTION privacy_writer_fence_advance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_writer_fence_advance(uuid) TO commerce_privacy_fence_worker;
CREATE FUNCTION privacy_writer_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE oldrow jsonb;newrow jsonb;w text;prior text;revision bigint;
BEGIN
 IF TG_OP<>'INSERT' THEN oldrow:=to_jsonb(OLD);END IF;
 IF TG_OP<>'DELETE' THEN newrow:=to_jsonb(NEW);END IF;
 w:=COALESCE(newrow,oldrow)->>TG_ARGV[0];prior:=oldrow->>TG_ARGV[0];
 IF TG_OP='UPDATE' AND w IS DISTINCT FROM prior THEN RAISE EXCEPTION 'PRIVACY_WRITER_SCOPE_CHANGED';END IF;
 -- A nullable environment affects REAL and SIMULATION; it must also be fenced.
 IF COALESCE(newrow,oldrow)->>'environment'='SIMULATION' AND (TG_OP<>'UPDATE' OR oldrow->>'environment'='SIMULATION') THEN RETURN COALESCE(NEW,OLD);END IF;
 IF w IS NULL OR w IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') THEN RAISE EXCEPTION 'PRIVACY_WRITER_SCOPE_REQUIRED';END IF;
 IF NOT pg_try_advisory_xact_lock_shared(public.privacy_writer_key(w)) THEN RAISE EXCEPTION 'PRIVACY_WRITERS_BUSY';END IF;
 -- FOR SHARE is essential: an old RR snapshot must fail after an erasure epoch.
 SELECT e.revision INTO revision FROM public.privacy_writer_epochs e WHERE e.workspace_id=w FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_WRITER_EPOCH_MISSING';END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
ALTER FUNCTION privacy_writer_guard() OWNER TO commerce_privacy_fence_owner;
REVOKE ALL ON FUNCTION privacy_writer_guard() FROM PUBLIC;
CREATE FUNCTION privacy_writer_profile_seed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous text:=current_setting('app.workspace_id',true);
BEGIN
 PERFORM set_config('app.workspace_id',NEW.id,true);
 INSERT INTO public.privacy_writer_epochs(workspace_id) VALUES(NEW.id);
 PERFORM set_config('app.workspace_id',COALESCE(previous,''),true);
 RETURN NEW;
END $$;
ALTER FUNCTION privacy_writer_profile_seed() OWNER TO commerce_privacy_fence_owner;
REVOKE ALL ON FUNCTION privacy_writer_profile_seed() FROM PUBLIC;
CREATE TRIGGER privacy_writer_profile_seed AFTER INSERT ON profiles FOR EACH ROW EXECUTE FUNCTION privacy_writer_profile_seed();
CREATE TRIGGER privacy_writer_profile_guard BEFORE UPDATE OR DELETE ON profiles FOR EACH ROW EXECUTE FUNCTION privacy_writer_guard('id');
-- <<< end 030_privacy_writer_fences.sql

-- >>> promoted from packages/db/profile-transition/components/030_profile_selection_authority.sql (source sha256 8d69a601c9b604c8b534271d86f159146e01b56367f850b8127779102bfc12dc)
-- Identity-only CAS selection is not conversation content. Apply after020/030,
-- before generating the content-writer fences and the028 inventory seal.
DO $$
DECLARE f record; t oid:='public.profile_session_context'::regclass; owner_id oid;
BEGIN
 LOCK TABLE public.profile_session_context IN ACCESS EXCLUSIVE MODE;
 SELECT relowner INTO owner_id FROM pg_class WHERE oid=t;
 IF (SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull) ORDER BY attnum) FROM pg_attribute WHERE attrelid=t AND attnum>0 AND NOT attisdropped) IS DISTINCT FROM
 '[ ["session_id","text",true],["user_id","text",true],["workspace_id","text",true],["membership_version","integer",true],["version","integer",true],["updated_at","timestamp with time zone",true] ]'::jsonb THEN RAISE EXCEPTION 'PRIVACY_SELECTION_STRUCTURE_DRIFT';END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=t AND attnum>0 AND attacl IS NOT NULL) THEN RAISE EXCEPTION 'PRIVACY_SELECTION_ACL_DRIFT';END IF;
 IF (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable) ORDER BY pg_get_userbyid(a.grantee),a.privilege_type) FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=t AND a.grantee<>owner_id) IS DISTINCT FROM
 '[["commerce_api","INSERT",false],["commerce_api","SELECT",false],["commerce_api","UPDATE",false],["commerce_profile_bootstrap_owner","INSERT",false],["commerce_profile_bootstrap_owner","SELECT",false],["commerce_profile_bootstrap_owner","UPDATE",false]]'::jsonb THEN RAISE EXCEPTION 'PRIVACY_SELECTION_ACL_DRIFT';END IF;
 FOR f IN SELECT * FROM (VALUES
 ('public.list_authenticated_profile_choices(text,text)'::regprocedure,'2efd8c65cd56baddb91fe154b5c658a1ffb0f869be20fee982242bc503f5be45'),
 ('public.select_authenticated_profile(text,text,text,integer)'::regprocedure,'88635ea12dcd79c7cb19dc37a4e3d89086a8c66f848809fafe8b484b872ac241')) x(id,expected_hash) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f.id AND p.prosecdef AND p.proowner='commerce_profile_bootstrap_owner'::regrole AND p.proconfig=ARRAY['search_path=pg_catalog'] AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')=f.expected_hash) THEN RAISE EXCEPTION 'PRIVACY_SELECTION_BOOTSTRAP_DRIFT';END IF;
  IF (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable) ORDER BY pg_get_userbyid(a.grantee)) FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f.id) IS DISTINCT FROM
   '[["commerce_api","EXECUTE",false],["commerce_profile_bootstrap_owner","EXECUTE",false]]'::jsonb THEN RAISE EXCEPTION 'PRIVACY_SELECTION_BOOTSTRAP_ACL_DRIFT';END IF;
 END LOOP;
 REVOKE INSERT,UPDATE ON public.profile_session_context FROM commerce_api;
END $$;
-- <<< end components/030_profile_selection_authority.sql
