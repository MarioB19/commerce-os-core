-- V5 recovery ledger is append-only history; no tables/assets/old grants are deleted.
CREATE TABLE platform_retirement_ledger (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id text NOT NULL, environment text NOT NULL, kind text NOT NULL,
 resource_id text NOT NULL, snapshot jsonb NOT NULL, disposition text NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT now(), UNIQUE(kind,resource_id)
);
INSERT INTO platform_retirement_ledger(workspace_id,environment,kind,resource_id,snapshot,disposition)
 SELECT workspace_id,environment,'SPONSORSHIP',id::text,to_jsonb(s),'LEGACY_COMMITMENT_REVIEW_NO_NEW_EFFECTS' FROM mcl_sponsorships s;
INSERT INTO platform_retirement_ledger(workspace_id,environment,kind,resource_id,snapshot,disposition)
 SELECT workspace_id,environment,'RENDER_JOB',id::text,to_jsonb(j)-'plan_inputs'-'production_authorization',
 CASE WHEN status='RUNNING' THEN 'RECONCILE_IN_FLIGHT_NO_REPLAY' ELSE 'ARCHIVED_NO_REPLAY' END FROM creative_jobs j;
INSERT INTO platform_retirement_ledger(workspace_id,environment,kind,resource_id,snapshot,disposition)
 SELECT workspace_id,environment,'VOICE_OPERATION',id::text,to_jsonb(v)-'request',
 CASE WHEN status IN('RUNNING','UNKNOWN','REQUESTED','PAID_PENDING_STORAGE') THEN 'RECONCILE_PROVIDER_AND_STORAGE_NO_REPLAY' ELSE 'ARCHIVED_NO_REPLAY' END FROM creative_voice_operations v;
-- Do not release paid/uncertain reservations. Intelligence and shared budgets are untouched.
UPDATE creative_jobs SET status=CASE WHEN status='RUNNING' THEN 'REVIEW' ELSE 'CANCELLED' END,
 error_code=CASE WHEN status='RUNNING' THEN 'V5_RECONCILIATION_REQUIRED' ELSE 'PLATFORM_PRODUCTION_RETIRED' END,version=version+1,updated_at=now()
 WHERE status IN('QUEUED','RETRY','RUNNING');
UPDATE creative_devices SET status='REVOKED',revoked_at=COALESCE(revoked_at,now()),version=version+1 WHERE status<>'REVOKED';
UPDATE creative_pairings SET status='EXPIRED',version=version+1 WHERE status IN('PENDING','APPROVED');
UPDATE creative_voice_operations SET status='UNKNOWN',error_code='V5_RECONCILIATION_REQUIRED',version=version+1,updated_at=now() WHERE status IN('REQUESTED','RUNNING');
UPDATE creative_voice_operations SET status='FAILED',error_code='PLATFORM_PRODUCTION_RETIRED',version=version+1,updated_at=now() WHERE status='QUOTED';
UPDATE outbox SET status='CANCELLED',result=result||'{"reason":"SPONSORSHIP_RETIRED","external_effects":0}'::jsonb,updated_at=now()
 WHERE status IN('READY','BLOCKED') AND (payload ? 'sponsorship_id' OR payload->>'purpose' IN('sponsorship','sponsorship_notice'));
-- Unknown/sending effects remain reconcilable. Restoration of an old offer cannot revive sponsorship.
CREATE FUNCTION v5_block_new_sponsorship() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'SPONSORSHIP_RETIRED';
END $$;
CREATE TRIGGER v5_no_new_sponsorship BEFORE INSERT ON mcl_sponsorships FOR EACH ROW EXECUTE FUNCTION v5_block_new_sponsorship();
CREATE FUNCTION v5_block_retired_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.payload ? 'sponsorship_id' OR NEW.payload->>'purpose' IN('sponsorship','sponsorship_notice') THEN RAISE EXCEPTION 'SPONSORSHIP_RETIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER v5_no_new_sponsorship_effect BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION v5_block_retired_outbox();
CREATE FUNCTION v5_block_remote_production() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'PLATFORM_PRODUCTION_RETIRED';
END $$;
CREATE TRIGGER v5_no_new_render BEFORE INSERT ON creative_jobs FOR EACH ROW EXECUTE FUNCTION v5_block_remote_production();
CREATE TRIGGER v5_no_new_voice BEFORE INSERT ON creative_voice_operations FOR EACH ROW EXECUTE FUNCTION v5_block_remote_production();
GRANT SELECT ON platform_retirement_ledger TO commerce_api,commerce_automation;
