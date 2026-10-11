-- Physical host slots are shared across workspaces; SIMULATION remains isolated.
CREATE FUNCTION guard_number_host_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.environment='REAL' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('number-host:'||NEW.host_ref,0));
  IF EXISTS(SELECT 1 FROM number_capacity_slots s WHERE s.environment='REAL' AND s.host_ref=NEW.host_ref AND s.slot=NEW.slot AND s.id<>NEW.id AND s.workspace_id<>NEW.workspace_id) THEN
   RAISE EXCEPTION 'HOST_SLOT_ALREADY_RESERVED';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_number_host_slot BEFORE INSERT OR UPDATE OF host_ref,slot,workspace_id,environment ON number_capacity_slots FOR EACH ROW EXECUTE FUNCTION guard_number_host_slot();
