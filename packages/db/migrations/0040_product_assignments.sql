-- V5 leaves every historical record/version untouched.
CREATE TABLE commercial_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 account_id uuid NOT NULL REFERENCES records(id), product_id uuid NOT NULL REFERENCES records(id),
 binding_id uuid NOT NULL REFERENCES records(id), revision integer NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN('ACTIVE','DRAFT','RETIRED')),
 authorization_id uuid REFERENCES operation_authorizations(id), created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,environment,account_id,product_id)
);
CREATE TABLE commercial_assignment_history (
 assignment_id uuid NOT NULL REFERENCES commercial_assignments(id),revision integer NOT NULL,binding_id uuid NOT NULL REFERENCES records(id),state text NOT NULL,
 actor_id text NOT NULL,reason text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(assignment_id,revision)
);
CREATE TRIGGER immutable_assignment_history BEFORE UPDATE OR DELETE ON commercial_assignment_history FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE physical_chats (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL,environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 account_id uuid NOT NULL REFERENCES records(id),contact_id uuid NOT NULL REFERENCES records(id),revision integer NOT NULL DEFAULT 1,
 active_journey_id uuid REFERENCES records(id),selected_assignment_id uuid REFERENCES commercial_assignments(id),selection_at timestamptz,last_inbound_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,environment,account_id,contact_id)
);
CREATE INDEX commercial_assignment_catalog ON commercial_assignments(workspace_id,environment,product_id,state);
CREATE INDEX commercial_outbox_chat ON outbox(workspace_id,account_id,contact_id,dispatch_sequence) WHERE kind<>'warmup';
-- New V5 scopes are unique by product as well as routing scope. Legacy scope checks stay intact.
CREATE OR REPLACE FUNCTION guard_binding_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ad_parent text; campaign_parent text; scope_key text;
BEGIN
 IF NEW.kind<>'binding' THEN RETURN NEW; END IF;
 IF NEW.body->>'ad_id' IS NOT NULL THEN
 SELECT body->>'ad_set_id' INTO ad_parent FROM records WHERE id::text=NEW.body->>'ad_id' AND workspace_id=NEW.workspace_id AND environment=NEW.environment AND kind='ad';
 IF NEW.body->>'ad_set_id' IS NOT NULL AND NEW.body->>'ad_set_id' IS DISTINCT FROM ad_parent THEN RAISE EXCEPTION 'INVALID_BINDING_AD_SET'; END IF;
 END IF;
 IF COALESCE(NEW.body->>'ad_set_id',ad_parent) IS NOT NULL THEN
 SELECT body->>'campaign_id' INTO campaign_parent FROM records WHERE id::text=COALESCE(NEW.body->>'ad_set_id',ad_parent) AND workspace_id=NEW.workspace_id AND environment=NEW.environment AND kind='ad_set';
 IF NEW.body->>'campaign_id' IS NOT NULL AND NEW.body->>'campaign_id' IS DISTINCT FROM campaign_parent THEN RAISE EXCEPTION 'INVALID_BINDING_CAMPAIGN'; END IF;
 END IF;
 scope_key:=COALESCE(NEW.body->>'assignment_id',CASE WHEN NEW.body->>'ad_id' IS NOT NULL THEN 'ad:'||(NEW.body->>'ad_id') WHEN NEW.body->>'ad_set_id' IS NOT NULL THEN 'ad_set:'||(NEW.body->>'ad_set_id') WHEN NEW.body->>'campaign_id' IS NOT NULL THEN 'campaign:'||(NEW.body->>'campaign_id') ELSE 'account' END);
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id||':'||NEW.environment||':'||(NEW.body->>'account_id')||':'||scope_key,0));
 IF EXISTS(SELECT 1 FROM records r WHERE r.kind='binding' AND r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.body->>'account_id'=NEW.body->>'account_id' AND (r.body->>'valid_from')::timestamptz=(NEW.body->>'valid_from')::timestamptz AND COALESCE(r.body->>'assignment_id',CASE WHEN r.body->>'ad_id' IS NOT NULL THEN 'ad:'||(r.body->>'ad_id') WHEN r.body->>'ad_set_id' IS NOT NULL THEN 'ad_set:'||(r.body->>'ad_set_id') WHEN r.body->>'campaign_id' IS NOT NULL THEN 'campaign:'||(r.body->>'campaign_id') ELSE 'account' END)=scope_key) THEN RAISE EXCEPTION 'AMBIGUOUS_BINDING_SCOPE'; END IF;
 RETURN NEW;
END $$;
-- Materialize only a demonstrable legacy account package; no invented destination.
INSERT INTO records(workspace_id,environment,kind,body)
 SELECT a.workspace_id,a.environment,'binding',jsonb_strip_nulls(jsonb_build_object('account_id',a.id,'product_id',o.body->>'product_id','offer_version_id',o.id,'workflow_version_id',COALESCE(a.body->>'workflow_version_id',o.body->>'workflow_version_id'),'agent_version_id',COALESCE(a.body->>'agent_version_id',o.body->>'agent_version_id'),'valid_from',a.created_at,'source','v5_legacy_account_configuration','evidence','Preserved persisted account package; authorization not migrated','confidence','observed'))
 FROM records a JOIN records o ON o.id::text=a.body->>'offer_version_id' AND o.workspace_id=a.workspace_id AND o.environment=a.environment AND o.kind='offer'
 WHERE a.kind='channel_account' AND o.body->>'product_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records b WHERE b.kind='binding' AND b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.body->>'account_id'=a.id::text);
INSERT INTO commercial_assignments(workspace_id,environment,account_id,product_id,binding_id)
 SELECT DISTINCT ON(b.workspace_id,b.environment,b.body->>'account_id',o.body->>'product_id') b.workspace_id,b.environment,(b.body->>'account_id')::uuid,(o.body->>'product_id')::uuid,b.id
 FROM records b JOIN records o ON o.id::text=b.body->>'offer_version_id' AND o.workspace_id=b.workspace_id AND o.environment=b.environment
 WHERE b.kind='binding' AND o.kind='offer' AND o.body->>'product_id' IS NOT NULL
 ORDER BY b.workspace_id,b.environment,b.body->>'account_id',o.body->>'product_id',(b.body->>'valid_from')::timestamptz DESC,b.created_at DESC;
INSERT INTO commercial_assignment_history(assignment_id,revision,binding_id,state,actor_id,reason,recorded_at)
 SELECT a.id,row_number() OVER(PARTITION BY a.id ORDER BY (b.body->>'valid_from')::timestamptz,b.created_at,b.id)::integer,b.id,'ACTIVE','migration-v5','Preserved immutable assignment history; authorization requires review',b.created_at
 FROM commercial_assignments a JOIN records b ON b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.kind='binding' AND b.body->>'account_id'=a.account_id::text
 JOIN records o ON o.id::text=b.body->>'offer_version_id' AND o.body->>'product_id'=a.product_id::text;
UPDATE commercial_assignments a SET revision=(SELECT max(revision) FROM commercial_assignment_history h WHERE h.assignment_id=a.id);
INSERT INTO physical_chats(workspace_id,environment,account_id,contact_id,last_inbound_at)
 SELECT workspace_id,environment,(body->>'account_id')::uuid,(body->>'contact_id')::uuid,max((body->>'last_inbound_at')::timestamptz)
 FROM records WHERE kind='conversation' AND body->>'account_id' IS NOT NULL AND body->>'contact_id' IS NOT NULL GROUP BY workspace_id,environment,body->>'account_id',body->>'contact_id';

-- Add metadata as a new snapshot only where the existing pinned context matches.
UPDATE records c SET version=c.version+1,updated_at=now(),body=c.body||jsonb_build_object('physical_chat_id',p.id,'assignment_id',a.id,'assignment_revision',a.revision,'binding_id',a.binding_id,'product_id',a.product_id)
 FROM physical_chats p,commercial_assignments a,records b
 WHERE c.kind='conversation' AND c.workspace_id=p.workspace_id AND c.environment=p.environment AND c.body->>'account_id'=p.account_id::text AND c.body->>'contact_id'=p.contact_id::text
 AND a.workspace_id=c.workspace_id AND a.environment=c.environment AND a.account_id=p.account_id AND b.id=a.binding_id
 AND c.body->>'offer_version_id'=b.body->>'offer_version_id' AND c.body->>'workflow_version_id' IS NOT DISTINCT FROM b.body->>'workflow_version_id' AND c.body->>'agent_version_id' IS NOT DISTINCT FROM b.body->>'agent_version_id';
UPDATE operation_authorizations au SET revoked_at=COALESCE(revoked_at,now()) WHERE au.scope->>'mode'='channel_setup' AND EXISTS(SELECT 1 FROM commercial_assignments a WHERE a.workspace_id=au.workspace_id AND a.environment=au.environment AND au.scope->'account_ids' ? a.account_id::text);
UPDATE records r SET body=r.body||'{"active_authorization_id":null}'::jsonb,version=r.version+1,updated_at=now() WHERE r.kind='channel_account' AND r.body->>'active_authorization_id' IS NOT NULL AND EXISTS(SELECT 1 FROM commercial_assignments a WHERE a.account_id=r.id);

-- Runtime ownership: API configures, automation selects chat context, channel only reads/locks.
GRANT SELECT ON commercial_assignments,commercial_assignment_history,physical_chats TO commerce_api,commerce_automation,commerce_channel;
GRANT INSERT,UPDATE ON commercial_assignments TO commerce_api;
GRANT INSERT ON commercial_assignment_history TO commerce_api;
GRANT SELECT,INSERT,UPDATE ON physical_chats TO commerce_automation;
GRANT UPDATE ON physical_chats TO commerce_api;
-- Row locking needs UPDATE privilege. Only the FK-protected identity is granted;
-- runtime workers cannot change package, revision, state or authorization.
GRANT UPDATE(id) ON commercial_assignments TO commerce_automation,commerce_channel;
GRANT UPDATE(status) ON timers TO commerce_api;
GRANT UPDATE(result) ON outbox TO commerce_api;
