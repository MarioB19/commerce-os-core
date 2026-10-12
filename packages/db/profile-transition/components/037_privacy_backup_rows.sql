-- Install before generated037 readers and final028/030 seals. No erasure RPC.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_privacy_row_owner') THEN RAISE EXCEPTION 'PRIVACY_ROW_ROLE_EXISTS';END IF;
 CREATE ROLE commerce_privacy_row_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT;
END $$;
GRANT USAGE ON SCHEMA public TO commerce_privacy_row_owner;
CREATE TABLE privacy_backup_row_sets(
 backup_id uuid PRIMARY KEY REFERENCES privacy_backup_attestations(id),workspace_id text NOT NULL REFERENCES profiles(id),
 environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),restore_sha256 text NOT NULL CHECK(restore_sha256~'^[a-f0-9]{64}$'),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256~'^[a-f0-9]{64}$'),catalog_sha256 text NOT NULL CHECK(catalog_sha256~'^[a-f0-9]{64}$'),
 row_count bigint NOT NULL CHECK(row_count>=0),page_count integer NOT NULL CHECK(page_count>0),root_sha256 text NOT NULL CHECK(root_sha256~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(backup_id,workspace_id,environment)
);
CREATE TABLE privacy_backup_row_pages(
 backup_id uuid NOT NULL,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),page_index integer NOT NULL CHECK(page_index>=0),
 row_count integer NOT NULL CHECK(row_count BETWEEN 0 AND 2000),page_sha256 text NOT NULL CHECK(page_sha256~'^[a-f0-9]{64}$'),
 PRIMARY KEY(backup_id,page_index),FOREIGN KEY(backup_id,workspace_id,environment) REFERENCES privacy_backup_row_sets(backup_id,workspace_id,environment)
);
CREATE TABLE privacy_backup_row_entries(
 backup_id uuid NOT NULL,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),page_index integer NOT NULL,
 relation_name text NOT NULL,key_sha256 text NOT NULL CHECK(key_sha256~'^[a-f0-9]{64}$'),source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
 PRIMARY KEY(backup_id,relation_name,key_sha256),FOREIGN KEY(backup_id,workspace_id,environment) REFERENCES privacy_backup_row_sets(backup_id,workspace_id,environment),
 FOREIGN KEY(backup_id,page_index) REFERENCES privacy_backup_row_pages(backup_id,page_index) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE privacy_backup_row_seals(
 backup_id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 row_count bigint NOT NULL,page_count integer NOT NULL,root_sha256 text NOT NULL CHECK(root_sha256~'^[a-f0-9]{64}$'),sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(backup_id,workspace_id,environment) REFERENCES privacy_backup_row_sets(backup_id,workspace_id,environment)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['privacy_backup_row_sets','privacy_backup_row_pages','privacy_backup_row_entries','privacy_backup_row_seals'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($policy$CREATE POLICY privacy_backup_rows_scope ON public.%I TO commerce_privacy_row_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL')$policy$,t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);EXECUTE format('GRANT SELECT,INSERT ON public.%I TO commerce_privacy_row_owner',t);
  EXECUTE format('CREATE TRIGGER immutable_privacy_backup_rows BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION immutable_row()',t);
 END LOOP;
END $$;
GRANT SELECT ON privacy_backup_attestations,privacy_backup_revocations,privacy_jobs TO commerce_privacy_row_owner;
CREATE POLICY privacy_row_backup_reader ON privacy_backup_attestations FOR SELECT TO commerce_privacy_row_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY privacy_row_revocation_reader ON privacy_backup_revocations FOR SELECT TO commerce_privacy_row_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY privacy_row_job_reader ON privacy_jobs FOR SELECT TO commerce_privacy_row_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
GRANT EXECUTE ON FUNCTION privacy_runtime_fingerprint(),privacy_require_writer_fences(),privacy_writer_fence_assert(uuid),privacy_job_authority(uuid,uuid) TO commerce_privacy_row_owner;

CREATE FUNCTION privacy_backup_row_page_hash(entries jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(public.digest(COALESCE(string_agg((e->>'relation')||':'||(e->>'key_sha256')||':'||(e->>'source_sha256')||chr(10),'' ORDER BY n),''),'sha256'),'hex') FROM jsonb_array_elements(entries) WITH ORDINALITY x(e,n)
$$;
REVOKE ALL ON FUNCTION privacy_backup_row_page_hash(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_backup_row_page_hash(jsonb) TO commerce_privacy_row_owner;

CREATE FUNCTION privacy_backup_rows_import_authority(backup uuid,restore_receipt text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b public.privacy_backup_attestations%ROWTYPE;w text:=NULLIF(current_setting('app.workspace_id',true),'');BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_CONTEXT';END IF;
 PERFORM public.privacy_require_writer_fences();PERFORM public.privacy_backup_row_catalog();
 SELECT * INTO b FROM public.privacy_backup_attestations WHERE id=backup AND workspace_id=w;
 IF NOT FOUND OR b.valid_until<=clock_timestamp() OR b.restore_sha256 IS DISTINCT FROM restore_receipt OR EXISTS(SELECT 1 FROM public.privacy_backup_revocations WHERE backup_id=backup AND workspace_id=w) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_AUTHORITY';END IF;
 IF b.topology_sha256 IS DISTINCT FROM public.privacy_runtime_fingerprint() THEN RAISE EXCEPTION 'PRIVACY_BACKUP_TOPOLOGY_CHANGED';END IF;
END $$;
ALTER FUNCTION privacy_backup_rows_import_authority(uuid,text) OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION privacy_backup_rows_import_authority(uuid,text) FROM PUBLIC;

CREATE FUNCTION import_privacy_backup_rows(backup uuid,restore_receipt text,evidence text,page jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');prior public.privacy_backup_row_sets%ROWTYPE;old_page public.privacy_backup_row_pages%ROWTYPE;
 e jsonb;entries jsonb;catalog jsonb;entry_hash text;index_value integer;count_value bigint;pages_value integer;previous_key text[];current_key text[];
BEGIN
 IF backup IS NULL OR restore_receipt IS NULL OR restore_receipt!~'^[a-f0-9]{64}$' OR evidence IS NULL OR evidence!~'^[a-f0-9]{64}$' OR page IS NULL OR jsonb_typeof(page)<>'object' OR octet_length(page::text)>1048576
 OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(page)k) IS DISTINCT FROM ARRAY['catalog_sha256','entries','page_count','page_index','root_sha256','row_count','schema_version']
 OR page->>'schema_version' IS DISTINCT FROM '1' OR jsonb_typeof(page->'row_count') IS DISTINCT FROM 'string' OR (page->>'row_count'~'^(0|[1-9][0-9]{0,12})$') IS NOT TRUE
 OR jsonb_typeof(page->'page_count') IS DISTINCT FROM 'number' OR (page->>'page_count'~'^[1-9][0-9]{0,8}$') IS NOT TRUE
 OR jsonb_typeof(page->'page_index') IS DISTINCT FROM 'number' OR (page->>'page_index'~'^(0|[1-9][0-9]{0,8})$') IS NOT TRUE
 OR (page->>'root_sha256'~'^[a-f0-9]{64}$') IS NOT TRUE OR jsonb_typeof(page->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(page->'entries')>2000 THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_INPUT';END IF;
 PERFORM public.privacy_backup_rows_import_authority(backup,restore_receipt);catalog:=public.privacy_backup_row_catalog();
 IF page->>'catalog_sha256' IS DISTINCT FROM catalog->>'catalog_sha256' THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROW_CATALOG_CHANGED';END IF;
 entries:=page->'entries';index_value:=(page->>'page_index')::integer;count_value:=(page->>'row_count')::bigint;pages_value:=(page->>'page_count')::integer;
 IF index_value>=pages_value OR (count_value=0 AND (pages_value<>1 OR jsonb_array_length(entries)<>0)) OR (count_value>0 AND jsonb_array_length(entries)=0) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_INPUT';END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(entries) LOOP
  IF jsonb_typeof(e)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e)k) IS DISTINCT FROM ARRAY['key_sha256','relation','source_sha256']
  OR jsonb_typeof(e->'relation') IS DISTINCT FROM 'string' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(catalog->'relations') r WHERE r->>'name'=e->>'relation')
  OR jsonb_typeof(e->'key_sha256') IS DISTINCT FROM 'string' OR (e->>'key_sha256'~'^[a-f0-9]{64}$') IS NOT TRUE
  OR jsonb_typeof(e->'source_sha256') IS DISTINCT FROM 'string' OR (e->>'source_sha256'~'^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROW_DESCRIPTOR';END IF;
  current_key:=ARRAY[e->>'relation',e->>'key_sha256'];IF previous_key IS NOT NULL AND previous_key COLLATE "C">=current_key COLLATE "C" THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_ORDER';END IF;previous_key:=current_key;
 END LOOP;
 entry_hash:=public.privacy_backup_row_page_hash(entries);
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy-backup-rows:'||backup::text,0));
 SELECT * INTO prior FROM public.privacy_backup_row_sets WHERE backup_id=backup AND workspace_id=w;
 IF FOUND THEN
  IF(prior.restore_sha256,prior.evidence_sha256,prior.catalog_sha256,prior.row_count,prior.page_count,prior.root_sha256) IS DISTINCT FROM(restore_receipt,evidence,page->>'catalog_sha256',count_value,pages_value,page->>'root_sha256') THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_CONFLICT';END IF;
 ELSE
  INSERT INTO public.privacy_backup_row_sets(backup_id,workspace_id,restore_sha256,evidence_sha256,catalog_sha256,row_count,page_count,root_sha256) VALUES(backup,w,restore_receipt,evidence,page->>'catalog_sha256',count_value,pages_value,page->>'root_sha256');
 END IF;
 SELECT * INTO old_page FROM public.privacy_backup_row_pages WHERE backup_id=backup AND page_index=index_value;
 IF FOUND THEN
  IF(old_page.row_count,old_page.page_sha256) IS DISTINCT FROM(jsonb_array_length(entries),entry_hash) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_CONFLICT';END IF;
  PERFORM public.privacy_backup_rows_import_authority(backup,restore_receipt);
  RETURN jsonb_build_object('status','NO_EFFECT','backup_id',backup,'page_index',index_value,'page_sha256',entry_hash);
 END IF;
 IF EXISTS(SELECT 1 FROM public.privacy_backup_row_seals WHERE backup_id=backup) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_SEALED';END IF;
 INSERT INTO public.privacy_backup_row_pages(backup_id,workspace_id,page_index,row_count,page_sha256) VALUES(backup,w,index_value,jsonb_array_length(entries),entry_hash);
 INSERT INTO public.privacy_backup_row_entries(backup_id,workspace_id,page_index,relation_name,key_sha256,source_sha256) SELECT backup,w,index_value,x.value->>'relation',x.value->>'key_sha256',x.value->>'source_sha256' FROM jsonb_array_elements(entries)x;
 PERFORM public.privacy_backup_rows_import_authority(backup,restore_receipt);
 RETURN jsonb_build_object('status','IMPORTED','backup_id',backup,'page_index',index_value,'page_sha256',entry_hash);
END $$;
ALTER FUNCTION import_privacy_backup_rows(uuid,text,text,jsonb) OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION import_privacy_backup_rows(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_privacy_backup_rows(uuid,text,text,jsonb) TO commerce_privacy_attestor;

CREATE FUNCTION seal_privacy_backup_rows(backup uuid,restore_receipt text,evidence text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s public.privacy_backup_row_sets%ROWTYPE;p record;idx integer:=0;total bigint:=0;root text:=encode(public.digest('PRIVACY_BACKUP_ROWS_V1','sha256'),'hex');existed boolean;
BEGIN
 PERFORM public.privacy_backup_rows_import_authority(backup,restore_receipt);PERFORM pg_advisory_xact_lock(hashtextextended('privacy-backup-rows:'||backup::text,0));
 SELECT * INTO STRICT s FROM public.privacy_backup_row_sets WHERE backup_id=backup AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'');
 IF s.evidence_sha256 IS DISTINCT FROM evidence THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_CONFLICT';END IF;
 FOR p IN SELECT * FROM public.privacy_backup_row_pages WHERE backup_id=backup ORDER BY page_index LOOP
  IF p.page_index<>idx THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_INCOMPLETE';END IF;
  root:=encode(public.digest(root||chr(10)||p.page_sha256,'sha256'),'hex');idx:=idx+1;total:=total+p.row_count;
 END LOOP;
 IF(idx,total,root) IS DISTINCT FROM(s.page_count,s.row_count,s.root_sha256) OR (SELECT count(*) FROM public.privacy_backup_row_entries WHERE backup_id=backup)<>s.row_count THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_INCOMPLETE';END IF;
 existed:=EXISTS(SELECT 1 FROM public.privacy_backup_row_seals WHERE backup_id=backup);
 IF NOT existed THEN INSERT INTO public.privacy_backup_row_seals(backup_id,workspace_id,row_count,page_count,root_sha256) VALUES(backup,s.workspace_id,total,idx,root);END IF;
 PERFORM public.privacy_backup_rows_import_authority(backup,restore_receipt);
 RETURN jsonb_build_object('status',CASE WHEN existed THEN 'NO_EFFECT' ELSE 'SEALED' END,'backup_id',backup,'row_count',total::text,'page_count',idx,'root_sha256',root,'erasure_authorized',false);
END $$;
ALTER FUNCTION seal_privacy_backup_rows(uuid,text,text) OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION seal_privacy_backup_rows(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seal_privacy_backup_rows(uuid,text,text) TO commerce_privacy_attestor;

-- One031 authority check and one native scan per relation; no runtime grant.
CREATE FUNCTION assert_privacy_backup_rows(job uuid,lease uuid,entries jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j public.privacy_jobs%ROWTYPE;s public.privacy_backup_row_sets%ROWTYPE;a jsonb;e jsonb;spec record;actual jsonb;expected jsonb;keys text[];catalog jsonb;
BEGIN
 IF entries IS NULL OR jsonb_typeof(entries)<>'array' OR jsonb_array_length(entries)>20000 OR octet_length(entries::text)>8388608 THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_INPUT';END IF;
 PERFORM public.privacy_require_writer_fences();PERFORM public.privacy_writer_fence_assert(lease);
 SELECT * INTO STRICT j FROM public.privacy_jobs WHERE id=job AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'');a:=public.privacy_job_authority(j.journey_id,j.backup_id);
 IF a IS DISTINCT FROM j.manifest->'authority' OR encode(public.digest(j.manifest::text,'sha256'),'hex')<>j.manifest_sha256 THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_JOB_CHANGED';END IF;
 SELECT * INTO STRICT s FROM public.privacy_backup_row_sets WHERE backup_id=j.backup_id AND workspace_id=j.workspace_id AND environment='REAL';catalog:=public.privacy_backup_row_catalog();
 IF s.catalog_sha256 IS DISTINCT FROM catalog->>'catalog_sha256' OR NOT EXISTS(SELECT 1 FROM public.privacy_backup_row_seals z WHERE z.backup_id=s.backup_id AND (z.row_count,z.page_count,z.root_sha256)=(s.row_count,s.page_count,s.root_sha256)) OR NOT EXISTS(SELECT 1 FROM public.privacy_backup_attestations b WHERE b.id=s.backup_id AND b.workspace_id=s.workspace_id AND b.restore_sha256=s.restore_sha256) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_UNSEALED';END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(entries) LOOP
  IF jsonb_typeof(e)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e)k) IS DISTINCT FROM ARRAY['key_sha256','relation','source_sha256'] OR NOT EXISTS(SELECT 1 FROM public.privacy_backup_row_entries r WHERE r.backup_id=s.backup_id AND (r.relation_name,r.key_sha256,r.source_sha256)=(e->>'relation',e->>'key_sha256',e->>'source_sha256')) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROW_NOT_COVERED';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(entries)x GROUP BY x.value->>'relation',x.value->>'key_sha256' HAVING count(*)<>1) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_DUPLICATE';END IF;
 FOR spec IN SELECT value->>'relation' relation FROM jsonb_array_elements(entries) GROUP BY value->>'relation' LOOP
  SELECT array_agg(value->>'key_sha256'),jsonb_agg(value ORDER BY value->>'key_sha256') INTO keys,expected FROM jsonb_array_elements(entries) WHERE value->>'relation'=spec.relation;
  actual:=public.privacy_current_backup_rows(spec.relation,keys,lease);
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROW_CHANGED';END IF;
 END LOOP;
 PERFORM public.privacy_writer_fence_assert(lease);IF(a->>'valid_until')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_AUTHORITY';END IF;
 RETURN jsonb_build_object('schema_version',1,'backup_id',s.backup_id,'restore_sha256',s.restore_sha256,'evidence_sha256',s.evidence_sha256,'rows',jsonb_array_length(entries),'covered',true,'erasure_authorized',false);
END $$;
ALTER FUNCTION assert_privacy_backup_rows(uuid,uuid,jsonb) OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION assert_privacy_backup_rows(uuid,uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION assert_privacy_backup_row(job uuid,lease uuid,relation_name text,key_hash text,source_hash text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT public.assert_privacy_backup_rows(job,lease,jsonb_build_array(jsonb_build_object('relation',relation_name,'key_sha256',key_hash,'source_sha256',source_hash)))
$$;
ALTER FUNCTION assert_privacy_backup_row(uuid,uuid,text,text,text) OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION assert_privacy_backup_row(uuid,uuid,text,text,text) FROM PUBLIC;
