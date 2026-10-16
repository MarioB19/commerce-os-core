-- The caller receives identity facts only, not unrestricted profile SELECT.
CREATE FUNCTION discover_worker_profiles()
RETURNS TABLE(id text,state text,version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'WORKER_DISCOVERY_OUTSIDE_PROFILE_REQUIRED';
 END IF;
 IF (SELECT count(*) FROM public.profiles)>3 THEN
  RAISE EXCEPTION 'WORKER_PROFILE_INVENTORY_BOUND';
 END IF;
 RETURN QUERY SELECT p.id,p.state,p.version FROM public.profiles p ORDER BY p.id;
END $$;
REVOKE ALL ON FUNCTION discover_worker_profiles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION discover_worker_profiles() TO commerce_automation,commerce_channel;
