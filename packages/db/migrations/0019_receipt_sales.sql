-- receipt_sales_v1: additive schema; no historical recognition or external effects.
CREATE TABLE payment_contributions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('SIMULATION','REAL')),
 order_id uuid NOT NULL REFERENCES records(id), receipt_id uuid NOT NULL REFERENCES records(id),
 payment_key text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), currency_source text NOT NULL,
 evidence_sha256 text NOT NULL, effective_at timestamptz NOT NULL, recognized_at timestamptz NOT NULL DEFAULT now(),
 provenance jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
 UNIQUE(workspace_id,environment,order_id,payment_key), UNIQUE(workspace_id,environment,receipt_id),
 UNIQUE(workspace_id,environment,evidence_sha256)
);
CREATE INDEX contribution_period ON payment_contributions(workspace_id,environment,effective_at);
CREATE FUNCTION validate_contribution_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM records o JOIN records r ON r.id=NEW.receipt_id
 WHERE o.id=NEW.order_id AND o.kind='order' AND r.kind='receipt' AND r.body->>'order_id'=o.id::text
 AND o.workspace_id=NEW.workspace_id AND r.workspace_id=NEW.workspace_id
 AND o.environment=NEW.environment AND r.environment=NEW.environment) THEN RAISE EXCEPTION 'INVALID_SCOPED_REFERENCE'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER contribution_scope BEFORE INSERT OR UPDATE ON payment_contributions FOR EACH ROW EXECUTE FUNCTION validate_contribution_scope();
CREATE VIEW receipt_sale_facts AS
 SELECT p.*, o.body->>'product_id' AS product_id, o.body->>'conversation_id' AS conversation_id,
 o.body->'attribution' AS attribution,
 CASE WHEN o.body->>'commercial_classification'='TEST' THEN 'TEST'
 WHEN r.body->>'commercial_classification'='FALSE' THEN 'FALSE'
 WHEN r.body->>'status'<>'APPROVED' THEN 'PENDING' ELSE 'VALID' END AS classification
 FROM payment_contributions p JOIN records o ON o.id=p.order_id JOIN records r ON r.id=p.receipt_id;

CREATE TABLE meta_insight_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL CHECK(environment IN ('SIMULATION','REAL')),
 actor_id text NOT NULL,request jsonb NOT NULL,status text NOT NULL DEFAULT 'PENDING',attempts integer NOT NULL DEFAULT 0,
 lease_until timestamptz,lease_token uuid,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 result jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_insight_job ON meta_insight_jobs(workspace_id,environment) WHERE status IN ('PENDING','RUNNING');
CREATE INDEX insight_job_pending ON meta_insight_jobs(next_attempt_at) WHERE status IN ('PENDING','RUNNING');
CREATE TABLE meta_ad_metadata (
 workspace_id text NOT NULL,environment text NOT NULL,meta_ad_account_id text NOT NULL,ad_id text NOT NULL,
 campaign_id text NOT NULL,ad_set_id text,ad_name text NOT NULL,campaign_name text NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(),source text NOT NULL,
 PRIMARY KEY(workspace_id,environment,meta_ad_account_id,ad_id)
);
CREATE TABLE meta_insight_accounts (
 workspace_id text NOT NULL,environment text NOT NULL,meta_ad_account_id text NOT NULL,name text NOT NULL,
 currency text NOT NULL,timezone text NOT NULL,tax_bps integer CHECK(tax_bps BETWEEN 0 AND 10000),
 status text NOT NULL,last_success_at timestamptz,last_attempt_at timestamptz NOT NULL DEFAULT now(),issue jsonb,
 PRIMARY KEY(workspace_id,environment,meta_ad_account_id)
);
CREATE TABLE meta_insight_days (
 workspace_id text NOT NULL,environment text NOT NULL,meta_ad_account_id text NOT NULL,day date NOT NULL,
 level text NOT NULL CHECK(level IN ('ad','campaign')),entity_id text NOT NULL,campaign_id text NOT NULL,
 ad_set_id text,name text NOT NULL,campaign_name text NOT NULL,currency text NOT NULL,timezone text NOT NULL,
 spend_minor bigint NOT NULL CHECK(spend_minor>=0),impressions bigint,clicks bigint,conversations numeric,
 action_type text,definition text NOT NULL DEFAULT 'meta_daily_v1',synced_at timestamptz NOT NULL DEFAULT now(),job_id uuid NOT NULL REFERENCES meta_insight_jobs(id),
 PRIMARY KEY(workspace_id,environment,meta_ad_account_id,day,level,entity_id,definition)
);
CREATE INDEX insight_period ON meta_insight_days(workspace_id,environment,day);
-- Complete coverage is recorded even for legitimate empty days.
CREATE TABLE meta_insight_coverage (
 workspace_id text NOT NULL,environment text NOT NULL,meta_ad_account_id text NOT NULL,day date NOT NULL,
 synced_at timestamptz NOT NULL DEFAULT now(),job_id uuid NOT NULL REFERENCES meta_insight_jobs(id),
 PRIMARY KEY(workspace_id,environment,meta_ad_account_id,day)
);
CREATE TABLE campaign_products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL,
 meta_ad_account_id text NOT NULL,entity_type text NOT NULL CHECK(entity_type IN ('campaign','ad')),entity_id text NOT NULL,
 product_id uuid REFERENCES records(id),valid_from date NOT NULL,actor_id text NOT NULL,reason text NOT NULL,
 revision integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,environment,meta_ad_account_id,entity_type,entity_id,valid_from,revision)
);
CREATE TRIGGER immutable_campaign_product BEFORE UPDATE OR DELETE ON campaign_products FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE sales_history_imports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL,actor_id text NOT NULL,
 source text NOT NULL,status text NOT NULL DEFAULT 'PREVIEW',payload_ciphertext text NOT NULL,preview jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),committed_at timestamptz
);
CREATE TABLE reported_sales (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL,source text NOT NULL,
 source_key text NOT NULL,content_hash text NOT NULL,batch_id uuid REFERENCES sales_history_imports(id),
 body jsonb NOT NULL,order_id uuid REFERENCES records(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,environment,source,source_key)
);
GRANT SELECT ON payment_contributions,receipt_sale_facts,meta_insight_jobs,meta_ad_metadata,meta_insight_accounts,meta_insight_days,meta_insight_coverage,campaign_products,sales_history_imports,reported_sales TO commerce_api,commerce_automation;
GRANT INSERT,UPDATE ON payment_contributions,meta_ad_metadata,meta_insight_accounts,meta_insight_days,meta_insight_coverage TO commerce_automation;
GRANT DELETE ON meta_insight_days TO commerce_automation;
GRANT INSERT,UPDATE ON meta_insight_jobs TO commerce_api,commerce_automation;
GRANT INSERT ON campaign_products TO commerce_api;
GRANT UPDATE(tax_bps) ON meta_insight_accounts TO commerce_api;
GRANT INSERT,UPDATE ON sales_history_imports,reported_sales TO commerce_api,commerce_automation;
CREATE POLICY integration_secret_meta_insights ON integration_secrets FOR SELECT TO commerce_automation USING(type='meta' AND field='access_token');
CREATE INDEX order_attribution ON records(workspace_id,environment,(body->'attribution'->>'ad_id')) WHERE kind='order';
