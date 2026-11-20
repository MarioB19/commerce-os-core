CREATE OR REPLACE FUNCTION valid_receipt_policy(v jsonb,partial boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE keys text[]:=ARRAY['automaticApproval','failureDisposition','minimumConfidenceBps','amount','destination','beneficiary','date','reference','concept'];k text;x jsonb;n numeric;
BEGIN
 IF v IS NULL OR partial IS NULL OR jsonb_typeof(v)<>'object' OR (v-keys)<>'{}'::jsonb OR (NOT partial AND NOT v?&keys) THEN RETURN false; END IF;
 IF v?'automaticApproval' AND jsonb_typeof(v->'automaticApproval')<>'boolean' THEN RETURN false; END IF;
 IF v?'failureDisposition' AND (v->>'failureDisposition' IS NULL OR v->>'failureDisposition' NOT IN('REVIEW','REJECT')) THEN RETURN false; END IF;
 IF v?'minimumConfidenceBps' THEN x:=v->'minimumConfidenceBps';IF jsonb_typeof(x)<>'number' THEN RETURN false;END IF;n:=(x#>>'{}')::numeric;IF n<>trunc(n) OR n<0 OR n>10000 THEN RETURN false;END IF; END IF;
 IF v?'amount' THEN
  x:=v->'amount';IF jsonb_typeof(x)<>'object' OR x->>'mode' IS NULL THEN RETURN false;END IF;
  IF x->>'mode' IN('EXACT','MINIMUM','POSITIVE') THEN IF x-ARRAY['mode']<>'{}' THEN RETURN false;END IF;
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

CREATE TABLE profile_spin_collections (
 workspace_id text NOT NULL REFERENCES profiles(id),
 environment text NOT NULL CHECK (environment IN ('REAL','SIMULATION')),
 revision integer NOT NULL CHECK (revision > 0),
 ciphertext text,
 last4 text,
 PRIMARY KEY(workspace_id, environment),
 CHECK ((ciphertext IS NULL) = (last4 IS NULL)),
 CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$')
);
ALTER TABLE profile_spin_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_spin_collections FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_spin_scope ON profile_spin_collections
 USING(workspace_id = nullif(current_setting('app.workspace_id',true),'')
 AND environment = nullif(current_setting('app.environment',true),''));
REVOKE ALL ON profile_spin_collections FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON profile_spin_collections TO commerce_api;
