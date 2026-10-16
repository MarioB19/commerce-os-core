-- Worker authority reads one profile already selected by the authenticated
-- scheduler. This supplies a locked fact, not authority to select a profile.
CREATE FUNCTION read_locked_continuous_worker_profile()
RETURNS TABLE(id text,state text,version integer,timezone text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected text:=pg_catalog.current_setting('app.workspace_id',true);
BEGIN
 IF selected IS NULL OR length(selected)=0 THEN
  RAISE EXCEPTION 'CONTINUITY_PROFILE_CONTEXT_REQUIRED';
 END IF;
 RETURN QUERY SELECT p.id,p.state,p.version,p.timezone FROM public.profiles p
  WHERE p.id=selected FOR SHARE;
END $$;
REVOKE ALL ON FUNCTION read_locked_continuous_worker_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_locked_continuous_worker_profile() TO commerce_automation,commerce_channel;
