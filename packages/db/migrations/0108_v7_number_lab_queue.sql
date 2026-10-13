-- V7 F6 (RF-19): the lab worker finds the next queued operation of each run.
-- Rows stay behind the profile RLS of commerce_number_lab; this definer reads
-- one ACTIVE profile at a time with its own app.workspace_id and returns only
-- identifiers. Per run, only the oldest QUEUED operation, and only when no
-- operation of that run is mid-flight (INTENT/UNKNOWN), so the run version the
-- operation expects is the one it will meet. An operation left in INTENT for
-- more than two minutes (a worker stopped mid-flight) is returned once per pass
-- as RECONCILE: the driver settles it from its engine receipt or leaves it
-- uncertain; it is never executed twice.
CREATE FUNCTION commerce_number_lab.queued_operations(p_limit integer)
RETURNS TABLE(workspace_id text,run_id uuid,operation_id uuid,created_at timestamptz,stage text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p record; remaining integer:=p_limit; n integer;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>50 THEN RAISE EXCEPTION 'LAB_QUEUE_LIMIT'; END IF;
 -- Profiles come from the bounded worker discovery (018), never a raw scan.
 PERFORM pg_catalog.set_config('app.workspace_id','',true);
 FOR p IN SELECT f.id FROM public.discover_worker_profiles() f WHERE f.state='ACTIVE' ORDER BY f.id LOOP
  EXIT WHEN remaining<=0;
  PERFORM pg_catalog.set_config('app.workspace_id',p.id,true);
  RETURN QUERY SELECT q.workspace_id,q.run_id,q.id,q.created_at,q.stage FROM (
   SELECT DISTINCT ON (o.run_id) o.workspace_id,o.run_id,o.id,o.created_at,CASE o.state WHEN 'QUEUED' THEN 'EXECUTE' ELSE 'RECONCILE' END AS stage
   FROM commerce_number_lab.operations o JOIN commerce_number_lab.runs r ON r.workspace_id=o.workspace_id AND r.id=o.run_id
   WHERE o.workspace_id=p.id AND r.state IN('READY','RUNNING','PARTIAL') AND r.expires_at>clock_timestamp()
    AND (o.state='QUEUED' OR (o.state='INTENT' AND o.intent_at<clock_timestamp()-interval '2 minutes'))
   ORDER BY o.run_id,o.created_at,o.id) q ORDER BY q.created_at LIMIT remaining;
  GET DIAGNOSTICS n=ROW_COUNT;remaining:=remaining-n;
 END LOOP;
 PERFORM pg_catalog.set_config('app.workspace_id','',true);
END $$;
ALTER FUNCTION commerce_number_lab.queued_operations(integer) OWNER TO commerce_number_lab_owner;
REVOKE ALL ON FUNCTION commerce_number_lab.queued_operations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.discover_worker_profiles() TO commerce_number_lab_owner;
GRANT EXECUTE ON FUNCTION commerce_number_lab.queued_operations(integer) TO commerce_number_lab;
