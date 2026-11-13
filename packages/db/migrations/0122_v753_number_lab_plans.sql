-- V7.5.3 (Claude): «Probar número» plans and one aggregate paid matrix.
-- A suite case may carry the plan the automatic buyer must verify (expected
-- materials per stage and approved amount, the acceptance it sends and the
-- receipt amount it uses). Suites started under one matrix share a single,
-- persistent ceiling of AI calls and cost: a second suite is admitted only if
-- the matrix's total stays within it. Columns only; RLS, ownership and grants
-- of both tables are unchanged (0115).
DO $$BEGIN
 IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'NUMBER_LAB_PLANS_OWNER_REQUIRED';
 END IF;
END$$;
ALTER TABLE commerce_number_lab.suite_cases ADD COLUMN plan jsonb NOT NULL DEFAULT '{}'::jsonb
 CHECK(jsonb_typeof(plan)='object' AND length(plan::text)<=20000);
ALTER TABLE commerce_number_lab.suites
 ADD COLUMN maximum_ai_calls integer CHECK(maximum_ai_calls IS NULL OR maximum_ai_calls BETWEEN 1 AND 19200),
 ADD COLUMN matrix_id uuid,
 ADD COLUMN matrix_maximum_microusd bigint CHECK(matrix_maximum_microusd IS NULL OR matrix_maximum_microusd BETWEEN 1 AND 9007199254740991),
 ADD COLUMN matrix_maximum_ai_calls integer CHECK(matrix_maximum_ai_calls IS NULL OR matrix_maximum_ai_calls BETWEEN 1 AND 19200),
 ADD CONSTRAINT suites_matrix_complete CHECK((matrix_id IS NULL)=(matrix_maximum_microusd IS NULL) AND (matrix_id IS NULL)=(matrix_maximum_ai_calls IS NULL) AND (matrix_id IS NULL OR maximum_ai_calls IS NOT NULL)),
 ADD CONSTRAINT suites_matrix_within CHECK(matrix_id IS NULL OR (maximum_microusd<=matrix_maximum_microusd AND maximum_ai_calls<=matrix_maximum_ai_calls));
CREATE INDEX number_lab_suite_matrix ON commerce_number_lab.suites(workspace_id,matrix_id) WHERE matrix_id IS NOT NULL;
