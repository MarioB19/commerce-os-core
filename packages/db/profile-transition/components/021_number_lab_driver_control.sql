-- Control database only: this is not installed in the dedicated engine.
-- The existing closed reader exposes no profile data and locks ACTIVE state.
DO $$ BEGIN
 IF to_regprocedure('commerce_number_lab.lock_profile(text)') IS NULL
  OR current_database() ~ '^commerce_lab_engine_' THEN
  RAISE EXCEPTION 'LAB_CONTROL_DATABASE_REQUIRED';
 END IF;
END $$;
GRANT EXECUTE ON FUNCTION commerce_number_lab.lock_profile(text) TO commerce_number_lab;
