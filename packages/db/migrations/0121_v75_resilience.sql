-- V7.5: recuperación, propiedad, avisos e IA vendedora. Additive; see
-- docs/adr-v7-5-resilience.md. No session, consent, program, permission or
-- commercial assignment is created, lifted or rewritten here.

-- §5 H01. A temporarily unreadable provider is recorded as UNKNOWN, not as a
-- failed account. Historical FAILED samples are kept as they were.
ALTER TABLE warmup_observations DROP CONSTRAINT warmup_observations_kind_check;
ALTER TABLE warmup_observations ADD CONSTRAINT warmup_observations_kind_check
 CHECK(kind IN('HEALTHY','FAILED','CONFIRMED_BLOCK','INTERNAL_MESSAGE','UNKNOWN'));

-- §2 H02. A human-reviewed recovery of a group protection records its cut:
-- failures observed up to this instant were reviewed and do not reopen it;
-- a later failure does. NULL keeps the V7.4 behaviour.
ALTER TABLE warmup_pools ADD COLUMN breaker_reviewed_until timestamptz;
ALTER TABLE warmup_pools ADD COLUMN breaker_opened_at timestamptz;

-- §4 H12/H13. Why an ownership is frozen. Only the health reader declares a
-- health cause (transaction-local setting): an unknown read, a confirmed
-- disconnection or a blocking signal. Every other freeze, including the
-- installer, a manual freeze, a transfer or a failed command, is UNSPECIFIED.
-- While frozen, a blocking or unspecified cause is never downgraded; the two
-- recoverable health causes follow the latest health classification.
ALTER TABLE session_ownership ADD COLUMN freeze_reason text
 CHECK(freeze_reason IS NULL OR freeze_reason IN('HEALTH_UNKNOWN','HEALTH_DISCONNECTED','HEALTH_BLOCKED','UNSPECIFIED','LEGACY_UNSPECIFIED'));
UPDATE session_ownership SET freeze_reason='LEGACY_UNSPECIFIED' WHERE frozen;
CREATE FUNCTION session_ownership_freeze_reason() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE requested text:=NULLIF(current_setting('commerce.freeze_reason',true),'');
BEGIN
 IF NOT NEW.frozen THEN NEW.freeze_reason:=NULL; RETURN NEW; END IF;
 IF requested IS NULL OR requested NOT IN('HEALTH_UNKNOWN','HEALTH_DISCONNECTED','HEALTH_BLOCKED') THEN requested:='UNSPECIFIED'; END IF;
 IF TG_OP='UPDATE' AND OLD.frozen AND (OLD.freeze_reason IS NULL OR OLD.freeze_reason NOT IN('HEALTH_UNKNOWN','HEALTH_DISCONNECTED')) THEN
  NEW.freeze_reason:=COALESCE(OLD.freeze_reason,'UNSPECIFIED'); RETURN NEW;
 END IF;
 NEW.freeze_reason:=requested; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION session_ownership_freeze_reason() FROM PUBLIC;
CREATE TRIGGER session_ownership_freeze_reason_insert BEFORE INSERT ON session_ownership FOR EACH ROW EXECUTE FUNCTION session_ownership_freeze_reason();
CREATE TRIGGER session_ownership_freeze_reason_update BEFORE UPDATE OF frozen ON session_ownership FOR EACH ROW EXECUTE FUNCTION session_ownership_freeze_reason();

-- §6 H10/H11. Incident, notification and human acknowledgement are separate.
-- An incident is open while resolved_at IS NULL and it was not merged into an
-- earlier episode of the same cause. `status` stays the notification state.
ALTER TABLE operational_alerts ADD COLUMN first_observed_at timestamptz;
ALTER TABLE operational_alerts ADD COLUMN last_observed_at timestamptz;
ALTER TABLE operational_alerts ADD COLUMN observations integer NOT NULL DEFAULT 1 CHECK(observations>0);
ALTER TABLE operational_alerts ADD COLUMN superseded_by uuid CHECK(superseded_by IS DISTINCT FROM id);
UPDATE operational_alerts SET first_observed_at=created_at,last_observed_at=created_at;
ALTER TABLE operational_alerts ALTER COLUMN first_observed_at SET DEFAULT now();
ALTER TABLE operational_alerts ALTER COLUMN last_observed_at SET DEFAULT now();
ALTER TABLE operational_alerts ALTER COLUMN first_observed_at SET NOT NULL;
ALTER TABLE operational_alerts ALTER COLUMN last_observed_at SET NOT NULL;
-- Rule 1: a historical writer declared these resolved through `status` only.
UPDATE operational_alerts SET resolved_at=updated_at,
 evidence=evidence||jsonb_build_object('resolution','LEGACY_STATUS_RESOLVED')
 WHERE status='RESOLVED' AND resolved_at IS NULL;
-- Rule 2: hourly duplicates of one open global cause become one episode. The
-- oldest row is the episode; the others point to it, keep their history and
-- acknowledgement, and are not declared resolved.
WITH ranked AS (
 SELECT id,row_number() OVER w AS n,first_value(id) OVER w AS episode,count(*) OVER (PARTITION BY workspace_id,environment,kind) AS total,
  max(created_at) OVER (PARTITION BY workspace_id,environment,kind) AS latest
 FROM operational_alerts WHERE account_id IS NULL AND resolved_at IS NULL
 WINDOW w AS (PARTITION BY workspace_id,environment,kind ORDER BY created_at,id)
), merged AS (
 UPDATE operational_alerts a SET superseded_by=r.episode,
  evidence=a.evidence||jsonb_build_object('merged_into_episode',r.episode::text)
 FROM ranked r WHERE a.id=r.id AND r.n>1 RETURNING a.id
)
UPDATE operational_alerts a SET observations=r.total,last_observed_at=r.latest
 FROM ranked r WHERE a.id=r.id AND r.n=1;
-- Rule 3: one open episode per global cause from now on.
CREATE UNIQUE INDEX operational_alert_global_episode ON operational_alerts(workspace_id,environment,kind)
 WHERE account_id IS NULL AND resolved_at IS NULL AND superseded_by IS NULL;
CREATE INDEX operational_alert_pending ON operational_alerts(workspace_id,environment,created_at DESC,id DESC)
 WHERE resolved_at IS NULL AND superseded_by IS NULL AND acknowledged_at IS NULL;

-- §6 H11. Backup currency from the producer the installation actually runs
-- (pgBackRest runs recorded by the PITR timers), bounded and content-free.
CREATE FUNCTION platform_backup_currency() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object(
  'last_success_at',(SELECT max(finished_at) FROM public.platform_backup_runs WHERE status='SUCCEEDED'),
  'last_full_at',(SELECT max(finished_at) FROM public.platform_backup_runs WHERE status='SUCCEEDED' AND kind='PITR_FULL'),
  'last_failure_at',(SELECT max(finished_at) FROM public.platform_backup_runs WHERE status='FAILED'),
  'checked_at',now())
$$;
REVOKE ALL ON FUNCTION platform_backup_currency() FROM PUBLIC;
DO $$BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commerce_automation') THEN
  GRANT EXECUTE ON FUNCTION platform_backup_currency() TO commerce_automation;
 END IF;
END$$;
