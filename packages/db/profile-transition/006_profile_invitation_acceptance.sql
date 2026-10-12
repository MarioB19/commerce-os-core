-- Staged delivery identity and recipient acceptance, no runtime activation.
ALTER TABLE profile_invitations
 ADD COLUMN attempt_id uuid,
 ADD COLUMN link_digest text CHECK(link_digest IS NULL OR link_digest ~ '^[a-f0-9]{64}$'),
 ADD COLUMN dispatched_at timestamptz,
 ADD COLUMN expires_at timestamptz,
 ADD COLUMN accepted_user_id text REFERENCES "user"(id),
 DROP CONSTRAINT profile_invitations_status_check,
 DROP CONSTRAINT profile_invitations_delivery_check,
 ADD CONSTRAINT profile_invitations_status_check CHECK(status IN ('PENDING','CANCELLED','ACCEPTED')),
 ADD CONSTRAINT profile_invitations_delivery_check CHECK(delivery IN ('QUEUED','SENDING','ACCEPTED','REJECTED','UNCERTAIN')),
 ADD CONSTRAINT profile_invitation_recipient_state CHECK((status='ACCEPTED')=(accepted_user_id IS NOT NULL)),
 ADD CONSTRAINT profile_invitation_delivery_identity CHECK(
  (delivery='QUEUED' AND attempt_id IS NULL AND link_digest IS NULL AND dispatched_at IS NULL AND expires_at IS NULL)
  OR (delivery<>'QUEUED' AND attempt_id IS NOT NULL AND link_digest IS NOT NULL
   AND dispatched_at IS NOT NULL AND expires_at IS NOT NULL AND isfinite(dispatched_at)
   AND isfinite(expires_at) AND dispatched_at>=created_at AND expires_at=dispatched_at+interval '24 hours'));
CREATE UNIQUE INDEX profile_invitation_link_digest_unique ON profile_invitations(link_digest) WHERE link_digest IS NOT NULL;
GRANT UPDATE(accepted_user_id) ON profile_invitations TO commerce_api;

CREATE FUNCTION locate_profile_invitation(link_hash text)
 RETURNS TABLE(invitation_id uuid,workspace_id text) LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog AS $$
 SELECT i.id,i.workspace_id FROM public.profile_invitations i JOIN public.profiles p ON p.id=i.workspace_id
 WHERE link_hash ~ '^[a-f0-9]{64}$' AND i.link_digest=link_hash
  AND i.status IN ('PENDING','ACCEPTED') AND i.delivery IN ('SENDING','ACCEPTED','UNCERTAIN')
  AND i.expires_at>clock_timestamp() AND p.state='ACTIVE'
$$;
REVOKE ALL ON FUNCTION locate_profile_invitation(text) FROM PUBLIC,commerce_ingress,commerce_automation,commerce_channel;
GRANT EXECUTE ON FUNCTION locate_profile_invitation(text) TO commerce_api;

CREATE OR REPLACE FUNCTION guard_profile_invitation_write() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE owns_table boolean; native_user text;
BEGIN
 IF current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id THEN
  RAISE EXCEPTION 'PROFILE_INVITATION_CONTEXT_REQUIRED';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.status<>'PENDING' OR NEW.delivery<>'QUEUED' OR NEW.accepted_user_id IS NOT NULL THEN
   RAISE EXCEPTION 'PROFILE_INVITATION_INITIAL_STATE_REQUIRED';
  END IF;
  RETURN NEW;
 END IF;
 SELECT r.rolname=current_user INTO owns_table FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=TG_RELID;
 -- Delivery installation is still owner-only. A reviewed worker grant and its
 -- own transition contract are added with the dispatcher, never inferred here.
 IF owns_table THEN RETURN NEW; END IF;
 IF (to_jsonb(NEW)-'status'-'version'-'accepted_user_id') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'version'-'accepted_user_id')
  OR OLD.status<>'PENDING' OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'PROFILE_INVITATION_VERSIONED_CHANGE_REQUIRED';
 END IF;
 IF NEW.status='CANCELLED' AND NEW.accepted_user_id IS NULL THEN RETURN NEW; END IF;
 IF NEW.status<>'ACCEPTED' OR NEW.accepted_user_id IS NULL OR OLD.delivery NOT IN ('SENDING','ACCEPTED','UNCERTAIN')
  OR OLD.expires_at<=clock_timestamp() OR current_setting('app.invitation_link_digest',true) IS DISTINCT FROM OLD.link_digest THEN
  RAISE EXCEPTION 'PROFILE_INVITATION_ACCEPTANCE_REQUIRED';
 END IF;
 SELECT s."userId" INTO native_user FROM public.session s JOIN public."user" u ON u.id=s."userId"
 WHERE s.id=current_setting('app.invitation_session_id',true) AND s."expiresAt">clock_timestamp() AND u."emailVerified";
 IF native_user IS DISTINCT FROM NEW.accepted_user_id THEN RAISE EXCEPTION 'PROFILE_INVITATION_NATIVE_RECIPIENT_REQUIRED'; END IF;
 RETURN NEW;
END $$;
