-- Isolated staged schema. No commercial migration, dispatch or RLS activation.
CREATE TABLE profile_invitations (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES profiles(id),
 operation_id uuid NOT NULL,
 requested_by text NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','operator','viewer')),
 recipient_digest text NOT NULL CHECK(recipient_digest ~ '^[a-f0-9]{64}$'),
 recipient_ciphertext text NOT NULL CHECK(length(recipient_ciphertext) BETWEEN 1 AND 4096),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CANCELLED')),
 delivery text NOT NULL DEFAULT 'QUEUED' CHECK(delivery='QUEUED'),
 created_at timestamptz NOT NULL,
 UNIQUE(workspace_id,operation_id),
 UNIQUE(id,workspace_id),
 FOREIGN KEY(requested_by,workspace_id) REFERENCES memberships(user_id,workspace_id)
);
CREATE UNIQUE INDEX profile_invitations_one_pending_recipient ON profile_invitations(workspace_id,recipient_digest) WHERE status='PENDING';
CREATE TABLE profile_invitation_mail_jobs (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 invitation_id uuid NOT NULL,
 invitation_version integer NOT NULL CHECK(invitation_version=1),
 template text NOT NULL CHECK(template='profile-invitation-v1'),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status='QUEUED'),
 created_at timestamptz NOT NULL,
 UNIQUE(workspace_id,invitation_id,invitation_version),
 FOREIGN KEY(invitation_id,workspace_id) REFERENCES profile_invitations(id,workspace_id)
);
REVOKE ALL ON profile_invitations,profile_invitation_mail_jobs FROM PUBLIC,commerce_api,commerce_ingress,commerce_automation,commerce_channel;
GRANT SELECT,INSERT ON profile_invitations,profile_invitation_mail_jobs TO commerce_api;
GRANT UPDATE(status,version) ON profile_invitations TO commerce_api;
CREATE FUNCTION guard_profile_invitation_write() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id THEN
  RAISE EXCEPTION 'PROFILE_INVITATION_CONTEXT_REQUIRED';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.status<>'PENDING' THEN RAISE EXCEPTION 'PROFILE_INVITATION_INITIAL_STATE_REQUIRED'; END IF;
 ELSIF (to_jsonb(NEW)-'status'-'version') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'version')
  OR OLD.status<>'PENDING' OR NEW.status<>'CANCELLED' OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'PROFILE_INVITATION_CANCEL_CAS_REQUIRED';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION guard_profile_invitation_mail_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id
  OR NOT EXISTS(SELECT 1 FROM public.profile_invitations i WHERE i.id=NEW.invitation_id AND i.workspace_id=NEW.workspace_id AND i.version=NEW.invitation_version AND i.status='PENDING' AND i.created_at=NEW.created_at) THEN
  RAISE EXCEPTION 'PROFILE_INVITATION_MAIL_BINDING_REQUIRED';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_profile_invitation_write(),guard_profile_invitation_mail_insert() FROM PUBLIC;
CREATE TRIGGER guard_profile_invitation_write BEFORE INSERT OR UPDATE ON profile_invitations FOR EACH ROW EXECUTE FUNCTION guard_profile_invitation_write();
CREATE TRIGGER guard_profile_invitation_mail_insert BEFORE INSERT ON profile_invitation_mail_jobs FOR EACH ROW EXECUTE FUNCTION guard_profile_invitation_mail_insert();
