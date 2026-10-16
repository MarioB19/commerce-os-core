-- Requires024. Closure evidence and minimal custody; no erasure authority.
GRANT SELECT ON record_versions,commands,domain_events TO commerce_result_custody;
CREATE TABLE privacy_closure_receipts(
 workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 journey_id uuid NOT NULL,journey_kind text NOT NULL DEFAULT 'conversation' CHECK(journey_kind='conversation'),
 closure_version integer NOT NULL CHECK(closure_version>=2),closed_at timestamptz NOT NULL,
 closure_source_hash text NOT NULL CHECK(closure_source_hash ~ '^[a-f0-9]{64}$'),
 closure_identity_hash text NOT NULL CHECK(closure_identity_hash ~ '^[a-f0-9]{64}$'),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,journey_id,closure_version),
 FOREIGN KEY(journey_id,workspace_id,environment,journey_kind) REFERENCES records(id,workspace_id,environment,kind)
);
ALTER TABLE privacy_closure_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_closure_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_closure_scope ON privacy_closure_receipts USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
CREATE POLICY privacy_closure_scope_guard ON privacy_closure_receipts AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
REVOKE ALL ON privacy_closure_receipts FROM PUBLIC,commerce_api,commerce_results,commerce_results_reader,commerce_automation,commerce_ingress,commerce_channel;
GRANT SELECT,INSERT ON privacy_closure_receipts TO commerce_result_custody;
CREATE TRIGGER immutable_privacy_closure_receipts BEFORE UPDATE OR DELETE ON privacy_closure_receipts FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE FUNCTION privacy_closure_proof(target uuid,expected_version integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');c record;proof record;
 observed timestamptz:=clock_timestamp();history_count bigint;last_open integer;invalid_history boolean;
 execution_kind text;ttl integer;source_hash text;last_change timestamptz;matches integer;
BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION 'PRIVACY_CONTEXT_REQUIRED';END IF;
 SELECT version,body INTO c FROM public.records WHERE workspace_id=w AND environment='REAL' AND kind='conversation' AND id=target;
 IF NOT FOUND OR c.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'PRIVACY_SOURCE_CHANGED';END IF;
 source_hash:=encode(public.digest(c.body::text,'sha256'),'hex');
 IF c.body->>'privacy_erased'='true' THEN RETURN jsonb_build_object('verified',false,'reason','ALREADY_ERASED','source_version',c.version,'source_sha256',source_hash);END IF;
 -- A body date and a FINISHED workflow are not authenticated closure evidence.
 IF c.body->>'status' IS DISTINCT FROM 'CLOSED' THEN RETURN jsonb_build_object('verified',false,'reason','NOT_CLOSED','source_version',c.version,'source_sha256',source_hash);END IF;
 SELECT count(*),max(v.version) FILTER(WHERE v.body->>'status' IS DISTINCT FROM 'CLOSED'),max(v.created_at),
  COALESCE(bool_or(v.workspace_id IS DISTINCT FROM w OR v.environment IS DISTINCT FROM 'REAL' OR v.kind IS DISTINCT FROM 'conversation' OR v.version<1 OR v.version>c.version OR v.created_at>observed OR (v.previous_at IS NOT NULL AND v.created_at<v.previous_at)),false)
 INTO history_count,last_open,last_change,invalid_history
 FROM(SELECT r.*,lag(r.created_at) OVER(ORDER BY r.version) previous_at FROM public.record_versions r WHERE r.record_id=target)v;
 IF invalid_history OR history_count<>c.version OR NOT EXISTS(SELECT 1 FROM public.record_versions v WHERE v.record_id=target AND v.version=c.version AND v.body=c.body) THEN
  RETURN jsonb_build_object('verified',false,'reason','HISTORY_INCOMPLETE','source_version',c.version,'source_sha256',source_hash);
 END IF;
 -- A prior authenticated receipt survives the separate 90-day log retention.
 -- The closed record version and its exact identity must still match; reopening
 -- or edited closure fields never borrow a receipt from an earlier episode.
 SELECT count(*) INTO matches FROM public.privacy_closure_receipts r
 JOIN public.record_versions v ON v.record_id=r.journey_id AND v.version=r.closure_version
 WHERE r.workspace_id=w AND r.environment='REAL' AND r.journey_id=target AND r.closure_version>COALESCE(last_open,0)
  AND r.closure_source_hash=encode(public.digest(v.body::text,'sha256'),'hex') AND r.closed_at=v.created_at
  AND r.closure_identity_hash=encode(public.digest(jsonb_build_array(c.body->>'closed_at',c.body->>'closed_by',c.body->>'closed_reason')::text,'sha256'),'hex');
 IF matches>1 THEN RETURN jsonb_build_object('verified',false,'reason','CLOSURE_AMBIGUOUS','source_version',c.version,'source_sha256',source_hash);END IF;
 IF matches=1 THEN
  SELECT v.version,v.created_at INTO proof FROM public.privacy_closure_receipts r JOIN public.record_versions v ON v.record_id=r.journey_id AND v.version=r.closure_version
  WHERE r.workspace_id=w AND r.environment='REAL' AND r.journey_id=target AND r.closure_version>COALESCE(last_open,0)
   AND r.closure_source_hash=encode(public.digest(v.body::text,'sha256'),'hex') AND r.closed_at=v.created_at
   AND r.closure_identity_hash=encode(public.digest(jsonb_build_array(c.body->>'closed_at',c.body->>'closed_by',c.body->>'closed_reason')::text,'sha256'),'hex');
 ELSE
 -- The command result, immutable event and record snapshot must have committed
 -- in the same transaction. now() is the database transaction time in all three.
 -- App wall-clock closed_at is matched for identity, never used as the TTL clock.
 SELECT count(*) INTO matches FROM public.record_versions v
 JOIN public.domain_events e ON e.workspace_id=w AND e.environment='REAL' AND e.aggregate_id=target::text AND e.event_type='conversation.closed' AND e.recorded_at=v.created_at AND e.occurred_at=e.recorded_at AND e.actor->>'type'='automation'
 JOIN public.commands cmd ON cmd.id::text=e.causation_id AND cmd.workspace_id=w AND cmd.environment='REAL' AND cmd.kind='conversation_command' AND cmd.resource_id=target::text AND cmd.status='APPLIED' AND cmd.payload->>'type'='close_conversation' AND cmd.result->>'status'='CLOSED' AND cmd.result->>'conversation_id'=target::text AND cmd.updated_at=v.created_at AND cmd.created_at<=cmd.updated_at
 WHERE v.record_id=target AND v.version>COALESCE(last_open,0) AND v.version>=2 AND v.body->>'status'='CLOSED'
  AND v.body->>'closed_at'=c.body->>'closed_at' AND v.body->>'closed_by'=cmd.actor_id AND c.body->>'closed_by'=cmd.actor_id
  AND e.payload->>'actor_id'=cmd.actor_id AND e.payload->>'reason'=cmd.payload->>'reason' AND v.body->>'closed_reason'=cmd.payload->>'reason' AND c.body->>'closed_reason'=cmd.payload->>'reason'
  AND length(cmd.payload->>'reason')>0;
 IF matches<>1 THEN RETURN jsonb_build_object('verified',false,'reason','CLOSURE_UNVERIFIED','source_version',c.version,'source_sha256',source_hash);END IF;
 SELECT v.version,v.created_at INTO proof FROM public.record_versions v
 JOIN public.domain_events e ON e.workspace_id=w AND e.environment='REAL' AND e.aggregate_id=target::text AND e.event_type='conversation.closed' AND e.recorded_at=v.created_at AND e.occurred_at=e.recorded_at AND e.actor->>'type'='automation'
 JOIN public.commands cmd ON cmd.id::text=e.causation_id AND cmd.workspace_id=w AND cmd.environment='REAL' AND cmd.kind='conversation_command' AND cmd.resource_id=target::text AND cmd.status='APPLIED' AND cmd.payload->>'type'='close_conversation' AND cmd.result->>'status'='CLOSED' AND cmd.result->>'conversation_id'=target::text AND cmd.updated_at=v.created_at AND cmd.created_at<=cmd.updated_at
 WHERE v.record_id=target AND v.version>COALESCE(last_open,0) AND v.version>=2 AND v.body->>'status'='CLOSED'
  AND v.body->>'closed_at'=c.body->>'closed_at' AND v.body->>'closed_by'=cmd.actor_id AND c.body->>'closed_by'=cmd.actor_id
  AND e.payload->>'actor_id'=cmd.actor_id AND e.payload->>'reason'=cmd.payload->>'reason' AND v.body->>'closed_reason'=cmd.payload->>'reason' AND c.body->>'closed_reason'=cmd.payload->>'reason'
  AND length(cmd.payload->>'reason')>0;
 END IF;
 -- Edits may retain a closed status, but cannot swap closure identity midway.
 IF EXISTS(SELECT 1 FROM public.record_versions v WHERE v.record_id=target AND v.version>proof.version AND
  ((v.body->>'closed_at',v.body->>'closed_by',v.body->>'closed_reason') IS DISTINCT FROM (c.body->>'closed_at',c.body->>'closed_by',c.body->>'closed_reason'))) THEN
  RETURN jsonb_build_object('verified',false,'reason','CLOSURE_IDENTITY_CHANGED','source_version',c.version,'source_sha256',source_hash);
 END IF;
 execution_kind:=CASE WHEN c.body->>'commercial_classification'='TEST' OR c.body->>'is_test'='true' OR c.body ? 'number_flow_test_id' OR c.body ? 'launch_test_id' OR EXISTS(SELECT 1 FROM public.records o WHERE o.workspace_id=w AND o.environment='REAL' AND o.kind='order' AND o.body->>'conversation_id'=target::text AND o.body->>'commercial_classification'='TEST') THEN 'TEST' ELSE 'COMMERCIAL' END;
 ttl:=CASE WHEN execution_kind='TEST' THEN 30 ELSE 180 END;
 RETURN jsonb_build_object('verified',true,'policy','v7-d18-1','workspace_id',w,'environment','REAL','journey_id',target,'source_version',c.version,'source_sha256',source_hash,'closure_version',proof.version,'closed_at',proof.created_at,'due_at',proof.created_at+ttl*interval '24 hours','observed_at',observed,'source_last_changed_at',last_change,'execution_kind',execution_kind);
END $$;
ALTER FUNCTION privacy_closure_proof(uuid,integer) OWNER TO commerce_result_custody;
REVOKE ALL ON FUNCTION privacy_closure_proof(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_closure_proof(uuid,integer) TO commerce_results;

-- Run before log expiry for closed journeys, and during erasure preparation.
-- Caller cannot submit a date, actor, proof hash or TTL; every value comes from
-- the canonical command/event/version or an already authenticated receipt.
CREATE FUNCTION capture_privacy_closure(target uuid,expected_version integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');p jsonb;v record;s text;i text;r public.privacy_closure_receipts%ROWTYPE;added integer;
BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION 'PRIVACY_CONTEXT_REQUIRED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('["result-projection-v1",'||to_json(w)::text||']',0));
 p:=public.privacy_closure_proof(target,expected_version);
 IF p->>'verified' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PRIVACY_CLOSURE_UNVERIFIED';END IF;
 SELECT body,created_at INTO v FROM public.record_versions WHERE record_id=target AND workspace_id=w AND environment='REAL' AND kind='conversation' AND version=(p->>'closure_version')::integer;
 IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_SOURCE_CHANGED';END IF;
 s:=encode(public.digest(v.body::text,'sha256'),'hex');i:=encode(public.digest(jsonb_build_array(v.body->>'closed_at',v.body->>'closed_by',v.body->>'closed_reason')::text,'sha256'),'hex');
 INSERT INTO public.privacy_closure_receipts(workspace_id,journey_id,closure_version,closed_at,closure_source_hash,closure_identity_hash)
 VALUES(w,target,(p->>'closure_version')::integer,v.created_at,s,i) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS added=ROW_COUNT;
 SELECT * INTO r FROM public.privacy_closure_receipts WHERE workspace_id=w AND environment='REAL' AND journey_id=target AND closure_version=(p->>'closure_version')::integer;
 IF (r.closed_at,r.closure_source_hash,r.closure_identity_hash) IS DISTINCT FROM (v.created_at,s,i) THEN RAISE EXCEPTION 'PRIVACY_CLOSURE_RECEIPT_CONFLICT';END IF;
 RETURN p||jsonb_build_object('receipt_status',CASE WHEN added=1 THEN 'CAPTURED' ELSE 'NO_EFFECT' END);
END $$;
ALTER FUNCTION capture_privacy_closure(uuid,integer) OWNER TO commerce_result_custody;
REVOKE ALL ON FUNCTION capture_privacy_closure(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION capture_privacy_closure(uuid,integer) TO commerce_results;
