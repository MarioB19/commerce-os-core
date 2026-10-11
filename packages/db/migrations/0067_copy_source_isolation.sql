-- Root technical evidence and operator declaration remain separate.
ALTER TABLE ownership_isolation_receipts DROP CONSTRAINT ownership_isolation_receipts_method_check;
ALTER TABLE ownership_isolation_receipts ADD CONSTRAINT ownership_isolation_receipts_method_check
 CHECK(method IN ('container_stopped_and_access_revoked','source_billing_disabled_and_primary_device_revoked'));
CREATE TABLE copy_source_isolation_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id text NOT NULL, environment text NOT NULL CHECK(environment='REAL'),
 account_id uuid NOT NULL REFERENCES records(id),
 account_version integer NOT NULL CHECK(account_version>0),
 session_revision bigint NOT NULL CHECK(session_revision>0),
 previous_owner_id text NOT NULL CHECK(length(previous_owner_id)>0),
 generation integer NOT NULL CHECK(generation>0),
 credential_generation integer NOT NULL CHECK(credential_generation>0),
 primary_device_id text NOT NULL CHECK(length(primary_device_id)>0),
 responsible_user_id text NOT NULL,
 source_project text NOT NULL CHECK(source_project='vibe-conversa-prod'),
 billing_enabled boolean NOT NULL CHECK(billing_enabled=false),
 technical_evidence_sha256 text NOT NULL CHECK(technical_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 technical_observed_at timestamptz NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 primary_revocation_reported_at timestamptz,
 primary_revocation_reported_by text,
 primary_report_source text CHECK(primary_report_source IN ('owner_confirmation','personal_owner_report')),
 completed_receipt_id uuid UNIQUE REFERENCES ownership_isolation_receipts(id),
 CHECK(technical_observed_at<=issued_at AND technical_observed_at>issued_at-interval '24 hours'),
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '12 hours'),
 CHECK((primary_revocation_reported_at IS NULL AND primary_revocation_reported_by IS NULL AND primary_report_source IS NULL)
  OR (primary_revocation_reported_at IS NOT NULL AND primary_revocation_reported_by IS NOT NULL AND primary_report_source IS NOT NULL AND primary_revocation_reported_at>=issued_at AND primary_revocation_reported_at<=expires_at AND length(primary_revocation_reported_by)>0))
);
CREATE INDEX copy_source_isolation_available ON copy_source_isolation_challenges(account_id,expires_at DESC);
REVOKE ALL ON copy_source_isolation_challenges FROM PUBLIC;
GRANT SELECT ON copy_source_isolation_challenges TO commerce_api;
GRANT UPDATE(primary_revocation_reported_at,primary_revocation_reported_by,primary_report_source) ON copy_source_isolation_challenges TO commerce_api;
CREATE FUNCTION guard_copy_source_isolation_challenge() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['primary_revocation_reported_at','primary_revocation_reported_by','primary_report_source','completed_receipt_id']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['primary_revocation_reported_at','primary_revocation_reported_by','primary_report_source','completed_receipt_id'] THEN RAISE EXCEPTION 'IMMUTABLE_COPY_SOURCE_CHALLENGE'; END IF;
 IF OLD.primary_revocation_reported_at IS NOT NULL AND
  ROW(NEW.primary_revocation_reported_at,NEW.primary_revocation_reported_by,NEW.primary_report_source)
  IS DISTINCT FROM ROW(OLD.primary_revocation_reported_at,OLD.primary_revocation_reported_by,OLD.primary_report_source) THEN RAISE EXCEPTION 'IMMUTABLE_PRIMARY_REVOCATION_REPORT'; END IF;
 IF OLD.completed_receipt_id IS NOT NULL AND NEW.completed_receipt_id IS DISTINCT FROM OLD.completed_receipt_id THEN RAISE EXCEPTION 'IMMUTABLE_COPY_SOURCE_RECEIPT'; END IF;
 IF NEW.completed_receipt_id IS NOT NULL AND NEW.primary_revocation_reported_at IS NULL THEN RAISE EXCEPTION 'PRIMARY_REVOCATION_REPORT_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_copy_source_isolation_challenge BEFORE UPDATE ON copy_source_isolation_challenges
 FOR EACH ROW EXECUTE FUNCTION guard_copy_source_isolation_challenge();

-- Return only the eligible receipt; channel workers do not read declarations or memberships.
CREATE FUNCTION public.read_copy_source_isolation_receipt(
 p_account_id uuid,p_workspace_id text,p_previous_owner_id text,p_generation integer,p_receipt_id uuid
) RETURNS TABLE(id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_receipt uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('channel-command:'||p_account_id::text,0));
 SELECT r.id INTO v_receipt FROM public.ownership_isolation_receipts r
 WHERE r.account_id=p_account_id AND r.workspace_id=p_workspace_id AND r.previous_owner_id=p_previous_owner_id AND r.generation=p_generation
  AND r.method='source_billing_disabled_and_primary_device_revoked' AND r.consumed_at IS NULL
  AND (p_receipt_id IS NULL OR r.id=p_receipt_id) ORDER BY r.verified_at DESC LIMIT 1 FOR UPDATE;
 IF v_receipt IS NULL THEN RETURN; END IF;
 -- Re-evaluate all bindings and actual time after any lock wait.
 RETURN QUERY SELECT r.id FROM public.ownership_isolation_receipts r
  JOIN public.copy_source_isolation_challenges c ON c.completed_receipt_id=r.id AND c.account_id=r.account_id AND c.workspace_id=r.workspace_id
  JOIN public.channel_sessions s ON s.account_id=c.account_id AND s.workspace_id=c.workspace_id AND s.environment=c.environment
  JOIN public.records a ON a.id=c.account_id AND a.workspace_id=c.workspace_id AND a.environment=c.environment
  WHERE r.id=v_receipt AND r.account_id=p_account_id AND r.workspace_id=p_workspace_id AND r.previous_owner_id=p_previous_owner_id AND r.generation=p_generation
   AND r.method='source_billing_disabled_and_primary_device_revoked' AND r.consumed_at IS NULL
   AND r.verified_at<=clock_timestamp() AND r.verified_at>clock_timestamp()-interval '24 hours'
   AND c.previous_owner_id=r.previous_owner_id AND c.generation=r.generation
   AND c.environment='REAL' AND c.source_project='vibe-conversa-prod' AND NOT c.billing_enabled
   AND c.technical_observed_at<=c.issued_at AND c.technical_observed_at>r.verified_at-interval '24 hours'
   AND c.primary_revocation_reported_at>=c.issued_at AND c.primary_revocation_reported_at<=r.verified_at
   AND c.primary_report_source IN ('owner_confirmation','personal_owner_report')
   AND c.expires_at>clock_timestamp() AND c.credential_generation=s.credential_generation
   AND c.primary_device_id=s.primary_device_id AND c.responsible_user_id=s.responsible_user_id
   AND s.archived_at IS NULL AND a.kind='channel_account' AND a.body->>'provider'='waha'
   AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=c.responsible_user_id AND m.active)
   AND (p_receipt_id::uuid IS NULL OR r.id=p_receipt_id) ORDER BY r.verified_at DESC LIMIT 1;
END $$;
REVOKE ALL ON FUNCTION public.read_copy_source_isolation_receipt(uuid,text,text,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_copy_source_isolation_receipt(uuid,text,text,integer,uuid) TO commerce_channel;
