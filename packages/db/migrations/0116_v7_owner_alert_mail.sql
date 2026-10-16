-- V7 RF-07.e (ADR-V7-13): the owner's e-mail for a number incident and for
-- its recovery, one per incident, through the same App Engine dispatcher,
-- quotas and monthly mail budget as invitations. The notice in the app stays
-- whatever happens to the mail. Messages name the kind of incident and link
-- to the app; never a customer, a phone or a secret.
DO $$BEGIN
 IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'OWNER_ALERT_MAIL_OWNER_REQUIRED';
 END IF;
END$$;

CREATE TABLE owner_alert_mail_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id text NOT NULL REFERENCES profiles(id),
 alert_id uuid NOT NULL, -- operational_alerts.id of this profile; checked by the closed functions
 event text NOT NULL CHECK(event IN('OPENED','RESOLVED')),
 recipient_user_id text NOT NULL REFERENCES "user"(id),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RESERVED','SENDING','ACCEPTED','REJECTED','UNCERTAIN','SKIPPED')),
 skip_reason text CHECK(skip_reason IS NULL OR skip_reason ~ '^[A-Z_]{3,60}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(alert_id,event,recipient_user_id),UNIQUE(id,workspace_id),
 CHECK((status='SKIPPED')=(skip_reason IS NOT NULL))
);
CREATE INDEX owner_alert_mail_queued ON owner_alert_mail_jobs(workspace_id,created_at) WHERE status='QUEUED';
CREATE TABLE owner_alert_mail_attempts (
 attempt_id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES profiles(id),
 job_id uuid NOT NULL UNIQUE,
 state text NOT NULL CHECK(state IN('RESERVED','SENDING','ACCEPTED','REJECTED','UNCERTAIN')),
 reserved_micro_usd integer NOT NULL CHECK(reserved_micro_usd=15467),
 budget_months text[] NOT NULL CHECK(cardinality(budget_months) BETWEEN 1 AND 2),
 dispatched_at timestamptz NOT NULL,authorized_until timestamptz NOT NULL,
 body_sha256 text CHECK(body_sha256 IS NULL OR body_sha256 ~ '^[a-f0-9]{64}$'),send_claimed_at timestamptz,completed_at timestamptz,
 FOREIGN KEY(job_id,workspace_id) REFERENCES owner_alert_mail_jobs(id,workspace_id),
 CHECK(isfinite(dispatched_at) AND authorized_until=dispatched_at+interval '120 seconds'),
 CHECK((body_sha256 IS NULL)=(send_claimed_at IS NULL)),
 CHECK((state IN('ACCEPTED','REJECTED','UNCERTAIN'))=(completed_at IS NOT NULL)),
 CHECK(state<>'SENDING' OR send_claimed_at IS NOT NULL)
);
CREATE INDEX owner_alert_mail_clock ON owner_alert_mail_attempts(dispatched_at);
ALTER TABLE owner_alert_mail_jobs ENABLE ROW LEVEL SECURITY;ALTER TABLE owner_alert_mail_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE owner_alert_mail_attempts ENABLE ROW LEVEL SECURITY;ALTER TABLE owner_alert_mail_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_scope ON owner_alert_mail_jobs USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY profile_scope ON owner_alert_mail_attempts USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
REVOKE ALL ON owner_alert_mail_jobs,owner_alert_mail_attempts FROM PUBLIC,commerce_api,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance,commerce_mail_dispatch;
GRANT SELECT ON owner_alert_mail_jobs TO commerce_api;

-- Incidents worth an e-mail: the number needs the owner, or sending stopped.
CREATE FUNCTION owner_alert_mail_kind(p_kind text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT p_kind IN('SESSION_QR_REQUIRED','SESSION_AUTH_REVOKED','SESSION_PASSKEY_REQUIRED','SESSION_IDENTITY_CONFLICT','SESSION_RECOVERY_EXHAUSTED','REAL_POLICY_FROZEN','CHANNEL_WORKER_UNAVAILABLE')
$$;
REVOKE ALL ON FUNCTION owner_alert_mail_kind(text) FROM PUBLIC;

-- Automation: one job per active owner with a verified address when a mailable
-- incident opens, and one when an incident that was mailed resolves. Bounded
-- worker discovery, one profile context at a time; identifiers only.
CREATE FUNCTION queue_owner_alert_mail(p_limit integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p record; n integer:=0; c integer;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'MAIL_QUEUE_LIMIT'; END IF;
 FOR p IN SELECT f.id FROM public.discover_worker_profiles() f WHERE f.state='ACTIVE' ORDER BY f.id LOOP
  EXIT WHEN n>=p_limit;
  PERFORM pg_catalog.set_config('app.workspace_id',p.id,true);
  INSERT INTO public.owner_alert_mail_jobs(workspace_id,alert_id,event,recipient_user_id)
  SELECT a.workspace_id,a.id,'OPENED',m.user_id FROM public.operational_alerts a
   JOIN public.memberships m ON m.workspace_id=a.workspace_id AND m.role='owner' AND m.active
   JOIN public."user" u ON u.id=m.user_id AND u."emailVerified"
   WHERE a.workspace_id=p.id AND a.environment='REAL' AND a.resolved_at IS NULL AND public.owner_alert_mail_kind(a.kind)
    AND NOT EXISTS(SELECT 1 FROM public.owner_alert_mail_jobs x WHERE x.alert_id=a.id AND x.event='OPENED' AND x.recipient_user_id=m.user_id)
   ORDER BY a.created_at LIMIT p_limit-n ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS c=ROW_COUNT;n:=n+c;
  INSERT INTO public.owner_alert_mail_jobs(workspace_id,alert_id,event,recipient_user_id)
  SELECT j.workspace_id,j.alert_id,'RESOLVED',j.recipient_user_id FROM public.owner_alert_mail_jobs j
   JOIN public.operational_alerts a ON a.id=j.alert_id AND a.workspace_id=j.workspace_id AND a.resolved_at IS NOT NULL
   JOIN public.memberships m ON m.workspace_id=j.workspace_id AND m.user_id=j.recipient_user_id AND m.role='owner' AND m.active
   WHERE j.workspace_id=p.id AND j.event='OPENED' AND j.status IN('ACCEPTED','UNCERTAIN')
    AND NOT EXISTS(SELECT 1 FROM public.owner_alert_mail_jobs x WHERE x.alert_id=j.alert_id AND x.event='RESOLVED' AND x.recipient_user_id=j.recipient_user_id)
   ORDER BY a.resolved_at LIMIT greatest(p_limit-n,0) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS c=ROW_COUNT;n:=n+c;
 END LOOP;
 PERFORM pg_catalog.set_config('app.workspace_id','',true);
 RETURN n;
END$$;
REVOKE ALL ON FUNCTION queue_owner_alert_mail(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queue_owner_alert_mail(integer) TO commerce_automation;

-- Mail dispatcher discovery (same role as invitations): identifiers only.
CREATE FUNCTION queued_owner_alert_mail(p_limit integer) RETURNS TABLE(workspace_id text,job_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT j.workspace_id,j.id FROM public.owner_alert_mail_jobs j JOIN public.profiles p ON p.id=j.workspace_id AND p.state='ACTIVE'
 WHERE j.status='QUEUED' ORDER BY j.created_at,j.id LIMIT least(greatest(coalesce(p_limit,1),1),20)
$$;
REVOKE ALL ON FUNCTION queued_owner_alert_mail(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queued_owner_alert_mail(integer) TO commerce_mail_dispatch;

-- Reservation: the shared invitation quotas and monthly mail budget count both
-- kinds of mail; a job whose incident or recipient changed is skipped, never sent.
CREATE FUNCTION reserve_owner_alert_mail(p_workspace text,p_job uuid,p_attempt uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job public.owner_alert_mail_jobs; alert public.operational_alerts; email text; instant timestamptz; lease_end timestamptz; months text[]; month text; send_day date; reason text;
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'MAIL_PROFILE_CONTEXT_REQUIRED'; END IF;
 IF p_attempt::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'MAIL_RESERVATION_INPUT'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('commerce.profile.invitation-mail.budget.v1',0)) THEN RAISE EXCEPTION 'MAIL_BUDGET_BUSY'; END IF;
 SELECT * INTO job FROM public.owner_alert_mail_jobs WHERE id=p_job AND workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MAIL_JOB_NOT_FOUND'; END IF;
 IF job.status<>'QUEUED' OR EXISTS(SELECT FROM public.owner_alert_mail_attempts WHERE job_id=p_job OR attempt_id=p_attempt) THEN RAISE EXCEPTION 'MAIL_ALREADY_RESERVED_NO_REPLAY'; END IF;
 IF (SELECT state FROM public.profiles WHERE id=p_workspace FOR SHARE) IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'MAIL_PROFILE_INACTIVE'; END IF;
 SELECT * INTO alert FROM public.operational_alerts WHERE id=job.alert_id AND workspace_id=p_workspace FOR SHARE;
 SELECT u.email INTO email FROM public.memberships m JOIN public."user" u ON u.id=m.user_id WHERE m.user_id=job.recipient_user_id AND m.workspace_id=p_workspace AND m.role='owner' AND m.active AND u."emailVerified";
 reason:=CASE WHEN alert.id IS NULL THEN 'ALERT_NOT_FOUND' WHEN email IS NULL THEN 'RECIPIENT_NOT_OWNER'
  WHEN job.event='OPENED' AND alert.resolved_at IS NOT NULL THEN 'ALERT_ALREADY_RESOLVED' WHEN job.event='RESOLVED' AND alert.resolved_at IS NULL THEN 'ALERT_REOPENED' END;
 IF reason IS NOT NULL THEN UPDATE public.owner_alert_mail_jobs SET status='SKIPPED',skip_reason=reason WHERE id=p_job;RETURN jsonb_build_object('skipped',reason); END IF;
 instant:=date_trunc('milliseconds',clock_timestamp()); lease_end:=instant+interval '120 seconds';
 months:=public.profile_invitation_mail_budget_months(instant,lease_end);
 IF (SELECT count(*) FROM public.profile_invitation_mail_attempts WHERE authorized_until>=instant-interval '60 seconds')+(SELECT count(*) FROM public.owner_alert_mail_attempts WHERE authorized_until>=instant-interval '60 seconds')>=8 THEN RAISE EXCEPTION 'MAIL_ROLLING_QUOTA'; END IF;
 FOREACH send_day IN ARRAY public.profile_invitation_mail_send_days(instant,lease_end) LOOP
  IF (SELECT count(*) FROM public.profile_invitation_mail_attempts WHERE send_day=ANY(public.profile_invitation_mail_send_days(dispatched_at,authorized_until)))
   +(SELECT count(*) FROM public.owner_alert_mail_attempts WHERE send_day=ANY(public.profile_invitation_mail_send_days(dispatched_at,authorized_until)))>=100 THEN RAISE EXCEPTION 'MAIL_DAILY_QUOTA'; END IF;
 END LOOP;
 FOREACH month IN ARRAY months LOOP
  IF (SELECT COALESCE(sum(reserved_micro_usd),0) FROM public.profile_invitation_mail_attempts WHERE month=ANY(budget_months))
   +(SELECT COALESCE(sum(reserved_micro_usd),0) FROM public.owner_alert_mail_attempts WHERE month=ANY(budget_months))+15467>2000000 THEN RAISE EXCEPTION 'MAIL_MONTHLY_BUDGET'; END IF;
 END LOOP;
 INSERT INTO public.owner_alert_mail_attempts(attempt_id,workspace_id,job_id,state,reserved_micro_usd,budget_months,dispatched_at,authorized_until) VALUES(p_attempt,p_workspace,p_job,'RESERVED',15467,months,instant,lease_end);
 UPDATE public.owner_alert_mail_jobs SET status='RESERVED' WHERE id=p_job;
 IF job.event='OPENED' THEN UPDATE public.operational_alerts SET status='SENDING',updated_at=clock_timestamp() WHERE id=alert.id AND status IN('PENDING','UNKNOWN','FAILED'); END IF;
 IF clock_timestamp()>=lease_end THEN RAISE EXCEPTION 'MAIL_AUTHORIZATION_EXPIRED'; END IF;
 RETURN jsonb_build_object('attemptId',p_attempt,'workspaceId',p_workspace,'jobId',p_job,'alertId',alert.id,'alertKind',alert.kind,'event',job.event,
  'recipient',email,'recipientDigest',encode(sha256(convert_to(lower(email),'UTF8')),'hex'),'dispatchedAt',instant,'authorizedUntil',lease_end,'reservedMicroUsd',15467,'budgetMonths',months);
END$$;
REVOKE ALL ON FUNCTION reserve_owner_alert_mail(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_owner_alert_mail(text,uuid,uuid) TO commerce_mail_dispatch;

CREATE FUNCTION claim_owner_alert_mail(p_workspace text,p_attempt uuid,p_body_sha256 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE lease public.owner_alert_mail_attempts; instant timestamptz;
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'MAIL_PROFILE_CONTEXT_REQUIRED'; END IF;
 IF p_body_sha256 IS NULL OR p_body_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'MAIL_BODY_HASH'; END IF;
 SELECT * INTO lease FROM public.owner_alert_mail_attempts WHERE attempt_id=p_attempt AND workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MAIL_ATTEMPT_NOT_FOUND'; END IF;
 instant:=clock_timestamp();
 IF lease.state<>'RESERVED' OR lease.send_claimed_at IS NOT NULL OR instant>=lease.authorized_until THEN RAISE EXCEPTION 'MAIL_SEND_NOT_AUTHORIZED_NO_REPLAY'; END IF;
 UPDATE public.owner_alert_mail_attempts SET state='SENDING',body_sha256=p_body_sha256,send_claimed_at=instant WHERE attempt_id=p_attempt;
 UPDATE public.owner_alert_mail_jobs SET status='SENDING' WHERE id=lease.job_id;
 RETURN jsonb_build_object('attemptId',p_attempt,'state','SENDING','bodySha256',p_body_sha256,'authorizedUntil',lease.authorized_until);
END$$;
REVOKE ALL ON FUNCTION claim_owner_alert_mail(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_owner_alert_mail(text,uuid,text) TO commerce_mail_dispatch;

CREATE FUNCTION finish_owner_alert_mail(p_workspace text,p_attempt uuid,p_outcome text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE lease public.owner_alert_mail_attempts; job public.owner_alert_mail_jobs;
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'MAIL_PROFILE_CONTEXT_REQUIRED'; END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN('ACCEPTED','REJECTED','UNCERTAIN') THEN RAISE EXCEPTION 'MAIL_OUTCOME_INVALID'; END IF;
 SELECT * INTO lease FROM public.owner_alert_mail_attempts WHERE attempt_id=p_attempt AND workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MAIL_ATTEMPT_NOT_FOUND'; END IF;
 IF lease.state NOT IN('RESERVED','SENDING') THEN
  IF lease.state<>p_outcome THEN RAISE EXCEPTION 'MAIL_TERMINAL_CONFLICT'; END IF;
 ELSE
  IF lease.state='RESERVED' AND p_outcome<>'UNCERTAIN' THEN RAISE EXCEPTION 'MAIL_SEND_NOT_CLAIMED'; END IF;
  UPDATE public.owner_alert_mail_attempts SET state=p_outcome,completed_at=clock_timestamp() WHERE attempt_id=p_attempt;
  UPDATE public.owner_alert_mail_jobs SET status=p_outcome WHERE id=lease.job_id RETURNING * INTO job;
  -- The app shows whether the incident's mail went out (never delivery proof).
  IF job.event='OPENED' THEN UPDATE public.operational_alerts SET status=CASE p_outcome WHEN 'ACCEPTED' THEN 'ACCEPTED' WHEN 'REJECTED' THEN 'FAILED' ELSE 'UNKNOWN' END,updated_at=clock_timestamp()
   WHERE id=job.alert_id AND workspace_id=p_workspace AND status IN('PENDING','SENDING','UNKNOWN','FAILED'); END IF;
  INSERT INTO public.domain_events(workspace_id,environment,event_type,aggregate_id,correlation_id,actor,payload)
  VALUES(p_workspace,'REAL','owner.alert.mail_result',job.alert_id::text,p_attempt::text,jsonb_build_object('type','system','id','owner-alert-mail'),jsonb_build_object('attemptId',p_attempt,'event',job.event,'state',p_outcome,'deliveryProven',false));
 END IF;
 RETURN jsonb_build_object('attemptId',p_attempt,'state',p_outcome,'deliveryProven',false,'reservationRefunded',false);
END$$;
REVOKE ALL ON FUNCTION finish_owner_alert_mail(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finish_owner_alert_mail(text,uuid,text) TO commerce_mail_dispatch;
