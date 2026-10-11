-- ADR-005: ordinary roles cannot bypass immutable history. Maintenance is separate.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_maintenance') THEN CREATE ROLE commerce_maintenance NOLOGIN; END IF; END $$;
CREATE TABLE retention_policies(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL CHECK(environment IN('SIMULATION','REAL')),approved_by text NOT NULL,approved_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,ttl jsonb NOT NULL,reason text NOT NULL,revoked_at timestamptz);
CREATE TABLE retention_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),policy_id uuid NOT NULL REFERENCES retention_policies(id),plan_digest text NOT NULL,manifest jsonb NOT NULL,status text NOT NULL DEFAULT 'PLANNED' CHECK(status IN('PLANNED','APPLYING','APPLIED')),created_at timestamptz NOT NULL DEFAULT now(),applied_at timestamptz,result jsonb NOT NULL DEFAULT '{}');
CREATE TABLE retention_tombstones(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL,resource_kind text NOT NULL,resource_id text NOT NULL,source_hash text NOT NULL,policy_id uuid NOT NULL REFERENCES retention_policies(id),plan_id uuid NOT NULL REFERENCES retention_plans(id),actor_id text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(plan_id,resource_kind,resource_id));
CREATE TABLE retention_files(tombstone_id uuid PRIMARY KEY REFERENCES retention_tombstones(id),storage_key text NOT NULL,status text NOT NULL DEFAULT 'PENDING',removed_at timestamptz,error text);
ALTER TABLE idempotency ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
GRANT USAGE ON SCHEMA public TO commerce_maintenance;
GRANT SELECT ON records,record_versions,inbound_envelopes,outbox,commands,timers,idempotency,memberships,retention_policies,retention_plans,retention_tombstones,retention_files TO commerce_maintenance;
GRANT SELECT,INSERT,UPDATE ON retention_policies TO commerce_api;
GRANT SELECT ON retention_plans,retention_tombstones TO commerce_api;
GRANT INSERT,UPDATE ON retention_plans,retention_files TO commerce_maintenance;
CREATE FUNCTION retention_context_valid() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT EXISTS(SELECT 1 FROM retention_plans WHERE id::text=current_setting('commerce.retention_plan',true) AND status='APPLYING') AND (EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper) OR pg_has_role(session_user,'commerce_maintenance','member')) $$;
REVOKE ALL ON FUNCTION retention_context_valid() FROM PUBLIC;
CREATE OR REPLACE FUNCTION immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_TABLE_NAME='record_versions' AND TG_OP='UPDATE' AND retention_context_valid() THEN RETURN NEW; END IF; RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END $$;
CREATE TRIGGER immutable_retention_tombstones BEFORE UPDATE OR DELETE ON retention_tombstones FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE OR REPLACE FUNCTION enforce_sealed_versions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.kind='agent' THEN RAISE EXCEPTION 'IMMUTABLE_VERSION'; END IF;
 IF OLD.kind='asset' AND OLD.body->>'status'='READY' AND NOT(retention_context_valid() AND NEW.body->>'status'='RETAINED') THEN RAISE EXCEPTION 'IMMUTABLE_ASSET'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_envelope_original() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF retention_context_valid() AND NEW.payload_ciphertext='REDACTED:'||encode(digest(OLD.payload_ciphertext,'sha256'),'hex') AND NEW.workspace_id=OLD.workspace_id AND NEW.environment=OLD.environment AND NEW.account_id=OLD.account_id AND NEW.provider=OLD.provider AND NEW.provider_event_id=OLD.provider_event_id AND NEW.metadata=OLD.metadata AND NEW.occurred_at=OLD.occurred_at AND NEW.received_at=OLD.received_at THEN RETURN NEW; END IF;
 IF NEW.workspace_id<>OLD.workspace_id OR NEW.environment<>OLD.environment OR NEW.account_id<>OLD.account_id OR NEW.provider<>OLD.provider OR NEW.provider_event_id<>OLD.provider_event_id OR NEW.payload_ciphertext<>OLD.payload_ciphertext OR NEW.metadata<>OLD.metadata OR NEW.occurred_at<>OLD.occurred_at OR NEW.received_at<>OLD.received_at THEN RAISE EXCEPTION 'IMMUTABLE_ENVELOPE'; END IF; RETURN NEW;
END $$;
-- Trigger functions invoke this check as invoker; only boolean context metadata is exposed.
GRANT EXECUTE ON FUNCTION retention_context_valid() TO commerce_api,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance;
CREATE FUNCTION apply_retention_plan(plan_uuid uuid,confirmed_digest text,allow_real boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE plan retention_plans%ROWTYPE; policy retention_policies%ROWTYPE; item jsonb; row_record records%ROWTYPE; envelope inbound_envelopes%ROWTYPE; effect outbox%ROWTYPE; idem idempotency%ROWTYPE; source_digest text; tombstone uuid; fields text[]; count_applied integer:=0; record_cutoff timestamptz;
BEGIN
 SELECT * INTO plan FROM retention_plans WHERE id=plan_uuid FOR UPDATE;
 IF NOT FOUND OR plan.plan_digest<>confirmed_digest THEN RAISE EXCEPTION 'RETENTION_PLAN_DIGEST_MISMATCH'; END IF;
 IF plan.status='APPLIED' THEN RETURN plan.result; END IF;
 SELECT * INTO policy FROM retention_policies WHERE id=plan.policy_id;
 IF policy.revoked_at IS NOT NULL OR policy.expires_at<=now() OR NOT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=policy.workspace_id AND user_id=policy.approved_by AND role='owner' AND active) THEN RAISE EXCEPTION 'RETENTION_POLICY_NOT_APPROVED'; END IF;
 IF plan.manifest->>'workspace_id'<>policy.workspace_id OR plan.manifest->>'environment'<>policy.environment THEN RAISE EXCEPTION 'RETENTION_SCOPE_MISMATCH'; END IF;
 IF policy.environment='REAL' AND NOT allow_real THEN RAISE EXCEPTION 'REAL_RETENTION_NOT_AUTHORIZED'; END IF;
 UPDATE retention_plans SET status='APPLYING' WHERE id=plan_uuid;
 PERFORM set_config('commerce.retention_plan',plan_uuid::text,true);
 FOR item IN SELECT * FROM jsonb_array_elements(plan.manifest->'candidates') LOOP
  IF item->>'kind'='envelope' THEN
   SELECT * INTO envelope FROM inbound_envelopes WHERE id::text=item->>'id' AND workspace_id=policy.workspace_id AND environment=policy.environment FOR UPDATE;
   IF NOT FOUND OR envelope.status NOT IN('PROCESSED','FAILED') OR envelope.received_at>plan.created_at-((policy.ttl->>'envelopes_days')::integer*interval '1 day') THEN RAISE EXCEPTION 'RETENTION_CANDIDATE_CHANGED'; END IF;
   source_digest:=encode(digest(envelope.payload_ciphertext,'sha256'),'hex');IF source_digest<>item->>'snapshot_hash' THEN RAISE EXCEPTION 'RETENTION_CANDIDATE_CHANGED'; END IF;
   INSERT INTO retention_tombstones(workspace_id,environment,resource_kind,resource_id,source_hash,policy_id,plan_id,actor_id,metadata) VALUES(policy.workspace_id,policy.environment,'envelope',envelope.id::text,source_digest,policy.id,plan_uuid,policy.approved_by,jsonb_build_object('provider',envelope.provider,'provider_event_id',envelope.provider_event_id,'received_at',envelope.received_at));
   UPDATE inbound_envelopes SET payload_ciphertext='REDACTED:'||source_digest WHERE id=envelope.id;
  ELSIF item->>'kind' IN('message','conversation','ai_run','asset') THEN
   SELECT * INTO row_record FROM records WHERE id::text=item->>'id' AND workspace_id=policy.workspace_id AND environment=policy.environment AND kind=item->>'kind' FOR UPDATE;
   record_cutoff:=plan.created_at-((policy.ttl->>CASE WHEN item->>'kind'='asset' THEN 'assets_days' WHEN item->>'kind'='ai_run' THEN 'ai_days' ELSE 'messages_days' END)::integer*interval '1 day');
   IF NOT FOUND OR row_record.updated_at>record_cutoff OR row_record.version<>(item->>'version')::integer THEN RAISE EXCEPTION 'RETENTION_CANDIDATE_CHANGED'; END IF;
   source_digest:=encode(digest(row_record.body::text,'sha256'),'hex');IF source_digest<>item->>'snapshot_hash' THEN RAISE EXCEPTION 'RETENTION_CANDIDATE_CHANGED'; END IF;
   IF EXISTS(SELECT 1 FROM outbox WHERE workspace_id=policy.workspace_id AND conversation_id=COALESCE(row_record.body->>'conversation_id',row_record.id::text) AND status IN('READY','BLOCKED','SENDING','UNKNOWN')) THEN RAISE EXCEPTION 'RETENTION_IN_FLIGHT'; END IF;
   IF row_record.kind='asset' THEN
    IF EXISTS(SELECT 1 FROM records r WHERE r.id<>row_record.id AND r.body::text LIKE '%'||row_record.id::text||'%') OR EXISTS(SELECT 1 FROM record_versions v WHERE v.record_id<>row_record.id AND v.body::text LIKE '%'||row_record.id::text||'%') OR EXISTS(SELECT 1 FROM outbox o WHERE o.payload::text LIKE '%'||row_record.id::text||'%') OR EXISTS(SELECT 1 FROM commands c WHERE c.payload::text LIKE '%'||row_record.id::text||'%') THEN RAISE EXCEPTION 'RETENTION_ASSET_REFERENCED'; END IF;
    fields:=ARRAY['storage_key','delivery_ciphertext'];
   ELSIF row_record.kind='message' THEN fields:=ARRAY['text'];
   ELSIF row_record.kind='conversation' THEN fields:=ARRAY['last_customer_text'];
   ELSE fields:=ARRAY['proposal','response','output','input']; END IF;
   INSERT INTO retention_tombstones(workspace_id,environment,resource_kind,resource_id,source_hash,policy_id,plan_id,actor_id,metadata) VALUES(policy.workspace_id,policy.environment,row_record.kind,row_record.id::text,source_digest,policy.id,plan_uuid,policy.approved_by,jsonb_build_object('version',row_record.version,'fields',fields)) RETURNING id INTO tombstone;
   IF row_record.kind='asset' THEN INSERT INTO retention_files(tombstone_id,storage_key) VALUES(tombstone,row_record.body->>'storage_key'); END IF;
   UPDATE record_versions SET body=(body-fields)||jsonb_build_object('content_redacted',true,'retention_plan_id',plan_uuid,'retained_payload_hash',encode(digest(body::text,'sha256'),'hex')) WHERE record_id=row_record.id;
   UPDATE records SET body=(body-fields)||jsonb_build_object('content_redacted',true,'retention_plan_id',plan_uuid,'retained_payload_hash',source_digest)||CASE WHEN row_record.kind='asset' THEN '{"status":"RETAINED"}'::jsonb ELSE '{}'::jsonb END,version=version+1,updated_at=now() WHERE id=row_record.id;
  ELSIF item->>'kind'='outbox' THEN
   SELECT * INTO effect FROM outbox WHERE id::text=item->>'id' AND workspace_id=policy.workspace_id AND environment=policy.environment FOR UPDATE;
   IF NOT FOUND OR effect.status NOT IN('SENT','DELIVERED','READ','FAILED','CANCELLED') OR effect.updated_at>plan.created_at-((policy.ttl->>'messages_days')::integer*interval '1 day') THEN RAISE EXCEPTION 'RETENTION_CANDIDATE_CHANGED'; END IF;
   source_digest:=encode(digest(effect.payload::text,'sha256'),'hex');IF source_digest<>item->>'snapshot_hash' THEN RAISE EXCEPTION 'RETENTION_CANDIDATE_CHANGED'; END IF;
   INSERT INTO retention_tombstones(workspace_id,environment,resource_kind,resource_id,source_hash,policy_id,plan_id,actor_id) VALUES(policy.workspace_id,policy.environment,'outbox',effect.id::text,source_digest,policy.id,plan_uuid,policy.approved_by);
   UPDATE outbox SET payload=(payload-'text')||jsonb_build_object('content_redacted',true,'retained_payload_hash',source_digest,'retention_plan_id',plan_uuid),updated_at=now() WHERE id=effect.id;
  ELSIF item->>'kind'='idempotency' THEN
   SELECT * INTO idem FROM idempotency WHERE workspace_id=policy.workspace_id AND actor_id=item->>'actor_id' AND operation=item->>'operation' AND key=item->>'key' FOR UPDATE;
   IF NOT FOUND OR idem.created_at>plan.created_at-((policy.ttl->>'idempotency_days')::integer*interval '1 day') OR idem.response->>'environment' IS DISTINCT FROM policy.environment THEN RAISE EXCEPTION 'RETENTION_CANDIDATE_CHANGED'; END IF;
   source_digest:=encode(digest(idem.response::text,'sha256'),'hex');IF source_digest<>item->>'snapshot_hash' THEN RAISE EXCEPTION 'RETENTION_CANDIDATE_CHANGED'; END IF;
   INSERT INTO retention_tombstones(workspace_id,environment,resource_kind,resource_id,source_hash,policy_id,plan_id,actor_id) VALUES(policy.workspace_id,policy.environment,'idempotency',item->>'id',source_digest,policy.id,plan_uuid,policy.approved_by);
   UPDATE idempotency SET response=jsonb_build_object('_retained',true,'retained_payload_hash',source_digest,'retention_plan_id',plan_uuid),status_code=410 WHERE workspace_id=idem.workspace_id AND actor_id=idem.actor_id AND operation=idem.operation AND key=idem.key;
  ELSE RAISE EXCEPTION 'RETENTION_KIND_UNSUPPORTED'; END IF;
  count_applied:=count_applied+1;
 END LOOP;
 UPDATE retention_plans SET status='APPLIED',applied_at=now(),result=jsonb_build_object('redacted',count_applied,'plan_id',plan_uuid,'file_deletions_pending',(SELECT count(*) FROM retention_files f JOIN retention_tombstones t ON t.id=f.tombstone_id WHERE t.plan_id=plan_uuid AND f.status='PENDING')) WHERE id=plan_uuid RETURNING result INTO plan.result;
 PERFORM set_config('commerce.retention_plan','',true);
 RETURN plan.result;
END $$;
REVOKE ALL ON FUNCTION apply_retention_plan(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_retention_plan(uuid,text,boolean) TO commerce_maintenance;
