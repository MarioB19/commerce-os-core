-- V7 F3 (arquitectura «Números y sesiones», RF-07.a, RF-01.9): a WhatsApp line
-- belongs to one confirmed number in the whole installation. Before the API
-- confirms a linked number it asks this closed port whether the same observed
-- identity is already confirmed on another live number, in any profile. The
-- answer is a single boolean: no profile, account, alias or count is revealed,
-- so the profile receives only a neutral "number unavailable" (never the owner).
GRANT SELECT(id) ON records TO commerce_platform_owner;
CREATE FUNCTION number_identity_claimed_elsewhere(p_environment text,p_account uuid,p_fingerprint text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_environment IS NULL OR p_environment NOT IN('REAL','SIMULATION') OR p_account IS NULL
  OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'NUMBER_IDENTITY_INPUT_INVALID'; END IF;
 RETURN EXISTS(SELECT 1 FROM public.records r WHERE r.kind='channel_account' AND r.environment=p_environment
  AND r.id<>p_account AND NOT (r.body ? 'deleted_at') AND r.body->>'identity_fingerprint'=p_fingerprint
  AND r.body->>'ownership_confirmed_at' IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION number_identity_claimed_elsewhere(text,uuid,text) FROM PUBLIC;
ALTER FUNCTION number_identity_claimed_elsewhere(text,uuid,text) OWNER TO commerce_platform_owner;
GRANT EXECUTE ON FUNCTION number_identity_claimed_elsewhere(text,uuid,text) TO commerce_api;
