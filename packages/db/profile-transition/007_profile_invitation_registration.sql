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
