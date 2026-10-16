-- V7 goals. No adoption, quotas or production migration is performed by saving
-- this transition. REAL commercial reports never accept a caller environment.
ALTER TABLE market_variants ADD CONSTRAINT market_variant_family_scope
 UNIQUE(workspace_id,environment,family_id,id);
CREATE TABLE result_goals(
 id uuid NOT NULL DEFAULT gen_random_uuid(),workspace_id text NOT NULL REFERENCES profiles(id),
 environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 family_id uuid,variant_id uuid,from_day date NOT NULL,to_day date NOT NULL,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 metric text NOT NULL CHECK(metric IN('REVENUE','SALES','MAX_COST_PER_SALE','ROAS')),
 target numeric(30,6) NOT NULL CHECK(target>0 AND target<>'NaN'::numeric),active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483646),
 created_by text NOT NULL,updated_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,environment,family_id) REFERENCES market_families(workspace_id,environment,id),
 FOREIGN KEY(workspace_id,environment,family_id,variant_id) REFERENCES market_variants(workspace_id,environment,family_id,id),
 CHECK(variant_id IS NULL OR family_id IS NOT NULL),CHECK(to_day>=from_day AND to_day-from_day<=365),
 CHECK(isfinite(from_day) AND isfinite(to_day)),CHECK(metric='ROAS' OR target=trunc(target))
);
CREATE INDEX result_goals_period ON result_goals(workspace_id,from_day,to_day,id);
CREATE TABLE result_goal_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,goal_id uuid NOT NULL,
 version integer NOT NULL,event text NOT NULL CHECK(event IN('CREATED','UPDATED')),actor_id text NOT NULL,
 before_state jsonb,after_state jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,goal_id,version),FOREIGN KEY(workspace_id,goal_id) REFERENCES result_goals(workspace_id,id)
);
CREATE TABLE result_goal_operations(
 workspace_id text NOT NULL REFERENCES profiles(id),actor_id text NOT NULL,operation_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(workspace_id,actor_id,operation_id)
);
CREATE FUNCTION guard_result_goal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NOT NEW.active THEN RAISE EXCEPTION 'GOAL_INITIAL_STATE_INVALID';END IF;
 ELSE
  IF (NEW.id,NEW.workspace_id,NEW.environment,NEW.created_by,NEW.created_at) IS DISTINCT FROM
   (OLD.id,OLD.workspace_id,OLD.environment,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'GOAL_IDENTITY_IMMUTABLE';END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'GOAL_VERSION_CONFLICT';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_result_goal() FROM PUBLIC;
CREATE TRIGGER guard_result_goal BEFORE INSERT OR UPDATE ON result_goals FOR EACH ROW EXECUTE FUNCTION guard_result_goal();
CREATE TRIGGER immutable_goal_events BEFORE UPDATE OR DELETE ON result_goal_events FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_goal_operations BEFORE UPDATE OR DELETE ON result_goal_operations FOR EACH ROW EXECUTE FUNCTION immutable_row();
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['result_goals','result_goal_events','result_goal_operations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY result_profile_scope ON %I USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),''''))',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,commerce_ingress,commerce_channel,commerce_automation',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO commerce_api',t);
 END LOOP;
END $$;
GRANT UPDATE ON result_goals TO commerce_api;

-- Indexed, invoker-scoped SQL projections. They use timestamps/evidence retained
-- by content redaction; no text, phone, customer identity or provider secrets.
CREATE FUNCTION result_observed_at(value text) RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF value IS NULL OR value !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$' THEN RETURN NULL;END IF;
 RETURN value::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION result_observed_at(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION result_observed_at(text) TO commerce_api,commerce_automation,commerce_maintenance;
CREATE INDEX result_outbox_journey ON outbox(workspace_id,environment,conversation_id) WHERE status IN('SENT','DELIVERED','READ');
CREATE INDEX result_record_journey ON records(workspace_id,environment,kind,(body->>'conversation_id')) WHERE kind IN('receipt','order','ai_run');
CREATE INDEX result_journey_created ON records(workspace_id,environment,created_at) WHERE kind='conversation';
CREATE VIEW result_journey_facts WITH(security_invoker=true,security_barrier=true) AS
 SELECT c.workspace_id,c.environment,c.id journey_id,p.timezone,
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
   AND r.body->>'conversation_id'=c.id::text AND r.body->>'commercial_classification' IS DISTINCT FROM 'FALSE'
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
   AND o.body->>'commercial_classification' IS DISTINCT FROM 'TEST' AND r.body->>'commercial_classification' IS DISTINCT FROM 'FALSE'
   AND r.body->>'duplicate_of' IS NULL AND r.body->>'status'='APPROVED') paid ON true
 WHERE c.workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND c.kind='conversation' AND c.environment='REAL' AND c.body->>'commercial_classification' IS DISTINCT FROM 'TEST'
  AND c.body->>'is_test' IS DISTINCT FROM 'true' AND NOT(c.body ? 'number_flow_test_id') AND NOT(c.body ? 'launch_test_id')
  AND NOT EXISTS(SELECT 1 FROM records o WHERE o.workspace_id=c.workspace_id AND o.environment=c.environment AND o.kind='order'
   AND o.body->>'conversation_id'=c.id::text AND o.body->>'commercial_classification'='TEST');
CREATE VIEW result_payment_facts WITH(security_invoker=true,security_barrier=true) AS
 SELECT pc.workspace_id,pc.environment,pc.id contribution_id,pc.order_id,pc.amount_minor,pc.currency,pc.effective_at,min(pc.effective_at) OVER(PARTITION BY pc.workspace_id,pc.environment,pc.order_id) first_order_payment_at,
  j.journey_id,j.timezone,j.family_id,j.variant_id,j.market,j.account_id,j.campaign_id,j.ad_id,
  CASE WHEN EXISTS(SELECT 1 FROM outbox x WHERE x.workspace_id=pc.workspace_id AND x.environment=pc.environment
   AND x.conversation_id=j.journey_id::text AND x.payload->>'purpose'='remarketing' AND x.status IN('SENT','DELIVERED','READ')
   AND x.provider_message_id IS NOT NULL AND result_observed_at(x.result->>'accepted_at')<=pc.effective_at) THEN 'REMARKETING' ELSE j.touch END touch
 FROM payment_contributions pc JOIN records o ON o.id=pc.order_id AND o.workspace_id=pc.workspace_id AND o.environment=pc.environment AND o.kind='order'
 JOIN records r ON r.id=pc.receipt_id AND r.workspace_id=pc.workspace_id AND r.environment=pc.environment AND r.kind='receipt'
 JOIN result_journey_facts j ON j.workspace_id=pc.workspace_id AND j.environment=pc.environment AND j.journey_id::text=o.body->>'conversation_id'
 WHERE pc.workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND pc.environment='REAL' AND o.body->>'commercial_classification' IS DISTINCT FROM 'TEST'
  AND r.body->>'commercial_classification' IS DISTINCT FROM 'FALSE' AND r.body->>'duplicate_of' IS NULL AND r.body->>'status'='APPROVED';
REVOKE ALL ON result_journey_facts,result_payment_facts FROM PUBLIC;
GRANT SELECT ON result_journey_facts,result_payment_facts TO commerce_api,commerce_automation,commerce_maintenance;
