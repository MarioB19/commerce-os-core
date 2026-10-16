-- V7 F2 cutover: platform quota policy (D-14: 3 profiles, 20 connected numbers,
-- 300 conversations/day, platform calendar America/Mexico_City) and a sealed
-- native baseline per adopted profile. Existing records are counted, never
-- rejected or rewritten: limits were chosen in 0071 at or above current use.
INSERT INTO profile_quota_policy(singleton,max_profiles,max_numbers,daily_conversations,calendar_timezone,adoption_sha256)
VALUES(true,3,20,300,'America/Mexico_City',encode(public.digest(convert_to('v7-platform-quota/v1:3:20:300:America/Mexico_City','UTF8'),'sha256'),'hex'));
DO $quota_adoption$
DECLARE profile record;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
 FOR profile IN SELECT id FROM public.profiles ORDER BY id LOOP
  PERFORM pg_catalog.set_config('app.workspace_id',profile.id,true);
  PERFORM public.adopt_profile_quota_inventory(profile.id,public.profile_quota_inventory(profile.id));
 END LOOP;
 PERFORM pg_catalog.set_config('app.workspace_id','',true);
 IF (SELECT count(*) FROM public.profile_quota_coverage)<>(SELECT count(*) FROM public.profiles)
  OR (SELECT count(*) FROM public.profile_quota_entries WHERE kind='channel_account' AND retired_at IS NULL)>20
  OR (SELECT count(*) FROM public.profile_quota_entries)<>(SELECT count(*) FROM public.records WHERE environment='REAL' AND kind IN('product','channel_account','conversation')) THEN
  RAISE EXCEPTION 'V7_QUOTA_ADOPTION_COUNT_MISMATCH';
 END IF;
END $quota_adoption$;
