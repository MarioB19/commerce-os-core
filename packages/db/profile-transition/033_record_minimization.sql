-- Install after031+032, before generating030/028. No application authority.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_privacy_record_eraser') THEN RAISE EXCEPTION 'PRIVACY_RECORD_ROLE_EXISTS';END IF;
 CREATE ROLE commerce_privacy_record_eraser NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT;
END $$;
GRANT USAGE ON SCHEMA public TO commerce_privacy_record_eraser;
CREATE TABLE privacy_record_batches(
 id uuid PRIMARY KEY REFERENCES privacy_jobs(id),workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 journey_id uuid NOT NULL,job_sha256 text NOT NULL CHECK(job_sha256~'^[a-f0-9]{64}$'),retention_id uuid NOT NULL REFERENCES financial_retention_attestations(id),
 retention_sha256 text NOT NULL CHECK(retention_sha256~'^[a-f0-9]{64}$'),manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='array'),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(id,workspace_id,environment,journey_id)
);
-- Only the future fully reviewed031 apply owner may receive INSERT.033 grants none.
CREATE TABLE privacy_record_apply_admissions(
 batch_id uuid PRIMARY KEY,job_id uuid NOT NULL CHECK(job_id=batch_id),workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),journey_id uuid NOT NULL,
 backend_pid integer NOT NULL,transaction_id xid8 NOT NULL,lease_id uuid NOT NULL REFERENCES privacy_writer_leases(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(batch_id,workspace_id,environment,journey_id) REFERENCES privacy_record_batches(id,workspace_id,environment,journey_id)
);
CREATE TABLE privacy_minimized_records(
 record_id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),kind text NOT NULL,
 batch_id uuid NOT NULL,journey_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(record_id,workspace_id,environment,kind) REFERENCES records(id,workspace_id,environment,kind),
 FOREIGN KEY(batch_id,workspace_id,environment,journey_id) REFERENCES privacy_record_batches(id,workspace_id,environment,journey_id)
);
CREATE TABLE privacy_record_completions(
 batch_id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),journey_id uuid NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(batch_id,workspace_id,environment,journey_id) REFERENCES privacy_record_batches(id,workspace_id,environment,journey_id)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['privacy_record_batches','privacy_record_apply_admissions','privacy_minimized_records','privacy_record_completions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY privacy_record_owner_scope ON public.%I TO commerce_privacy_record_eraser USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'') WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'')',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);EXECUTE format('GRANT SELECT ON public.%I TO commerce_privacy_record_eraser',t);
  EXECUTE format('CREATE TRIGGER immutable_privacy_record_evidence BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.immutable_row()',t);
 END LOOP;
END $$;
GRANT INSERT ON privacy_record_batches,privacy_minimized_records,privacy_record_completions TO commerce_privacy_record_eraser;
GRANT SELECT ON records,record_versions,privacy_jobs,financial_retention_attestations,financial_retention_corrections,financial_retention_installations TO commerce_privacy_record_eraser;
GRANT UPDATE(body) ON records,record_versions TO commerce_privacy_record_eraser;
CREATE POLICY privacy_record_source ON records TO commerce_privacy_record_eraser USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
CREATE POLICY privacy_record_history ON record_versions TO commerce_privacy_record_eraser USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
CREATE POLICY privacy_record_job_reader ON privacy_jobs FOR SELECT TO commerce_privacy_record_eraser USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
GRANT EXECUTE ON FUNCTION privacy_writer_fence_assert(uuid),privacy_job_authority(uuid,uuid),privacy_require_writer_fences(),privacy_closure_proof(uuid,integer),verify_financial_retention(uuid),confirm_financial_minimization(uuid),financial_minimum_body(text,jsonb),financial_minimum_pick(jsonb,jsonb),retention_context_valid() TO commerce_privacy_record_eraser;

CREATE FUNCTION privacy_record_authority(job uuid,lease uuid) RETURNS public.privacy_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE j public.privacy_jobs%ROWTYPE;a jsonb;BEGIN
 PERFORM public.privacy_require_writer_fences();PERFORM public.privacy_writer_fence_assert(lease);
 SELECT * INTO STRICT j FROM public.privacy_jobs WHERE id=job AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'');
 IF encode(public.digest(j.manifest::text,'sha256'),'hex')<>j.manifest_sha256 OR j.manifest->>'status' IS DISTINCT FROM 'INVENTORIED' OR j.manifest->>'erasure_authorized' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'PRIVACY_RECORD_JOB_CHANGED';END IF;
 a:=public.privacy_job_authority(j.journey_id,j.backup_id);
 IF j.manifest->'authority' IS DISTINCT FROM a THEN RAISE EXCEPTION 'PRIVACY_RECORD_AUTHORITY_CHANGED';END IF;
 RETURN j;
END $$;
ALTER FUNCTION privacy_record_authority(uuid,uuid) OWNER TO commerce_privacy_record_eraser;
REVOKE ALL ON FUNCTION privacy_record_authority(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION prepare_privacy_record_minimization(job uuid,retention uuid,lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE j public.privacy_jobs%ROWTYPE;b public.privacy_record_batches%ROWTYPE;r public.records%ROWTYPE;v public.record_versions%ROWTYPE;
 c jsonb;proof jsonb;images jsonb;image jsonb;minimum jsonb;manifest_value jsonb:='[]';n integer;total_count integer:=0;total_bytes bigint:=0;backup_at timestamptz;retention_hash text;manifest_hash text;
BEGIN
 j:=public.privacy_record_authority(job,lease);
 c:=public.privacy_closure_proof(j.journey_id,j.source_version);
 IF c->>'verified' IS DISTINCT FROM 'true' OR c->>'source_sha256' IS DISTINCT FROM j.manifest->>'source_sha256' OR (c->>'due_at')::timestamptz>clock_timestamp() THEN RAISE EXCEPTION 'PRIVACY_RECORD_SOURCE_CHANGED';END IF;
 proof:=public.verify_financial_retention(j.journey_id);
 IF proof->>'receipt_uuid' IS DISTINCT FROM retention::text OR proof->>'installed' IS DISTINCT FROM 'false' OR proof->>'status' IS DISTINCT FROM 'RESOLUTION_PRESERVED' THEN RAISE EXCEPTION 'PRIVACY_RECORD_FINANCIAL_REQUIRED';END IF;
 retention_hash:=proof->>'receipt_sha256';backup_at:=(j.manifest->'authority'->>'backup_snapshot_at')::timestamptz;
 FOR r IN SELECT * FROM public.records WHERE workspace_id=j.workspace_id AND environment='REAL' AND (id=j.journey_id OR body->>'conversation_id'=j.journey_id::text) ORDER BY id FOR UPDATE LOOP
  IF r.kind NOT IN('conversation','message','touchpoint','ai_run','order','receipt','fulfillment') OR (r.kind='conversation' AND r.id<>j.journey_id) OR r.created_at>backup_at OR r.updated_at>backup_at THEN RAISE EXCEPTION 'PRIVACY_RECORD_SCOPE_OR_BACKUP';END IF;
  images:='[]';n:=0;
  FOR v IN SELECT * FROM public.record_versions WHERE record_id=r.id ORDER BY version FOR UPDATE LOOP
   n:=n+1;total_count:=total_count+1;total_bytes:=total_bytes+octet_length(v.body::text);
   IF total_count>10000 OR total_bytes>16777216 THEN RAISE EXCEPTION 'PRIVACY_RECORD_HISTORY_BOUND';END IF;
   IF v.version<>n OR (v.workspace_id,v.environment,v.kind) IS DISTINCT FROM(r.workspace_id,r.environment,r.kind) OR v.created_at>backup_at OR v.created_at<r.created_at OR (r.id<>j.journey_id AND v.body->>'conversation_id' IS DISTINCT FROM j.journey_id::text) OR (v.version=r.version AND v.body<>r.body) THEN RAISE EXCEPTION 'PRIVACY_RECORD_HISTORY_CHANGED';END IF;
   minimum:=CASE WHEN r.kind IN('order','receipt','fulfillment') THEN public.financial_minimum_body(r.kind,v.body) WHEN r.kind='conversation' THEN jsonb_build_object('privacy_erased',true,'status','CLOSED') ELSE jsonb_build_object('privacy_erased',true,'conversation_id',j.journey_id) END;
   image:=jsonb_set(to_jsonb(v),'{body}',minimum);
   images:=images||jsonb_build_array(jsonb_build_object('version',v.version,'source_sha256',encode(public.digest(to_jsonb(v)::text,'sha256'),'hex'),'minimum_sha256',encode(public.digest(image::text,'sha256'),'hex'),'body',minimum));
  END LOOP;
  IF n<>r.version THEN RAISE EXCEPTION 'PRIVACY_RECORD_HISTORY_CHANGED';END IF;
  manifest_value:=manifest_value||jsonb_build_array(jsonb_build_object('record_id',r.id,'kind',r.kind,'version',r.version,'source_sha256',encode(public.digest(to_jsonb(r)::text,'sha256'),'hex'),'minimum_sha256',encode(public.digest(jsonb_set(to_jsonb(r),'{body}',minimum)::text,'sha256'),'hex'),'history',images));
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(manifest_value)x WHERE x->>'record_id'=j.journey_id::text) THEN RAISE EXCEPTION 'PRIVACY_RECORD_SOURCE_CHANGED';END IF;
 manifest_hash:=encode(public.digest(manifest_value::text,'sha256'),'hex');
 PERFORM public.privacy_record_authority(job,lease);
 SELECT * INTO b FROM public.privacy_record_batches WHERE id=job;
 IF FOUND THEN
  IF (b.workspace_id,b.journey_id,b.job_sha256,b.retention_id,b.retention_sha256,b.manifest_sha256,b.manifest) IS DISTINCT FROM(j.workspace_id,j.journey_id,j.manifest_sha256,retention,retention_hash,manifest_hash,manifest_value) THEN RAISE EXCEPTION 'PRIVACY_RECORD_BATCH_CHANGED';END IF;
 ELSE
  INSERT INTO public.privacy_record_batches(id,workspace_id,journey_id,job_sha256,retention_id,retention_sha256,manifest,manifest_sha256) VALUES(job,j.workspace_id,j.journey_id,j.manifest_sha256,retention,retention_hash,manifest_value,manifest_hash);
 END IF;
 RETURN jsonb_build_object('schema_version',1,'status','PREPARED','batch_id',job,'job_id',job,'workspace_id',j.workspace_id,'environment','REAL','journey_id',j.journey_id,'manifest_sha256',manifest_hash,'records',jsonb_array_length(manifest_value),'versions',total_count,'erasure_authorized',false);
END $$;
ALTER FUNCTION prepare_privacy_record_minimization(uuid,uuid,uuid) OWNER TO commerce_privacy_record_eraser;
REVOKE ALL ON FUNCTION prepare_privacy_record_minimization(uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION privacy_record_admission(batch uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE a public.privacy_record_apply_admissions%ROWTYPE;BEGIN
 SELECT * INTO a FROM public.privacy_record_apply_admissions WHERE batch_id=batch AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL';
 IF NOT FOUND OR a.backend_pid<>pg_backend_pid() OR a.transaction_id<>pg_current_xact_id() THEN RAISE EXCEPTION 'PRIVACY_RECORD_ADMISSION_REQUIRED';END IF;
 PERFORM public.privacy_writer_fence_assert(a.lease_id);RETURN a.lease_id;
END $$;
ALTER FUNCTION privacy_record_admission(uuid) OWNER TO commerce_privacy_record_eraser;
REVOKE ALL ON FUNCTION privacy_record_admission(uuid) FROM PUBLIC;

-- A read-only trigger predicate. Supplied actor never grants a write: invoker
-- triggers supply current_user themselves and no direct DML port exists here.
CREATE FUNCTION privacy_record_transition(prior jsonb,next_image jsonb,relation_name text,operation text,actor text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE rid uuid;mark public.privacy_minimized_records%ROWTYPE;b public.privacy_record_batches%ROWTYPE;e jsonb;h jsonb;v integer;correction public.financial_retention_corrections%ROWTYPE;
BEGIN
 IF relation_name NOT IN('records','record_versions') THEN RAISE EXCEPTION 'PRIVACY_RECORD_RELATION';END IF;
 IF COALESCE(prior,next_image)->>'workspace_id' IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') OR COALESCE(prior,next_image)->>'environment' IS DISTINCT FROM current_setting('app.environment',true) THEN RAISE EXCEPTION 'PRIVACY_RECORD_CONTEXT_REQUIRED';END IF;
 rid:=(COALESCE(prior,next_image)->>CASE WHEN relation_name='records' THEN 'id' ELSE 'record_id' END)::uuid;
 SELECT * INTO mark FROM public.privacy_minimized_records WHERE record_id=rid;
 IF NOT FOUND THEN
  IF operation<>'DELETE' AND EXISTS(
   SELECT 1 FROM public.privacy_minimized_records m JOIN (
    SELECT jsonb_path_query(next_image->'body','$.**.conversation_id') value UNION ALL SELECT jsonb_path_query(next_image->'body','$.**.order_id') UNION ALL SELECT jsonb_path_query(next_image->'body','$.**.receipt_id') UNION ALL SELECT jsonb_path_query(next_image->'body','$.**.fulfillment_id') UNION ALL SELECT jsonb_path_query(next_image->'body','$.**.message_id') UNION ALL SELECT jsonb_path_query(next_image->'body','$.**.ai_run_id') UNION ALL SELECT jsonb_path_query(next_image->'body','$.**.touchpoint_id')
   ) refs ON jsonb_typeof(refs.value)='string' AND m.record_id::text=refs.value#>>'{}'
   WHERE m.workspace_id=next_image->>'workspace_id' AND m.environment=next_image->>'environment'
  ) THEN RAISE EXCEPTION 'PRIVACY_RECORD_RESURRECTION';END IF;
  RETURN 'UNCHANGED';
 END IF;
 IF operation='DELETE' OR next_image->>'workspace_id' IS DISTINCT FROM mark.workspace_id OR next_image->>'environment' IS DISTINCT FROM 'REAL' OR next_image->>'kind' IS DISTINCT FROM mark.kind THEN RAISE EXCEPTION 'PRIVACY_RECORD_RESURRECTION';END IF;
 SELECT * INTO STRICT b FROM public.privacy_record_batches WHERE id=mark.batch_id;
 SELECT value INTO STRICT e FROM jsonb_array_elements(b.manifest) WHERE value->>'record_id'=rid::text;
 v:=(next_image->>'version')::integer;
 IF actor='commerce_privacy_record_eraser' AND operation='UPDATE' AND prior-'body'=next_image-'body' THEN
  PERFORM public.privacy_record_admission(b.id);
  h:=CASE WHEN relation_name='records' THEN e ELSE e->'history'->(v-1) END;
  IF h->>'source_sha256'=encode(public.digest(prior::text,'sha256'),'hex') AND h->>'minimum_sha256'=encode(public.digest(next_image::text,'sha256'),'hex') THEN RETURN 'MINIMIZE';END IF;
 END IF;
 IF mark.kind IN('order','receipt') AND v>mark.source_version AND ((relation_name='records' AND operation='UPDATE' AND actor='commerce_financial_retention' AND (next_image-'body'-'version'-'updated_at')=(prior-'body'-'version'-'updated_at') AND v=(prior->>'version')::integer+1) OR (relation_name='record_versions' AND operation='INSERT')) THEN
  SELECT * INTO correction FROM public.financial_retention_corrections WHERE attestation_id=b.retention_id AND workspace_id=mark.workspace_id AND environment='REAL' AND record_id=rid AND record_kind=mark.kind AND after_version=v AND body_sha256=encode(public.digest((next_image->'body')::text,'sha256'),'hex');
  IF FOUND AND EXISTS(SELECT 1 FROM public.financial_retention_installations WHERE attestation_id=b.retention_id) AND (relation_name='records' OR ((next_image->>'created_at')::timestamptz=correction.created_at AND EXISTS(SELECT 1 FROM public.records r WHERE r.id=rid AND r.workspace_id=mark.workspace_id AND r.environment='REAL' AND r.kind=mark.kind AND r.version=v AND r.body=next_image->'body'))) THEN RETURN 'CORRECTION';END IF;
 END IF;
 RAISE EXCEPTION 'PRIVACY_RECORD_RESURRECTION';
END $$;
ALTER FUNCTION privacy_record_transition(jsonb,jsonb,text,text,text) OWNER TO commerce_privacy_record_eraser;
REVOKE ALL ON FUNCTION privacy_record_transition(jsonb,jsonb,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_record_transition(jsonb,jsonb,text,text,text) TO commerce_api,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance,commerce_results,commerce_results_reader,commerce_ai,commerce_number_lab,commerce_financial_retention;

CREATE FUNCTION privacy_minimized_record_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog SET TimeZone='UTC' AS $$
BEGIN
 PERFORM public.privacy_record_transition(CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,TG_TABLE_NAME,TG_OP,current_user);
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER aa_privacy_minimized_record_guard BEFORE INSERT OR UPDATE OR DELETE ON records FOR EACH ROW EXECUTE FUNCTION privacy_minimized_record_guard();
CREATE TRIGGER aa_privacy_minimized_version_guard BEFORE INSERT OR UPDATE OR DELETE ON record_versions FOR EACH ROW EXECUTE FUNCTION privacy_minimized_record_guard();

CREATE FUNCTION privacy_record_snapshot_skip(prior jsonb,next_image jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE mark public.privacy_minimized_records%ROWTYPE;BEGIN
 SELECT * INTO mark FROM public.privacy_minimized_records WHERE record_id=(next_image->>'id')::uuid;
 IF NOT FOUND OR (next_image->>'version')::integer>mark.source_version THEN RETURN false;END IF;
 RETURN public.privacy_record_transition(prior,next_image,'records','UPDATE','commerce_privacy_record_eraser')='MINIMIZE';
END $$;
ALTER FUNCTION privacy_record_snapshot_skip(jsonb,jsonb) OWNER TO commerce_privacy_record_eraser;
REVOKE ALL ON FUNCTION privacy_record_snapshot_skip(jsonb,jsonb) FROM PUBLIC;
-- The existing SECURITY DEFINER snapshot owner calls this read-only predicate.
-- Preserve that native owner; do not assume superuser or change memberships.
DO $$ DECLARE native_owner text;BEGIN
 SELECT pg_get_userbyid(proowner) INTO STRICT native_owner FROM pg_proc WHERE oid='public.snapshot_record()'::regprocedure;
 EXECUTE format('GRANT EXECUTE ON FUNCTION public.privacy_record_snapshot_skip(jsonb,jsonb),public.privacy_record_transition(jsonb,jsonb,text,text,text) TO %I',native_owner);
END $$;

CREATE FUNCTION apply_privacy_record_minimization(batch uuid,lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE b public.privacy_record_batches%ROWTYPE;j public.privacy_jobs%ROWTYPE;e jsonb;h jsonb;result_value jsonb;existing jsonb;confirmed jsonb;total_count integer:=0;
BEGIN
 SELECT * INTO STRICT b FROM public.privacy_record_batches WHERE id=batch AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL';
 IF public.privacy_record_admission(batch) IS DISTINCT FROM lease THEN RAISE EXCEPTION 'PRIVACY_RECORD_ADMISSION_REQUIRED';END IF;
 j:=public.privacy_record_authority(b.id,lease);
 SELECT result INTO existing FROM public.privacy_record_completions WHERE batch_id=batch;
 IF FOUND THEN RETURN existing||jsonb_build_object('status','NO_EFFECT');END IF;
 PERFORM public.prepare_privacy_record_minimization(b.id,b.retention_id,lease);
 FOR e IN SELECT value FROM jsonb_array_elements(b.manifest) LOOP
  INSERT INTO public.privacy_minimized_records(record_id,workspace_id,kind,batch_id,journey_id,source_version) VALUES((e->>'record_id')::uuid,b.workspace_id,e->>'kind',batch,b.journey_id,(e->>'version')::integer);
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(b.manifest) LOOP
  FOR h IN SELECT value FROM jsonb_array_elements(e->'history') LOOP
   UPDATE public.record_versions SET body=h->'body' WHERE record_id=(e->>'record_id')::uuid AND version=(h->>'version')::integer AND workspace_id=b.workspace_id AND environment='REAL';
   IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_RECORD_HISTORY_CHANGED';END IF;total_count:=total_count+1;
  END LOOP;
  UPDATE public.records SET body=(e->'history'->((e->>'version')::integer-1))->'body' WHERE id=(e->>'record_id')::uuid AND workspace_id=b.workspace_id AND environment='REAL' AND version=(e->>'version')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_RECORD_SOURCE_CHANGED';END IF;
 END LOOP;
 confirmed:=public.confirm_financial_minimization(b.retention_id);
 IF confirmed->>'resolution' IS DISTINCT FROM 'RESOLUTION_PRESERVED' THEN RAISE EXCEPTION 'PRIVACY_RECORD_FINANCIAL_CHANGED';END IF;
 PERFORM public.privacy_record_authority(b.id,lease);PERFORM public.privacy_record_admission(batch);
 result_value:=jsonb_build_object('schema_version',1,'status','MINIMIZED','batch_id',batch,'job_id',b.id,'workspace_id',b.workspace_id,'environment','REAL','journey_id',b.journey_id,'manifest_sha256',b.manifest_sha256,'records',jsonb_array_length(b.manifest),'versions',total_count,'erasure_authorized',false);
 INSERT INTO public.privacy_record_completions(batch_id,workspace_id,journey_id,result) VALUES(batch,b.workspace_id,b.journey_id,result_value);
 RETURN result_value;
END $$;
ALTER FUNCTION apply_privacy_record_minimization(uuid,uuid) OWNER TO commerce_privacy_record_eraser;
REVOKE ALL ON FUNCTION apply_privacy_record_minimization(uuid,uuid) FROM PUBLIC;
-- Source-pinned legacy trigger extensions follow. No EXECUTE/INSERT adoption.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.guard_record()'::regprocedure AND p.prorettype='trigger'::regtype AND p.prosecdef=false AND p.proconfig IS NULL AND encode(public.digest(p.prosrc,'sha256'),'hex')='02923386200f3dba90c035944fc154f76ef3b7369fce52d2a6ed2128a98fb5b6') THEN RAISE EXCEPTION 'PRIVACY_RECORD_LEGACY_DRIFT: guard_record';END IF;END $$;

CREATE OR REPLACE FUNCTION guard_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE key text; target text; expected text; ref jsonb;
BEGIN
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

DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.snapshot_record()'::regprocedure AND p.prorettype='trigger'::regtype AND p.prosecdef=true AND p.proconfig=ARRAY['search_path=pg_catalog, public'] AND encode(public.digest(p.prosrc,'sha256'),'hex')='d45a6ae4fbdb69e286fe8c8709616f2cadb3c8234b22e9b1b568d21166b767a9') THEN RAISE EXCEPTION 'PRIVACY_RECORD_LEGACY_DRIFT: snapshot_record';END IF;END $$;

CREATE OR REPLACE FUNCTION snapshot_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='UPDATE' AND public.privacy_record_snapshot_skip(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
 INSERT INTO record_versions(record_id,workspace_id,environment,kind,version,body) VALUES(NEW.id,NEW.workspace_id,NEW.environment,NEW.kind,NEW.version,NEW.body); RETURN NEW; END $$;

DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.immutable_row()'::regprocedure AND p.prorettype='trigger'::regtype AND p.prosecdef=false AND p.proconfig IS NULL AND encode(public.digest(p.prosrc,'sha256'),'hex')='92992ab9ad7f97c995aabda165d79b0a34417708191f34e35a04171d66d47d62') THEN RAISE EXCEPTION 'PRIVACY_RECORD_LEGACY_DRIFT: immutable_row';END IF;END $$;

CREATE OR REPLACE FUNCTION immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='record_versions' AND TG_OP='UPDATE' AND current_user='commerce_privacy_record_eraser' AND public.privacy_record_transition(to_jsonb(OLD),to_jsonb(NEW),'record_versions',TG_OP,current_user)='MINIMIZE' THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='record_versions' AND TG_OP='UPDATE' AND retention_context_valid() THEN RETURN NEW; END IF; RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END $$;

DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.guard_retained_asset_references()'::regprocedure AND p.prorettype='trigger'::regtype AND p.prosecdef=false AND p.proconfig IS NULL AND encode(public.digest(p.prosrc,'sha256'),'hex')='d6e634bb5fff021fe3a7b8fb693fe6a74a7add41508283a82b5e6fd8faca5d37') THEN RAISE EXCEPTION 'PRIVACY_RECORD_LEGACY_DRIFT: guard_retained_asset_references';END IF;END $$;

CREATE OR REPLACE FUNCTION guard_retained_asset_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text; asset_state text;
BEGIN
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
