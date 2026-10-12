-- Install after030; bind inventory EXECUTE before sealing generated028.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('commerce_privacy_job_owner','commerce_privacy_attestor','commerce_privacy_job_worker')) THEN RAISE EXCEPTION 'PRIVACY_JOB_ROLE_EXISTS';END IF;
 CREATE ROLE commerce_privacy_job_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
 CREATE ROLE commerce_privacy_attestor NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
 CREATE ROLE commerce_privacy_job_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
END $$;
GRANT USAGE ON SCHEMA public TO commerce_privacy_job_owner,commerce_privacy_attestor,commerce_privacy_job_worker;
CREATE TABLE privacy_policy_adoptions(
 id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES profiles(id),revision integer NOT NULL CHECK(revision>0),
 owner_id text NOT NULL,owner_version integer NOT NULL CHECK(owner_version>0),policy text NOT NULL CHECK(policy='v7-d18-1'),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,revision),FOREIGN KEY(owner_id,workspace_id) REFERENCES memberships(user_id,workspace_id)
);
CREATE TABLE privacy_hold_events(
 id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES profiles(id),hold_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 journey_id uuid,active boolean NOT NULL,evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(workspace_id,hold_id,revision)
);
CREATE TABLE privacy_backup_attestations(
 id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES profiles(id),run_id text NOT NULL CHECK(run_id ~ '^gcp-[a-f0-9]{32}$'),
 snapshot_at timestamptz NOT NULL,restored_at timestamptz NOT NULL,valid_until timestamptz NOT NULL,
 originals_sha256 text NOT NULL CHECK(originals_sha256 ~ '^[a-f0-9]{64}$'),
 restore_sha256 text NOT NULL CHECK(restore_sha256 ~ '^[a-f0-9]{64}$'),
 topology_sha256 text NOT NULL CHECK(topology_sha256 ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(snapshot_at<=restored_at AND restored_at<=created_at AND created_at<valid_until AND valid_until=snapshot_at+interval '24 hours')
);
CREATE TABLE privacy_backup_revocations(
 id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES profiles(id),backup_id uuid NOT NULL REFERENCES privacy_backup_attestations(id),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(backup_id)
);
CREATE TABLE privacy_jobs(
 id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES profiles(id),journey_id uuid NOT NULL,
 source_version integer NOT NULL CHECK(source_version>0),backup_id uuid NOT NULL REFERENCES privacy_backup_attestations(id),
 manifest jsonb NOT NULL,manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(workspace_id,id)
);
DO $tables$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['privacy_policy_adoptions','privacy_hold_events','privacy_backup_attestations','privacy_backup_revocations','privacy_jobs'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY privacy_job_owner_scope ON public.%I TO commerce_privacy_job_owner USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),''''))',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO commerce_privacy_job_owner',t);
  EXECUTE format('CREATE TRIGGER immutable_privacy_authority BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.immutable_row()',t);
 END LOOP;
END $tables$;
GRANT SELECT(user_id,workspace_id,role,active,version),UPDATE(user_id) ON memberships TO commerce_privacy_job_owner;
CREATE POLICY privacy_job_membership_reader ON memberships FOR SELECT TO commerce_privacy_job_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
GRANT SELECT ON records TO commerce_privacy_job_owner;
CREATE POLICY privacy_job_source_reader ON records FOR SELECT TO commerce_privacy_job_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
GRANT EXECUTE ON FUNCTION privacy_writer_fence_assert(uuid),privacy_closure_proof(uuid,integer) TO commerce_privacy_job_owner;

-- Database-native hash, including actual trigger enablement, source and access.
-- It changes on deployment/ACL drift, not when rows or backup receipts change.
CREATE FUNCTION privacy_runtime_fingerprint() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT encode(public.digest(jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner::regrole::text,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,
  (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attacl::text) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  CASE WHEN c.relkind IN('v','m') THEN pg_get_viewdef(c.oid) END) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','v','m','f')),
 'policies',(SELECT jsonb_agg(jsonb_build_array(p.polrelid::regclass::text,p.polname,p.polcmd,p.polpermissive,(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE r::regrole::text END ORDER BY r::regrole::text) FROM unnest(p.polroles)r),pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polrelid::regclass::text,p.polname) FROM pg_policy p),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid::regclass::text,t.tgname) FROM pg_trigger t WHERE NOT t.tgisinternal),
 'functions',(SELECT jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),p.proowner::regrole::text,p.proacl::text,CASE WHEN p.prokind IN('f','p') THEN pg_get_functiondef(p.oid) ELSE p.prosrc END) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'),
 'roles',(SELECT jsonb_agg(jsonb_build_array(rolname,rolsuper,rolcanlogin,rolbypassrls,rolcreaterole,rolcreatedb,rolinherit,rolreplication,rolconnlimit,rolvaliduntil,rolconfig) ORDER BY rolname) FROM pg_roles),
 'role_memberships',(SELECT COALESCE(jsonb_agg(jsonb_build_array(roleid::regrole::text,member::regrole::text,grantor::regrole::text,admin_option,inherit_option,set_option) ORDER BY roleid::regrole::text,member::regrole::text,grantor::regrole::text),'[]') FROM pg_auth_members)
 )::text,'sha256'),'hex')
$$;
REVOKE ALL ON FUNCTION privacy_runtime_fingerprint() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_runtime_fingerprint() TO commerce_privacy_job_owner,commerce_privacy_attestor;

-- Missing guards are not made valid merely by recording their absence in a hash.
CREATE FUNCTION privacy_require_writer_fences() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped
  WHERE n.nspname='public' AND c.relkind IN('r','p') AND c.relname NOT IN('privacy_writer_epochs','privacy_writer_leases','creative_pairings','profile_session_context')
   AND (NOT a.attnotnull OR a.atttypid<>'text'::regtype OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='privacy_writer_guard' AND t.tgenabled='O' AND t.tgfoid='public.privacy_writer_guard()'::regprocedure AND t.tgtype=31 AND t.tgnargs=1 AND t.tgargs=convert_to('workspace_id','UTF8')||decode('00','hex'))))
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.profiles'::regclass AND tgname='privacy_writer_profile_guard' AND tgenabled='O' AND tgfoid='public.privacy_writer_guard()'::regprocedure AND tgtype=27)
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.profiles'::regclass AND tgname='privacy_writer_profile_seed' AND tgenabled='O' AND tgfoid='public.privacy_writer_profile_seed()'::regprocedure AND tgtype=5)
 THEN RAISE EXCEPTION 'PRIVACY_WRITER_FENCES_INCOMPLETE';END IF;
END $$;
REVOKE ALL ON FUNCTION privacy_require_writer_fences() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_require_writer_fences() TO commerce_privacy_job_owner;

CREATE FUNCTION privacy_authority_context() RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' THEN RAISE EXCEPTION 'PRIVACY_AUTHORITY_CONTEXT';END IF;
 RETURN w;
END $$;
REVOKE ALL ON FUNCTION privacy_authority_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_authority_context() TO commerce_privacy_job_owner;

CREATE FUNCTION import_privacy_policy(token uuid,owner_user text,evidence text,expected_revision integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w text:=public.privacy_authority_context();m record;r public.privacy_policy_adoptions%ROWTYPE;prior integer;BEGIN
 IF token IS NULL OR owner_user IS NULL OR evidence IS NULL OR evidence !~ '^[a-f0-9]{64}$' OR expected_revision IS NULL OR expected_revision<0 THEN RAISE EXCEPTION 'PRIVACY_POLICY_INPUT';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('privacy-authority:'||w,0)) THEN RAISE EXCEPTION 'PRIVACY_AUTHORITY_BUSY';END IF;
 SELECT role,active,version INTO m FROM public.memberships WHERE workspace_id=w AND user_id=owner_user FOR SHARE;
 IF NOT FOUND OR m.role<>'owner' OR NOT m.active THEN RAISE EXCEPTION 'PRIVACY_OWNER_REQUIRED';END IF;
 SELECT * INTO r FROM public.privacy_policy_adoptions WHERE id=token;
 IF FOUND THEN
  IF (r.workspace_id,r.owner_id,r.owner_version,r.evidence_sha256,r.revision) IS DISTINCT FROM (w,owner_user,m.version,evidence,expected_revision+1) THEN RAISE EXCEPTION 'PRIVACY_POLICY_CONFLICT';END IF;
  RETURN jsonb_build_object('status','NO_EFFECT','id',r.id,'revision',r.revision);
 END IF;
 SELECT COALESCE(max(revision),0) INTO prior FROM public.privacy_policy_adoptions WHERE workspace_id=w;
 IF prior<>expected_revision THEN RAISE EXCEPTION 'PRIVACY_POLICY_CHANGED';END IF;
 INSERT INTO public.privacy_policy_adoptions(id,workspace_id,revision,owner_id,owner_version,policy,evidence_sha256) VALUES(token,w,prior+1,owner_user,m.version,'v7-d18-1',evidence);
 RETURN jsonb_build_object('status','IMPORTED','id',token,'revision',prior+1);
END $$;
ALTER FUNCTION import_privacy_policy(uuid,text,text,integer) OWNER TO commerce_privacy_job_owner;
REVOKE ALL ON FUNCTION import_privacy_policy(uuid,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_privacy_policy(uuid,text,text,integer) TO commerce_privacy_attestor;

CREATE FUNCTION import_privacy_hold(token uuid,hold uuid,target uuid,is_active boolean,evidence text,expected_revision integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w text:=public.privacy_authority_context();r public.privacy_hold_events%ROWTYPE;prior public.privacy_hold_events%ROWTYPE;BEGIN
 IF token IS NULL OR hold IS NULL OR is_active IS NULL OR evidence IS NULL OR evidence !~ '^[a-f0-9]{64}$' OR expected_revision IS NULL OR expected_revision<0 THEN RAISE EXCEPTION 'PRIVACY_HOLD_INPUT';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('privacy-authority:'||w,0)) THEN RAISE EXCEPTION 'PRIVACY_AUTHORITY_BUSY';END IF;
 SELECT * INTO r FROM public.privacy_hold_events WHERE id=token;
 IF FOUND THEN
  IF (r.workspace_id,r.hold_id,r.journey_id,r.active,r.evidence_sha256,r.revision) IS DISTINCT FROM(w,hold,target,is_active,evidence,expected_revision+1) THEN RAISE EXCEPTION 'PRIVACY_HOLD_CONFLICT';END IF;
  RETURN jsonb_build_object('status','NO_EFFECT','id',r.id,'revision',r.revision);
 END IF;
 SELECT * INTO prior FROM public.privacy_hold_events WHERE workspace_id=w AND hold_id=hold ORDER BY revision DESC LIMIT 1;
 IF COALESCE(prior.revision,0)<>expected_revision OR (expected_revision>0 AND prior.journey_id IS DISTINCT FROM target) OR (expected_revision=0 AND NOT is_active) THEN RAISE EXCEPTION 'PRIVACY_HOLD_CHANGED';END IF;
 IF target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.records WHERE id=target AND workspace_id=w AND environment='REAL' AND kind='conversation') THEN RAISE EXCEPTION 'PRIVACY_HOLD_TARGET';END IF;
 INSERT INTO public.privacy_hold_events(id,workspace_id,hold_id,revision,journey_id,active,evidence_sha256) VALUES(token,w,hold,expected_revision+1,target,is_active,evidence);
 RETURN jsonb_build_object('status','IMPORTED','id',token,'revision',expected_revision+1);
END $$;
ALTER FUNCTION import_privacy_hold(uuid,uuid,uuid,boolean,text,integer) OWNER TO commerce_privacy_job_owner;
REVOKE ALL ON FUNCTION import_privacy_hold(uuid,uuid,uuid,boolean,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_privacy_hold(uuid,uuid,uuid,boolean,text,integer) TO commerce_privacy_attestor;

CREATE FUNCTION import_privacy_backup(token uuid,native_run text,snapshot timestamptz,restored timestamptz,originals text,restore_receipt text,topology text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w text:=public.privacy_authority_context();r public.privacy_backup_attestations%ROWTYPE;observed timestamptz:=clock_timestamp();BEGIN
 IF token IS NULL OR native_run IS NULL OR native_run !~ '^gcp-[a-f0-9]{32}$' OR snapshot IS NULL OR restored IS NULL OR originals IS NULL OR restore_receipt IS NULL OR topology IS NULL OR originals !~ '^[a-f0-9]{64}$' OR restore_receipt !~ '^[a-f0-9]{64}$' OR topology !~ '^[a-f0-9]{64}$' OR snapshot>restored OR restored>observed OR snapshot+interval '24 hours'<=observed THEN RAISE EXCEPTION 'PRIVACY_BACKUP_INPUT';END IF;
 IF public.privacy_runtime_fingerprint() IS DISTINCT FROM topology THEN RAISE EXCEPTION 'PRIVACY_BACKUP_TOPOLOGY_CHANGED';END IF;
 SELECT * INTO r FROM public.privacy_backup_attestations WHERE id=token;
 IF FOUND THEN
  IF (r.workspace_id,r.run_id,r.snapshot_at,r.restored_at,r.originals_sha256,r.restore_sha256,r.topology_sha256) IS DISTINCT FROM(w,native_run,snapshot,restored,originals,restore_receipt,topology) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_CONFLICT';END IF;
  RETURN jsonb_build_object('status','NO_EFFECT','id',r.id,'valid_until',r.valid_until);
 END IF;
 INSERT INTO public.privacy_backup_attestations(id,workspace_id,run_id,snapshot_at,restored_at,valid_until,originals_sha256,restore_sha256,topology_sha256) VALUES(token,w,native_run,snapshot,restored,snapshot+interval '24 hours',originals,restore_receipt,topology) RETURNING * INTO r;
 RETURN jsonb_build_object('status','IMPORTED','id',r.id,'valid_until',r.valid_until);
END $$;
ALTER FUNCTION import_privacy_backup(uuid,text,timestamptz,timestamptz,text,text,text) OWNER TO commerce_privacy_job_owner;
REVOKE ALL ON FUNCTION import_privacy_backup(uuid,text,timestamptz,timestamptz,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_privacy_backup(uuid,text,timestamptz,timestamptz,text,text,text) TO commerce_privacy_attestor;

CREATE FUNCTION revoke_privacy_backup(token uuid,target uuid,evidence text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w text:=public.privacy_authority_context();r public.privacy_backup_revocations%ROWTYPE;BEGIN
 IF token IS NULL OR target IS NULL OR evidence IS NULL OR evidence !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PRIVACY_BACKUP_REVOCATION_INPUT';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.privacy_backup_attestations WHERE id=target AND workspace_id=w) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_REQUIRED';END IF;
 INSERT INTO public.privacy_backup_revocations(id,workspace_id,backup_id,evidence_sha256) VALUES(token,w,target,evidence) ON CONFLICT DO NOTHING;
 SELECT * INTO r FROM public.privacy_backup_revocations WHERE id=token AND workspace_id=w;
 IF NOT FOUND OR(r.backup_id,r.evidence_sha256) IS DISTINCT FROM(target,evidence) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_REVOCATION_CONFLICT';END IF;
 RETURN jsonb_build_object('status','REVOKED','id',token);
END $$;
ALTER FUNCTION revoke_privacy_backup(uuid,uuid,text) OWNER TO commerce_privacy_job_owner;
REVOKE ALL ON FUNCTION revoke_privacy_backup(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_privacy_backup(uuid,uuid,text) TO commerce_privacy_attestor;

CREATE FUNCTION privacy_job_authority(target uuid,backup uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w text:=public.privacy_authority_context();p public.privacy_policy_adoptions%ROWTYPE;b public.privacy_backup_attestations%ROWTYPE;m record;holds jsonb;BEGIN
 IF target IS NULL OR backup IS NULL OR current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION 'PRIVACY_JOB_CONTEXT';END IF;
 SELECT * INTO p FROM public.privacy_policy_adoptions WHERE workspace_id=w ORDER BY revision DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_POLICY_REQUIRED';END IF;
 SELECT role,active,version INTO m FROM public.memberships WHERE workspace_id=w AND user_id=p.owner_id FOR SHARE;
 IF NOT FOUND OR m.role<>'owner' OR NOT m.active OR m.version<>p.owner_version THEN RAISE EXCEPTION 'PRIVACY_OWNER_CHANGED';END IF;
 IF EXISTS(SELECT 1 FROM(SELECT DISTINCT ON(hold_id) active,journey_id FROM public.privacy_hold_events WHERE workspace_id=w ORDER BY hold_id,revision DESC)h WHERE h.active AND(h.journey_id IS NULL OR h.journey_id=target)) THEN RAISE EXCEPTION 'PRIVACY_LEGAL_HOLD';END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_array(id,hold_id,revision,active,evidence_sha256) ORDER BY hold_id,revision),'[]') INTO holds FROM public.privacy_hold_events WHERE workspace_id=w AND(journey_id IS NULL OR journey_id=target);
 SELECT * INTO b FROM public.privacy_backup_attestations WHERE id=backup AND workspace_id=w;
 IF NOT FOUND OR b.valid_until<=clock_timestamp() OR EXISTS(SELECT 1 FROM public.privacy_backup_revocations WHERE backup_id=backup AND workspace_id=w) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_UNAVAILABLE';END IF;
 IF b.topology_sha256 IS DISTINCT FROM public.privacy_runtime_fingerprint() THEN RAISE EXCEPTION 'PRIVACY_BACKUP_TOPOLOGY_CHANGED';END IF;
 RETURN jsonb_build_object('policy_id',p.id,'policy_revision',p.revision,'policy','v7-d18-1','owner_version',p.owner_version,'holds_sha256',encode(public.digest(holds::text,'sha256'),'hex'),'backup_id',b.id,'backup_sha256',encode(public.digest(to_jsonb(b)::text,'sha256'),'hex'),'backup_snapshot_at',b.snapshot_at,'valid_until',b.valid_until,'topology_sha256',b.topology_sha256);
END $$;
ALTER FUNCTION privacy_job_authority(uuid,uuid) OWNER TO commerce_privacy_job_owner;
REVOKE ALL ON FUNCTION privacy_job_authority(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION prepare_privacy_job(token uuid,target uuid,expected_version integer,backup uuid,lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w text:=public.privacy_authority_context();epoch bigint;a jsonb;c jsonb;i jsonb;manifest_value jsonb;r public.privacy_jobs%ROWTYPE;BEGIN
 IF token IS NULL OR target IS NULL OR expected_version IS NULL OR expected_version<1 THEN RAISE EXCEPTION 'PRIVACY_JOB_INPUT';END IF;
 PERFORM public.privacy_require_writer_fences();
 epoch:=public.privacy_writer_fence_assert(lease);
 a:=public.privacy_job_authority(target,backup);
 c:=public.privacy_closure_proof(target,expected_version);
 IF c->>'verified' IS DISTINCT FROM 'true' OR (c->>'due_at')::timestamptz>clock_timestamp() THEN RAISE EXCEPTION 'PRIVACY_JOB_NOT_DUE';END IF;
 IF(c->>'source_last_changed_at')::timestamptz>(a->>'backup_snapshot_at')::timestamptz THEN RAISE EXCEPTION 'PRIVACY_BACKUP_BEFORE_SOURCE';END IF;
 i:=public.privacy_reference_inventory(target,expected_version);
 IF i->>'unclassified_references' IS DISTINCT FROM '0' OR i->>'source_sha256' IS DISTINCT FROM c->>'source_sha256' THEN RAISE EXCEPTION 'PRIVACY_INVENTORY_BLOCKED';END IF;
 manifest_value:=jsonb_build_object('schema_version',1,'status','INVENTORIED','erasure_authorized',false,'workspace_id',w,'environment','REAL','journey_id',target,'source_version',expected_version,'source_sha256',c->>'source_sha256','closed_at',c->>'closed_at','due_at',c->>'due_at','execution_kind',c->>'execution_kind','authority',a,'catalog_sha256',i->>'catalog_sha256','inventory_sha256',i->>'inventory_sha256','writer_epoch',epoch::text);
 PERFORM public.privacy_writer_fence_assert(lease);
 IF(a->>'valid_until')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'PRIVACY_BACKUP_UNAVAILABLE';END IF;
 SELECT * INTO r FROM public.privacy_jobs WHERE id=token;
 IF FOUND THEN
  -- The original epoch is evidence of preparation. Retries never replace it.
  IF r.workspace_id<>w OR r.manifest-'writer_epoch' IS DISTINCT FROM manifest_value-'writer_epoch' THEN RAISE EXCEPTION 'PRIVACY_JOB_CHANGED';END IF;
  RETURN jsonb_build_object('status','NO_EFFECT','job_id',r.id,'manifest_sha256',r.manifest_sha256,'erasure_authorized',false);
 END IF;
 INSERT INTO public.privacy_jobs(id,workspace_id,journey_id,source_version,backup_id,manifest,manifest_sha256) VALUES(token,w,target,expected_version,backup,manifest_value,encode(public.digest(manifest_value::text,'sha256'),'hex')) RETURNING * INTO r;
 RETURN jsonb_build_object('status','INVENTORIED','job_id',r.id,'manifest_sha256',r.manifest_sha256,'erasure_authorized',false);
END $$;
ALTER FUNCTION prepare_privacy_job(uuid,uuid,integer,uuid,uuid) OWNER TO commerce_privacy_job_owner;
REVOKE ALL ON FUNCTION prepare_privacy_job(uuid,uuid,integer,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prepare_privacy_job(uuid,uuid,integer,uuid,uuid) TO commerce_privacy_job_worker;
