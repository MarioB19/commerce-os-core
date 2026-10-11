-- Scoped cancellation for commands that have never been claimed.
-- API may cancel one definitively unclaimed command, without UPDATE(status).
CREATE FUNCTION public.cancel_pending_channel_command(
 p_workspace_id text, p_environment text, p_account_id uuid, p_command_id uuid,
 p_actor_id text, p_reason text, p_account_version integer, p_session_revision bigint
) RETURNS TABLE(command_id uuid,command_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_session_id uuid; v_type text;
BEGIN
 IF p_environment NOT IN ('REAL','SIMULATION') OR p_actor_id IS NULL
    OR length(p_actor_id)=0 OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000
    OR p_account_version IS NULL OR p_account_version<=0
    OR p_session_revision IS NULL OR p_session_revision<=0 THEN RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('channel-command:'||p_account_id::text,0));
 -- Preserve the canonical resource/version binding even against non-worker writers.
 PERFORM r.id FROM public.records r
   WHERE r.id=p_account_id AND r.workspace_id=p_workspace_id AND r.environment=p_environment
     AND r.kind='channel_account' AND r.version=p_account_version
     AND coalesce(r.body->>'deleted_at','')='' FOR SHARE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT s.id INTO v_session_id FROM public.channel_sessions s
   WHERE s.account_id=p_account_id AND s.workspace_id=p_workspace_id AND s.environment=p_environment
     AND s.archived_at IS NULL AND s.revision=p_session_revision FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE public.commands c SET status='FAILED',
   result=pg_catalog.jsonb_build_object('error','CHANNEL_COMMAND_CANCELLED_BEFORE_EXECUTION',
     'remote_outcome','NOT_ATTEMPTED','cancelled_by',p_actor_id,'reason',p_reason,
     'cancelled_at',pg_catalog.clock_timestamp()),updated_at=pg_catalog.clock_timestamp()
   WHERE c.id=p_command_id AND c.workspace_id=p_workspace_id AND c.environment=p_environment
     AND c.resource_id=p_account_id::text AND c.kind='channel_command'
     AND c.payload->>'type' IN('connect','restart','disconnect','logout','check_health')
     AND c.status='PENDING' AND c.result='{}'::jsonb
   RETURNING c.payload->>'type' INTO v_type;
 IF NOT FOUND THEN RETURN; END IF;
 IF v_type IN('connect','restart','disconnect','logout') THEN
   UPDATE public.channel_sessions SET desired_state='STOPPED',operational_pause=true,
     revision=revision+1,updated_at=pg_catalog.now() WHERE id=v_session_id;
 END IF;
 RETURN QUERY SELECT p_command_id,v_type;
END $$;
REVOKE ALL ON FUNCTION public.cancel_pending_channel_command(text,text,uuid,uuid,text,text,integer,bigint)
 FROM PUBLIC,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance;
GRANT EXECUTE ON FUNCTION public.cancel_pending_channel_command(text,text,uuid,uuid,text,text,integer,bigint)
 TO commerce_api;
