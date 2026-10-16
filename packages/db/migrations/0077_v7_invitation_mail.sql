-- V7 F2 cutover: Invitation mail leases and budget (011).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/011_profile_invitation_mail_leases.sql (source sha256 71badcb99d61eb2716ebce7efe9bbf67f9783630bdedef88abc58cfda87be40a)
-- V7 F2: 1 role-existence refusal(s) and 1 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- Prepared invitation-only dispatch custody. No runtime credentials or mounting.
DO $$BEGIN

 PERFORM public.v7_ensure_reviewed_role('commerce_mail_dispatch',true);
END$$;
ALTER TABLE profile_invitation_mail_jobs DROP CONSTRAINT profile_invitation_mail_jobs_status_check,
 ADD CONSTRAINT profile_invitation_mail_jobs_status_check CHECK(status IN ('QUEUED','RESERVED','SENDING','ACCEPTED','REJECTED','UNCERTAIN'));
ALTER TABLE profile_invitation_mail_jobs ADD CONSTRAINT profile_invitation_mail_job_profile UNIQUE(id,workspace_id);
CREATE TABLE profile_invitation_mail_attempts (
 attempt_id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES profiles(id),
 job_id uuid NOT NULL UNIQUE,
 invitation_id uuid NOT NULL,
 invitation_version integer NOT NULL CHECK(invitation_version>0),
 requested_by text NOT NULL,
 state text NOT NULL CHECK(state IN ('RESERVED','SENDING','ACCEPTED','REJECTED','UNCERTAIN')),
 reserved_micro_usd integer NOT NULL CHECK(reserved_micro_usd=15467),
 budget_months text[] NOT NULL CHECK(cardinality(budget_months) BETWEEN 1 AND 2),
 dispatched_at timestamptz NOT NULL,
 authorized_until timestamptz NOT NULL,
 link_expires_at timestamptz NOT NULL,
 body_sha256 text CHECK(body_sha256 IS NULL OR body_sha256 ~ '^[a-f0-9]{64}$'),
 send_claimed_at timestamptz,
 completed_at timestamptz,
 FOREIGN KEY(invitation_id,workspace_id) REFERENCES profile_invitations(id,workspace_id),
 FOREIGN KEY(job_id,workspace_id) REFERENCES profile_invitation_mail_jobs(id,workspace_id),
 FOREIGN KEY(requested_by,workspace_id) REFERENCES memberships(user_id,workspace_id),
 CHECK(isfinite(dispatched_at) AND authorized_until=dispatched_at+interval '120 seconds'
       AND link_expires_at=dispatched_at+interval '24 hours'),
 CHECK((body_sha256 IS NULL)=(send_claimed_at IS NULL)),
 CHECK((state IN ('ACCEPTED','REJECTED','UNCERTAIN'))=(completed_at IS NOT NULL)),
 CHECK(state<>'SENDING' OR send_claimed_at IS NOT NULL)
);
CREATE INDEX profile_invitation_mail_clock ON profile_invitation_mail_attempts(dispatched_at);
CREATE INDEX profile_invitation_mail_months ON profile_invitation_mail_attempts USING gin(budget_months);
-- Custodial global accounting is visible only inside closed functions, never
-- through tenant-selectable table grants. All states retain their charge.
REVOKE ALL ON profile_invitation_mail_attempts FROM PUBLIC,commerce_api,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance,commerce_mail_dispatch;

CREATE FUNCTION lock_profile_invitation_mail(p_workspace text,p_job uuid)
 RETURNS public.profile_invitations LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE invitation public.profile_invitations; job public.profile_invitation_mail_jobs; active_profile text; author_role text; author_active boolean;
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'MAIL_PROFILE_CONTEXT_REQUIRED'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('commerce.profile.authority.v1:'||p_workspace,0)) THEN RAISE EXCEPTION 'PROFILE_AUTHORITY_BUSY'; END IF;
 SELECT * INTO job FROM public.profile_invitation_mail_jobs WHERE id=p_job AND workspace_id=p_workspace;
 IF NOT FOUND THEN RAISE EXCEPTION 'MAIL_JOB_NOT_FOUND'; END IF;
 SELECT state INTO active_profile FROM public.profiles WHERE id=p_workspace FOR SHARE;
 IF active_profile IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'MAIL_PROFILE_INACTIVE'; END IF;
 SELECT * INTO invitation FROM public.profile_invitations WHERE id=job.invitation_id AND workspace_id=p_workspace FOR UPDATE;
 IF invitation.status IS DISTINCT FROM 'PENDING' OR invitation.version IS DISTINCT FROM job.invitation_version THEN RAISE EXCEPTION 'MAIL_INVITATION_CHANGED'; END IF;
 SELECT role,active INTO author_role,author_active FROM public.memberships WHERE user_id=invitation.requested_by AND workspace_id=p_workspace FOR SHARE;
 IF author_role IS DISTINCT FROM 'owner' OR author_active IS DISTINCT FROM true THEN RAISE EXCEPTION 'MAIL_ISSUER_REVOKED'; END IF;
 PERFORM 1 FROM public.profile_invitation_mail_jobs WHERE id=p_job AND workspace_id=p_workspace FOR UPDATE;
 RETURN invitation;
END$$;
REVOKE ALL ON FUNCTION lock_profile_invitation_mail(text,uuid) FROM PUBLIC;

CREATE FUNCTION profile_invitation_mail_budget_months(p_start timestamptz,p_authorized_until timestamptz)
 RETURNS text[] LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT array_agg(DISTINCT value ORDER BY value) FROM (VALUES
  (to_char(p_start AT TIME ZONE 'UTC','YYYY-MM')),
  (to_char((p_authorized_until+interval '960 seconds') AT TIME ZONE 'UTC','YYYY-MM')),
  (to_char(p_start AT TIME ZONE 'America/Los_Angeles','YYYY-MM')),
  (to_char((p_authorized_until+interval '960 seconds') AT TIME ZONE 'America/Los_Angeles','YYYY-MM'))
 ) AS touched(value)
$$;
REVOKE ALL ON FUNCTION profile_invitation_mail_budget_months(timestamptz,timestamptz) FROM PUBLIC;

CREATE FUNCTION profile_invitation_mail_send_days(p_start timestamptz,p_authorized_until timestamptz)
 RETURNS date[] LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT array_agg(DISTINCT value ORDER BY value) FROM (VALUES
  ((p_start AT TIME ZONE 'America/Los_Angeles')::date),
  (((p_authorized_until-interval '1 microsecond') AT TIME ZONE 'America/Los_Angeles')::date)
 ) AS touched(value)
$$;
REVOKE ALL ON FUNCTION profile_invitation_mail_send_days(timestamptz,timestamptz) FROM PUBLIC;

CREATE FUNCTION reserve_profile_invitation_mail(p_workspace text,p_job uuid,p_attempt uuid,p_link_digest text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE invitation public.profile_invitations; instant timestamptz; lease_end timestamptz; months text[]; month text; send_day date;
BEGIN
 IF p_attempt::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' OR p_link_digest !~ '^[a-f0-9]{64}$' OR p_link_digest IS NULL THEN RAISE EXCEPTION 'MAIL_RESERVATION_INPUT'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('commerce.profile.invitation-mail.budget.v1',0)) THEN RAISE EXCEPTION 'MAIL_BUDGET_BUSY'; END IF;
 invitation:=public.lock_profile_invitation_mail(p_workspace,p_job);
 IF invitation.delivery<>'QUEUED' OR EXISTS(SELECT FROM public.profile_invitation_mail_attempts WHERE job_id=p_job OR attempt_id=p_attempt)
  OR NOT EXISTS(SELECT FROM public.profile_invitation_mail_jobs WHERE id=p_job AND workspace_id=p_workspace AND status='QUEUED') THEN RAISE EXCEPTION 'MAIL_ALREADY_RESERVED_NO_REPLAY'; END IF;
 instant:=date_trunc('milliseconds',clock_timestamp()); lease_end:=instant+interval '120 seconds';
 -- Union of UTC and native Billing Pacific months. Never reset earlier than
 -- either calendar; charge the complete ceiling for every possible month.
 months:=public.profile_invitation_mail_budget_months(instant,lease_end);
 -- Every lease counts even if it failed before sending. No terminal/refund filter.
 IF (SELECT count(*) FROM public.profile_invitation_mail_attempts WHERE authorized_until>=instant-interval '60 seconds')>=8
 OR (SELECT count(*) FROM public.profile_invitation_mail_attempts WHERE workspace_id=p_workspace AND authorized_until>=instant-interval '60 seconds')>=8 THEN RAISE EXCEPTION 'MAIL_ROLLING_QUOTA'; END IF;
 FOREACH send_day IN ARRAY public.profile_invitation_mail_send_days(instant,lease_end) LOOP
  IF (SELECT count(*) FROM public.profile_invitation_mail_attempts WHERE send_day=ANY(public.profile_invitation_mail_send_days(dispatched_at,authorized_until)))>=100
  OR (SELECT count(*) FROM public.profile_invitation_mail_attempts WHERE workspace_id=p_workspace AND send_day=ANY(public.profile_invitation_mail_send_days(dispatched_at,authorized_until)))>=100 THEN RAISE EXCEPTION 'MAIL_DAILY_QUOTA'; END IF;
 END LOOP;
 FOREACH month IN ARRAY months LOOP
  IF (SELECT COALESCE(sum(reserved_micro_usd),0) FROM public.profile_invitation_mail_attempts WHERE month=ANY(budget_months))+15467>2000000 THEN RAISE EXCEPTION 'MAIL_MONTHLY_BUDGET'; END IF;
 END LOOP;
 INSERT INTO public.profile_invitation_mail_attempts(attempt_id,workspace_id,job_id,invitation_id,invitation_version,requested_by,state,reserved_micro_usd,budget_months,dispatched_at,authorized_until,link_expires_at)
 VALUES(p_attempt,p_workspace,p_job,invitation.id,invitation.version,invitation.requested_by,'RESERVED',15467,months,instant,lease_end,instant+interval '24 hours');
 UPDATE public.profile_invitations SET delivery='SENDING',attempt_id=p_attempt,link_digest=p_link_digest,dispatched_at=instant,expires_at=instant+interval '24 hours' WHERE id=invitation.id AND workspace_id=p_workspace;
 UPDATE public.profile_invitation_mail_jobs SET status='RESERVED' WHERE id=p_job AND workspace_id=p_workspace;
 INSERT INTO public.domain_events(id,workspace_id,environment,event_type,aggregate_id,correlation_id,actor,payload)
 VALUES(p_attempt,p_workspace,'REAL','profile.invitation.mail_reserved',invitation.id::text,p_attempt::text,jsonb_build_object('type','system','id','invitation-mail'),jsonb_build_object('jobId',p_job,'version',invitation.version,'reservedMicroUsd',15467,'budgetMonths',months));
 IF clock_timestamp()>=lease_end THEN RAISE EXCEPTION 'MAIL_AUTHORIZATION_EXPIRED'; END IF;
 RETURN jsonb_build_object('attemptId',p_attempt,'workspaceId',p_workspace,'jobId',p_job,'invitationId',invitation.id,'invitationVersion',invitation.version,'recipientCiphertext',invitation.recipient_ciphertext,'recipientDigest',invitation.recipient_digest,'dispatchedAt',instant,'authorizedUntil',lease_end,'linkExpiresAt',instant+interval '24 hours','reservedMicroUsd',15467,'budgetMonths',months);
END$$;
REVOKE ALL ON FUNCTION reserve_profile_invitation_mail(text,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_profile_invitation_mail(text,uuid,uuid,text) TO commerce_mail_dispatch;

CREATE FUNCTION claim_profile_invitation_mail(p_workspace text,p_attempt uuid,p_body_sha256 text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE lease public.profile_invitation_mail_attempts; invitation public.profile_invitations; instant timestamptz;
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'MAIL_PROFILE_CONTEXT_REQUIRED'; END IF;
 IF p_body_sha256 IS NULL OR p_body_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'MAIL_BODY_HASH'; END IF;
 SELECT * INTO lease FROM public.profile_invitation_mail_attempts WHERE attempt_id=p_attempt AND workspace_id=p_workspace;
 IF NOT FOUND THEN RAISE EXCEPTION 'MAIL_ATTEMPT_NOT_FOUND'; END IF;
 invitation:=public.lock_profile_invitation_mail(p_workspace,lease.job_id);
 SELECT * INTO lease FROM public.profile_invitation_mail_attempts WHERE attempt_id=p_attempt AND workspace_id=p_workspace FOR UPDATE;
 instant:=clock_timestamp();
 IF lease.state<>'RESERVED' OR lease.send_claimed_at IS NOT NULL OR invitation.attempt_id IS DISTINCT FROM p_attempt
 OR invitation.delivery<>'SENDING' OR instant>=lease.authorized_until THEN RAISE EXCEPTION 'MAIL_SEND_NOT_AUTHORIZED_NO_REPLAY'; END IF;
 UPDATE public.profile_invitation_mail_attempts SET state='SENDING',body_sha256=p_body_sha256,send_claimed_at=instant WHERE attempt_id=p_attempt;
 UPDATE public.profile_invitation_mail_jobs SET status='SENDING' WHERE id=lease.job_id AND workspace_id=p_workspace;
 IF clock_timestamp()>=lease.authorized_until THEN RAISE EXCEPTION 'MAIL_AUTHORIZATION_EXPIRED'; END IF;
 RETURN jsonb_build_object('attemptId',p_attempt,'state','SENDING','bodySha256',p_body_sha256,'authorizedUntil',lease.authorized_until);
END$$;
REVOKE ALL ON FUNCTION claim_profile_invitation_mail(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_profile_invitation_mail(text,uuid,text) TO commerce_mail_dispatch;

CREATE FUNCTION finish_profile_invitation_mail(p_workspace text,p_attempt uuid,p_outcome text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE lease public.profile_invitation_mail_attempts;
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'MAIL_PROFILE_CONTEXT_REQUIRED'; END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN ('ACCEPTED','REJECTED','UNCERTAIN') THEN RAISE EXCEPTION 'MAIL_OUTCOME_INVALID'; END IF;
 -- Same authority lock before row locks; recording does not re-authorize sending.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('commerce.profile.authority.v1:'||p_workspace,0)) THEN RAISE EXCEPTION 'PROFILE_AUTHORITY_BUSY'; END IF;
 SELECT * INTO lease FROM public.profile_invitation_mail_attempts WHERE attempt_id=p_attempt AND workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MAIL_ATTEMPT_NOT_FOUND'; END IF;
 IF lease.state NOT IN ('RESERVED','SENDING') THEN
  IF lease.state<>p_outcome THEN RAISE EXCEPTION 'MAIL_TERMINAL_CONFLICT'; END IF;
 ELSE
  IF lease.state='RESERVED' AND p_outcome<>'UNCERTAIN' THEN RAISE EXCEPTION 'MAIL_SEND_NOT_CLAIMED'; END IF;
  UPDATE public.profile_invitation_mail_attempts SET state=p_outcome,completed_at=clock_timestamp() WHERE attempt_id=p_attempt;
  UPDATE public.profile_invitation_mail_jobs SET status=p_outcome WHERE id=lease.job_id AND workspace_id=p_workspace;
  -- Cancellation/acceptance may have advanced version; retain those fields.
  UPDATE public.profile_invitations SET delivery=p_outcome WHERE id=lease.invitation_id AND workspace_id=p_workspace AND attempt_id=p_attempt;
  INSERT INTO public.domain_events(workspace_id,environment,event_type,aggregate_id,correlation_id,actor,payload)
  VALUES(p_workspace,'REAL','profile.invitation.mail_result',lease.invitation_id::text,p_attempt::text,jsonb_build_object('type','system','id','invitation-mail'),jsonb_build_object('attemptId',p_attempt,'state',p_outcome,'deliveryProven',false));
 END IF;
 RETURN jsonb_build_object('attemptId',p_attempt,'state',p_outcome,'deliveryProven',false,'reservationRefunded',false);
END$$;
REVOKE ALL ON FUNCTION finish_profile_invitation_mail(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finish_profile_invitation_mail(text,uuid,text) TO commerce_mail_dispatch;

CREATE FUNCTION read_profile_invitation_mail(p_workspace text,p_job uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE lease public.profile_invitation_mail_attempts;
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'MAIL_PROFILE_CONTEXT_REQUIRED'; END IF;
 SELECT * INTO lease FROM public.profile_invitation_mail_attempts WHERE workspace_id=p_workspace AND job_id=p_job;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('attemptId',lease.attempt_id,'state',lease.state,'authorizedUntil',lease.authorized_until,'reservedMicroUsd',lease.reserved_micro_usd,'budgetMonths',lease.budget_months,'deliveryProven',false,'reservationRefunded',false);
END$$;
REVOKE ALL ON FUNCTION read_profile_invitation_mail(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_profile_invitation_mail(text,uuid) TO commerce_mail_dispatch;
-- <<< end 011_profile_invitation_mail_leases.sql
