-- Retired device credentials remain intact administrative history, never runtime authority.
DO $retired_creative$
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED';
 END IF;
 LOCK TABLE public.creative_devices,public.creative_pairings IN ACCESS EXCLUSIVE MODE;
 IF NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE name='0042_v5_platform_retirement.sql' AND sha256='91059aeb557c2627d2b09513f4015e863dd791e4b6ae242d6aad20f2ce91669f') THEN
  RAISE EXCEPTION 'PROFILE_CREATIVE_RETIREMENT_SOURCE_REQUIRED';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_policy WHERE polrelid IN('public.creative_devices'::regclass,'public.creative_pairings'::regclass))
 OR EXISTS(SELECT 1 FROM pg_class WHERE oid IN('public.creative_devices'::regclass,'public.creative_pairings'::regclass) AND (relrowsecurity OR relforcerowsecurity)) THEN
  RAISE EXCEPTION 'PROFILE_CREATIVE_CUSTODY_ALREADY_ALTERED';
 END IF;
 IF EXISTS(SELECT 1 FROM public.creative_devices WHERE status IS DISTINCT FROM 'REVOKED' OR revoked_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.creative_pairings WHERE status NOT IN('EXPIRED','CONSUMED')) THEN
  RAISE EXCEPTION 'PROFILE_CREATIVE_RETIREMENT_INCOMPLETE';
 END IF;
 ALTER TABLE public.creative_devices ENABLE ROW LEVEL SECURITY;
 ALTER TABLE public.creative_devices FORCE ROW LEVEL SECURITY;
 ALTER TABLE public.creative_pairings ENABLE ROW LEVEL SECURITY;
 ALTER TABLE public.creative_pairings FORCE ROW LEVEL SECURITY;
 -- A restrictive deny also survives an accidental later permissive policy.
 -- No runtime role receives a history/custodian bypass or credential projection.
 CREATE POLICY retired_creative_custody ON public.creative_devices AS RESTRICTIVE TO PUBLIC USING(false) WITH CHECK(false);
 CREATE POLICY retired_creative_custody ON public.creative_pairings AS RESTRICTIVE TO PUBLIC USING(false) WITH CHECK(false);
END
$retired_creative$;
