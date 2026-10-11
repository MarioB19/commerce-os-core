-- Durable commercial follow-up cycles shared by every product and phone for a
-- workspace contact.  These tables do not authorize transport; the existing
-- outbox authorization and channel-window controls remain authoritative.
CREATE TABLE commercial_remarketing_cycles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('SIMULATION','REAL')),
 contact_id uuid NOT NULL REFERENCES records(id),
 source_conversation_id uuid NOT NULL REFERENCES records(id),
 source_offer_version_id uuid NOT NULL REFERENCES records(id),
 policy_snapshot jsonb NOT NULL CHECK(jsonb_typeof(policy_snapshot)='object'),
 max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 0 AND 3),
 consumed_attempts integer NOT NULL DEFAULT 0 CHECK(consumed_attempts>=0 AND consumed_attempts<=max_attempts),
 stage text NOT NULL CHECK(stage IN ('AGREEMENT','COLLECTION')),
 anchor_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','PAID','REPLIED','DECLINED','OPTED_OUT','HUMAN_REVIEW','CLOSED')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 opened_at timestamptz NOT NULL DEFAULT now(),
 closed_at timestamptz,
 close_reason text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_open_commercial_cycle_per_contact
 ON commercial_remarketing_cycles(workspace_id,environment,contact_id)
 WHERE status='OPEN';
CREATE INDEX commercial_cycle_lookup
 ON commercial_remarketing_cycles(workspace_id,environment,contact_id,updated_at DESC);

CREATE TABLE commercial_remarketing_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 cycle_id uuid NOT NULL REFERENCES commercial_remarketing_cycles(id),
 workspace_id text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('SIMULATION','REAL')),
 contact_id uuid NOT NULL REFERENCES records(id),
 slot_id text NOT NULL CHECK(slot_id ~ '^[a-zA-Z0-9_-]{1,64}$'),
 stage text NOT NULL CHECK(stage IN ('AGREEMENT','COLLECTION')),
 status text NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED','PROPOSED','SENT','DELIVERED','UNKNOWN','CANCELLED')),
 timer_id uuid REFERENCES timers(id),
 conversation_id uuid NOT NULL REFERENCES records(id),
 reserved_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 metadata jsonb NOT NULL DEFAULT '{}',
 UNIQUE(cycle_id,slot_id)
);
CREATE INDEX commercial_attempt_lookup
 ON commercial_remarketing_attempts(workspace_id,environment,contact_id,reserved_at DESC);

-- A buyer exclusion suppresses only automatic commercial follow-up.  It is
-- intentionally not a manual_control/contact SUPPRESSED flag, so inbound
-- support and requested replies remain available.
CREATE TABLE commercial_buyer_exclusions (
 workspace_id text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('SIMULATION','REAL')),
 contact_id uuid NOT NULL REFERENCES records(id),
 first_order_id uuid NOT NULL REFERENCES records(id),
 first_receipt_id uuid NOT NULL REFERENCES records(id),
 recognized_at timestamptz NOT NULL,
 source text NOT NULL CHECK(source IN ('receipt_recognition','receipt_sales_backfill')),
 metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,environment,contact_id)
);

-- Idempotent backfill from already recognized positive receipts. Historical
-- evidence remains untouched. Pending commercial timers/outbox rows are
-- cancelled below as a safe suppression; no delivery or new effect is created.
INSERT INTO commercial_buyer_exclusions(
 workspace_id,environment,contact_id,first_order_id,first_receipt_id,recognized_at,source,metadata
)
SELECT DISTINCT ON (p.workspace_id,p.environment,identity.contact_id)
 p.workspace_id,p.environment,identity.contact_id::uuid,p.order_id,p.receipt_id,p.recognized_at,
 'receipt_sales_backfill',jsonb_build_object('migration','0058','definition','receipt_sales_v1')
FROM payment_contributions p
JOIN records o ON o.id=p.order_id AND o.kind='order'
 AND o.workspace_id=p.workspace_id AND o.environment=p.environment
LEFT JOIN records c ON c.id::text=o.body->>'conversation_id' AND c.kind='conversation'
 AND c.workspace_id=p.workspace_id AND c.environment=p.environment
JOIN records r ON r.id=p.receipt_id AND r.kind='receipt'
 AND r.workspace_id=p.workspace_id AND r.environment=p.environment
 AND r.body->>'order_id'=p.order_id::text
CROSS JOIN LATERAL (
 SELECT CASE
  WHEN o.body->>'contact_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN o.body->>'contact_id'
  ELSE NULLIF(c.body->>'contact_id','')
 END contact_id
) identity
WHERE p.amount_minor>0
 AND identity.contact_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND COALESCE(o.body->>'commercial_classification','COMMERCIAL')<>'TEST'
 AND COALESCE(r.body->>'commercial_classification','GENUINE')<>'FALSE'
 AND r.body->>'status'='APPROVED'
ORDER BY p.workspace_id,p.environment,identity.contact_id,p.recognized_at,p.id
ON CONFLICT(workspace_id,environment,contact_id) DO NOTHING;

UPDATE timers t SET status='CANCELLED'
FROM records c,commercial_buyer_exclusions b
WHERE t.status='PENDING' AND t.kind='followup' AND c.id::text=t.conversation_id
 AND c.kind='conversation' AND c.workspace_id=t.workspace_id AND c.environment=t.environment
 AND b.workspace_id=c.workspace_id AND b.environment=c.environment
 AND b.contact_id::text=c.body->>'contact_id';
UPDATE outbox o SET status='CANCELLED',result=jsonb_build_object('reason','BUYER_EXCLUDED_BY_BACKFILL'),updated_at=now()
FROM commercial_buyer_exclusions b
WHERE o.status IN('READY','BLOCKED') AND o.payload->>'purpose' IN('followup','remarketing')
 AND b.workspace_id=o.workspace_id AND b.environment=o.environment AND b.contact_id::text=o.contact_id;

GRANT SELECT ON commercial_remarketing_cycles,commercial_remarketing_attempts,commercial_buyer_exclusions TO commerce_api,commerce_automation,commerce_channel;
GRANT UPDATE ON commercial_remarketing_cycles TO commerce_api;
GRANT INSERT,UPDATE ON commercial_remarketing_cycles,commercial_remarketing_attempts,commercial_buyer_exclusions TO commerce_automation;
-- The channel worker performs the last eligibility check and records the
-- transport outcome. It may update an existing attempt, but it never opens a
-- cycle, reserves quota or creates a buyer exclusion.
GRANT UPDATE(status,metadata,updated_at) ON commercial_remarketing_attempts TO commerce_channel;
