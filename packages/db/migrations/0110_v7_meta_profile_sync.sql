-- V7 RF-11 (D-06): the automation worker reads the profile's own Meta token
-- for official GET-only insight reads, inside that profile's WorkerScope. It
-- gains SELECT of exactly the columns the read needs; the existing
-- v7_integration_profile policy limits every row to the profile context, so a
-- worker transaction without a profile sees none. No write grant, no other role.
DO $meta_sync$
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.meta_profile_credentials'::regclass AND polname='v7_integration_profile')
  OR NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.meta_profile_credential_versions'::regclass AND polname='v7_integration_profile') THEN
  RAISE EXCEPTION 'META_PROFILE_POLICY_REQUIRED';
 END IF;
END $meta_sync$;
GRANT SELECT(workspace_id,revision,enabled,state) ON meta_profile_credentials TO commerce_automation;
GRANT SELECT(workspace_id,revision,ciphertext) ON meta_profile_credential_versions TO commerce_automation;
