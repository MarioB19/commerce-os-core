-- Transitional schema for isolated validation only. Not an automatic migration.
-- Promote only with the native inventory, explicit profile/role/quota adoption,
-- all consumers, and the final RLS/FK migration reviewed together.
CREATE TABLE profiles (
 id text PRIMARY KEY CHECK (length(id)>0),
 business_name text NOT NULL CHECK (length(btrim(business_name)) BETWEEN 1 AND 160),
 state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','SUSPENDED')),
 timezone text NOT NULL CHECK (length(timezone)>0),
 number_limit integer NOT NULL CHECK (number_limit BETWEEN 0 AND 20),
 product_limit integer NOT NULL CHECK (product_limit>=0),
 daily_conversation_limit integer NOT NULL CHECK (daily_conversation_limit>=0),
 version integer NOT NULL DEFAULT 1 CHECK (version>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- No default rows, implicit quota or renaming of an existing workspace.
REVOKE ALL ON profiles FROM PUBLIC,commerce_ingress,commerce_automation,commerce_channel;
GRANT SELECT ON profiles TO commerce_api;
-- PostgreSQL row locks require an UPDATE privilege. Grant only the immutable
-- ID column, not state, quotas or business data; the trigger rejects ID changes.
GRANT UPDATE(id) ON profiles TO commerce_api;
CREATE FUNCTION guard_profile_identity() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'PROFILE_IDENTITY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_profile_identity() FROM PUBLIC;
CREATE TRIGGER guard_profile_identity BEFORE UPDATE ON profiles
 FOR EACH ROW EXECUTE FUNCTION guard_profile_identity();

ALTER TABLE memberships ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version>0);
CREATE FUNCTION version_profile_membership() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
  RAISE EXCEPTION 'PROFILE_MEMBERSHIP_IDENTITY_IMMUTABLE';
 END IF;
 IF NEW.role IS DISTINCT FROM OLD.role OR NEW.active IS DISTINCT FROM OLD.active THEN
  NEW.version:=OLD.version+1;
 ELSE
  NEW.version:=OLD.version;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION version_profile_membership() FROM PUBLIC;
CREATE TRIGGER version_profile_membership BEFORE UPDATE ON memberships
 FOR EACH ROW EXECUTE FUNCTION version_profile_membership();

ALTER TABLE session ADD CONSTRAINT session_profile_user_unique UNIQUE(id,"userId");
CREATE TABLE profile_session_context (
 session_id text PRIMARY KEY,
 user_id text NOT NULL,
 workspace_id text NOT NULL REFERENCES profiles(id),
 membership_version integer NOT NULL CHECK (membership_version>0),
 version integer NOT NULL DEFAULT 1 CHECK (version>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(session_id,user_id) REFERENCES session(id,"userId") ON DELETE CASCADE,
 FOREIGN KEY(user_id,workspace_id) REFERENCES memberships(user_id,workspace_id) ON DELETE CASCADE
);
REVOKE ALL ON profile_session_context FROM PUBLIC,commerce_ingress,commerce_automation,commerce_channel;
GRANT SELECT,INSERT,UPDATE ON profile_session_context TO commerce_api;
-- Membership→profile FK, closed role adoption, scoped PATs, quotas and commercial
-- RLS deliberately remain part of the reviewed data transition, not this schema.
