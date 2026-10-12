-- Prepared transition. No automatic adoption, live installation or receipt decision.
CREATE FUNCTION receipt_policy_canonical(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE result text;
BEGIN
 IF jsonb_typeof(v)='object' THEN SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||public.receipt_policy_canonical(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(v);RETURN result; END IF;
 IF jsonb_typeof(v)='array' THEN SELECT '['||COALESCE(string_agg(public.receipt_policy_canonical(value),',' ORDER BY ordinal),'')||']' INTO result FROM jsonb_array_elements(v) WITH ORDINALITY a(value,ordinal);RETURN result; END IF;
 IF jsonb_typeof(v)='number' AND (v#>>'{}')::numeric=trunc((v#>>'{}')::numeric) THEN RETURN ((v#>>'{}')::numeric)::bigint::text; END IF;
 RETURN v::text;
END $$;
CREATE FUNCTION valid_receipt_policy(v jsonb,partial boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE keys text[]:=ARRAY['automaticApproval','failureDisposition','minimumConfidenceBps','amount','destination','beneficiary','date','reference','concept'];k text;x jsonb;n numeric;
BEGIN
 IF v IS NULL OR partial IS NULL OR jsonb_typeof(v)<>'object' OR (v-keys)<>'{}'::jsonb OR (NOT partial AND NOT v?&keys) THEN RETURN false; END IF;
 IF v?'automaticApproval' AND jsonb_typeof(v->'automaticApproval')<>'boolean' THEN RETURN false; END IF;
 IF v?'failureDisposition' AND (v->>'failureDisposition' IS NULL OR v->>'failureDisposition' NOT IN('REVIEW','REJECT')) THEN RETURN false; END IF;
 IF v?'minimumConfidenceBps' THEN x:=v->'minimumConfidenceBps';IF jsonb_typeof(x)<>'number' THEN RETURN false;END IF;n:=(x#>>'{}')::numeric;IF n<>trunc(n) OR n<0 OR n>10000 THEN RETURN false;END IF; END IF;
 IF v?'amount' THEN
  x:=v->'amount';IF jsonb_typeof(x)<>'object' OR x->>'mode' IS NULL THEN RETURN false;END IF;
  IF x->>'mode' IN('EXACT','MINIMUM') THEN IF x-ARRAY['mode']<>'{}' THEN RETURN false;END IF;
  ELSIF x->>'mode'='TOLERANCE' THEN IF NOT x?&ARRAY['mode','toleranceMinor'] OR x-ARRAY['mode','toleranceMinor']<>'{}' OR jsonb_typeof(x->'toleranceMinor')<>'number' THEN RETURN false;END IF;n:=(x->>'toleranceMinor')::numeric;IF n<>trunc(n) OR n<0 OR n>9007199254740991 THEN RETURN false;END IF;
  ELSE RETURN false;END IF;
 END IF;
 IF v?'destination' THEN
  x:=v->'destination';IF jsonb_typeof(x)<>'object' OR x->>'mode' IS NULL THEN RETURN false;END IF;
  IF x->>'mode' IN('EXACT','DISABLED') THEN IF x-ARRAY['mode']<>'{}' THEN RETURN false;END IF;
  ELSIF x->>'mode'='SUFFIX' THEN IF NOT x?&ARRAY['mode','digits'] OR x-ARRAY['mode','digits']<>'{}' OR jsonb_typeof(x->'digits')<>'number' THEN RETURN false;END IF;n:=(x->>'digits')::numeric;IF n<>trunc(n) OR n<4 OR n>18 THEN RETURN false;END IF;
  ELSE RETURN false;END IF;
 END IF;
 IF v?'beneficiary' THEN x:=v->'beneficiary';IF jsonb_typeof(x)<>'object' OR NOT x?'required' OR x-ARRAY['required']<>'{}' OR jsonb_typeof(x->'required')<>'boolean' THEN RETURN false;END IF;END IF;
 IF v?'date' THEN
  x:=v->'date';IF jsonb_typeof(x)<>'object' OR NOT x?&ARRAY['required','maximumAgeDays','maximumFutureDays'] OR x-ARRAY['required','maximumAgeDays','maximumFutureDays']<>'{}' OR jsonb_typeof(x->'required')<>'boolean' THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['maximumAgeDays','maximumFutureDays'] LOOP IF jsonb_typeof(x->k)<>'number' THEN RETURN false;END IF;n:=(x->>k)::numeric;IF n<>trunc(n) OR n<0 OR n>(CASE WHEN k='maximumAgeDays' THEN 365 ELSE 1 END) THEN RETURN false;END IF;END LOOP;
 END IF;
 FOREACH k IN ARRAY ARRAY['reference','concept'] LOOP
  IF v?k THEN x:=v->k;IF jsonb_typeof(x)<>'object' OR NOT x?&ARRAY['required','match'] OR x-ARRAY['required','match']<>'{}' OR jsonb_typeof(x->'required')<>'boolean' OR x->>'match' IS NULL OR x->>'match' NOT IN('PRESENT','EXACT','CONTAINS') THEN RETURN false;END IF;END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE TABLE receipt_policy_heads (
 workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 id uuid NOT NULL,variant_id uuid,revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),current_version_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,id),UNIQUE NULLS NOT DISTINCT(workspace_id,environment,variant_id),
 FOREIGN KEY(workspace_id,environment,variant_id) REFERENCES market_variants(workspace_id,environment,id)
);
CREATE TABLE receipt_policy_versions (
 workspace_id text NOT NULL,environment text NOT NULL,id uuid NOT NULL,head_id uuid NOT NULL,revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),
 is_override boolean NOT NULL,body jsonb NOT NULL,sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),actor_id text NOT NULL CHECK(length(actor_id)>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,id),UNIQUE(workspace_id,environment,head_id,revision),UNIQUE(workspace_id,environment,head_id,revision,id),
 FOREIGN KEY(workspace_id,environment,head_id) REFERENCES receipt_policy_heads(workspace_id,environment,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(valid_receipt_policy(body,is_override) IS TRUE),CHECK(sha256=encode(sha256(convert_to(receipt_policy_canonical(body),'UTF8')),'hex'))
);
ALTER TABLE receipt_policy_heads ADD CONSTRAINT receipt_policy_current FOREIGN KEY(workspace_id,environment,id,revision,current_version_id)
 REFERENCES receipt_policy_versions(workspace_id,environment,head_id,revision,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE receipt_policy_operations (
 workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),actor_id text NOT NULL CHECK(length(actor_id)>0),operation_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,actor_id,operation_id)
);
CREATE TABLE receipt_order_policy_snapshots (
 workspace_id text NOT NULL,environment text NOT NULL,order_id uuid NOT NULL,order_kind text NOT NULL DEFAULT 'order' CHECK(order_kind='order'),variant_id uuid NOT NULL,
 profile_version_id uuid NOT NULL,variant_version_id uuid,body jsonb NOT NULL,sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,order_id),
 FOREIGN KEY(order_id,workspace_id,environment,order_kind) REFERENCES records(id,workspace_id,environment,kind),
 FOREIGN KEY(workspace_id,environment,variant_id) REFERENCES market_variants(workspace_id,environment,id),
 FOREIGN KEY(workspace_id,environment,profile_version_id) REFERENCES receipt_policy_versions(workspace_id,environment,id),
 FOREIGN KEY(workspace_id,environment,variant_version_id) REFERENCES receipt_policy_versions(workspace_id,environment,id),
 CHECK(jsonb_typeof(body)='object' AND (body->>'sha256'=sha256) IS TRUE),CHECK(sha256=encode(sha256(convert_to(receipt_policy_canonical(body-'sha256'),'UTF8')),'hex'))
);
CREATE FUNCTION guard_receipt_policy_head() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('receipt-policy:'||NEW.workspace_id||':'||NEW.environment,0));
 IF TG_OP='INSERT' THEN IF NEW.revision<>1 THEN RAISE EXCEPTION 'RECEIPT_POLICY_REVISION';END IF;
 ELSIF (NEW.id,NEW.workspace_id,NEW.environment,NEW.variant_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.environment,OLD.variant_id,OLD.created_at) OR NEW.revision<>OLD.revision+1 OR NEW.current_version_id=OLD.current_version_id THEN RAISE EXCEPTION 'RECEIPT_POLICY_REVISION';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION guard_receipt_policy_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE h public.receipt_policy_heads%ROWTYPE;
BEGIN
 SELECT * INTO h FROM public.receipt_policy_heads WHERE workspace_id=NEW.workspace_id AND environment=NEW.environment AND id=NEW.head_id;
 IF NOT FOUND OR h.revision<>NEW.revision OR h.current_version_id<>NEW.id OR NEW.is_override IS DISTINCT FROM (h.variant_id IS NOT NULL) THEN RAISE EXCEPTION 'RECEIPT_POLICY_VERSION';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION guard_receipt_order_policy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p public.receipt_policy_versions%ROWTYPE;v public.receipt_policy_versions%ROWTYPE;actual jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('receipt-policy:'||NEW.workspace_id||':'||NEW.environment,0));
 SELECT pv.* INTO p FROM public.receipt_policy_versions pv JOIN public.receipt_policy_heads ph ON ph.workspace_id=pv.workspace_id AND ph.environment=pv.environment AND ph.id=pv.head_id
 WHERE pv.workspace_id=NEW.workspace_id AND pv.environment=NEW.environment AND pv.id=NEW.profile_version_id AND ph.variant_id IS NULL AND ph.current_version_id=pv.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'RECEIPT_POLICY_PROFILE_VERSION';END IF;
 IF NEW.variant_version_id IS NULL AND EXISTS(SELECT 1 FROM public.receipt_policy_heads WHERE workspace_id=NEW.workspace_id AND environment=NEW.environment AND variant_id=NEW.variant_id) THEN RAISE EXCEPTION 'RECEIPT_POLICY_OVERRIDE_REQUIRED';END IF;
 IF NEW.variant_version_id IS NOT NULL THEN
  SELECT pv.* INTO v FROM public.receipt_policy_versions pv JOIN public.receipt_policy_heads ph ON ph.workspace_id=pv.workspace_id AND ph.environment=pv.environment AND ph.id=pv.head_id
  WHERE pv.workspace_id=NEW.workspace_id AND pv.environment=NEW.environment AND pv.id=NEW.variant_version_id AND ph.variant_id=NEW.variant_id AND ph.current_version_id=pv.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECEIPT_POLICY_VARIANT_VERSION';END IF;
 END IF;
 actual:=jsonb_build_object('schemaVersion',1,'scope',jsonb_build_object('workspace_id',NEW.workspace_id,'environment',NEW.environment),'variantId',NEW.variant_id::text,
 'profile',jsonb_build_object('id',p.id::text,'revision',p.revision,'sha256',p.sha256),'variant',CASE WHEN NEW.variant_version_id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',v.id::text,'revision',v.revision,'sha256',v.sha256) END,'policy',p.body||COALESCE(v.body,'{}'::jsonb));
 IF actual IS DISTINCT FROM NEW.body-'sha256' THEN RAISE EXCEPTION 'RECEIPT_POLICY_SNAPSHOT_CHANGED';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.records o JOIN public.market_journey_snapshots j ON j.workspace_id=o.workspace_id AND j.environment=o.environment AND j.journey_id::text=o.body->>'conversation_id'
 WHERE o.workspace_id=NEW.workspace_id AND o.environment=NEW.environment AND o.id=NEW.order_id AND o.kind='order' AND o.version=1 AND o.xmin=((pg_current_xact_id()::text::numeric % 4294967296)::text)::xid AND j.body->'release'->>'variant_id'=NEW.variant_id::text) THEN RAISE EXCEPTION 'RECEIPT_POLICY_ORDER_SCOPE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_receipt_policy_head BEFORE INSERT OR UPDATE ON receipt_policy_heads FOR EACH ROW EXECUTE FUNCTION guard_receipt_policy_head();
CREATE TRIGGER guard_receipt_policy_version BEFORE INSERT ON receipt_policy_versions FOR EACH ROW EXECUTE FUNCTION guard_receipt_policy_version();
CREATE TRIGGER guard_receipt_order_policy BEFORE INSERT ON receipt_order_policy_snapshots FOR EACH ROW EXECUTE FUNCTION guard_receipt_order_policy();
CREATE TRIGGER immutable_receipt_policy_versions BEFORE UPDATE OR DELETE ON receipt_policy_versions FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_receipt_policy_operations BEFORE UPDATE OR DELETE ON receipt_policy_operations FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_receipt_order_policy BEFORE UPDATE OR DELETE ON receipt_order_policy_snapshots FOR EACH ROW EXECUTE FUNCTION immutable_row();
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['receipt_policy_heads','receipt_policy_versions','receipt_policy_operations','receipt_order_policy_snapshots'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;ALTER TABLE %I FORCE ROW LEVEL SECURITY',t,t);
  EXECUTE format('CREATE POLICY receipt_policy_scope ON %I USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=NULLIF(current_setting(''app.environment'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=NULLIF(current_setting(''app.environment'',true),''''))',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,commerce_ingress,commerce_api,commerce_automation,commerce_channel;GRANT SELECT,INSERT ON %I TO commerce_api',t,t);
 END LOOP;
END $$;
GRANT UPDATE(revision,current_version_id,updated_at) ON receipt_policy_heads TO commerce_api;
GRANT SELECT ON receipt_policy_heads,receipt_policy_versions,receipt_order_policy_snapshots TO commerce_automation;
GRANT INSERT ON receipt_order_policy_snapshots TO commerce_automation;
-- The worker captures the already pinned journey; no catalog mutation is granted.
GRANT SELECT ON market_journey_snapshots TO commerce_automation;
GRANT SELECT(id,workspace_id,environment) ON market_variants TO commerce_automation;
REVOKE ALL ON FUNCTION receipt_policy_canonical(jsonb),valid_receipt_policy(jsonb,boolean),guard_receipt_policy_head(),guard_receipt_policy_version(),guard_receipt_order_policy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION receipt_policy_canonical(jsonb),valid_receipt_policy(jsonb,boolean) TO commerce_api,commerce_automation;
CREATE INDEX receipt_policy_snapshot_profile ON receipt_order_policy_snapshots(workspace_id,environment,profile_version_id);
CREATE INDEX receipt_policy_snapshot_override ON receipt_order_policy_snapshots(workspace_id,environment,variant_version_id);
CREATE INDEX receipt_policy_snapshot_variant ON receipt_order_policy_snapshots(workspace_id,environment,variant_id);
