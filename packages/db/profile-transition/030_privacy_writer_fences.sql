-- Closed fencing port. Install generated scoped triggers before any D18 job.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('commerce_privacy_fence_owner','commerce_privacy_fence_worker')) THEN RAISE EXCEPTION 'PRIVACY_FENCE_ROLE_EXISTS';END IF;
 CREATE ROLE commerce_privacy_fence_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
 CREATE ROLE commerce_privacy_fence_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
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
