-- V7 F2 cutover: Result financial context custody (024).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/024_result_financial_context.sql (source sha256 f613f7fad69a88460a2bd0d3fc45302ff0491dd250e03b10876abd7c28ca5a4a)
-- V7 F2: 1 role-existence refusal(s) and 1 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- Requires022 and source-reader component; no records are erased here.
DO $$ BEGIN

 PERFORM public.v7_ensure_reviewed_role('commerce_result_custody',false);
END $$;
GRANT USAGE ON SCHEMA public TO commerce_result_custody;
CREATE TABLE result_financial_context(
 workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 journey_id uuid NOT NULL,journey_kind text NOT NULL DEFAULT 'conversation' CHECK(journey_kind='conversation'),
 source_version integer NOT NULL CHECK(source_version>0),source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 grain jsonb NOT NULL CHECK(result_grain_valid(grain) AND NOT(grain ? 'ai_unattributed')),
 started_at timestamptz NOT NULL,first_response_at timestamptz,
 offered boolean NOT NULL,collection_sent boolean NOT NULL,remarketing_accepted_at timestamptz[] NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,journey_id),
 FOREIGN KEY(journey_id,workspace_id,environment,journey_kind) REFERENCES records(id,workspace_id,environment,kind),
 CHECK(first_response_at IS NULL OR first_response_at>=started_at)
);
ALTER TABLE result_financial_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_financial_context FORCE ROW LEVEL SECURITY;
CREATE POLICY financial_context_scope ON result_financial_context USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
CREATE POLICY financial_context_scope_guard ON result_financial_context AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
REVOKE ALL ON result_financial_context FROM PUBLIC,commerce_api,commerce_results,commerce_results_reader,commerce_automation,commerce_ingress,commerce_channel;
GRANT SELECT ON result_financial_context TO commerce_api,commerce_results_reader,commerce_result_custody;
GRANT INSERT ON result_financial_context TO commerce_result_custody;
CREATE TRIGGER immutable_result_financial_context BEFORE UPDATE OR DELETE ON result_financial_context FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE VIEW result_active_journey_facts WITH(security_invoker=true,security_barrier=true) AS
 SELECT c.workspace_id,c.environment,c.id journey_id,COALESCE(s.body->'release'->'locale'->>'timezone',p.timezone) timezone,
  COALESCE(result_observed_at(c.body->>'started_at'),c.created_at) started_at,
  COALESCE(s.body->'release'->'locale'->>'currency',offer.body->>'currency',sale_order.body->>'currency') currency,
  COALESCE(s.body->'release'->>'family_id',c.body->>'product_id') family_id,
  s.body->'release'->>'variant_id' variant_id,s.body->'release'->'locale'->>'market' market,
  c.body->>'account_id' account_id,
  CASE WHEN attribution.n=1 THEN attribution.campaign_id END campaign_id,
  CASE WHEN attribution.n=1 THEN attribution.ad_id END ad_id,
  CASE WHEN c.body->'origin'->>'source'='remarketing' AND c.body->'origin'->>'evidence_ref' IS NOT NULL THEN 'REMARKETING'
   WHEN c.body->>'started_at' IS NOT NULL AND c.body->>'historical_only' IS DISTINCT FROM 'true' THEN 'FIRST_CONTACT' ELSE 'UNKNOWN' END touch,
  outgoing.first_response_at,
  (outgoing.offer_seen OR result_observed_at(sale_order.body->>'committed_at') IS NOT NULL) offered,
  outgoing.collection_sent,
  EXISTS(SELECT 1 FROM records r WHERE r.workspace_id=c.workspace_id AND r.environment=c.environment AND r.kind='receipt'
   AND r.body->>'conversation_id'=c.id::text AND COALESCE(r.body->>'commercial_classification','COMMERCIAL') NOT IN('FALSE','TEST')
   AND r.body->>'duplicate_of' IS NULL) receipt_received,
  paid.first_sale_at
 FROM records c JOIN profiles p ON p.id=c.workspace_id
 LEFT JOIN market_journey_snapshots s ON s.workspace_id=c.workspace_id AND s.environment=c.environment AND s.journey_id=c.id
 LEFT JOIN records offer ON offer.workspace_id=c.workspace_id AND offer.environment=c.environment AND offer.kind='offer' AND offer.id::text=c.body->>'offer_version_id'
 LEFT JOIN LATERAL(SELECT o.body FROM records o WHERE o.workspace_id=c.workspace_id AND o.environment=c.environment AND o.kind='order'
  AND o.body->>'conversation_id'=c.id::text ORDER BY o.created_at,o.id LIMIT 1) sale_order ON true
 LEFT JOIN LATERAL(SELECT count(*) n,min(m.campaign_id) campaign_id,min(m.ad_id) ad_id FROM meta_ad_metadata m
  WHERE m.workspace_id=c.workspace_id AND m.environment=c.environment
   AND m.ad_id=COALESCE(sale_order.body->'attribution'->>'ad_id',c.body->'origin'->>'ad_id')
   AND COALESCE(sale_order.body->'attribution'->>'classification',c.body->'origin'->>'classification') IN('observed','manual')
   AND (COALESCE(sale_order.body->'attribution'->>'meta_ad_account_id',c.body->'origin'->>'meta_ad_account_id') IS NULL
    OR m.meta_ad_account_id=COALESCE(sale_order.body->'attribution'->>'meta_ad_account_id',c.body->'origin'->>'meta_ad_account_id'))) attribution ON true
 LEFT JOIN LATERAL(SELECT min(result_observed_at(o.result->>'accepted_at')) first_response_at,
   COALESCE(bool_or(o.payload->>'purpose' IN('offer','agreement') OR o.payload->>'workflow_recipe_step' IN('3','5')),false) offer_seen,
   COALESCE(bool_or(o.payload->>'purpose'='collection'),false) collection_sent
  FROM outbox o WHERE o.workspace_id=c.workspace_id AND o.environment=c.environment AND o.conversation_id=c.id::text
   AND o.kind<>'warmup' AND o.payload->>'kind' IS DISTINCT FROM 'grant' AND o.status IN('SENT','DELIVERED','READ')
   AND o.provider_message_id IS NOT NULL AND result_observed_at(o.result->>'accepted_at')>=COALESCE(result_observed_at(c.body->>'started_at'),c.created_at)) outgoing ON true
 LEFT JOIN LATERAL(SELECT min(pc.effective_at) first_sale_at FROM payment_contributions pc
  JOIN records o ON o.id=pc.order_id AND o.workspace_id=pc.workspace_id AND o.environment=pc.environment AND o.kind='order'
  JOIN records r ON r.id=pc.receipt_id AND r.workspace_id=pc.workspace_id AND r.environment=pc.environment AND r.kind='receipt'
  WHERE pc.workspace_id=c.workspace_id AND pc.environment=c.environment AND o.body->>'conversation_id'=c.id::text
   AND pc.currency=COALESCE(s.body->'release'->'locale'->>'currency',offer.body->>'currency',sale_order.body->>'currency')
   AND o.body->>'commercial_classification' IS DISTINCT FROM 'TEST' AND COALESCE(r.body->>'commercial_classification','COMMERCIAL') NOT IN('FALSE','TEST')
   AND r.body->>'duplicate_of' IS NULL AND r.body->>'status'='APPROVED') paid ON true
 WHERE c.workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND c.kind='conversation' AND c.environment='REAL' AND c.body->>'privacy_erased' IS DISTINCT FROM 'true' AND c.body->>'commercial_classification' IS DISTINCT FROM 'TEST'
  AND c.body->>'is_test' IS DISTINCT FROM 'true' AND NOT(c.body ? 'number_flow_test_id') AND NOT(c.body ? 'launch_test_id')
  AND NOT EXISTS(SELECT 1 FROM records o WHERE o.workspace_id=c.workspace_id AND o.environment=c.environment AND o.kind='order'
   AND o.body->>'conversation_id'=c.id::text AND o.body->>'commercial_classification'='TEST');

GRANT SELECT ON result_active_journey_facts TO commerce_result_custody,commerce_api,commerce_results_reader;
GRANT SELECT ON records,profiles,market_journey_snapshots,outbox,meta_ad_metadata,payment_contributions TO commerce_result_custody;
GRANT EXECUTE ON FUNCTION result_observed_at(text),result_grain_valid(jsonb) TO commerce_result_custody;
CREATE FUNCTION capture_result_financial_context(target uuid,expected_version integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');j record;c record;g jsonb;previous public.result_financial_context%ROWTYPE;h text;remarketing timestamptz[];
BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION 'RESULT_CUSTODY_CONTEXT_REQUIRED';END IF;
 -- Same lock order as projection and erasure. The caller commits capture+erase together.
 PERFORM pg_advisory_xact_lock(hashtextextended('["result-projection-v1",'||to_json(w)::text||']',0));
 SELECT version,body INTO c FROM public.records WHERE id=target AND workspace_id=w AND environment='REAL' AND kind='conversation';
 IF NOT FOUND OR c.version IS DISTINCT FROM expected_version OR c.body->>'privacy_erased'='true' THEN RAISE EXCEPTION 'RESULT_CUSTODY_SOURCE_CHANGED';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.records WHERE workspace_id=w AND environment='REAL' AND kind IN('order','receipt') AND body->>'conversation_id'=target::text) THEN RAISE EXCEPTION 'RESULT_FINANCIAL_CONTEXT_NOT_REQUIRED';END IF;
 SELECT * INTO j FROM public.result_active_journey_facts WHERE workspace_id=w AND environment='REAL' AND journey_id=target;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESULT_CUSTODY_SOURCE_NOT_ELIGIBLE';END IF;
 g:=jsonb_build_object('day',(j.started_at AT TIME ZONE j.timezone)::date::text,'currency',j.currency,'timezone',j.timezone,'dimensions',jsonb_build_object('family_id',j.family_id,'variant_id',j.variant_id,'market',j.market,'account_id',j.account_id,'campaign_id',j.campaign_id,'ad_id',j.ad_id,'touch',j.touch));
 SELECT COALESCE(array_agg(DISTINCT public.result_observed_at(o.result->>'accepted_at') ORDER BY public.result_observed_at(o.result->>'accepted_at')),ARRAY[]::timestamptz[]) INTO remarketing FROM public.outbox o WHERE o.workspace_id=w AND o.environment='REAL' AND o.conversation_id=target::text AND o.payload->>'purpose'='remarketing' AND o.status IN('SENT','DELIVERED','READ') AND o.provider_message_id IS NOT NULL AND public.result_observed_at(o.result->>'accepted_at') IS NOT NULL;
 h:=encode(public.digest(c.body::text,'sha256'),'hex');
 SELECT * INTO previous FROM public.result_financial_context WHERE workspace_id=w AND environment='REAL' AND journey_id=target;
 IF FOUND THEN
  IF (previous.source_version,previous.source_hash,previous.grain,previous.started_at,previous.first_response_at,previous.offered,previous.collection_sent,previous.remarketing_accepted_at) IS DISTINCT FROM (c.version,h,g,j.started_at,j.first_response_at,j.offered,j.collection_sent,remarketing) THEN RAISE EXCEPTION 'RESULT_CUSTODY_SNAPSHOT_CHANGED';END IF;
  RETURN jsonb_build_object('status','NO_EFFECT','source_version',c.version,'source_hash',h);
 END IF;
 INSERT INTO public.result_financial_context(workspace_id,journey_id,source_version,source_hash,grain,started_at,first_response_at,offered,collection_sent,remarketing_accepted_at) VALUES(w,target,c.version,h,g,j.started_at,j.first_response_at,j.offered,j.collection_sent,remarketing);
 RETURN jsonb_build_object('status','CAPTURED','source_version',c.version,'source_hash',h);
END $$;
ALTER FUNCTION capture_result_financial_context(uuid,integer) OWNER TO commerce_result_custody;
REVOKE ALL ON FUNCTION capture_result_financial_context(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION capture_result_financial_context(uuid,integer) TO commerce_results;
CREATE OR REPLACE VIEW result_journey_facts WITH(security_invoker=true,security_barrier=true) AS
 SELECT * FROM result_active_journey_facts
 UNION ALL
 SELECT x.workspace_id,x.environment,x.journey_id,x.grain->>'timezone' timezone,x.started_at,x.grain->>'currency' currency,
  x.grain->'dimensions'->>'family_id' family_id,x.grain->'dimensions'->>'variant_id' variant_id,x.grain->'dimensions'->>'market' market,
  x.grain->'dimensions'->>'account_id' account_id,x.grain->'dimensions'->>'campaign_id' campaign_id,x.grain->'dimensions'->>'ad_id' ad_id,x.grain->'dimensions'->>'touch' touch,
  x.first_response_at,x.offered,x.collection_sent,
  EXISTS(SELECT 1 FROM records r WHERE r.workspace_id=x.workspace_id AND r.environment=x.environment AND r.kind='receipt' AND r.body->>'conversation_id'=x.journey_id::text AND COALESCE(r.body->>'commercial_classification','COMMERCIAL') NOT IN('FALSE','TEST') AND r.body->>'duplicate_of' IS NULL) receipt_received,
  (SELECT min(pc.effective_at) FROM payment_contributions pc JOIN records o ON o.id=pc.order_id AND o.workspace_id=pc.workspace_id AND o.environment=pc.environment AND o.kind='order' JOIN records r ON r.id=pc.receipt_id AND r.workspace_id=pc.workspace_id AND r.environment=pc.environment AND r.kind='receipt'
   WHERE pc.workspace_id=x.workspace_id AND pc.environment=x.environment AND o.body->>'conversation_id'=x.journey_id::text AND pc.currency=x.grain->>'currency' AND o.body->>'commercial_classification' IS DISTINCT FROM 'TEST' AND COALESCE(r.body->>'commercial_classification','COMMERCIAL') NOT IN('FALSE','TEST') AND r.body->>'duplicate_of' IS NULL AND r.body->>'status'='APPROVED') first_sale_at
 FROM result_financial_context x JOIN records c ON c.workspace_id=x.workspace_id AND c.environment=x.environment AND c.id=x.journey_id AND c.kind='conversation'
 WHERE x.workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND x.environment='REAL' AND c.body->>'privacy_erased'='true'
  AND NOT EXISTS(SELECT 1 FROM records o WHERE o.workspace_id=x.workspace_id AND o.environment=x.environment AND o.kind='order' AND o.body->>'conversation_id'=x.journey_id::text AND o.body->>'commercial_classification'='TEST');

CREATE OR REPLACE VIEW result_payment_facts WITH(security_invoker=true,security_barrier=true) AS
 SELECT pc.workspace_id,pc.environment,pc.id contribution_id,pc.order_id,pc.amount_minor,pc.currency,pc.effective_at,min(pc.effective_at) OVER(PARTITION BY pc.workspace_id,pc.environment,pc.order_id) first_order_payment_at,
  j.journey_id,j.timezone,j.family_id,j.variant_id,j.market,j.account_id,j.campaign_id,j.ad_id,
  CASE WHEN EXISTS(SELECT 1 FROM outbox x WHERE x.workspace_id=pc.workspace_id AND x.environment=pc.environment
   AND x.conversation_id=j.journey_id::text AND x.payload->>'purpose'='remarketing' AND x.status IN('SENT','DELIVERED','READ')
   AND x.provider_message_id IS NOT NULL AND result_observed_at(x.result->>'accepted_at')<=pc.effective_at AND result_observed_at(x.result->>'accepted_at')>=pc.effective_at-interval '7 days') OR EXISTS(SELECT 1 FROM result_financial_context fc CROSS JOIN LATERAL unnest(fc.remarketing_accepted_at) accepted(at) WHERE fc.workspace_id=pc.workspace_id AND fc.environment=pc.environment AND fc.journey_id=j.journey_id AND accepted.at<=pc.effective_at AND accepted.at>=pc.effective_at-interval '7 days') THEN 'REMARKETING' ELSE j.touch END touch
 FROM payment_contributions pc JOIN records o ON o.id=pc.order_id AND o.workspace_id=pc.workspace_id AND o.environment=pc.environment AND o.kind='order'
 JOIN records r ON r.id=pc.receipt_id AND r.workspace_id=pc.workspace_id AND r.environment=pc.environment AND r.kind='receipt'
 JOIN result_journey_facts j ON j.workspace_id=pc.workspace_id AND j.environment=pc.environment AND j.journey_id::text=o.body->>'conversation_id'
 WHERE pc.workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND pc.environment='REAL' AND o.body->>'commercial_classification' IS DISTINCT FROM 'TEST'
  AND COALESCE(r.body->>'commercial_classification','COMMERCIAL') NOT IN('FALSE','TEST') AND r.body->>'duplicate_of' IS NULL AND r.body->>'status'='APPROVED';
-- <<< end 024_result_financial_context.sql
