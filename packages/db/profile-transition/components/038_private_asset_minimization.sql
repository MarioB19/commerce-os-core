-- Install after031–037, before final generated028/030/035 seals. No runtime apply/admission.
CREATE TABLE privacy_asset_batches(
 id uuid PRIMARY KEY REFERENCES privacy_record_batches(id),workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 journey_id uuid NOT NULL,job_sha256 text NOT NULL CHECK(job_sha256~'^[a-f0-9]{64}$'),opaque_pass_id uuid NOT NULL REFERENCES privacy_opaque_passes(id),
 reference_sha256 text NOT NULL CHECK(reference_sha256~'^[a-f0-9]{64}$'),manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='array'),manifest_sha256 text NOT NULL CHECK(manifest_sha256~'^[a-f0-9]{64}$'),
 file_manifest jsonb NOT NULL CHECK(jsonb_typeof(file_manifest)='object'),file_manifest_sha256 text NOT NULL CHECK(file_manifest_sha256~'^[a-f0-9]{64}$'),candidate jsonb NOT NULL CHECK(jsonb_typeof(candidate)='object'),
 candidate_sha256 text NOT NULL CHECK(candidate_sha256~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(id,workspace_id,environment,journey_id)
);
CREATE TABLE privacy_asset_apply_admissions(
 batch_id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),journey_id uuid NOT NULL,
 backend_pid integer NOT NULL,transaction_id xid8 NOT NULL,profile_lease uuid NOT NULL REFERENCES privacy_writer_leases(id),reference_lease uuid NOT NULL REFERENCES privacy_reference_leases(id),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256~'^[a-f0-9]{64}$'),reference_epoch bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(batch_id,workspace_id,environment,journey_id) REFERENCES privacy_asset_batches(id,workspace_id,environment,journey_id)
);
CREATE TABLE privacy_minimized_assets(
 record_id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),kind text NOT NULL DEFAULT 'asset' CHECK(kind='asset'),
 batch_id uuid NOT NULL,journey_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(record_id,workspace_id,environment,kind) REFERENCES records(id,workspace_id,environment,kind),
 FOREIGN KEY(batch_id,workspace_id,environment,journey_id) REFERENCES privacy_asset_batches(id,workspace_id,environment,journey_id)
);
CREATE TABLE privacy_asset_completions(
 batch_id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),journey_id uuid NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(batch_id,workspace_id,environment,journey_id) REFERENCES privacy_asset_batches(id,workspace_id,environment,journey_id)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['privacy_asset_batches','privacy_asset_apply_admissions','privacy_minimized_assets','privacy_asset_completions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY privacy_asset_owner_scope ON public.%I TO commerce_privacy_file_owner USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'') WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'')',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);EXECUTE format('GRANT SELECT ON public.%I TO commerce_privacy_file_owner',t);
  EXECUTE format('CREATE TRIGGER immutable_privacy_asset_evidence BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.immutable_row()',t);
 END LOOP;
END $$;
GRANT INSERT ON privacy_asset_batches,privacy_minimized_assets,privacy_asset_completions TO commerce_privacy_file_owner;
-- The future final assembler alone may receive INSERT on admissions, after full review.
GRANT SELECT ON records,record_versions TO commerce_privacy_file_owner;
GRANT UPDATE(body) ON records,record_versions TO commerce_privacy_file_owner;
CREATE POLICY privacy_asset_source_scope ON records TO commerce_privacy_file_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
CREATE POLICY privacy_asset_history_scope ON record_versions TO commerce_privacy_file_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
GRANT EXECUTE ON FUNCTION privacy_record_authority(uuid,uuid),privacy_reference_fence_assert(uuid),privacy_record_transition(jsonb,jsonb,text,text,text) TO commerce_privacy_file_owner;

-- Fixed ASCII object keys; values remain JSON strings, never concatenated SQL.
-- This matches the private-file manifest's recursively sorted compact JSON.
CREATE FUNCTION privacy_file_canonical_json(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE result text;BEGIN
 IF value IS NULL THEN RAISE EXCEPTION 'PRIVACY_FILE_JSON_REQUIRED';END IF;
 IF jsonb_typeof(value)='object' THEN SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||public.privacy_file_canonical_json(x.value),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(value)x;
 ELSIF jsonb_typeof(value)='array' THEN SELECT '['||COALESCE(string_agg(public.privacy_file_canonical_json(x.value),',' ORDER BY n),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY x(value,n);
 ELSE result:=value::text;END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION privacy_file_canonical_json(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_file_canonical_json(jsonb) TO commerce_privacy_file_owner;

CREATE FUNCTION prepare_privacy_asset_minimization(job uuid,opaque_pass uuid,profile_lease uuid,reference_lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE j public.privacy_jobs%ROWTYPE;b public.privacy_asset_batches%ROWTYPE;r public.records%ROWTYPE;v public.record_versions%ROWTYPE;
 refs jsonb;backup jsonb;a jsonb;h jsonb;images jsonb;minimum jsonb:='{"privacy_erased":true,"status":"RETAINED"}';
 manifest_value jsonb:='[]';files_value jsonb:='[]';descriptors jsonb:='[]';pins jsonb:='[]';descriptor jsonb;file_value jsonb;candidate_value jsonb;
 manifest_hash text;file_hash text;candidate_hash text;reference_hash text;source_hash text;history_hash text;backup_at timestamptz;n integer;total integer:=0;total_bytes bigint:=0;file_bytes bigint:=0;
BEGIN
 j:=public.privacy_record_authority(job,profile_lease);PERFORM public.privacy_reference_fences_assert();PERFORM public.privacy_reference_fence_assert(reference_lease);
 refs:=public.read_privacy_asset_references(job,opaque_pass,profile_lease,reference_lease);backup:=public.read_privacy_backup_files(job,profile_lease);
 IF refs->>'workspace_id' IS DISTINCT FROM j.workspace_id OR refs->>'record_batch_id' IS DISTINCT FROM job::text OR refs->>'journey_id' IS DISTINCT FROM j.journey_id::text OR refs->>'environment' IS DISTINCT FROM 'REAL' OR refs->>'erasure_authorized' IS DISTINCT FROM 'false' OR jsonb_typeof(refs->'assets') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PRIVACY_ASSET_REFERENCE_BINDING';END IF;
 backup_at:=(j.manifest->'authority'->>'backup_snapshot_at')::timestamptz;
 -- Epoch changes only with a fenced transaction. It is validated, but excluded
 -- from stable candidate identity so a read-only recheck cannot renew authority.
 reference_hash:=encode(public.digest((refs-ARRAY['reference_epoch','coverage'])::text,'sha256'),'hex');
 FOR a IN SELECT value FROM jsonb_array_elements(refs->'assets') ORDER BY value->>'asset_id' LOOP
  IF a->>'classification'='SHARED' THEN CONTINUE;END IF;
  IF a->>'classification' IS DISTINCT FROM 'OWNED' THEN RAISE EXCEPTION 'PRIVACY_ASSET_REFERENCE_UNRESOLVED';END IF;
  SELECT * INTO STRICT r FROM public.records WHERE id=(a->>'asset_id')::uuid AND workspace_id=j.workspace_id AND environment='REAL' AND kind='asset' FOR UPDATE;
  source_hash:=encode(public.digest(to_jsonb(r)::text,'sha256'),'hex');
  IF source_hash IS DISTINCT FROM a->>'source_sha256' OR r.created_at>backup_at OR r.updated_at>backup_at OR r.body->>'privacy_erased'='true' THEN RAISE EXCEPTION 'PRIVACY_ASSET_SOURCE_CHANGED';END IF;
  pins:=pins||jsonb_build_array(jsonb_build_object('relation','public.records','key_sha256',encode(public.digest(jsonb_build_object('id',r.id)::text,'sha256'),'hex'),'source_sha256',source_hash));
  images:='[]';n:=0;
  FOR v IN SELECT * FROM public.record_versions WHERE record_id=r.id ORDER BY version FOR UPDATE LOOP
   n:=n+1;total:=total+1;total_bytes:=total_bytes+octet_length(v.body::text);
   IF total>10000 OR total_bytes>16777216 OR v.version<>n OR (v.workspace_id,v.environment,v.kind) IS DISTINCT FROM(r.workspace_id,r.environment,r.kind) OR v.created_at>backup_at OR (v.version=r.version AND v.body<>r.body) THEN RAISE EXCEPTION 'PRIVACY_ASSET_HISTORY_CHANGED';END IF;
   history_hash:=encode(public.digest(to_jsonb(v)::text,'sha256'),'hex');
   SELECT value INTO STRICT h FROM jsonb_array_elements(a->'history') WHERE (value->>'version')::integer=v.version;
   IF history_hash IS DISTINCT FROM h->>'fullrow_sha256' THEN RAISE EXCEPTION 'PRIVACY_ASSET_HISTORY_CHANGED';END IF;
   pins:=pins||jsonb_build_array(jsonb_build_object('relation','public.record_versions','key_sha256',encode(public.digest(jsonb_build_object('record_id',v.record_id,'version',v.version)::text,'sha256'),'hex'),'source_sha256',history_hash));
   images:=images||jsonb_build_array(jsonb_build_object('version',v.version,'source_sha256',history_hash,'minimum_sha256',encode(public.digest(jsonb_set(to_jsonb(v),'{body}',minimum)::text,'sha256'),'hex')));
  END LOOP;
  IF n<>r.version OR n<1 OR n<>jsonb_array_length(a->'history') THEN RAISE EXCEPTION 'PRIVACY_ASSET_HISTORY_CHANGED';END IF;
  manifest_value:=manifest_value||jsonb_build_array(jsonb_build_object('asset_id',r.id,'version',r.version,'source_sha256',source_hash,'minimum_sha256',encode(public.digest(jsonb_set(to_jsonb(r),'{body}',minimum)::text,'sha256'),'hex'),'history',images,'reference_sha256',a->>'reference_sha256'));
  IF COALESCE(r.body->>'kind','file')='file' THEN
   SELECT value INTO STRICT descriptor FROM jsonb_array_elements(backup->'files') WHERE value->>'asset_id'=r.id::text AND value->>'storage_key'=r.body->>'storage_key';
   file_bytes:=file_bytes+(descriptor->>'ciphertext_bytes')::bigint;
   IF file_bytes>2147483648 THEN RAISE EXCEPTION 'PRIVACY_ASSET_FILE_BOUND';END IF;
   descriptors:=descriptors||jsonb_build_array(descriptor);
   files_value:=files_value||jsonb_build_array(descriptor||jsonb_build_object('source_sha256',source_hash,'history_sha256',encode(public.digest(images::text,'sha256'),'hex'),'reference_sha256',a->>'reference_sha256'));
  ELSIF COALESCE(r.body->>'kind','') NOT IN('link','access') THEN RAISE EXCEPTION 'PRIVACY_ASSET_ADAPTER_UNRESOLVED';END IF;
 END LOOP;
 --037 must authenticate the restored complete row, not merely old timestamps.
 PERFORM public.assert_privacy_backup_rows(job,profile_lease,pins);
 manifest_hash:=encode(public.digest(manifest_value::text,'sha256'),'hex');
 file_value:=jsonb_build_object('schema_version',1,'job_id',job,'workspace_id',j.workspace_id,'plan_sha256',manifest_hash,'inventory_sha256',reference_hash,'backup_fence_sha256',encode(public.digest((j.manifest->'authority')::text,'sha256'),'hex'),'files',descriptors);
 file_hash:=encode(public.digest(public.privacy_file_canonical_json(file_value),'sha256'),'hex');
 candidate_value:=jsonb_build_object('schema_version',1,'job_id',job,'workspace_id',j.workspace_id,'plan_sha256',manifest_hash,'inventory_sha256',reference_hash,'backup_fence_sha256',file_value->>'backup_fence_sha256','backup_id',j.backup_id,'restore_sha256',backup->>'restore_sha256','backup_snapshot_unix_ns',backup->>'backup_snapshot_unix_ns','valid_until',backup->>'valid_until','files',files_value,'erasure_authorized',false);
 candidate_hash:=encode(public.digest(candidate_value::text,'sha256'),'hex');candidate_value:=candidate_value||jsonb_build_object('candidate_sha256',candidate_hash);
 PERFORM public.privacy_record_authority(job,profile_lease);PERFORM public.privacy_reference_fence_assert(reference_lease);PERFORM public.privacy_reference_fences_assert();
 SELECT * INTO b FROM public.privacy_asset_batches WHERE id=job;
 IF FOUND THEN
  IF(b.workspace_id,b.journey_id,b.job_sha256,b.opaque_pass_id,b.reference_sha256,b.manifest,b.manifest_sha256,b.file_manifest,b.file_manifest_sha256,b.candidate,b.candidate_sha256) IS DISTINCT FROM(j.workspace_id,j.journey_id,j.manifest_sha256,opaque_pass,reference_hash,manifest_value,manifest_hash,file_value,file_hash,candidate_value,candidate_hash) THEN RAISE EXCEPTION 'PRIVACY_ASSET_BATCH_CHANGED';END IF;
 ELSE
  INSERT INTO public.privacy_asset_batches(id,workspace_id,journey_id,job_sha256,opaque_pass_id,reference_sha256,manifest,manifest_sha256,file_manifest,file_manifest_sha256,candidate,candidate_sha256) VALUES(job,j.workspace_id,j.journey_id,j.manifest_sha256,opaque_pass,reference_hash,manifest_value,manifest_hash,file_value,file_hash,candidate_value,candidate_hash);
 END IF;
 RETURN candidate_value||jsonb_build_object('observed_at',clock_timestamp());
END $$;
ALTER FUNCTION prepare_privacy_asset_minimization(uuid,uuid,uuid,uuid) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION prepare_privacy_asset_minimization(uuid,uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION privacy_asset_admission(batch uuid) RETURNS public.privacy_asset_apply_admissions LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE a public.privacy_asset_apply_admissions%ROWTYPE;b public.privacy_asset_batches%ROWTYPE;BEGIN
 SELECT * INTO a FROM public.privacy_asset_apply_admissions WHERE batch_id=batch AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL';
 IF NOT FOUND OR a.backend_pid<>pg_backend_pid() OR a.transaction_id<>pg_current_xact_id() THEN RAISE EXCEPTION 'PRIVACY_ASSET_ADMISSION_REQUIRED';END IF;
 SELECT * INTO STRICT b FROM public.privacy_asset_batches WHERE id=batch;
 IF a.manifest_sha256<>b.manifest_sha256 OR a.reference_epoch<>public.privacy_reference_fence_assert(a.reference_lease) THEN RAISE EXCEPTION 'PRIVACY_ASSET_ADMISSION_CHANGED';END IF;
 -- Full031/catalog checks bracket apply. The row predicate checks the same
 -- transaction admission and both live leases; global EX freezes its sources.
 PERFORM public.privacy_writer_fence_assert(a.profile_lease);RETURN a;
END $$;
ALTER FUNCTION privacy_asset_admission(uuid) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION privacy_asset_admission(uuid) FROM PUBLIC;

CREATE FUNCTION privacy_asset_reference_allowed(workspace text,environment_name text,asset uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF workspace IS NULL OR workspace IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') OR environment_name IS NULL OR environment_name IS DISTINCT FROM current_setting('app.environment',true) THEN RAISE EXCEPTION 'PRIVACY_ASSET_CONTEXT_REQUIRED';END IF;
 RETURN NOT EXISTS(SELECT 1 FROM public.privacy_minimized_assets WHERE record_id=asset AND workspace_id=workspace AND environment=environment_name);
END $$;
ALTER FUNCTION privacy_asset_reference_allowed(text,text,uuid) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION privacy_asset_reference_allowed(text,text,uuid) FROM PUBLIC;

CREATE FUNCTION privacy_asset_transition(prior jsonb,next_image jsonb,relation_name text,operation text,actor text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE rid uuid;m public.privacy_minimized_assets%ROWTYPE;b public.privacy_asset_batches%ROWTYPE;e jsonb;h jsonb;v integer;
BEGIN
 IF relation_name NOT IN('records','record_versions') THEN RAISE EXCEPTION 'PRIVACY_ASSET_RELATION';END IF;
 IF COALESCE(prior,next_image)->>'workspace_id' IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') OR COALESCE(prior,next_image)->>'environment' IS DISTINCT FROM current_setting('app.environment',true) THEN RAISE EXCEPTION 'PRIVACY_ASSET_CONTEXT_REQUIRED';END IF;
 rid:=(COALESCE(prior,next_image)->>CASE WHEN relation_name='records' THEN 'id' ELSE 'record_id' END)::uuid;
 SELECT * INTO m FROM public.privacy_minimized_assets WHERE record_id=rid;
 IF NOT FOUND THEN
  IF operation<>'DELETE' AND EXISTS(SELECT 1 FROM public.privacy_minimized_assets x WHERE x.workspace_id=next_image->>'workspace_id' AND x.environment=next_image->>'environment' AND position(x.record_id::text IN lower((next_image->'body')::text))>0) THEN
   --033 validates native032 correction and snapshot, not a caller permission flag.
   IF public.privacy_record_transition(prior,next_image,relation_name,operation,actor)='CORRECTION' THEN RETURN 'CORRECTION';END IF;
   RAISE EXCEPTION 'PRIVACY_ASSET_REFERENCE_RESURRECTION';
  END IF;RETURN 'UNCHANGED';
 END IF;
 IF operation='UPDATE' AND actor='commerce_privacy_file_owner' AND prior-'body'=next_image-'body' THEN
  PERFORM public.privacy_asset_admission(m.batch_id);SELECT * INTO STRICT b FROM public.privacy_asset_batches WHERE id=m.batch_id;
  SELECT value INTO STRICT e FROM jsonb_array_elements(b.manifest) WHERE value->>'asset_id'=rid::text;v:=(next_image->>'version')::integer;
  h:=CASE WHEN relation_name='records' THEN e ELSE e->'history'->(v-1) END;
  IF h->>'source_sha256'=encode(public.digest(prior::text,'sha256'),'hex') AND h->>'minimum_sha256'=encode(public.digest(next_image::text,'sha256'),'hex') THEN RETURN 'MINIMIZE';END IF;
 END IF;RAISE EXCEPTION 'PRIVACY_ASSET_RESURRECTION';
END $$;
ALTER FUNCTION privacy_asset_transition(jsonb,jsonb,text,text,text) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION privacy_asset_transition(jsonb,jsonb,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_asset_transition(jsonb,jsonb,text,text,text),privacy_asset_reference_allowed(text,text,uuid) TO commerce_api,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance,commerce_results,commerce_results_reader,commerce_ai,commerce_number_lab,commerce_financial_retention,commerce_privacy_record_eraser;
CREATE FUNCTION privacy_minimized_asset_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 PERFORM public.privacy_asset_transition(CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,TG_TABLE_NAME,TG_OP,current_user);RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER aa_privacy_minimized_asset_guard BEFORE INSERT OR UPDATE OR DELETE ON records FOR EACH ROW EXECUTE FUNCTION privacy_minimized_asset_guard();
CREATE TRIGGER aa_privacy_minimized_asset_version_guard BEFORE INSERT OR UPDATE OR DELETE ON record_versions FOR EACH ROW EXECUTE FUNCTION privacy_minimized_asset_guard();
CREATE FUNCTION privacy_asset_snapshot_skip(prior jsonb,next_image jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.privacy_minimized_assets WHERE record_id=(next_image->>'id')::uuid) THEN RETURN false;END IF;
 RETURN public.privacy_asset_transition(prior,next_image,'records','UPDATE','commerce_privacy_file_owner')='MINIMIZE';
END $$;
ALTER FUNCTION privacy_asset_snapshot_skip(jsonb,jsonb) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION privacy_asset_snapshot_skip(jsonb,jsonb) FROM PUBLIC;
DO $$ DECLARE native_owner text;BEGIN
 SELECT pg_get_userbyid(proowner) INTO STRICT native_owner FROM pg_proc WHERE oid='public.snapshot_record()'::regprocedure;
 EXECUTE format('GRANT EXECUTE ON FUNCTION public.privacy_asset_snapshot_skip(jsonb,jsonb),public.privacy_asset_transition(jsonb,jsonb,text,text,text) TO %I',native_owner);
END $$;

CREATE FUNCTION apply_privacy_asset_minimization(batch uuid,profile_lease uuid,reference_lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE b public.privacy_asset_batches%ROWTYPE;a public.privacy_asset_apply_admissions%ROWTYPE;e jsonb;h jsonb;prior jsonb;result_value jsonb;total integer:=0;BEGIN
 a:=public.privacy_asset_admission(batch);
 IF(a.profile_lease,a.reference_lease) IS DISTINCT FROM(profile_lease,reference_lease) THEN RAISE EXCEPTION 'PRIVACY_ASSET_ADMISSION_REQUIRED';END IF;
 SELECT * INTO STRICT b FROM public.privacy_asset_batches WHERE id=batch;
 PERFORM public.privacy_record_authority(batch,profile_lease);PERFORM public.privacy_reference_fences_assert();
 IF encode(public.digest(b.manifest::text,'sha256'),'hex')<>b.manifest_sha256 OR encode(public.digest(public.privacy_file_canonical_json(b.file_manifest),'sha256'),'hex')<>b.file_manifest_sha256 THEN RAISE EXCEPTION 'PRIVACY_ASSET_BATCH_CHANGED';END IF;
 SELECT result INTO result_value FROM public.privacy_asset_completions WHERE batch_id=batch;
 IF FOUND THEN RETURN result_value||jsonb_build_object('status','NO_EFFECT');END IF;
 -- The private final assembler validated035/037 in this same fenced transaction
 -- BEFORE changing033/copies. Admission cannot survive a COMMIT or backend switch.
 FOR e IN SELECT value FROM jsonb_array_elements(b.manifest) LOOP
  SELECT to_jsonb(r) INTO STRICT prior FROM public.records r WHERE id=(e->>'asset_id')::uuid AND workspace_id=b.workspace_id AND environment='REAL' FOR UPDATE;
  IF encode(public.digest(prior::text,'sha256'),'hex')<>e->>'source_sha256' THEN RAISE EXCEPTION 'PRIVACY_ASSET_SOURCE_CHANGED';END IF;
  INSERT INTO public.privacy_minimized_assets(record_id,workspace_id,batch_id,journey_id,source_version) VALUES((e->>'asset_id')::uuid,b.workspace_id,batch,b.journey_id,(e->>'version')::integer);
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(b.manifest) LOOP
  FOR h IN SELECT value FROM jsonb_array_elements(e->'history') LOOP
   UPDATE public.record_versions SET body='{"privacy_erased":true,"status":"RETAINED"}' WHERE record_id=(e->>'asset_id')::uuid AND workspace_id=b.workspace_id AND environment='REAL' AND version=(h->>'version')::integer;
   IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_ASSET_HISTORY_CHANGED';END IF;total:=total+1;
  END LOOP;
  UPDATE public.records SET body='{"privacy_erased":true,"status":"RETAINED"}' WHERE id=(e->>'asset_id')::uuid AND workspace_id=b.workspace_id AND environment='REAL' AND version=(e->>'version')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_ASSET_SOURCE_CHANGED';END IF;
 END LOOP;
 PERFORM public.privacy_asset_admission(batch);PERFORM public.privacy_record_authority(batch,profile_lease);PERFORM public.privacy_reference_fences_assert();
 result_value:=jsonb_build_object('schema_version',1,'status','MINIMIZED','batch_id',batch,'job_id',batch,'workspace_id',b.workspace_id,'environment','REAL','journey_id',b.journey_id,'manifest_sha256',b.manifest_sha256,'file_manifest_sha256',b.file_manifest_sha256,'assets',jsonb_array_length(b.manifest),'versions',total,'files',jsonb_array_length(b.file_manifest->'files'),'erasure_authorized',false);
 INSERT INTO public.privacy_asset_completions(batch_id,workspace_id,journey_id,result) VALUES(batch,b.workspace_id,b.journey_id,result_value);RETURN result_value;
END $$;
ALTER FUNCTION apply_privacy_asset_minimization(uuid,uuid,uuid) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION apply_privacy_asset_minimization(uuid,uuid,uuid) FROM PUBLIC;

-- Source-pinned033 extensions, with all prior gates preserved.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.guard_record()'::regprocedure AND p.prorettype='trigger'::regtype AND p.prosecdef=false AND p.proconfig IS NULL AND encode(public.digest(p.prosrc,'sha256'),'hex')='3c80f70cab408979300f105ce71bb93b3a345d6d635711e364db1c9054dde529') THEN RAISE EXCEPTION 'PRIVACY_ASSET_LEGACY_DRIFT: guard_record';END IF;END $$;

CREATE OR REPLACE FUNCTION guard_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE key text; target text; expected text; ref jsonb;
BEGIN
 IF current_user='commerce_privacy_file_owner' AND TG_OP='UPDATE' AND public.privacy_asset_transition(to_jsonb(OLD),to_jsonb(NEW),'records',TG_OP,current_user)='MINIMIZE' THEN RETURN NEW;END IF;
 IF current_user='commerce_privacy_record_eraser' AND TG_OP='UPDATE' AND public.privacy_record_transition(to_jsonb(OLD),to_jsonb(NEW),'records',TG_OP,current_user)='MINIMIZE' THEN RETURN NEW;END IF;

 IF TG_OP='UPDATE' THEN
  IF (OLD.kind IN ('offer','bank_profile','receipt_policy') OR (OLD.kind='workflow' AND OLD.body->>'status'='PUBLISHED')) AND NOT (OLD.kind IN ('offer','workflow') AND catalog_archive_only(OLD.body,NEW.body)) THEN RAISE EXCEPTION 'IMMUTABLE_VERSION'; END IF;
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.environment<>OLD.environment OR NEW.kind<>OLD.kind OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
 END IF;
 FOR key,target IN SELECT * FROM jsonb_each_text(NEW.body) LOOP
 expected:=CASE key WHEN 'product_id' THEN 'product' WHEN 'offer_version_id' THEN 'offer' WHEN 'workflow_version_id' THEN 'workflow' WHEN 'agent_version_id' THEN 'agent' WHEN 'payment_profile_version_id' THEN 'bank_profile' WHEN 'receipt_policy_version_id' THEN 'receipt_policy' WHEN 'campaign_id' THEN 'acquisition_campaign' WHEN 'ad_set_id' THEN 'ad_set' WHEN 'ad_id' THEN 'ad' WHEN 'account_id' THEN 'channel_account' WHEN 'contact_id' THEN 'contact' WHEN 'conversation_id' THEN 'conversation' WHEN 'order_id' THEN 'order' WHEN 'asset_id' THEN 'asset' ELSE NULL END;
 IF expected IS NOT NULL AND target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records r WHERE r.id::text=target AND r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.kind=expected) THEN RAISE EXCEPTION 'INVALID_SCOPED_REFERENCE: %',key; END IF;
 END LOOP;
 IF NEW.body ? 'fulfillment' THEN FOR ref IN SELECT * FROM jsonb_array_elements(NEW.body->'fulfillment') LOOP IF NOT EXISTS(SELECT 1 FROM records r WHERE r.id::text=ref->>'asset_id' AND r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.kind='asset') THEN RAISE EXCEPTION 'INVALID_ASSET_REFERENCE'; END IF; END LOOP; END IF;
 RETURN NEW;
END $$;

DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.snapshot_record()'::regprocedure AND p.prorettype='trigger'::regtype AND p.prosecdef=true AND p.proconfig=ARRAY['search_path=pg_catalog, public'] AND encode(public.digest(p.prosrc,'sha256'),'hex')='36a03fe2f1ab58d06ace828c360c367b3b20928d2f6673b5dd99e1791b1c782d') THEN RAISE EXCEPTION 'PRIVACY_ASSET_LEGACY_DRIFT: snapshot_record';END IF;END $$;

CREATE OR REPLACE FUNCTION snapshot_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='UPDATE' AND public.privacy_asset_snapshot_skip(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND public.privacy_record_snapshot_skip(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
 INSERT INTO record_versions(record_id,workspace_id,environment,kind,version,body) VALUES(NEW.id,NEW.workspace_id,NEW.environment,NEW.kind,NEW.version,NEW.body); RETURN NEW; END $$;

DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.immutable_row()'::regprocedure AND p.prorettype='trigger'::regtype AND p.prosecdef=false AND p.proconfig IS NULL AND encode(public.digest(p.prosrc,'sha256'),'hex')='f074159c972af5fed850e504db0caa554dc9b954506fce5fa821f4ea0719e688') THEN RAISE EXCEPTION 'PRIVACY_ASSET_LEGACY_DRIFT: immutable_row';END IF;END $$;

CREATE OR REPLACE FUNCTION immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='record_versions' AND TG_OP='UPDATE' AND current_user='commerce_privacy_file_owner' AND public.privacy_asset_transition(to_jsonb(OLD),to_jsonb(NEW),'record_versions',TG_OP,current_user)='MINIMIZE' THEN RETURN NEW;END IF;
 IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='record_versions' AND TG_OP='UPDATE' AND current_user='commerce_privacy_record_eraser' AND public.privacy_record_transition(to_jsonb(OLD),to_jsonb(NEW),'record_versions',TG_OP,current_user)='MINIMIZE' THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='record_versions' AND TG_OP='UPDATE' AND retention_context_valid() THEN RETURN NEW; END IF; RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END $$;

DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.guard_retained_asset_references()'::regprocedure AND p.prorettype='trigger'::regtype AND p.prosecdef=false AND p.proconfig IS NULL AND encode(public.digest(p.prosrc,'sha256'),'hex')='b90098014d388f7e924740e64097a8cb0f67ed18e3026a5eac8784efa28ee572') THEN RAISE EXCEPTION 'PRIVACY_ASSET_LEGACY_DRIFT: guard_retained_asset_references';END IF;END $$;

CREATE OR REPLACE FUNCTION guard_retained_asset_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text; asset_state text;
BEGIN
 IF current_user='commerce_privacy_file_owner' AND TG_OP='UPDATE' AND public.privacy_asset_transition(to_jsonb(OLD),to_jsonb(NEW),'records',TG_OP,current_user)='MINIMIZE' THEN RETURN NEW;END IF;
 IF current_user='commerce_privacy_record_eraser' AND TG_OP='UPDATE' AND public.privacy_record_transition(to_jsonb(OLD),to_jsonb(NEW),'records',TG_OP,current_user)='MINIMIZE' THEN RETURN NEW;END IF;


 -- Existing references in an authenticated032 classification correction are
 -- technical identities. No new reference, body field or asset read is allowed.
 IF current_user='commerce_financial_retention' AND TG_OP='UPDATE' THEN
  IF OLD.kind NOT IN('order','receipt') OR (NEW.body-ARRAY['commercial_classification','classification_decision']) IS DISTINCT FROM (OLD.body-ARRAY['commercial_classification','classification_decision']) OR NOT EXISTS(
   SELECT 1 FROM public.financial_retention_corrections c JOIN public.financial_retention_installations i ON i.attestation_id=c.attestation_id AND i.workspace_id=c.workspace_id AND i.environment=c.environment AND i.journey_id=c.journey_id
   WHERE c.workspace_id=OLD.workspace_id AND c.environment=OLD.environment AND c.record_id=OLD.id AND c.record_kind=OLD.kind AND c.before_version=OLD.version AND c.after_version=NEW.version AND c.body_sha256=encode(public.digest(NEW.body::text,'sha256'),'hex')
  ) THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_REFERENCE_CHANGED';END IF;
  RETURN NEW;
 END IF;
 FOR ref IN SELECT DISTINCT value #>> '{}' FROM (
  SELECT jsonb_path_query(NEW.body,'$.**.asset_id') value
  UNION ALL SELECT jsonb_path_query(NEW.body,'$.**.evidence_asset_id') value
 ) references_found WHERE jsonb_typeof(value)='string' LOOP
  SELECT r.body->>'status' INTO asset_state FROM records r WHERE r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.kind='asset' AND r.id::text=ref FOR SHARE;
  IF asset_state='RETAINED' THEN RAISE EXCEPTION 'INVALID_RETAINED_ASSET_REFERENCE'; END IF;
 END LOOP;
 RETURN NEW;
END $$;

-- Used by the host capture adapter only after private adoption. The opaque pass
-- is resolved from the native batch, never supplied in a file-deletion request.
CREATE FUNCTION read_privacy_asset_candidates(job uuid,profile_lease uuid,reference_lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE opaque uuid;BEGIN
 PERFORM public.privacy_record_authority(job,profile_lease);
 SELECT opaque_pass_id INTO STRICT opaque FROM public.privacy_asset_batches WHERE id=job AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL';
 RETURN public.prepare_privacy_asset_minimization(job,opaque,profile_lease,reference_lease);
END $$;
ALTER FUNCTION read_privacy_asset_candidates(uuid,uuid,uuid) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION read_privacy_asset_candidates(uuid,uuid,uuid) FROM PUBLIC;
