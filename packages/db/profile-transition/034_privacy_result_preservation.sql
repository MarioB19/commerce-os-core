-- Requires031 and024/027. Preservation only: no record/file erasure authority.
CREATE TABLE privacy_result_seals(
 workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 job_id uuid NOT NULL REFERENCES privacy_jobs(id),journey_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('COHORT','FINANCIAL','AI')),source_id uuid NOT NULL,
 source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 source_sha256 text CHECK(source_sha256~'^[a-f0-9]{64}$'),
 projection_sha256 text NOT NULL CHECK(projection_sha256~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,kind,source_id),
 FOREIGN KEY(workspace_id,job_id) REFERENCES privacy_jobs(workspace_id,id),
 CHECK((kind='AI')=(source_sha256 IS NOT NULL))
);
ALTER TABLE privacy_result_seals ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_result_seals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON privacy_result_seals FROM PUBLIC;
GRANT SELECT,INSERT ON privacy_result_seals TO commerce_privacy_job_owner;
CREATE POLICY privacy_result_scope ON privacy_result_seals TO commerce_privacy_job_owner
 USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL')
 WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
CREATE TRIGGER immutable_privacy_result_seals BEFORE UPDATE OR DELETE ON privacy_result_seals FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE privacy_result_preservations(
 job_id uuid PRIMARY KEY,workspace_id text NOT NULL,lease_id uuid NOT NULL,backend_pid integer NOT NULL,transaction_id text NOT NULL,
 generation bigint NOT NULL,source_watermark timestamptz NOT NULL,completed_at timestamptz NOT NULL,
 aggregate_sha256 text NOT NULL CHECK(aggregate_sha256~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,job_id),FOREIGN KEY(workspace_id,job_id) REFERENCES privacy_jobs(workspace_id,id)
);
CREATE TABLE privacy_result_confirmations(
 job_id uuid PRIMARY KEY,workspace_id text NOT NULL,aggregate_sha256 text NOT NULL CHECK(aggregate_sha256~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(workspace_id,job_id) REFERENCES privacy_result_preservations(workspace_id,job_id)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['privacy_result_preservations','privacy_result_confirmations'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);EXECUTE format('GRANT SELECT,INSERT ON public.%I TO commerce_privacy_job_owner',t);
  EXECUTE format('CREATE POLICY privacy_result_private ON public.%I TO commerce_privacy_job_owner USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),''''))',t);
  EXECUTE format('CREATE TRIGGER immutable_privacy_result_receipt BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.immutable_row()',t);
 END LOOP;
END $$;
GRANT SELECT ON result_metric_daily,result_projection_state TO commerce_privacy_job_owner;
GRANT UPDATE(phase) ON result_projection_state TO commerce_privacy_job_owner;
CREATE POLICY privacy_result_totals_reader ON result_metric_daily FOR SELECT TO commerce_privacy_job_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
CREATE POLICY privacy_result_state_authority ON result_projection_state TO commerce_privacy_job_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
GRANT SELECT ON ai_attempts,result_projection_sources,result_financial_context TO commerce_privacy_job_owner;
CREATE POLICY privacy_result_ai_reader ON ai_attempts FOR SELECT TO commerce_privacy_job_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
CREATE POLICY privacy_result_projection_reader ON result_projection_sources FOR SELECT TO commerce_privacy_job_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
CREATE POLICY privacy_result_context_reader ON result_financial_context FOR SELECT TO commerce_privacy_job_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');

CREATE FUNCTION privacy_result_context(token uuid,lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE w text:=public.privacy_authority_context();j public.privacy_jobs%ROWTYPE;r public.records%ROWTYPE;a jsonb;sources jsonb;financial boolean;required boolean;
BEGIN
 PERFORM public.privacy_require_writer_fences();PERFORM public.privacy_writer_fence_assert(lease);
 SELECT * INTO STRICT j FROM public.privacy_jobs WHERE id=token AND workspace_id=w;
 a:=public.privacy_job_authority(j.journey_id,j.backup_id);
 IF a IS DISTINCT FROM j.manifest->'authority' THEN RAISE EXCEPTION 'PRIVACY_RESULT_AUTHORITY_CHANGED';END IF;
 SELECT * INTO STRICT r FROM public.records WHERE id=j.journey_id AND workspace_id=w AND environment='REAL' AND kind='conversation';
 IF r.version<>j.source_version OR encode(public.digest(r.body::text,'sha256'),'hex')<>j.manifest->>'source_sha256' THEN RAISE EXCEPTION 'PRIVACY_RESULT_SOURCE_CHANGED';END IF;
 IF EXISTS(SELECT 1 FROM public.ai_attempts x WHERE x.workspace_id=w AND x.environment='REAL' AND x.conversation_id=j.journey_id AND(x.state NOT IN('SUCCEEDED','REJECTED') OR x.settled_at IS NULL)) THEN RAISE EXCEPTION 'PRIVACY_RESULT_AI_UNSETTLED';END IF;
 IF EXISTS(SELECT 1 FROM public.ai_attempts x WHERE x.workspace_id=w AND x.environment='REAL' AND x.conversation_id=j.journey_id AND greatest(x.created_at,x.intent_at,x.settled_at)>(a->>'backup_snapshot_at')::timestamptz) THEN RAISE EXCEPTION 'PRIVACY_RESULT_AI_NEWER_THAN_BACKUP';END IF;
 required:=j.manifest->>'execution_kind'='COMMERCIAL' AND NOT EXISTS(SELECT 1 FROM public.records x WHERE x.workspace_id=w AND x.environment='REAL' AND x.kind='order' AND x.body->>'conversation_id'=j.journey_id::text AND x.body->>'commercial_classification'='TEST');
 financial:=required AND EXISTS(SELECT 1 FROM public.records x WHERE x.workspace_id=w AND x.environment='REAL' AND x.kind IN('order','receipt') AND x.body->>'conversation_id'=j.journey_id::text);
 SELECT COALESCE(jsonb_agg(jsonb_build_object('kind','AI','source_id',x.attempt_id,'required',true) ORDER BY x.attempt_id),'[]') INTO sources FROM public.ai_attempts x WHERE x.workspace_id=w AND x.environment='REAL' AND x.conversation_id=j.journey_id AND NOT x.is_test AND x.intent_at IS NOT NULL;
 IF jsonb_array_length(sources)>10000 THEN RAISE EXCEPTION 'PRIVACY_RESULT_BOUND';END IF;
 sources:=jsonb_build_array(jsonb_build_object('kind','COHORT','source_id',j.journey_id,'required',required),jsonb_build_object('kind','FINANCIAL','source_id',j.journey_id,'required',required))||sources;
 PERFORM public.privacy_writer_fence_assert(lease);
 RETURN jsonb_build_object('job_id',j.id,'workspace_id',w,'journey_id',j.journey_id,'source_version',j.source_version,'source_sha256',j.manifest->>'source_sha256','manifest_sha256',j.manifest_sha256,'financial_context',financial,'sources',sources);
END $$;
ALTER FUNCTION privacy_result_context(uuid,uuid) OWNER TO commerce_privacy_job_owner;
REVOKE ALL ON FUNCTION privacy_result_context(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_result_context(uuid,uuid) TO commerce_privacy_job_worker;

CREATE FUNCTION privacy_result_aggregate_hash() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog SET TimeZone='UTC' AS $$
 SELECT encode(public.digest(COALESCE(jsonb_agg(jsonb_build_array(grain_hash,grain,counters,latencies) ORDER BY grain_hash),'[]')::text,'sha256'),'hex') FROM public.result_metric_daily WHERE workspace_id=public.privacy_authority_context() AND environment='REAL'
$$;
ALTER FUNCTION privacy_result_aggregate_hash() OWNER TO commerce_privacy_job_owner;
REVOKE ALL ON FUNCTION privacy_result_aggregate_hash() FROM PUBLIC;
CREATE FUNCTION begin_privacy_result_preservation(token uuid,lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE c jsonb;r public.result_projection_state%ROWTYPE;p public.privacy_result_preservations%ROWTYPE;w text:=public.privacy_authority_context();h text;
BEGIN
 c:=public.privacy_result_context(token,lease);
 SELECT * INTO STRICT r FROM public.result_projection_state WHERE workspace_id=w AND environment='REAL' FOR UPDATE;
 IF r.phase<>'READY' OR r.source_watermark IS DISTINCT FROM transaction_timestamp() OR r.completed_at<transaction_timestamp() THEN RAISE EXCEPTION 'PRIVACY_RESULT_CURRENT_GENERATION_REQUIRED';END IF;
 h:=public.privacy_result_aggregate_hash();
 INSERT INTO public.privacy_result_preservations(job_id,workspace_id,lease_id,backend_pid,transaction_id,generation,source_watermark,completed_at,aggregate_sha256)
 VALUES(token,w,lease,pg_backend_pid(),pg_current_xact_id()::text,r.generation,r.source_watermark,r.completed_at,h) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT p FROM public.privacy_result_preservations WHERE job_id=token AND workspace_id=w;
 IF(p.lease_id,p.backend_pid,p.transaction_id,p.generation,p.source_watermark,p.completed_at,p.aggregate_sha256) IS DISTINCT FROM(lease,pg_backend_pid(),pg_current_xact_id()::text,r.generation,r.source_watermark,r.completed_at,h) THEN RAISE EXCEPTION 'PRIVACY_RESULT_PRESERVATION_CHANGED';END IF;
 RETURN jsonb_build_object('status','PREPARED','job_id',token,'manifest_sha256',c->>'manifest_sha256');
END $$;
ALTER FUNCTION begin_privacy_result_preservation(uuid,uuid) OWNER TO commerce_privacy_job_owner;
REVOKE ALL ON FUNCTION begin_privacy_result_preservation(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION begin_privacy_result_preservation(uuid,uuid) TO commerce_privacy_job_worker;

CREATE FUNCTION finish_privacy_result_preservation(token uuid,lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE p public.privacy_result_preservations%ROWTYPE;j public.privacy_jobs%ROWTYPE;r public.result_projection_state%ROWTYPE;w text:=public.privacy_authority_context();a jsonb;h text;
BEGIN
 PERFORM public.privacy_require_writer_fences();PERFORM public.privacy_writer_fence_assert(lease);
 SELECT * INTO STRICT j FROM public.privacy_jobs WHERE id=token AND workspace_id=w;
 a:=public.privacy_job_authority(j.journey_id,j.backup_id);IF a IS DISTINCT FROM j.manifest->'authority' THEN RAISE EXCEPTION 'PRIVACY_RESULT_AUTHORITY_CHANGED';END IF;
 SELECT * INTO STRICT p FROM public.privacy_result_preservations WHERE job_id=token AND workspace_id=w;
 IF(p.lease_id,p.backend_pid,p.transaction_id) IS DISTINCT FROM(lease,pg_backend_pid(),pg_current_xact_id()::text) THEN RAISE EXCEPTION 'PRIVACY_RESULT_SAME_TRANSACTION_REQUIRED';END IF;
 SELECT * INTO STRICT r FROM public.result_projection_state WHERE workspace_id=w AND environment='REAL' FOR UPDATE;
 IF(r.generation,r.source_watermark,r.completed_at) IS DISTINCT FROM(p.generation,p.source_watermark,p.completed_at) THEN RAISE EXCEPTION 'PRIVACY_RESULT_GENERATION_CHANGED';END IF;
 h:=public.privacy_result_aggregate_hash();IF h<>p.aggregate_sha256 THEN RAISE EXCEPTION 'PRIVACY_RESULT_NATIVE_DIFFERENCE';END IF;
 UPDATE public.result_projection_state SET phase='READY' WHERE workspace_id=w AND environment='REAL';
 INSERT INTO public.privacy_result_confirmations(job_id,workspace_id,aggregate_sha256) VALUES(token,w,h) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.privacy_result_confirmations WHERE workspace_id=w AND job_id=token AND aggregate_sha256=h) THEN RAISE EXCEPTION 'PRIVACY_RESULT_CONFIRMATION_CHANGED';END IF;
 PERFORM public.privacy_writer_fence_assert(lease);
 IF(a->>'valid_until')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'PRIVACY_BACKUP_UNAVAILABLE';END IF;
 RETURN jsonb_build_object('status','READY','job_id',token,'manifest_sha256',j.manifest_sha256,'generation',p.generation::text);
END $$;
ALTER FUNCTION finish_privacy_result_preservation(uuid,uuid) OWNER TO commerce_privacy_job_owner;
REVOKE ALL ON FUNCTION finish_privacy_result_preservation(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finish_privacy_result_preservation(uuid,uuid) TO commerce_privacy_job_worker;

CREATE FUNCTION confirm_privacy_result_seals(token uuid,lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE c jsonb;s jsonb;p public.result_projection_sources%ROWTYPE;previous public.privacy_result_seals%ROWTYPE;d text;h text;w text:=public.privacy_authority_context();n integer:=0;
BEGIN
 c:=public.privacy_result_context(token,lease);
 IF(c->>'financial_context')::boolean THEN
  IF NOT EXISTS(SELECT 1 FROM public.result_financial_context x WHERE x.workspace_id=w AND x.environment='REAL' AND x.journey_id=(c->>'journey_id')::uuid AND x.source_version=(c->>'source_version')::integer AND x.source_hash=c->>'source_sha256') THEN RAISE EXCEPTION 'PRIVACY_RESULT_CUSTODY_REQUIRED';END IF;
 ELSE
  FOR s IN SELECT value FROM jsonb_array_elements(c->'sources') LOOP
   d:=encode(public.digest('["result-source-v1",'||to_json(w)::text||','||to_json(s->>'kind')::text||','||to_json(s->>'source_id')::text||']','sha256'),'hex');
   SELECT * INTO p FROM public.result_projection_sources WHERE workspace_id=w AND environment='REAL' AND kind=s->>'kind' AND source_digest=d;
   IF NOT FOUND THEN IF(s->>'required')::boolean THEN RAISE EXCEPTION 'PRIVACY_RESULT_SOURCE_REQUIRED';ELSE CONTINUE;END IF;END IF;
   IF p.sealed_at IS NULL OR p.facts IS NOT NULL THEN RAISE EXCEPTION 'PRIVACY_RESULT_NOT_SEALED';END IF;
   h:=NULL;
   IF s->>'kind'='AI' THEN SELECT encode(public.digest(to_jsonb(x)::text,'sha256'),'hex') INTO STRICT h FROM public.ai_attempts x WHERE x.workspace_id=w AND x.environment='REAL' AND x.attempt_id=(s->>'source_id')::uuid AND x.conversation_id=(c->>'journey_id')::uuid;END IF;
   INSERT INTO public.privacy_result_seals(workspace_id,job_id,journey_id,kind,source_id,source_digest,source_sha256,projection_sha256)
   VALUES(w,token,(c->>'journey_id')::uuid,s->>'kind',(s->>'source_id')::uuid,d,h,p.fingerprint) ON CONFLICT DO NOTHING;
   SELECT * INTO STRICT previous FROM public.privacy_result_seals WHERE workspace_id=w AND environment='REAL' AND kind=s->>'kind' AND source_id=(s->>'source_id')::uuid;
   IF(previous.job_id,previous.journey_id,previous.source_digest,previous.source_sha256,previous.projection_sha256) IS DISTINCT FROM(token,(c->>'journey_id')::uuid,d,h,p.fingerprint) THEN RAISE EXCEPTION 'PRIVACY_RESULT_SEAL_CHANGED';END IF;
   n:=n+1;
  END LOOP;
 END IF;
 PERFORM public.privacy_writer_fence_assert(lease);
 RETURN jsonb_build_object('status','PRESERVED','job_id',token,'manifest_sha256',c->>'manifest_sha256','financial_context',(c->>'financial_context')::boolean,'sealed',n);
END $$;
ALTER FUNCTION confirm_privacy_result_seals(uuid,uuid) OWNER TO commerce_privacy_job_owner;
REVOKE ALL ON FUNCTION confirm_privacy_result_seals(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_privacy_result_seals(uuid,uuid) TO commerce_privacy_job_worker;

-- Private reader prevents a settled, sealed AI source from moving to an
-- unattributed grain when its non-financial conversation becomes a stub.
CREATE FUNCTION privacy_sealed_ai_visible(target uuid,journey uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE w text:=public.privacy_authority_context();s public.privacy_result_seals%ROWTYPE;h text;erased boolean;
BEGIN
 SELECT * INTO s FROM public.privacy_result_seals WHERE workspace_id=w AND environment='REAL' AND kind='AI' AND source_id=target;
 IF NOT FOUND THEN RETURN true;END IF;
 IF s.journey_id IS DISTINCT FROM journey THEN RAISE EXCEPTION 'PRIVACY_RESULT_AI_SCOPE_CHANGED';END IF;
 SELECT encode(public.digest(to_jsonb(x)::text,'sha256'),'hex') INTO STRICT h FROM public.ai_attempts x WHERE x.workspace_id=w AND x.environment='REAL' AND x.attempt_id=target AND x.conversation_id=journey;
 IF h IS DISTINCT FROM s.source_sha256 OR NOT EXISTS(SELECT 1 FROM public.result_projection_sources p WHERE p.workspace_id=w AND p.environment='REAL' AND p.kind='AI' AND p.source_digest=s.source_digest AND p.fingerprint=s.projection_sha256 AND p.sealed_at IS NOT NULL AND p.facts IS NULL) THEN RAISE EXCEPTION 'PRIVACY_RESULT_AI_SEAL_CHANGED';END IF;
 SELECT body->'privacy_erased'='true'::jsonb INTO STRICT erased FROM public.records WHERE workspace_id=w AND environment='REAL' AND kind='conversation' AND id=journey;
 RETURN NOT COALESCE(erased,false);
END $$;
ALTER FUNCTION privacy_sealed_ai_visible(uuid,uuid) OWNER TO commerce_privacy_job_owner;
REVOKE ALL ON FUNCTION privacy_sealed_ai_visible(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_sealed_ai_visible(uuid,uuid) TO commerce_results_reader;

-- Extend only the reviewed022 private source reader, preserving its native ACL.
DO $patch$ DECLARE source text;definition text;needle text:='WHERE a.workspace_id=w AND a.environment=''REAL'' AND a.operation_class=''OPERATION'' AND a.intent_at IS NOT NULL';BEGIN
 SELECT prosrc,pg_get_functiondef(oid) INTO STRICT source,definition FROM pg_proc WHERE oid='public.read_result_source_page(text,uuid,integer)'::regprocedure AND prosecdef AND proowner='commerce_results_reader'::regrole AND proconfig=ARRAY['search_path=pg_catalog'];
 IF encode(public.digest(source,'sha256'),'hex')<>'2501b80d8590a017b4e489d47c4a5db9a95ae914da5d23cf1e9a7fbe6a60f922' OR length(source)-length(replace(source,needle,''))<>length(needle) THEN RAISE EXCEPTION 'PRIVACY_RESULT_READER_CHANGED';END IF;
 EXECUTE replace(definition,needle,needle||' AND public.privacy_sealed_ai_visible(a.attempt_id,a.conversation_id)');
END $patch$;
