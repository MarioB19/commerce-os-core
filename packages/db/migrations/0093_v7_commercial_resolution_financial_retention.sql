-- V7 F2 cutover: Commercial resolution receipts and financial retention custody (029, 032).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/029_commercial_resolution_receipts.sql (source sha256 88d9c330e361a4c3b7a65feb82f8bbae1beab594c37e9a1d7c1e5f45ba43bb9e)
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
-- <<< end 029_commercial_resolution_receipts.sql

-- >>> promoted from packages/db/profile-transition/032_financial_retention_custody.sql (source sha256 eff500a04d4e600639fb1d4347de12e1ebb06a8fa0a434a0197aade743689711)
-- V7 F2: 1 role-existence refusal(s) and 1 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- Requires024/025/029. Prepared custody/correction ports; no purge or job authority.
DO $$ BEGIN

 PERFORM public.v7_ensure_reviewed_role('commerce_financial_retention',false);
END $$;
GRANT USAGE ON SCHEMA public TO commerce_financial_retention;
GRANT SELECT ON records,record_versions,commands,payment_contributions,outbox,commercial_resolution_receipts,privacy_closure_receipts,result_financial_context TO commerce_financial_retention;
GRANT UPDATE(body,version,updated_at) ON records TO commerce_financial_retention;
-- Read-only legacy trigger predicate, not retention plan creation or execution.
GRANT EXECUTE ON FUNCTION retention_context_valid() TO commerce_financial_retention;
GRANT UPDATE(status,result,updated_at) ON commands TO commerce_financial_retention;
GRANT EXECUTE ON FUNCTION capture_privacy_closure(uuid,integer),capture_commercial_resolution(uuid,text,uuid),verify_commercial_resolution(uuid,text,uuid) TO commerce_financial_retention;

CREATE TABLE financial_retention_attestations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 journey_id uuid NOT NULL,journey_kind text NOT NULL DEFAULT 'conversation' CHECK(journey_kind='conversation'),
 source_version integer NOT NULL CHECK(source_version>0),source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
 closure_version integer NOT NULL,closure_sha256 text NOT NULL CHECK(closure_sha256~'^[a-f0-9]{64}$'),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='array'),ledger_sha256 text NOT NULL CHECK(ledger_sha256~'^[a-f0-9]{64}$'),
 resolution jsonb NOT NULL CHECK(jsonb_typeof(resolution)='object'),proofs jsonb NOT NULL CHECK(jsonb_typeof(proofs)='array'),
 expires_at timestamptz NOT NULL,captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,environment,journey_id),UNIQUE(id,workspace_id,environment,journey_id),
 FOREIGN KEY(journey_id,workspace_id,environment,journey_kind) REFERENCES records(id,workspace_id,environment,kind),
 CHECK(expires_at>captured_at)
);
CREATE TABLE financial_retention_installations(
 attestation_id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),journey_id uuid NOT NULL,
 installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(attestation_id,workspace_id,environment,journey_id) REFERENCES financial_retention_attestations(id,workspace_id,environment,journey_id)
);
CREATE TABLE financial_retention_corrections(
 command_id uuid PRIMARY KEY,attestation_id uuid NOT NULL,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),journey_id uuid NOT NULL,
 record_id uuid NOT NULL,record_kind text NOT NULL CHECK(record_kind IN('order','receipt','fulfillment')),before_version integer NOT NULL,after_version integer NOT NULL CHECK(after_version=before_version+1),
 previous_class text NOT NULL CHECK(previous_class IN('COMMERCIAL','TEST','GENUINE','FALSE')),classification text NOT NULL CHECK(classification IN('COMMERCIAL','TEST','GENUINE','FALSE')),
 command_sha256 text NOT NULL CHECK(command_sha256~'^[a-f0-9]{64}$'),body_sha256 text NOT NULL CHECK(body_sha256~'^[a-f0-9]{64}$'),
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,environment,record_id,after_version),
 FOREIGN KEY(attestation_id,workspace_id,environment,journey_id) REFERENCES financial_retention_attestations(id,workspace_id,environment,journey_id),
 FOREIGN KEY(record_id,workspace_id,environment,record_kind) REFERENCES records(id,workspace_id,environment,kind)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['financial_retention_attestations','financial_retention_installations','financial_retention_corrections'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY retention_scope ON %I USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'') WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'')',t);
  EXECUTE format('CREATE POLICY retention_guard ON %I AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'') WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'')',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,commerce_api,commerce_automation,commerce_results,commerce_results_reader,commerce_ingress,commerce_channel,commerce_maintenance',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO commerce_financial_retention',t);
  EXECUTE format('CREATE TRIGGER immutable_retention BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_row()',t);
 END LOOP;
END $$;

-- Private projection interpreter. The caller cannot select a shape through any
-- privileged port; financial_minimum_body supplies the only two closed shapes.
CREATE FUNCTION financial_minimum_pick(value jsonb,shape jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE pair record;item jsonb;result jsonb;tag text;val text;required text;
BEGIN
 IF jsonb_typeof(shape)='object' THEN
  IF value='null'::jsonb AND shape->>'@nullable'='true' THEN RETURN value;END IF;
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'FINANCIAL_MINIMUM_INVALID';END IF;
  FOR required IN SELECT jsonb_array_elements_text(COALESCE(shape->'@required','[]')) LOOP IF NOT(value?required) THEN RAISE EXCEPTION 'FINANCIAL_MINIMUM_REQUIRED';END IF;END LOOP;
  result:='{}';FOR pair IN SELECT * FROM jsonb_each(shape) LOOP
   IF left(pair.key,1)<>'@' AND value?pair.key THEN result:=result||jsonb_build_object(pair.key,public.financial_minimum_pick(value->pair.key,pair.value));END IF;
  END LOOP;RETURN result;
 ELSIF jsonb_typeof(shape)='array' THEN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array' OR jsonb_array_length(value)>1000 THEN RAISE EXCEPTION 'FINANCIAL_MINIMUM_INVALID';END IF;
  result:='[]';FOR item IN SELECT jsonb_array_elements(value) LOOP result:=result||jsonb_build_array(public.financial_minimum_pick(item,shape->0));END LOOP;RETURN result;
 END IF;
 tag:=shape#>>'{}';IF left(tag,9)='nullable:' THEN IF value='null'::jsonb THEN RETURN value;END IF;tag:=substr(tag,10);END IF;
 val:=value#>>'{}';
 IF tag='money' THEN IF jsonb_typeof(value) IS DISTINCT FROM 'number' OR val::numeric<0 OR val::numeric>9007199254740991 OR trunc(val::numeric)<>val::numeric THEN RAISE EXCEPTION 'FINANCIAL_MINIMUM_INVALID';END IF;RETURN to_jsonb(val::numeric::bigint);
 ELSIF tag='boolean' THEN IF jsonb_typeof(value) IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'FINANCIAL_MINIMUM_INVALID';END IF;
 ELSE
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'FINANCIAL_MINIMUM_INVALID';END IF;
  IF tag='uuid' THEN IF val !~* '^([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$' THEN RAISE EXCEPTION 'FINANCIAL_MINIMUM_INVALID';END IF;
  ELSIF tag='currency' THEN IF val !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'FINANCIAL_MINIMUM_INVALID';END IF;
  ELSIF tag='sha' THEN IF val !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'FINANCIAL_MINIMUM_INVALID';END IF;
  ELSIF tag='instant' THEN IF substr(val,12,2)::integer>23 OR substr(val,15,2)::integer>59 OR substr(val,18,2)::integer>59 OR val !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN RAISE EXCEPTION 'FINANCIAL_MINIMUM_INVALID';END IF;PERFORM val::timestamptz;
  ELSIF left(tag,5)='enum:' THEN IF NOT(val=ANY(string_to_array(substr(tag,6),'|'))) THEN RAISE EXCEPTION 'FINANCIAL_MINIMUM_INVALID';END IF;
  ELSE RAISE EXCEPTION 'FINANCIAL_MINIMUM_SHAPE';END IF;
 END IF;RETURN value;
END $$;
REVOKE ALL ON FUNCTION financial_minimum_pick(jsonb,jsonb) FROM PUBLIC;
ALTER FUNCTION financial_minimum_pick(jsonb,jsonb) OWNER TO commerce_financial_retention;
CREATE FUNCTION financial_minimum_body(kind text,body jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE shape jsonb;result jsonb;common jsonb:='{"conversation_id":"uuid","product_id":"nullable:uuid","is_test":"boolean","classification_decision":{"previous":"enum:COMMERCIAL|GENUINE|FALSE|TEST","command_id":"uuid","at":"instant"}}';
BEGIN
 IF kind='order' THEN shape:=common||'{"@required":["conversation_id","amount_minor","currency","offer_snapshot"],"amount_minor":"money","currency":"currency","commercial_classification":"enum:COMMERCIAL|TEST","committed_at":"nullable:instant","offer_snapshot":{"base_amount_minor":"money","currency":"currency","payment_method":"enum:bank_transfer_receipt|payment_link","positive_payment_unlocks_all":"boolean","fulfillment":[{"@required":["asset_id","release_on"],"asset_id":"uuid","release_on":"enum:commitment_accepted|receipt_approved|reconciled","min_amount_minor":"money"}]},"reconciled_amount_minor":"money","reconciled_currency":"currency","reconciled_at":"instant","reconciliation_status":"enum:UNRECONCILED|RECONCILED","reconciliation":{"@required":["command_id","evidence_asset_id"],"command_id":"uuid","evidence_asset_id":"uuid"}}';
 ELSIF kind='receipt' THEN shape:=common||'{"@required":["conversation_id","order_id","status"],"order_id":"uuid","status":"enum:APPROVED|REJECTED|HUMAN_REVIEW","commercial_classification":"enum:COMMERCIAL|GENUINE|FALSE|TEST","duplicate_of":"nullable:uuid","asset_id":"uuid","evidence_sha256":"sha","extraction":{"@nullable":true,"amount_minor":"nullable:money","currency":"nullable:currency"},"received_at":"instant","review":{"command_id":"uuid","at":"instant"}}';
 ELSIF kind='fulfillment' THEN shape:='{"@required":["conversation_id","order_id","asset_id","release_on","status"],"conversation_id":"uuid","order_id":"uuid","asset_id":"uuid","effect_id":"uuid","grant_effect_id":"uuid","release_on":"enum:commitment_accepted|receipt_approved|reconciled","status":"enum:PROPOSED|READY|BLOCKED|SENDING|SENT|DELIVERED|READ|FAILED|CANCELLED|UNKNOWN","delivered_at":"instant","read_at":"instant","is_test":"boolean"}';
 ELSE RAISE EXCEPTION 'FINANCIAL_MINIMUM_KIND';END IF;
 result:=public.financial_minimum_pick(body,shape);
 IF kind<>'fulfillment' AND (body->'is_test'='true'::jsonb OR body->>'commercial_classification'='TEST' OR body ?| ARRAY['simulation_id','number_flow_test_id','launch_test_scope_id','launch_test_id']) THEN
  result:=result||'{"is_test":true}';IF result->>'commercial_classification' IS DISTINCT FROM 'FALSE' THEN result:=result||'{"commercial_classification":"TEST"}';END IF;
 END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION financial_minimum_body(text,jsonb) FROM PUBLIC;
ALTER FUNCTION financial_minimum_body(text,jsonb) OWNER TO commerce_financial_retention;

CREATE FUNCTION financial_retention_ledger(target uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog SET TimeZone='UTC' AS $$
 SELECT encode(public.digest(COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]')::text,'sha256'),'hex') FROM public.payment_contributions p JOIN public.records o ON o.id=p.order_id AND o.workspace_id=p.workspace_id AND o.environment=p.environment AND o.kind='order' WHERE p.workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND p.environment='REAL' AND o.body->>'conversation_id'=target::text
$$;
REVOKE ALL ON FUNCTION financial_retention_ledger(uuid) FROM PUBLIC;
ALTER FUNCTION financial_retention_ledger(uuid) OWNER TO commerce_financial_retention;

CREATE FUNCTION financial_retention_receipt(a public.financial_retention_attestations) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('schema_version',1,'receipt_uuid',a.id,'receipt_sha256',encode(public.digest(to_jsonb(a)::text,'sha256'),'hex'),'workspace_id',a.workspace_id,'environment',a.environment,'journey_id',a.journey_id,'source_version',a.source_version,'source_sha256',a.source_sha256,'coverage',a.manifest,'ledger_sha256',a.ledger_sha256,'expires_at',a.expires_at)
$$;
ALTER FUNCTION financial_retention_receipt(public.financial_retention_attestations) OWNER TO commerce_financial_retention;
REVOKE ALL ON FUNCTION financial_retention_receipt(public.financial_retention_attestations) FROM PUBLIC;
CREATE FUNCTION financial_retention_proof(o uuid,k text,s uuid,p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE r public.commercial_resolution_receipts%ROWTYPE;
BEGIN
 SELECT * INTO STRICT r FROM public.commercial_resolution_receipts WHERE workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND order_id=o AND proof_kind=k AND source_id=s AND source_hash=p->>'source_hash' AND expires_at=(p->>'expires_at')::timestamptz;
 RETURN jsonb_build_object('order_id',o,'kind',k,'source_id',s,'receipt_sha256',encode(public.digest(to_jsonb(r)::text,'sha256'),'hex'),'expires_at',r.expires_at);
END $$;
ALTER FUNCTION financial_retention_proof(uuid,text,uuid,jsonb) OWNER TO commerce_financial_retention;
REVOKE ALL ON FUNCTION financial_retention_proof(uuid,text,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION capture_financial_retention(target uuid,expected_version integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');j public.records%ROWTYPE;o public.records%ROWTYPE;r record;v record;p jsonb;cmd public.commands%ROWTYPE;
 claim jsonb;claims jsonb;entry jsonb;proof jsonb;proofs jsonb:='[]';manifest jsonb:='[]';history jsonb;resolution jsonb:='[]';minimum jsonb;
 expected_ids jsonb;actual_ids jsonb;ttl timestamptz;ledger text;previous public.financial_retention_attestations%ROWTYPE;captured_id uuid;hist_count integer;hist_bytes bigint;closure_hash text;paid numeric;reconciled numeric;
BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_CONTEXT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('["result-projection-v1",'||to_json(w)::text||']',0));PERFORM pg_advisory_xact_lock(hashtextextended(target::text,0));
 SELECT * INTO j FROM public.records WHERE id=target AND workspace_id=w AND environment='REAL' AND kind='conversation' FOR SHARE;
 IF NOT FOUND OR j.version IS DISTINCT FROM expected_version OR j.body->>'privacy_erased'='true' THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_SOURCE_CHANGED';END IF;
 SELECT * INTO previous FROM public.financial_retention_attestations WHERE workspace_id=w AND environment='REAL' AND journey_id=target;
 IF FOUND THEN
  IF previous.source_version<>expected_version THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_CAPTURE_CHANGED';END IF;
  PERFORM public.financial_retention_check(previous,'SOURCE');RETURN public.financial_retention_receipt(previous)||jsonb_build_object('status','NO_EFFECT');
 END IF;
 p:=public.capture_privacy_closure(target,expected_version);SELECT encode(public.digest(to_jsonb(x)::text,'sha256'),'hex') INTO STRICT closure_hash FROM public.privacy_closure_receipts x WHERE x.workspace_id=w AND x.environment='REAL' AND x.journey_id=target AND x.closure_version=(p->>'closure_version')::integer;ttl:=(((p->>'closed_at')::timestamptz AT TIME ZONE 'UTC')+interval '5 years') AT TIME ZONE 'UTC';
 SELECT * INTO STRICT cmd FROM public.commands c WHERE c.workspace_id=w AND c.environment='REAL' AND c.kind='conversation_command' AND c.resource_id=target::text AND c.status='APPLIED' AND c.updated_at=(p->>'closed_at')::timestamptz AND c.actor_id=j.body->>'closed_by' AND c.payload->>'type'='close_conversation' AND c.payload->>'reason'=j.body->>'closed_reason' AND c.result->>'conversation_id'=target::text AND c.result->>'status'='CLOSED';
 IF cmd.result->'commercial_resolution'->>'kind' IS DISTINCT FROM 'EXPLICIT_HUMAN_COMMERCIAL_CLOSURE' OR cmd.result->'commercial_resolution'->>'schema_version' IS DISTINCT FROM '1' OR jsonb_typeof(cmd.result->'commercial_resolution'->'orders') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_CANONICAL_RESOLUTION_REQUIRED';END IF;
 claims:=cmd.result->'commercial_resolution'->'orders';
 SELECT COALESCE(jsonb_agg(value->>'order_id' ORDER BY value->>'order_id'),'[]') INTO expected_ids FROM jsonb_array_elements(claims);
 SELECT COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]') INTO actual_ids FROM public.records WHERE workspace_id=w AND environment='REAL' AND kind='order' AND body->>'conversation_id'=target::text;
 IF expected_ids<>actual_ids THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_ORDER_COVERAGE';END IF;
 IF EXISTS(SELECT 1 FROM public.outbox WHERE workspace_id=w AND environment='REAL' AND conversation_id=target::text AND status IN('UNKNOWN','SENDING','READY','BLOCKED')) THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_EFFECT_PENDING';END IF;
 FOR o IN SELECT * FROM public.records WHERE workspace_id=w AND environment='REAL' AND kind='order' AND body->>'conversation_id'=target::text ORDER BY id FOR SHARE LOOP
  SELECT value INTO STRICT claim FROM jsonb_array_elements(claims) WHERE value->>'order_id'=o.id::text;
  IF claim->>'order_version' IS DISTINCT FROM o.version::text THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_ORDER_CHANGED';END IF;
  IF claim->>'classification'='TEST' THEN
   IF cmd.result->'commercial_resolution'->>'classification' IS DISTINCT FROM 'TEST' OR NOT(o.body->>'commercial_classification'='TEST' OR o.body->>'is_test'='true' OR o.body ?| ARRAY['simulation_id','number_flow_test_id','launch_test_scope_id','launch_test_id']) THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_TEST_MISMATCH';END IF;
  ELSIF claim->>'classification'='UNCOMMITTED' THEN
   IF o.body->>'committed_at' IS NOT NULL OR o.body?'reconciliation' OR o.body->>'sale_status'='RECOGNIZED' OR o.body->>'reconciliation_status'='RECONCILED' OR o.body->>'status' IN('COMMITTED','RECEIPT_APPROVED','RECONCILED') OR EXISTS(SELECT 1 FROM public.payment_contributions WHERE workspace_id=w AND environment='REAL' AND order_id=o.id) OR EXISTS(SELECT 1 FROM public.records WHERE workspace_id=w AND environment='REAL' AND kind='fulfillment' AND body->>'order_id'=o.id::text) THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_OBLIGATION_CHANGED';END IF;
  ELSIF claim->>'classification'='RESOLVED' THEN
   IF cmd.result->'commercial_resolution'->>'classification' IS DISTINCT FROM 'COMMERCIAL' OR claim->>'currency' IS DISTINCT FROM o.body->>'currency' OR claim->>'due_minor' IS DISTINCT FROM o.body->>'amount_minor' THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_TERMS_CHANGED';END IF;
   SELECT COALESCE(jsonb_agg(jsonb_build_object('contribution_id',id,'revision',revision,'receipt_id',receipt_id,'amount_minor',amount_minor::text) ORDER BY id),'[]') INTO actual_ids FROM public.payment_contributions WHERE workspace_id=w AND environment='REAL' AND order_id=o.id;
   SELECT COALESCE(jsonb_agg(value ORDER BY value->>'contribution_id'),'[]') INTO expected_ids FROM jsonb_array_elements(claim->'payments');
   IF actual_ids<>expected_ids THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_PAYMENT_CHANGED';END IF;
   SELECT COALESCE(sum(amount_minor),0) INTO paid FROM public.payment_contributions WHERE workspace_id=w AND environment='REAL' AND order_id=o.id;
   reconciled:=COALESCE((o.body->>'reconciled_amount_minor')::numeric,0);
   IF claim->>'paid_minor' IS DISTINCT FROM paid::text OR claim->>'reconciled_minor' IS DISTINCT FROM reconciled::text OR greatest(paid,reconciled)<(o.body->>'amount_minor')::numeric THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_OBLIGATION_CHANGED';END IF;
   FOR entry IN SELECT value FROM jsonb_array_elements(actual_ids) LOOP
    proof:=public.capture_commercial_resolution(o.id,'PAYMENT',(entry->>'contribution_id')::uuid);
    proofs:=proofs||jsonb_build_array(public.financial_retention_proof(o.id,'PAYMENT',(entry->>'contribution_id')::uuid,proof));ttl:=least(ttl,(proof->>'expires_at')::timestamptz);
   END LOOP;
   IF claim->>'reconciliation_command_id' IS DISTINCT FROM o.body->'reconciliation'->>'command_id' THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_RECONCILIATION_CHANGED';END IF;
   IF claim->>'reconciliation_command_id' IS NOT NULL THEN
    proof:=public.capture_commercial_resolution(o.id,'RECONCILIATION',(claim->>'reconciliation_command_id')::uuid);
    proofs:=proofs||jsonb_build_array(public.financial_retention_proof(o.id,'RECONCILIATION',(claim->>'reconciliation_command_id')::uuid,proof));ttl:=least(ttl,(proof->>'expires_at')::timestamptz);
   END IF;
   SELECT COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]') INTO actual_ids FROM public.records WHERE workspace_id=w AND environment='REAL' AND kind='fulfillment' AND body->>'order_id'=o.id::text;
   SELECT COALESCE(jsonb_agg(value->>'fulfillment_id' ORDER BY value->>'fulfillment_id'),'[]') INTO expected_ids FROM jsonb_array_elements(claim->'delivery');
   IF actual_ids<>expected_ids THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_DELIVERY_CHANGED';END IF;
   FOR entry IN SELECT value FROM jsonb_array_elements(claim->'delivery') LOOP
    IF NOT EXISTS(SELECT 1 FROM public.records x WHERE x.id::text=entry->>'fulfillment_id' AND x.workspace_id=w AND x.environment='REAL' AND x.kind='fulfillment' AND x.body->>'effect_id'=entry->>'effect_id' AND x.body->>'grant_effect_id' IS NOT DISTINCT FROM entry->>'grant_effect_id') THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_DELIVERY_CHANGED';END IF;
    proof:=public.capture_commercial_resolution(o.id,'DELIVERY',(entry->>'fulfillment_id')::uuid);
    proofs:=proofs||jsonb_build_array(public.financial_retention_proof(o.id,'DELIVERY',(entry->>'fulfillment_id')::uuid,proof));ttl:=least(ttl,(proof->>'expires_at')::timestamptz);
   END LOOP;
  ELSE RAISE EXCEPTION 'FINANCIAL_RETENTION_RESOLUTION_INVALID';END IF;
  resolution:=resolution||jsonb_build_array(jsonb_build_object('order_id',o.id,'classification',claim->>'classification'));
 END LOOP;
 IF (SELECT count(*) FROM public.records fr JOIN public.record_versions fv ON fv.record_id=fr.id WHERE fr.workspace_id=w AND fr.environment='REAL' AND fr.kind IN('order','receipt','fulfillment') AND fr.body->>'conversation_id'=target::text)>10000 OR (SELECT COALESCE(sum(octet_length(fv.body::text)),0) FROM public.records fr JOIN public.record_versions fv ON fv.record_id=fr.id WHERE fr.workspace_id=w AND fr.environment='REAL' AND fr.kind IN('order','receipt','fulfillment') AND fr.body->>'conversation_id'=target::text)>16777216 THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_HISTORY_BOUND';END IF;
 FOR r IN SELECT * FROM public.records WHERE workspace_id=w AND environment='REAL' AND kind IN('order','receipt','fulfillment') AND body->>'conversation_id'=target::text ORDER BY id FOR SHARE LOOP
  IF r.kind IN('receipt','fulfillment') AND NOT EXISTS(SELECT 1 FROM public.records x WHERE x.id::text=r.body->>'order_id' AND x.workspace_id=w AND x.environment='REAL' AND x.kind='order' AND x.body->>'conversation_id'=target::text) THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_RECEIPT_SCOPE';END IF;
  history:='[]';hist_count:=0;hist_bytes:=0;
  FOR v IN SELECT * FROM public.record_versions WHERE record_id=r.id ORDER BY version LOOP
   hist_count:=hist_count+1;hist_bytes:=hist_bytes+octet_length(v.body::text);IF hist_count>10000 OR hist_bytes>16777216 THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_HISTORY_BOUND';END IF;IF v.version<>hist_count OR v.workspace_id<>w OR v.environment<>'REAL' OR v.kind<>r.kind OR v.body->>'conversation_id' IS DISTINCT FROM target::text OR (r.kind IN('receipt','fulfillment') AND v.body->>'order_id' IS DISTINCT FROM r.body->>'order_id') THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_HISTORY_CHANGED';END IF;
   minimum:=public.financial_minimum_body(r.kind,v.body);
   history:=history||jsonb_build_array(jsonb_build_object('version',v.version,'source_sha256',encode(public.digest(v.body::text,'sha256'),'hex'),'minimum_sha256',encode(public.digest(minimum::text,'sha256'),'hex')));
   IF v.version=r.version AND v.body<>r.body THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_HISTORY_CHANGED';END IF;
  END LOOP;
  IF hist_count<>r.version THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_HISTORY_CHANGED';END IF;
  manifest:=manifest||jsonb_build_array(jsonb_build_object('record_id',r.id,'kind',r.kind,'version',r.version,'classification',CASE WHEN r.kind='fulfillment' THEN NULL ELSE COALESCE(minimum->>'commercial_classification',CASE WHEN r.kind='order' THEN 'COMMERCIAL' ELSE 'GENUINE' END) END,'history',history));
 END LOOP;
 ledger:=public.financial_retention_ledger(target);
 SELECT * INTO previous FROM public.financial_retention_attestations WHERE workspace_id=w AND environment='REAL' AND journey_id=target;
 IF FOUND THEN
  IF (previous.source_version,previous.source_sha256,previous.manifest,previous.ledger_sha256) IS DISTINCT FROM (expected_version,p->>'source_sha256',manifest,ledger) OR previous.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_CAPTURE_CHANGED';END IF;
  RETURN public.financial_retention_receipt(previous)||jsonb_build_object('status','NO_EFFECT');
 END IF;
 IF ttl<=clock_timestamp() THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_EXPIRED';END IF;
 INSERT INTO public.financial_retention_attestations(workspace_id,journey_id,source_version,source_sha256,closure_version,closure_sha256,manifest,ledger_sha256,resolution,proofs,expires_at)
 VALUES(w,target,expected_version,p->>'source_sha256',(p->>'closure_version')::integer,closure_hash,manifest,ledger,jsonb_build_object('command_id',cmd.id,'orders',resolution),proofs,ttl) RETURNING financial_retention_attestations.id INTO captured_id;
 SELECT * INTO STRICT previous FROM public.financial_retention_attestations x WHERE x.id=captured_id;RETURN public.financial_retention_receipt(previous)||jsonb_build_object('status','CAPTURED');
END $$;
ALTER FUNCTION capture_financial_retention(uuid,integer) OWNER TO commerce_financial_retention;
REVOKE ALL ON FUNCTION capture_financial_retention(uuid,integer) FROM PUBLIC;
-- No runtime EXECUTE. 031 must grant only its reviewed private job owner.

-- Private verifier: SOURCE before erase, MINIMUM after erase. Neither mode reads
-- assets or historical outbox/attempts/commands/events. Native receipts are immutable.
CREATE FUNCTION financial_retention_check(a public.financial_retention_attestations,mode text) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE j public.records%ROWTYPE;r public.records%ROWTYPE;v record;e jsonb;h jsonb;proof jsonb;correction public.financial_retention_corrections%ROWTYPE;
 current_ids jsonb;expected_ids jsonb;n integer;expected_hash text;changed boolean:=false;
BEGIN
 IF mode NOT IN('SOURCE','MINIMUM') OR a.workspace_id IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_CONTEXT';END IF;
 IF a.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_EXPIRED';END IF;
 SELECT * INTO j FROM public.records WHERE workspace_id=a.workspace_id AND environment='REAL' AND id=a.journey_id AND kind='conversation' FOR SHARE;
 IF NOT FOUND OR (mode='SOURCE' AND (j.version<>a.source_version OR encode(public.digest(j.body::text,'sha256'),'hex')<>a.source_sha256 OR j.body->>'privacy_erased'='true')) OR (mode='MINIMUM' AND j.body->>'privacy_erased' IS DISTINCT FROM 'true') THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_SOURCE_CHANGED';END IF;
 IF public.financial_retention_ledger(a.journey_id)<>a.ledger_sha256 THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_LEDGER_CHANGED';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.privacy_closure_receipts x WHERE x.workspace_id=a.workspace_id AND x.environment='REAL' AND x.journey_id=a.journey_id AND x.closure_version=a.closure_version AND encode(public.digest(to_jsonb(x)::text,'sha256'),'hex')=a.closure_sha256) THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_CLOSURE_CHANGED';END IF;
 FOR proof IN SELECT value FROM jsonb_array_elements(a.proofs) LOOP
  IF NOT EXISTS(SELECT 1 FROM public.commercial_resolution_receipts x WHERE x.workspace_id=a.workspace_id AND x.environment='REAL' AND x.journey_id=a.journey_id AND x.order_id::text=proof->>'order_id' AND x.proof_kind=proof->>'kind' AND x.source_id::text=proof->>'source_id' AND x.expires_at>clock_timestamp() AND encode(public.digest(to_jsonb(x)::text,'sha256'),'hex')=proof->>'receipt_sha256') THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_PROOF_CHANGED';END IF;
 END LOOP;
 SELECT COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]') INTO current_ids FROM public.records WHERE workspace_id=a.workspace_id AND environment='REAL' AND kind IN('order','receipt','fulfillment') AND body->>'conversation_id'=a.journey_id::text;
 SELECT COALESCE(jsonb_agg(value->>'record_id' ORDER BY value->>'record_id'),'[]') INTO expected_ids FROM jsonb_array_elements(a.manifest);
 IF current_ids<>expected_ids THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_RECORD_COVERAGE';END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(a.manifest) LOOP
  SELECT * INTO STRICT r FROM public.records WHERE id::text=e->>'record_id' AND workspace_id=a.workspace_id AND environment='REAL' AND kind=e->>'kind' FOR SHARE;
  IF r.version<(e->>'version')::integer OR (mode='SOURCE' AND r.version<>(e->>'version')::integer) OR (r.kind='fulfillment' AND r.version<>(e->>'version')::integer) THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_VERSION_CHANGED';END IF;
  n:=0;
  FOR v IN SELECT * FROM public.record_versions WHERE record_id=r.id ORDER BY version LOOP
   n:=n+1;
   IF v.version<>n OR v.workspace_id<>a.workspace_id OR v.environment<>'REAL' OR v.kind<>r.kind OR v.body->>'conversation_id' IS DISTINCT FROM a.journey_id::text THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_HISTORY_CHANGED';END IF;
   IF n<=(e->>'version')::integer THEN
    h:=e->'history'->(n-1);expected_hash:=h->>CASE WHEN mode='SOURCE' THEN 'source_sha256' ELSE 'minimum_sha256' END;
   ELSE
    SELECT * INTO correction FROM public.financial_retention_corrections x WHERE x.attestation_id=a.id AND x.workspace_id=a.workspace_id AND x.environment='REAL' AND x.journey_id=a.journey_id AND x.record_id=r.id AND x.record_kind=r.kind AND x.after_version=n;
    IF NOT FOUND THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_CORRECTION_MISSING';END IF;
    expected_hash:=correction.body_sha256;
   END IF;
   IF expected_hash IS NULL OR encode(public.digest(v.body::text,'sha256'),'hex')<>expected_hash OR (n=r.version AND v.body<>r.body) THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_HISTORY_CHANGED';END IF;
  END LOOP;
  IF n<>r.version THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_HISTORY_CHANGED';END IF;
  IF r.kind<>'fulfillment' AND COALESCE(r.body->>'commercial_classification',CASE WHEN r.kind='order' THEN 'COMMERCIAL' ELSE 'GENUINE' END) IS DISTINCT FROM e->>'classification' THEN changed:=true;END IF;
 END LOOP;
 RETURN CASE WHEN changed THEN 'CORRECTED_REQUIRES_RECONCILIATION' ELSE 'RESOLUTION_PRESERVED' END;
END $$;
ALTER FUNCTION financial_retention_check(public.financial_retention_attestations,text) OWNER TO commerce_financial_retention;
REVOKE ALL ON FUNCTION financial_retention_check(public.financial_retention_attestations,text) FROM PUBLIC;

CREATE FUNCTION verify_financial_retention(target uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE a public.financial_retention_attestations%ROWTYPE;state text;installed boolean;
BEGIN
 SELECT * INTO STRICT a FROM public.financial_retention_attestations WHERE journey_id=target AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL';
 PERFORM pg_advisory_xact_lock(hashtextextended('["result-projection-v1",'||to_json(a.workspace_id)::text||']',0));PERFORM pg_advisory_xact_lock(hashtextextended(target::text,0));
 installed:=EXISTS(SELECT 1 FROM public.financial_retention_installations WHERE attestation_id=a.id);
 state:=public.financial_retention_check(a,CASE WHEN installed THEN 'MINIMUM' ELSE 'SOURCE' END);
 RETURN public.financial_retention_receipt(a)||jsonb_build_object('status',state,'installed',installed);
END $$;
ALTER FUNCTION verify_financial_retention(uuid) OWNER TO commerce_financial_retention;
REVOKE ALL ON FUNCTION verify_financial_retention(uuid) FROM PUBLIC;

CREATE FUNCTION confirm_financial_minimization(target uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE a public.financial_retention_attestations%ROWTYPE;added integer;state text;
BEGIN
 SELECT * INTO STRICT a FROM public.financial_retention_attestations WHERE id=target AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL';
 PERFORM pg_advisory_xact_lock(hashtextextended('["result-projection-v1",'||to_json(a.workspace_id)::text||']',0));PERFORM pg_advisory_xact_lock(hashtextextended(a.journey_id::text,0));
 state:=public.financial_retention_check(a,'MINIMUM');
 -- Non-TEST financial journeys require the native024 dimensional snapshot from
 -- the SAME source. TEST/no-order journeys do not invent an active commercial fact.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(a.resolution->'orders') x WHERE x->>'classification'<>'TEST') AND NOT EXISTS(SELECT 1 FROM public.result_financial_context x WHERE x.workspace_id=a.workspace_id AND x.environment='REAL' AND x.journey_id=a.journey_id AND x.source_version=a.source_version AND x.source_hash=a.source_sha256) THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_CONTEXT_MISSING';END IF;
 INSERT INTO public.financial_retention_installations(attestation_id,workspace_id,journey_id) VALUES(a.id,a.workspace_id,a.journey_id) ON CONFLICT DO NOTHING;GET DIAGNOSTICS added=ROW_COUNT;
 RETURN public.financial_retention_receipt(a)||jsonb_build_object('status',CASE WHEN added=1 THEN 'MINIMUM_CONFIRMED' ELSE 'NO_EFFECT' END,'resolution',state);
END $$;
ALTER FUNCTION confirm_financial_minimization(uuid) OWNER TO commerce_financial_retention;
REVOKE ALL ON FUNCTION confirm_financial_minimization(uuid) FROM PUBLIC;

-- Native command, not caller payload. No classification updates can create a
-- recognition, approval, contribution, delivery or external effect.
CREATE FUNCTION correct_retained_financial_classification(command_uuid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');cmd public.commands%ROWTYPE;r public.records%ROWTYPE;
 a public.financial_retention_attestations%ROWTYPE;old public.financial_retention_corrections%ROWTYPE;
 next_class text;before_class text;cmd_hash text;new_body jsonb;correction_result jsonb;baseline jsonb;
BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_CONTEXT';END IF;
 SELECT * INTO STRICT cmd FROM public.commands WHERE id=command_uuid AND workspace_id=w AND environment='REAL';
 IF cmd.kind NOT IN('order_classification','receipt_classification') OR COALESCE(length(btrim(cmd.actor_id)),0)=0 OR jsonb_typeof(cmd.payload) IS DISTINCT FROM 'object' OR jsonb_typeof(cmd.payload->'reason') IS DISTINCT FROM 'string' OR COALESCE(length(btrim(cmd.payload->>'reason')),0)=0 OR length(cmd.payload->>'reason')>2000 OR cmd.created_at>clock_timestamp() OR (cmd.payload-ARRAY['classification','reason','expected_version'])<>'{}' OR jsonb_typeof(cmd.payload->'expected_version') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_COMMAND_INVALID';END IF;
 next_class:=cmd.payload->>'classification';
 IF next_class IS NULL OR (cmd.kind='order_classification' AND next_class NOT IN('COMMERCIAL','TEST')) OR (cmd.kind='receipt_classification' AND next_class NOT IN('FALSE','GENUINE')) THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_COMMAND_INVALID';END IF;
 cmd_hash:=encode(public.digest(jsonb_build_array(cmd.id,cmd.workspace_id,cmd.environment,cmd.kind,cmd.resource_id,cmd.actor_id,cmd.payload,cmd.created_at)::text,'sha256'),'hex');
 SELECT * INTO r FROM public.records WHERE id::text=cmd.resource_id AND workspace_id=w AND environment='REAL' AND kind=CASE WHEN cmd.kind='order_classification' THEN 'order' ELSE 'receipt' END;
 IF NOT FOUND THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_TARGET_MISSING';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('["result-projection-v1",'||to_json(w)::text||']',0));PERFORM pg_advisory_xact_lock(hashtextextended(r.body->>'conversation_id',0));
 SELECT * INTO STRICT a FROM public.financial_retention_attestations WHERE workspace_id=w AND environment='REAL' AND journey_id::text=r.body->>'conversation_id';
 IF NOT EXISTS(SELECT 1 FROM public.financial_retention_installations WHERE attestation_id=a.id) THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_NOT_INSTALLED';END IF;
 PERFORM public.financial_retention_check(a,'MINIMUM');
 SELECT * INTO old FROM public.financial_retention_corrections WHERE command_id=command_uuid;
 IF FOUND THEN
  IF old.command_sha256<>cmd_hash OR cmd.status<>'APPLIED' OR cmd.result<>old.result THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_REPLAY_CHANGED';END IF;RETURN old.result;
 END IF;
 SELECT * INTO STRICT cmd FROM public.commands WHERE id=command_uuid AND workspace_id=w AND environment='REAL' FOR UPDATE;
 SELECT * INTO STRICT r FROM public.records WHERE id=r.id AND workspace_id=w AND environment='REAL' FOR UPDATE;
 IF cmd.status<>'PENDING' OR (cmd.payload->>'expected_version')::numeric<>r.version THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_COMMAND_CHANGED';END IF;
 SELECT value INTO STRICT baseline FROM jsonb_array_elements(a.manifest) WHERE value->>'record_id'=r.id::text;
 IF baseline->>'classification'='TEST' OR r.body->>'is_test'='true' THEN
  IF next_class NOT IN('TEST','FALSE') THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_TEST_IMMUTABLE';END IF;
 END IF;
 before_class:=COALESCE(r.body->>'commercial_classification',CASE WHEN r.kind='order' THEN 'COMMERCIAL' ELSE 'GENUINE' END);
 new_body:=r.body||jsonb_build_object('commercial_classification',next_class,'classification_decision',jsonb_build_object('previous',before_class,'command_id',command_uuid,'at',clock_timestamp()));
 correction_result:=jsonb_build_object('resource_id',r.id,'classification',next_class,'version',r.version+1,'retention_receipt_uuid',a.id,'external_effects',0);
 INSERT INTO public.financial_retention_corrections(command_id,attestation_id,workspace_id,journey_id,record_id,record_kind,before_version,after_version,previous_class,classification,command_sha256,body_sha256,result)
 VALUES(command_uuid,a.id,w,a.journey_id,r.id,r.kind,r.version,r.version+1,before_class,next_class,cmd_hash,encode(public.digest(new_body::text,'sha256'),'hex'),correction_result);
 UPDATE public.records SET body=new_body,version=version+1,updated_at=now() WHERE id=r.id AND workspace_id=w AND environment='REAL' AND version=r.version;
 IF NOT FOUND THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_VERSION_CHANGED';END IF;
 UPDATE public.commands SET status='APPLIED',result=correction_result,updated_at=now() WHERE id=command_uuid AND workspace_id=w AND environment='REAL';
 PERFORM public.financial_retention_check(a,'MINIMUM');RETURN correction_result;
END $$;
ALTER FUNCTION correct_retained_financial_classification(uuid) OWNER TO commerce_financial_retention;
REVOKE ALL ON FUNCTION correct_retained_financial_classification(uuid) FROM PUBLIC;
-- All public-shaped ports remain closed. Reviewed031 integration must grant its
-- private owner and the authenticated classification path explicitly.

-- Preserve the exact historical trigger outside this one closed-owner seam.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_retained_asset_references' AND p.pronargs=0 AND NOT p.prosecdef AND encode(digest(p.prosrc,'sha256'),'hex')='3b15427a94da96c6e4934fc0fa80091e6de6a52b169d8fdc067816545469c451') THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_LEGACY_TRIGGER_CHANGED';END IF;
 IF has_schema_privilege('commerce_financial_retention','public','CREATE') OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('commerce_api','commerce_automation','commerce_results','commerce_results_reader','commerce_ingress','commerce_channel','commerce_maintenance') AND has_schema_privilege(oid,'public','CREATE')) THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_SCHEMA_UNTRUSTED';END IF;
END $$;
CREATE OR REPLACE FUNCTION guard_retained_asset_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text; asset_state text;
BEGIN

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
-- <<< end 032_financial_retention_custody.sql
