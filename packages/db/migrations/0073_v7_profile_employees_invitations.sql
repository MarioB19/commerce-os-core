-- V7 F2 cutover: Employees and invitations (004-007).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/004_profile_employees.sql (source sha256 efeb0253d53873be840684e649656c5b5f09948486cb711eaf98ff7f0f6d9403)
-- Isolated staged schema. No commercial migration or FORCE RLS activation.
REVOKE UPDATE,DELETE ON memberships FROM commerce_api;
GRANT UPDATE(role,active) ON memberships TO commerce_api;
CREATE FUNCTION guard_profile_membership_write() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog AS $$
DECLARE owns_table boolean;
BEGIN
 SELECT r.rolname=current_user INTO owns_table FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=TG_RELID;
 IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
  RAISE EXCEPTION 'PROFILE_MEMBERSHIP_IDENTITY_IMMUTABLE';
 END IF;
 IF NOT owns_table AND (current_setting('app.workspace_id',true) IS DISTINCT FROM OLD.workspace_id OR NEW.role NOT IN ('owner','operator','viewer')) THEN
  RAISE EXCEPTION 'PROFILE_MEMBERSHIP_CONTEXT_OR_ROLE_INVALID';
 END IF;
 IF NEW.role IS DISTINCT FROM OLD.role OR NEW.active IS DISTINCT FROM OLD.active THEN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
   RAISE EXCEPTION 'PROFILE_MEMBERSHIP_READ_COMMITTED_REQUIRED';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('commerce.profile.authority.v1:' || OLD.workspace_id,0)) THEN
   RAISE EXCEPTION 'PROFILE_AUTHORITY_BUSY';
  END IF;
  IF OLD.role='owner' AND OLD.active AND (NEW.role<>'owner' OR NOT NEW.active)
   AND NOT EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=OLD.workspace_id AND m.user_id<>OLD.user_id AND m.role='owner' AND m.active) THEN
   RAISE EXCEPTION 'PROFILE_LAST_OWNER_REQUIRED';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_profile_membership_write() FROM PUBLIC;
CREATE TRIGGER guard_profile_membership_write BEFORE UPDATE ON memberships
 FOR EACH ROW EXECUTE FUNCTION guard_profile_membership_write();
-- <<< end 004_profile_employees.sql

-- >>> promoted from packages/db/profile-transition/005_profile_invitations.sql (source sha256 dcb570a200902eef7a0bea7d11f0bb8de6c48e7147d5b1642b4e1aad00ddd6ec)
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
-- <<< end 005_profile_invitations.sql

-- >>> promoted from packages/db/profile-transition/006_profile_invitation_acceptance.sql (source sha256 88a673e2d5459b67974a9d3603ed846bdb8140052b136c66865362fc4e1845f7)
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
-- <<< end 006_profile_invitation_acceptance.sql

-- >>> promoted from packages/db/profile-transition/007_profile_invitation_registration.sql (source sha256 bfe6923428790dd15e351931fae387b71e5ab0a922b8f2914128602e92654202)
-- Staged invitation-only registration. No runtime activation or new grants.
CREATE OR REPLACE FUNCTION guard_profile_invitation_write() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE owns_table boolean; native_user text; new_user text; current_xid bigint;
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
 new_user:=nullif(current_setting('app.invitation_new_user_id',true),'');
 IF new_user IS NOT NULL THEN
  -- xmin is the 32-bit transaction ID. Compare the low bits of the current
  -- xid8 to preserve correctness across the PostgreSQL transaction-ID wrap.
  current_xid:=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint;
  IF new_user IS DISTINCT FROM NEW.accepted_user_id
   OR nullif(current_setting('app.invitation_session_id',true),'') IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM public."user" u JOIN public.account a ON a."userId"=u.id
     JOIN public.memberships m ON m.user_id=u.id AND m.workspace_id=OLD.workspace_id
    WHERE u.id=new_user AND u."emailVerified" AND u.xmin::text::bigint=current_xid
     AND a.xmin::text::bigint=current_xid AND m.xmin::text::bigint=current_xid
     AND a."providerId"='credential' AND a.issuer='local:credential' AND a."accountId"=u.id
     AND a.password ~ '^[a-f0-9]{32}:[a-f0-9]{128}$'
     AND m.active AND m.role=OLD.role AND m.version=1) THEN
   RAISE EXCEPTION 'PROFILE_INVITATION_NEW_IDENTITY_TRANSACTION_REQUIRED';
  END IF;
  RETURN NEW;
 END IF;
 SELECT s."userId" INTO native_user FROM public.session s JOIN public."user" u ON u.id=s."userId"
 WHERE s.id=current_setting('app.invitation_session_id',true) AND s."expiresAt">clock_timestamp() AND u."emailVerified";
 IF native_user IS DISTINCT FROM NEW.accepted_user_id THEN RAISE EXCEPTION 'PROFILE_INVITATION_NATIVE_RECIPIENT_REQUIRED'; END IF;
 RETURN NEW;
END $$;
-- <<< end 007_profile_invitation_registration.sql
