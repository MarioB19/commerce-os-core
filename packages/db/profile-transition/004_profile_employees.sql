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
