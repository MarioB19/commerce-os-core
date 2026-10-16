-- V7 F2 cutover: Profile and platform quotas (014).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/014_profile_quotas.sql (source sha256 64c77a026640df93b011cbee2fd3c91ef8868790b3616e0f1479832c80ae2a70)
-- Staged V7 schema only. No native policy, LOAD admission or baseline is created.
CREATE TABLE profile_quota_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 max_profiles integer NOT NULL CHECK(max_profiles=3),
 max_numbers integer NOT NULL CHECK(max_numbers=20),
 daily_conversations integer NOT NULL CHECK(daily_conversations=300),
 calendar_timezone text NOT NULL,
 adoption_sha256 text NOT NULL CHECK(adoption_sha256 ~ '^[0-9a-f]{64}$'),
 adopted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE profile_quota_load_admissions (
 id uuid PRIMARY KEY,
 measured_proof_sha256 text NOT NULL CHECK(measured_proof_sha256 ~ '^[0-9a-f]{64}$'),
 economic_adoption_sha256 text NOT NULL CHECK(economic_adoption_sha256 ~ '^[0-9a-f]{64}$'),
 daily_conversations integer NOT NULL CHECK(daily_conversations=1000),
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 starts_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 CHECK(issued_at<=starts_at AND starts_at<expires_at)
);
CREATE TABLE profile_quota_coverage (
 workspace_id text PRIMARY KEY REFERENCES profiles(id),
 inventory_sha256 text NOT NULL CHECK(inventory_sha256 ~ '^[0-9a-f]{64}$'),
 adopted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE profile_quota_entries (
 record_id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES profiles(id),
 kind text NOT NULL CHECK(kind IN ('product','channel_account','conversation')),
 admitted_at timestamptz NOT NULL,
 profile_timezone text NOT NULL,
 profile_day_start timestamptz NOT NULL,
 profile_day_end timestamptz NOT NULL,
 platform_day_start timestamptz NOT NULL,
 platform_day_end timestamptz NOT NULL,
 retired_at timestamptz,
 source text NOT NULL CHECK(source IN ('NATIVE_BASELINE','RUNTIME')),
 CHECK(profile_day_start<=admitted_at AND admitted_at<profile_day_end),
 CHECK(platform_day_start<=admitted_at AND admitted_at<platform_day_end),
 CHECK(retired_at IS NULL OR (kind='channel_account' AND retired_at>=admitted_at))
);
CREATE INDEX profile_quota_usage ON profile_quota_entries(workspace_id,kind,profile_day_start,profile_day_end);
CREATE INDEX profile_quota_platform_usage ON profile_quota_entries(kind,platform_day_start,platform_day_end);
REVOKE ALL ON profile_quota_policy,profile_quota_load_admissions,profile_quota_coverage,profile_quota_entries
 FROM PUBLIC,commerce_api,commerce_ingress,commerce_automation,commerce_channel;
CREATE TRIGGER immutable_quota_policy BEFORE UPDATE OR DELETE ON profile_quota_policy FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_quota_load BEFORE UPDATE OR DELETE ON profile_quota_load_admissions FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_quota_coverage BEFORE UPDATE OR DELETE ON profile_quota_coverage FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE FUNCTION guard_profile_quota_history() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PROFILE_QUOTA_HISTORY_IMMUTABLE'; END IF;
 IF OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL OR OLD.kind<>'channel_account'
  OR (to_jsonb(NEW)-'retired_at') IS DISTINCT FROM (to_jsonb(OLD)-'retired_at') THEN
  RAISE EXCEPTION 'PROFILE_QUOTA_HISTORY_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_profile_quota_history() FROM PUBLIC;
CREATE TRIGGER immutable_quota_entries BEFORE UPDATE OR DELETE ON profile_quota_entries
 FOR EACH ROW EXECUTE FUNCTION guard_profile_quota_history();

CREATE FUNCTION profile_quota_day(moment timestamptz, zone text)
 RETURNS TABLE(day_start timestamptz,day_end timestamptz) LANGUAGE plpgsql STABLE
 SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=zone) THEN RAISE EXCEPTION 'PROFILE_QUOTA_TIMEZONE_INVALID'; END IF;
 RETURN QUERY SELECT date_trunc('day',moment AT TIME ZONE zone) AT TIME ZONE zone,
  (date_trunc('day',moment AT TIME ZONE zone)+interval '1 day') AT TIME ZONE zone;
END $$;

CREATE FUNCTION profile_quota_lock() RETURNS void LANGUAGE plpgsql
 SET search_path=pg_catalog AS $$
BEGIN
 IF NOT pg_catalog.pg_try_advisory_xact_lock(743912014::bigint) THEN RAISE EXCEPTION 'PROFILE_QUOTA_BUSY' USING ERRCODE='55P03'; END IF;
END $$;

CREATE FUNCTION profile_quota_allocation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog AS $$
DECLARE p public.profile_quota_policy%ROWTYPE; n bigint; allocated bigint;
BEGIN
 PERFORM public.profile_quota_lock();
 SELECT * INTO p FROM public.profile_quota_policy WHERE singleton FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_QUOTA_POLICY_REQUIRED'; END IF;
 PERFORM * FROM public.profile_quota_day(clock_timestamp(),p.calendar_timezone);
 PERFORM * FROM public.profile_quota_day(clock_timestamp(),NEW.timezone);
 SELECT count(*),COALESCE(sum(number_limit),0) INTO n,allocated FROM public.profiles WHERE id<>NEW.id;
 IF n+1>p.max_profiles OR allocated+NEW.number_limit>p.max_numbers THEN RAISE EXCEPTION 'PROFILE_QUOTA_ALLOCATION_EXCEEDED'; END IF;
 IF (SELECT count(*) FROM public.profile_quota_entries WHERE workspace_id=NEW.id AND kind='channel_account' AND retired_at IS NULL)>NEW.number_limit
 OR (SELECT count(*) FROM public.profile_quota_entries WHERE workspace_id=NEW.id AND kind='product')>NEW.product_limit THEN
  RAISE EXCEPTION 'PROFILE_QUOTA_BELOW_CONSUMED';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.number_limit IS DISTINCT FROM OLD.number_limit OR NEW.product_limit IS DISTINCT FROM OLD.product_limit
  OR NEW.daily_conversation_limit IS DISTINCT FROM OLD.daily_conversation_limit) THEN
  NEW.version:=OLD.version+1;NEW.updated_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profile_quota_allocation BEFORE INSERT OR UPDATE OF timezone,number_limit,product_limit,daily_conversation_limit ON profiles
 FOR EACH ROW EXECUTE FUNCTION profile_quota_allocation_guard();

-- Owner-only hash: no row body, PII or secret leaves this function.
CREATE FUNCTION profile_quota_inventory(workspace text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('app.workspace_id',true) IS DISTINCT FROM workspace THEN RAISE EXCEPTION 'PROFILE_QUOTA_CONTEXT_REQUIRED'; END IF;
 RETURN (SELECT encode(public.digest(convert_to(jsonb_build_object(
 'profile',(SELECT jsonb_build_array(id,state,timezone,number_limit,product_limit,daily_conversation_limit,version) FROM public.profiles WHERE id=workspace),
 'records',COALESCE((SELECT jsonb_agg(jsonb_build_array(id,kind,version,
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),encode(public.digest(convert_to(body::text,'UTF8'),'sha256'),'hex')) ORDER BY id)
  FROM public.records WHERE workspace_id=workspace AND environment='REAL' AND kind IN ('product','channel_account','conversation')),'[]'::jsonb)
 )::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION adopt_profile_quota_inventory(workspace text,expected_sha256 text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog AS $$
DECLARE p public.profile_quota_policy%ROWTYPE; f public.profiles%ROWTYPE; observed timestamptz:=clock_timestamp();
BEGIN
 IF current_setting('app.workspace_id',true) IS DISTINCT FROM workspace THEN RAISE EXCEPTION 'PROFILE_QUOTA_CONTEXT_REQUIRED'; END IF;
 PERFORM public.profile_quota_lock();
 SELECT * INTO p FROM public.profile_quota_policy WHERE singleton FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_QUOTA_POLICY_REQUIRED'; END IF;
 SELECT * INTO f FROM public.profiles WHERE id=workspace FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_QUOTA_PROFILE_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM public.profile_quota_coverage WHERE workspace_id=workspace) THEN RAISE EXCEPTION 'PROFILE_QUOTA_ALREADY_ADOPTED'; END IF;
 -- Lock the native rows before hashing and seeding; an update cannot change
 -- their body/created_at between the two statements.
 PERFORM 1 FROM public.records WHERE workspace_id=workspace AND environment='REAL'
  AND kind IN ('product','channel_account','conversation') FOR SHARE;
 IF expected_sha256 IS NULL OR expected_sha256 !~ '^[0-9a-f]{64}$' OR public.profile_quota_inventory(workspace)<>expected_sha256 THEN RAISE EXCEPTION 'PROFILE_QUOTA_INVENTORY_CHANGED'; END IF;
 IF (SELECT count(*) FROM public.profiles)>p.max_profiles OR (SELECT COALESCE(sum(number_limit),0) FROM public.profiles)>p.max_numbers THEN RAISE EXCEPTION 'PROFILE_QUOTA_ALLOCATION_EXCEEDED'; END IF;
 IF EXISTS(SELECT 1 FROM public.records WHERE workspace_id=workspace AND environment='REAL' AND kind IN ('product','channel_account','conversation') AND created_at>observed) THEN RAISE EXCEPTION 'PROFILE_QUOTA_FUTURE_BASELINE'; END IF;
 INSERT INTO public.profile_quota_entries(record_id,workspace_id,kind,admitted_at,profile_timezone,profile_day_start,profile_day_end,platform_day_start,platform_day_end,retired_at,source)
 SELECT r.id,r.workspace_id,r.kind,r.created_at,f.timezone,d.day_start,d.day_end,g.day_start,g.day_end,
 CASE WHEN r.kind='channel_account' AND r.body?'deleted_at' THEN observed ELSE NULL END,'NATIVE_BASELINE'
 FROM public.records r CROSS JOIN LATERAL public.profile_quota_day(r.created_at,f.timezone) d
 CROSS JOIN LATERAL public.profile_quota_day(r.created_at,p.calendar_timezone) g
 WHERE r.workspace_id=workspace AND r.environment='REAL' AND r.kind IN ('product','channel_account','conversation');
 IF (SELECT count(*) FROM public.profile_quota_entries WHERE workspace_id=workspace AND kind='channel_account' AND retired_at IS NULL)>f.number_limit
 OR (SELECT count(*) FROM public.profile_quota_entries WHERE workspace_id=workspace AND kind='product')>f.product_limit THEN RAISE EXCEPTION 'PROFILE_QUOTA_BELOW_CONSUMED'; END IF;
 INSERT INTO public.profile_quota_coverage(workspace_id,inventory_sha256,adopted_at) VALUES(workspace,expected_sha256,observed);
END $$;

CREATE FUNCTION profile_quota_record_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog AS $$
DECLARE p public.profile_quota_policy%ROWTYPE; f public.profiles%ROWTYPE;
 moment timestamptz; ds timestamptz; de timestamptz; gs timestamptz; ge timestamptz;
 capacity integer; loads integer; used bigint; own public.session_ownership%ROWTYPE;
BEGIN
 IF NEW.environment<>'REAL' OR NEW.kind NOT IN ('product','channel_account','conversation') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.id<>OLD.id THEN RAISE EXCEPTION 'PROFILE_QUOTA_IDENTITY_IMMUTABLE'; END IF;
  IF NEW.kind<>'channel_account' THEN RETURN NEW; END IF;
  IF OLD.body?'deleted_at' THEN
   IF NEW.body IS DISTINCT FROM OLD.body THEN RAISE EXCEPTION 'PROFILE_QUOTA_RETIRED_IMMUTABLE'; END IF;
   RETURN NEW;
  END IF;
  IF NOT (NEW.body?'deleted_at') THEN RETURN NEW; END IF;
 END IF;
 IF current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id THEN RAISE EXCEPTION 'PROFILE_QUOTA_CONTEXT_REQUIRED'; END IF;
 PERFORM public.profile_quota_lock();
 SELECT * INTO p FROM public.profile_quota_policy WHERE singleton FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_QUOTA_POLICY_REQUIRED'; END IF;
 SELECT * INTO f FROM public.profiles WHERE id=NEW.workspace_id FOR SHARE;
 IF NOT FOUND OR f.state<>'ACTIVE' THEN RAISE EXCEPTION 'PROFILE_QUOTA_PROFILE_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.profile_quota_coverage WHERE workspace_id=f.id) THEN RAISE EXCEPTION 'PROFILE_QUOTA_INVENTORY_REQUIRED'; END IF;
 moment:=clock_timestamp();
 IF TG_OP='UPDATE' THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('channel-command:'||OLD.id::text,0)) THEN RAISE EXCEPTION 'CHANNEL_COMMAND_PENDING'; END IF;
  IF OLD.body->>'status' IS NULL OR OLD.body->>'status' NOT IN ('NEW','DISCONNECTED','STOPPED')
   OR NEW.body->>'sending_enabled' IS DISTINCT FROM 'false' OR NEW.body->>'identity_verified' IS DISTINCT FROM 'false'
   OR NEW.body->>'active_authorization_id' IS NOT NULL OR COALESCE(NEW.body->>'deleted_at','')='' THEN RAISE EXCEPTION 'PROFILE_QUOTA_UNSAFE_RETIREMENT'; END IF;
  PERFORM 1 FROM public.manual_controls WHERE workspace_id=f.id AND scope_type='channel_account' AND scope_id=OLD.id::text AND paused FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_QUOTA_RETIREMENT_PAUSE_REQUIRED'; END IF;
  SELECT * INTO own FROM public.session_ownership WHERE workspace_id=f.id AND account_id=OLD.id::text FOR SHARE;
  IF FOUND AND (NOT own.frozen OR (OLD.body->>'provider'='waha' AND COALESCE(OLD.body->>'unlinked_at','')='')) THEN RAISE EXCEPTION 'PROFILE_QUOTA_OWNERSHIP_UNRESOLVED'; END IF;
  IF EXISTS(SELECT 1 FROM public.commands WHERE workspace_id=f.id AND environment='REAL' AND resource_id=OLD.id::text AND kind='channel_command' AND status='PENDING')
   OR EXISTS(SELECT 1 FROM public.outbox WHERE workspace_id=f.id AND environment='REAL' AND account_id=OLD.id::text AND status IN ('SENDING','UNKNOWN')) THEN RAISE EXCEPTION 'PROFILE_QUOTA_EFFECTS_UNRESOLVED'; END IF;
  UPDATE public.profile_quota_entries SET retired_at=moment WHERE record_id=OLD.id AND workspace_id=f.id AND kind='channel_account' AND retired_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_QUOTA_RESERVATION_REQUIRED'; END IF;
  RETURN NEW;
 END IF;
 -- The platform limit is meaningful only when every existing profile has a
 -- sealed baseline, including suspended profiles. Profile creation and adoption
 -- share this global lock, so a new uncovered profile cannot race this check.
 IF EXISTS(SELECT 1 FROM public.profiles p0 WHERE NOT EXISTS(
  SELECT 1 FROM public.profile_quota_coverage c WHERE c.workspace_id=p0.id)) THEN
  RAISE EXCEPTION 'PLATFORM_QUOTA_INVENTORY_REQUIRED';
 END IF;
 IF NEW.kind='channel_account' AND NEW.body?'deleted_at' THEN RAISE EXCEPTION 'PROFILE_QUOTA_RETIRED_INSERT_FORBIDDEN'; END IF;
 SELECT day_start,day_end INTO ds,de FROM public.profile_quota_day(moment,f.timezone);
 SELECT day_start,day_end INTO gs,ge FROM public.profile_quota_day(moment,p.calendar_timezone);
 IF NEW.kind='conversation' THEN
  SELECT count(*),max(daily_conversations) INTO loads,capacity FROM public.profile_quota_load_admissions WHERE starts_at<=moment AND moment<expires_at;
  IF loads>1 THEN RAISE EXCEPTION 'PROFILE_QUOTA_LOAD_AMBIGUOUS'; END IF;
  capacity:=COALESCE(capacity,p.daily_conversations);
  SELECT count(*) INTO used FROM public.profile_quota_entries WHERE kind='conversation' AND platform_day_start<ge AND platform_day_end>gs;
  IF used>=capacity THEN RAISE EXCEPTION 'PLATFORM_CONVERSATION_QUOTA_EXCEEDED'; END IF;
  SELECT count(*) INTO used FROM public.profile_quota_entries WHERE workspace_id=f.id AND kind='conversation' AND profile_day_start<de AND profile_day_end>ds;
  IF used>=f.daily_conversation_limit THEN RAISE EXCEPTION 'PROFILE_CONVERSATION_QUOTA_EXCEEDED'; END IF;
 ELSIF NEW.kind='channel_account' THEN
  IF (SELECT count(*) FROM public.profile_quota_entries WHERE kind='channel_account' AND retired_at IS NULL)>=p.max_numbers THEN RAISE EXCEPTION 'PLATFORM_NUMBER_QUOTA_EXCEEDED'; END IF;
  IF (SELECT count(*) FROM public.profile_quota_entries WHERE workspace_id=f.id AND kind='channel_account' AND retired_at IS NULL)>=f.number_limit THEN RAISE EXCEPTION 'PROFILE_NUMBER_QUOTA_EXCEEDED'; END IF;
 ELSE
  IF (SELECT count(*) FROM public.profile_quota_entries WHERE workspace_id=f.id AND kind='product')>=f.product_limit THEN RAISE EXCEPTION 'PROFILE_PRODUCT_QUOTA_EXCEEDED'; END IF;
 END IF;
 INSERT INTO public.profile_quota_entries(record_id,workspace_id,kind,admitted_at,profile_timezone,profile_day_start,profile_day_end,platform_day_start,platform_day_end,source)
 VALUES(NEW.id,f.id,NEW.kind,moment,f.timezone,ds,de,gs,ge,'RUNTIME');
 RETURN NEW;
END $$;
CREATE TRIGGER profile_quota_record BEFORE INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION profile_quota_record_guard();

REVOKE ALL ON FUNCTION profile_quota_day(timestamptz,text),profile_quota_lock(),profile_quota_allocation_guard(),
 profile_quota_inventory(text),adopt_profile_quota_inventory(text,text),profile_quota_record_guard()
 FROM PUBLIC,commerce_api,commerce_ingress,commerce_automation,commerce_channel;
-- <<< end 014_profile_quotas.sql
