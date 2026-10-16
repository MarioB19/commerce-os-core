-- V7 F1 (ADR-V7-13): the mail dispatcher discovers queued invitation jobs
-- across profiles. Only identifiers leave this function; reservation, quotas,
-- budget and all checks stay in reserve_profile_invitation_mail (0077).
DO $$BEGIN
 IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'INVITATION_MAIL_QUEUE_OWNER_REQUIRED';
 END IF;
END$$;
CREATE FUNCTION queued_profile_invitation_mail(p_limit integer)
 RETURNS TABLE(workspace_id text, job_id uuid)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT j.workspace_id, j.id
 FROM public.profile_invitation_mail_jobs j
 JOIN public.profile_invitations i ON i.id=j.invitation_id AND i.workspace_id=j.workspace_id
 JOIN public.profiles p ON p.id=j.workspace_id
 WHERE j.status='QUEUED' AND i.status='PENDING' AND i.delivery='QUEUED' AND p.state='ACTIVE'
 ORDER BY j.created_at, j.id
 LIMIT least(greatest(coalesce(p_limit,1),1),20)
$$;
REVOKE ALL ON FUNCTION queued_profile_invitation_mail(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queued_profile_invitation_mail(integer) TO commerce_mail_dispatch;
