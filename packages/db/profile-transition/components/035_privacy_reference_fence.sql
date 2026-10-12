-- Additive global reference fence. 030 remains byte-identical.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('commerce_privacy_reference_owner','commerce_privacy_reference_worker')) THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_ROLE_EXISTS';END IF;
 CREATE ROLE commerce_privacy_reference_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
 CREATE ROLE commerce_privacy_reference_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
END $$;
GRANT USAGE ON SCHEMA public TO commerce_privacy_reference_owner,commerce_privacy_reference_worker;
CREATE TABLE privacy_reference_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO privacy_reference_epoch DEFAULT VALUES;
CREATE TABLE privacy_reference_leases(
 id uuid PRIMARY KEY,backend_pid integer NOT NULL,epoch bigint NOT NULL CHECK(epoch>0),
 acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),valid_until timestamptz NOT NULL,released_at timestamptz,
 CHECK(valid_until>acquired_at AND valid_until<=acquired_at+interval '30 seconds'),CHECK(released_at IS NULL OR released_at>=acquired_at)
);
ALTER TABLE privacy_reference_epoch ENABLE ROW LEVEL SECURITY;ALTER TABLE privacy_reference_epoch FORCE ROW LEVEL SECURITY;
ALTER TABLE privacy_reference_leases ENABLE ROW LEVEL SECURITY;ALTER TABLE privacy_reference_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_reference_epoch_owner ON privacy_reference_epoch TO commerce_privacy_reference_owner USING(singleton) WITH CHECK(singleton);
CREATE POLICY privacy_reference_lease_owner ON privacy_reference_leases TO commerce_privacy_reference_owner USING(true) WITH CHECK(true);
REVOKE ALL ON privacy_reference_epoch,privacy_reference_leases FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON privacy_reference_epoch,privacy_reference_leases TO commerce_privacy_reference_owner;
CREATE FUNCTION privacy_reference_lock_key() RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT hashtextextended('commerce-privacy-global-references-v1',0) $$;
CREATE FUNCTION privacy_reference_lock_held() RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock' AND objsubid=1 AND classid=((public.privacy_reference_lock_key()>>32)&4294967295)::oid AND objid=(public.privacy_reference_lock_key()&4294967295)::oid) $$;
REVOKE ALL ON FUNCTION privacy_reference_lock_key(),privacy_reference_lock_held() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_reference_lock_key(),privacy_reference_lock_held() TO commerce_privacy_reference_owner;
CREATE FUNCTION privacy_reference_fence_acquire() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE token uuid:=gen_random_uuid();r bigint;observed timestamptz;deadline timestamptz;BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' OR to_regclass('pg_temp.privacy_reference_session') IS NOT NULL OR public.privacy_reference_lock_held() THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_ACQUIRE_CONTEXT';END IF;
 IF NOT pg_try_advisory_lock(public.privacy_reference_lock_key()) THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_WRITERS_BUSY';END IF;
 BEGIN
  SELECT revision INTO STRICT r FROM public.privacy_reference_epoch WHERE singleton FOR SHARE;
  CREATE TEMP TABLE privacy_reference_session(lease_id uuid PRIMARY KEY) ON COMMIT PRESERVE ROWS;REVOKE ALL ON pg_temp.privacy_reference_session FROM PUBLIC;
  INSERT INTO pg_temp.privacy_reference_session VALUES(token);observed:=clock_timestamp();deadline:=observed+interval '30 seconds';
  INSERT INTO public.privacy_reference_leases(id,backend_pid,epoch,acquired_at,valid_until) VALUES(token,pg_backend_pid(),r,observed,deadline);
 EXCEPTION WHEN OTHERS THEN PERFORM pg_advisory_unlock(public.privacy_reference_lock_key());RAISE;END;
 RETURN jsonb_build_object('lease_id',token,'epoch',r::text,'valid_until',deadline);
END $$;
ALTER FUNCTION privacy_reference_fence_acquire() OWNER TO commerce_privacy_reference_owner;
REVOKE ALL ON FUNCTION privacy_reference_fence_acquire() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_reference_fence_acquire() TO commerce_privacy_reference_worker;
CREATE FUNCTION privacy_reference_fence_assert(token uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public.privacy_reference_leases%ROWTYPE;r bigint;BEGIN
 IF token IS NULL OR current_setting('transaction_isolation') IS DISTINCT FROM 'repeatable read' THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_CONTEXT';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE relname='privacy_reference_session' AND relnamespace=pg_my_temp_schema() AND relpersistence='t' AND relkind='r' AND relowner='commerce_privacy_reference_owner'::regrole) THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_SESSION_INVALID';END IF;
 IF(SELECT lease_id FROM pg_temp.privacy_reference_session) IS DISTINCT FROM token THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_SESSION_INVALID';END IF;
 SELECT * INTO a FROM public.privacy_reference_leases WHERE id=token;
 IF NOT FOUND OR a.backend_pid<>pg_backend_pid() OR a.released_at IS NOT NULL OR a.valid_until<=clock_timestamp() OR NOT public.privacy_reference_lock_held() THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_INVALID';END IF;
 SELECT revision INTO STRICT r FROM public.privacy_reference_epoch WHERE singleton FOR SHARE;
 IF r IS DISTINCT FROM a.epoch THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_EPOCH_CHANGED';END IF;RETURN r;
END $$;
ALTER FUNCTION privacy_reference_fence_assert(uuid) OWNER TO commerce_privacy_reference_owner;
REVOKE ALL ON FUNCTION privacy_reference_fence_assert(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_reference_fence_assert(uuid) TO commerce_privacy_reference_worker;
CREATE FUNCTION privacy_reference_fence_advance(token uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r bigint;BEGIN
 r:=public.privacy_reference_fence_assert(token);
 UPDATE public.privacy_reference_epoch SET revision=revision+1 WHERE singleton AND revision=r RETURNING revision INTO r;
 IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_EPOCH_CHANGED';END IF;
 UPDATE public.privacy_reference_leases SET released_at=clock_timestamp() WHERE id=token;RETURN r;
END $$;
ALTER FUNCTION privacy_reference_fence_advance(uuid) OWNER TO commerce_privacy_reference_owner;
REVOKE ALL ON FUNCTION privacy_reference_fence_advance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_reference_fence_advance(uuid) TO commerce_privacy_reference_worker;
CREATE FUNCTION privacy_reference_writer_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r bigint;BEGIN
 -- REAL and SIMULATION may reference the same filesystem. No environment bypass.
 IF NOT pg_try_advisory_xact_lock_shared(public.privacy_reference_lock_key()) THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_WRITERS_BUSY';END IF;
 SELECT revision INTO STRICT r FROM public.privacy_reference_epoch WHERE singleton FOR SHARE;
 -- FOR SHARE raises serialization failure for an RR snapshot older than advance.
 RETURN COALESCE(NEW,OLD);
END $$;
ALTER FUNCTION privacy_reference_writer_guard() OWNER TO commerce_privacy_reference_owner;
REVOKE ALL ON FUNCTION privacy_reference_writer_guard() FROM PUBLIC;
