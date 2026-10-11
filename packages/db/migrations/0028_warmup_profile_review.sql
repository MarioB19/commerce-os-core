-- Explicit read-only reconciliation after uncertain profile writes; never a write retry.
ALTER TABLE warmup_identities ADD COLUMN profile_review_requested_at timestamptz;
GRANT UPDATE(profile_review_requested_at) ON warmup_identities TO commerce_api,commerce_channel;
GRANT UPDATE(window_start) ON warmup_rate_reservations TO commerce_channel;

-- Deleted accounts must remain auditable/quarantinable; only enrolment requires a live account.
CREATE OR REPLACE FUNCTION guard_warmup_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM records WHERE id=NEW.account_id AND workspace_id=NEW.workspace_id AND environment=NEW.environment AND kind='channel_account' AND (TG_OP='UPDATE' OR NOT(body?'deleted_at'))) THEN RAISE EXCEPTION 'WARMUP_ACCOUNT_SCOPE_INVALID'; END IF;
 IF TG_OP='UPDATE' AND (NEW.account_id<>OLD.account_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.environment<>OLD.environment) THEN RAISE EXCEPTION 'WARMUP_SCOPE_IMMUTABLE'; END IF;
 RETURN NEW; END $$;
