-- Requires024/025. Minimal custody before operational90d purge; no erasure authority.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_result_custody' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolinherit) THEN RAISE EXCEPTION 'COMMERCIAL_CUSTODY_OWNER_REQUIRED';END IF;
END $$;
CREATE TABLE commercial_resolution_receipts(
 workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 journey_id uuid NOT NULL,journey_kind text NOT NULL DEFAULT 'conversation' CHECK(journey_kind='conversation'),
 order_id uuid NOT NULL,order_kind text NOT NULL DEFAULT 'order' CHECK(order_kind='order'),
 proof_kind text NOT NULL CHECK(proof_kind IN('PAYMENT','RECONCILIATION','DELIVERY')),source_id uuid NOT NULL,
 source_revision bigint NOT NULL CHECK(source_revision>0),source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 terms_hash text NOT NULL CHECK(terms_hash ~ '^[a-f0-9]{64}$'),authority_hash text NOT NULL CHECK(authority_hash ~ '^[a-f0-9]{64}$'),
 proved_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,order_id,proof_kind,source_id,source_hash,terms_hash,authority_hash),
 FOREIGN KEY(order_id,workspace_id,environment,order_kind) REFERENCES records(id,workspace_id,environment,kind),
 FOREIGN KEY(journey_id,workspace_id,environment,journey_kind) REFERENCES records(id,workspace_id,environment,kind),
 CHECK(proved_at<=captured_at AND expires_at=((proved_at AT TIME ZONE 'UTC')+interval '5 years') AT TIME ZONE 'UTC')
);
ALTER TABLE commercial_resolution_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_resolution_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_resolution_scope ON commercial_resolution_receipts USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=current_setting('app.environment',true)) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=current_setting('app.environment',true));
CREATE POLICY commercial_resolution_guard ON commercial_resolution_receipts AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=current_setting('app.environment',true)) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=current_setting('app.environment',true));
REVOKE ALL ON commercial_resolution_receipts FROM PUBLIC,commerce_api,commerce_results,commerce_results_reader,commerce_automation,commerce_ingress,commerce_channel;
GRANT SELECT,INSERT ON commercial_resolution_receipts TO commerce_result_custody;
CREATE TRIGGER immutable_commercial_resolution_receipts BEFORE UPDATE OR DELETE ON commercial_resolution_receipts FOR EACH ROW EXECUTE FUNCTION immutable_row();
GRANT SELECT ON records,record_versions,payment_contributions,commands,domain_events,outbox,effect_attempts TO commerce_result_custody;

-- Private current-source derivation. No hashes, clocks, statuses or authority are
-- supplied by the caller. native=false never accesses commands/events/attempts.
CREATE FUNCTION commercial_resolution_source(target uuid,proof_type text,source uuid,native boolean)
 RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');o public.records%ROWTYPE;j public.records%ROWTYPE;
 r public.records%ROWTYPE;a public.records%ROWTYPE;f public.records%ROWTYPE;
 p public.payment_contributions%ROWTYPE;e public.outbox%ROWTYPE;g public.outbox%ROWTYPE;
 terms jsonb;identity jsonb;facts jsonb;revision bigint:=1;proved timestamptz;grant_proved timestamptz;grant_required boolean;
BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' THEN RETURN NULL;END IF;
 SELECT * INTO o FROM public.records WHERE id=target AND workspace_id=w AND environment='REAL' AND kind='order';
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO j FROM public.records WHERE id::text=o.body->>'conversation_id' AND workspace_id=w AND environment='REAL' AND kind='conversation';
 IF NOT FOUND OR j.body->>'privacy_erased'='true' OR EXISTS(SELECT 1 FROM (VALUES(o.body),(j.body)) b(value) WHERE value->>'commercial_classification'='TEST' OR value->>'is_test'='true' OR value ?| ARRAY['simulation_id','number_flow_test_id','launch_test_scope_id','launch_test_id']) THEN RETURN NULL;END IF;
 SELECT jsonb_build_object('amount_minor',v.body->'amount_minor','currency',v.body->'currency','offer_snapshot',v.body->'offer_snapshot') INTO terms
 FROM public.record_versions v WHERE v.record_id=o.id AND v.workspace_id=w AND v.environment='REAL' AND v.kind='order' AND v.version=1
 AND v.body->'amount_minor'=o.body->'amount_minor' AND v.body->'currency'=o.body->'currency' AND v.body->'offer_snapshot'=o.body->'offer_snapshot';
 IF NOT FOUND OR COALESCE(o.body->>'currency','') !~ '^[A-Z]{3}$' OR COALESCE(o.body->>'amount_minor','') !~ '^(0|[1-9][0-9]*)$' OR jsonb_typeof(o.body->'offer_snapshot') IS DISTINCT FROM 'object' THEN RETURN NULL;END IF;
 identity:=jsonb_build_object('workspace_id',w,'environment','REAL','journey_id',j.id,'order_id',o.id,'order_class',COALESCE(o.body->>'commercial_classification','COMMERCIAL'),'journey_class',COALESCE(j.body->>'commercial_classification','COMMERCIAL'),'committed_at',o.body->'committed_at');
 IF proof_type='PAYMENT' THEN
  SELECT * INTO p FROM public.payment_contributions WHERE id=source AND workspace_id=w AND environment='REAL' AND order_id=o.id;
  IF NOT FOUND OR p.amount_minor<=0 OR p.currency IS DISTINCT FROM o.body->>'currency' THEN RETURN NULL;END IF;
  SELECT * INTO r FROM public.records WHERE id=p.receipt_id AND workspace_id=w AND environment='REAL' AND kind='receipt';
  IF NOT FOUND OR r.body->>'status' IS DISTINCT FROM 'APPROVED' OR r.body->>'commercial_classification' IN('FALSE','TEST') OR r.body->>'duplicate_of' IS NOT NULL OR r.body->>'conversation_id' IS DISTINCT FROM j.id::text OR r.body->'extraction'->>'amount_minor' IS DISTINCT FROM p.amount_minor::text OR COALESCE(r.body->'extraction'->>'currency',o.body->>'currency') IS DISTINCT FROM p.currency THEN RETURN NULL;END IF;
  SELECT * INTO a FROM public.records WHERE id::text=r.body->>'asset_id' AND workspace_id=w AND environment='REAL' AND kind='asset';
  IF NOT FOUND OR a.body->>'status' IS DISTINCT FROM 'READY' OR COALESCE(length(a.body->>'storage_key'),0)=0 OR a.body->>'sha256' IS DISTINCT FROM p.evidence_sha256 THEN RETURN NULL;END IF;
  revision:=p.revision;
  facts:=jsonb_build_object('contribution_id',p.id,'revision',p.revision,'receipt_id',r.id,'amount_minor',p.amount_minor::text,'currency',p.currency,'evidence_sha256',p.evidence_sha256,'asset_id',a.id,'provenance',p.provenance,'effective_at',p.effective_at);
  IF native THEN
   SELECT min(d.recorded_at) INTO proved FROM public.domain_events d WHERE d.workspace_id=w AND d.environment='REAL' AND d.aggregate_id=o.id::text AND d.event_type IN('sale.recognized','sale.contribution_corrected') AND d.causation_id=p.provenance->>'cause' AND d.payload->>'contribution_id'=p.id::text AND d.payload->>'receipt_id'=p.receipt_id::text AND d.payload->>'revision'=p.revision::text AND d.payload->>'amount_minor'=p.amount_minor::text AND d.payload->>'currency'=p.currency;
  END IF;
 ELSIF proof_type='RECONCILIATION' THEN
  IF o.body->'reconciliation'->>'command_id' IS DISTINCT FROM source::text OR COALESCE(o.body->>'reconciled_amount_minor','') !~ '^[1-9][0-9]*$' OR o.body->>'reconciled_currency' IS DISTINCT FROM o.body->>'currency' THEN RETURN NULL;END IF;
  SELECT * INTO a FROM public.records WHERE id::text=o.body->'reconciliation'->>'evidence_asset_id' AND workspace_id=w AND environment='REAL' AND kind='asset';
  IF NOT FOUND OR a.body->>'status' IS DISTINCT FROM 'READY' OR COALESCE(length(a.body->>'storage_key'),0)=0 OR COALESCE(a.body->>'sha256','') !~ '^[a-f0-9]{64}$' THEN RETURN NULL;END IF;
  facts:=jsonb_build_object('command_id',source,'amount_minor',o.body->'reconciled_amount_minor','currency',o.body->'reconciled_currency','reconciliation',o.body->'reconciliation','evidence_asset_id',a.id,'evidence_sha256',a.body->'sha256');
  IF native THEN
   SELECT min(d.recorded_at) INTO proved FROM public.commands c JOIN public.domain_events d ON d.workspace_id=c.workspace_id AND d.environment=c.environment AND d.aggregate_id=j.id::text AND d.event_type='order.reconciled' AND d.causation_id=c.id::text AND d.recorded_at=c.updated_at
   WHERE c.id=source AND c.workspace_id=w AND c.environment='REAL' AND c.kind='order_reconcile' AND c.resource_id=o.id::text AND c.status='APPLIED' AND c.actor_id=o.body->'reconciliation'->>'actor_id' AND c.payload->>'amount_minor'=o.body->>'reconciled_amount_minor' AND c.payload->>'currency'=o.body->>'reconciled_currency' AND c.payload->>'evidence_asset_id'=a.id::text AND c.payload->>'reason'=o.body->'reconciliation'->>'reason' AND c.result->>'order_id'=o.id::text AND c.result->>'status'='RECONCILED'
   AND d.payload->>'order_id'=o.id::text AND d.payload->>'amount_minor'=o.body->>'reconciled_amount_minor' AND d.payload->>'currency'=o.body->>'reconciled_currency' AND d.payload->>'evidence_asset_id'=a.id::text AND d.payload->>'actor_id'=c.actor_id;
  END IF;
 ELSIF proof_type='DELIVERY' THEN
  SELECT * INTO f FROM public.records WHERE id=source AND workspace_id=w AND environment='REAL' AND kind='fulfillment' AND body->>'order_id'=o.id::text AND body->>'conversation_id'=j.id::text;
  IF NOT FOUND THEN RETURN NULL;END IF;
  SELECT * INTO a FROM public.records WHERE id::text=f.body->>'asset_id' AND workspace_id=w AND environment='REAL' AND kind='asset';
  IF NOT FOUND OR jsonb_typeof(a.body->'kind') IS DISTINCT FROM 'string' THEN RETURN NULL;END IF;
  SELECT * INTO e FROM public.outbox WHERE id::text=f.body->>'effect_id' AND workspace_id=w AND environment='REAL' AND conversation_id=j.id::text;
  IF NOT FOUND OR e.status NOT IN('DELIVERED','READ') OR f.body->>'status' IS DISTINCT FROM e.status OR COALESCE(length(e.provider_message_id),0)=0 OR e.payload->>'fulfillment_id' IS DISTINCT FROM f.id::text THEN RETURN NULL;END IF;
  grant_required:=(a.body->>'kind'='access' AND a.body->>'adapter' IN('webhook','link')) OR f.body->>'grant_effect_id' IS NOT NULL;
  facts:=jsonb_build_object('fulfillment_id',f.id,'asset_id',a.id,'asset_kind',a.body->'kind','asset_adapter',a.body->'adapter','release_on',f.body->'release_on','effect_id',e.id,'config_hash',e.config_hash,'provider_hash',encode(public.digest(e.provider_message_id,'sha256'),'hex'),'confirmed_delivery',true);
  IF native THEN SELECT min(t.finished_at) INTO proved FROM public.effect_attempts t WHERE t.effect_id=e.id AND t.status IN('SENT','DELIVERED','READ') AND t.finished_at IS NOT NULL AND t.result->>'provider_message_id'=e.provider_message_id;IF proved IS NULL OR proved>clock_timestamp() THEN RETURN NULL;END IF;END IF;
  IF grant_required THEN
   SELECT * INTO g FROM public.outbox WHERE id::text=f.body->>'grant_effect_id' AND workspace_id=w AND environment='REAL' AND conversation_id=j.id::text;
   IF NOT FOUND OR e.payload->>'grant_effect_id' IS DISTINCT FROM g.id::text OR g.status NOT IN('SENT','DELIVERED','READ') OR COALESCE(length(g.provider_message_id),0)=0 OR g.payload->>'kind' IS DISTINCT FROM 'grant' OR g.payload->>'asset_id' IS DISTINCT FROM a.id::text OR g.payload->>'grant_id' IS DISTINCT FROM f.id::text OR jsonb_typeof(g.result->'access_ciphertext') IS DISTINCT FROM 'string' OR COALESCE(length(g.result->>'access_ciphertext'),0)=0 THEN RETURN NULL;END IF;
   facts:=facts||jsonb_build_object('grant_id',g.id,'grant_config_hash',g.config_hash,'grant_provider_hash',encode(public.digest(g.provider_message_id,'sha256'),'hex'),'grant_access_hash',encode(public.digest(g.result->>'access_ciphertext','sha256'),'hex'));
   IF native THEN
    SELECT min(t.finished_at) INTO grant_proved FROM public.effect_attempts t WHERE t.effect_id=g.id AND t.status IN('SENT','DELIVERED','READ') AND t.finished_at IS NOT NULL AND t.result->>'provider_message_id'=g.provider_message_id;
    IF grant_proved IS NULL OR grant_proved>clock_timestamp() THEN RETURN NULL;END IF;proved:=least(proved,grant_proved);
   END IF;
  ELSIF e.payload->>'asset_id' IS DISTINCT FROM a.id::text THEN RETURN NULL;END IF;
 ELSE RETURN NULL;
 END IF;
 IF native AND (proved IS NULL OR proved>clock_timestamp()) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('workspace_id',w,'journey_id',j.id,'order_id',o.id,'proof_kind',proof_type,'source_id',source,'source_revision',revision,'source_hash',encode(public.digest(facts::text,'sha256'),'hex'),'terms_hash',encode(public.digest(terms::text,'sha256'),'hex'),'authority_hash',encode(public.digest(identity::text,'sha256'),'hex'),'proved_at',proved);
END $$;
ALTER FUNCTION commercial_resolution_source(uuid,text,uuid,boolean) OWNER TO commerce_result_custody;
REVOKE ALL ON FUNCTION commercial_resolution_source(uuid,text,uuid,boolean) FROM PUBLIC;

CREATE FUNCTION verify_commercial_resolution(target uuid,proof_type text,source uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE s jsonb;
BEGIN
 s:=public.commercial_resolution_source(target,proof_type,source,false);IF s IS NULL THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.commercial_resolution_receipts r WHERE r.workspace_id=s->>'workspace_id' AND r.environment='REAL' AND r.order_id=target AND r.journey_id::text=s->>'journey_id' AND r.proof_kind=proof_type AND r.source_id=source AND r.source_revision=(s->>'source_revision')::bigint AND r.source_hash=s->>'source_hash' AND r.terms_hash=s->>'terms_hash' AND r.authority_hash=s->>'authority_hash' AND r.expires_at>clock_timestamp());
END $$;
ALTER FUNCTION verify_commercial_resolution(uuid,text,uuid) OWNER TO commerce_result_custody;
REVOKE ALL ON FUNCTION verify_commercial_resolution(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_commercial_resolution(uuid,text,uuid) TO commerce_automation,commerce_results;

CREATE FUNCTION capture_commercial_resolution(target uuid,proof_type text,source uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');s jsonb;n jsonb;j text;r public.commercial_resolution_receipts%ROWTYPE;proof_at timestamptz;expiry timestamptz;
BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION 'COMMERCIAL_CUSTODY_CONTEXT_REQUIRED';END IF;
 SELECT body->>'conversation_id' INTO j FROM public.records WHERE id=target AND workspace_id=w AND environment='REAL' AND kind='order';
 IF j IS NULL THEN RAISE EXCEPTION 'COMMERCIAL_CUSTODY_SOURCE_INVALID';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j,0));
 s:=public.commercial_resolution_source(target,proof_type,source,false);IF s IS NULL THEN RAISE EXCEPTION 'COMMERCIAL_CUSTODY_SOURCE_INVALID';END IF;
 SELECT * INTO r FROM public.commercial_resolution_receipts x WHERE x.workspace_id=w AND x.environment='REAL' AND x.order_id=target AND x.proof_kind=proof_type AND x.source_id=source AND x.source_hash=s->>'source_hash' AND x.terms_hash=s->>'terms_hash' AND x.authority_hash=s->>'authority_hash';
 IF FOUND THEN
  IF r.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'COMMERCIAL_CUSTODY_EXPIRED';END IF;
  RETURN jsonb_build_object('status','NO_EFFECT','proof_kind',proof_type,'source_id',source,'source_hash',r.source_hash,'proved_at',r.proved_at,'expires_at',r.expires_at);
 END IF;
 n:=public.commercial_resolution_source(target,proof_type,source,true);IF n IS NULL OR n-'proved_at' IS DISTINCT FROM s-'proved_at' THEN RAISE EXCEPTION 'COMMERCIAL_CUSTODY_NATIVE_PROOF_REQUIRED';END IF;
 proof_at:=(n->>'proved_at')::timestamptz;expiry:=((proof_at AT TIME ZONE 'UTC')+interval '5 years') AT TIME ZONE 'UTC';
 IF expiry<=clock_timestamp() THEN RAISE EXCEPTION 'COMMERCIAL_CUSTODY_EXPIRED';END IF;
 INSERT INTO public.commercial_resolution_receipts(workspace_id,journey_id,order_id,proof_kind,source_id,source_revision,source_hash,terms_hash,authority_hash,proved_at,expires_at) VALUES(w,(s->>'journey_id')::uuid,target,proof_type,source,(s->>'source_revision')::bigint,s->>'source_hash',s->>'terms_hash',s->>'authority_hash',proof_at,expiry);
 RETURN jsonb_build_object('status','CAPTURED','proof_kind',proof_type,'source_id',source,'source_hash',s->>'source_hash','proved_at',proof_at,'expires_at',expiry);
END $$;
ALTER FUNCTION capture_commercial_resolution(uuid,text,uuid) OWNER TO commerce_result_custody;
REVOKE ALL ON FUNCTION capture_commercial_resolution(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION capture_commercial_resolution(uuid,text,uuid) TO commerce_results;
