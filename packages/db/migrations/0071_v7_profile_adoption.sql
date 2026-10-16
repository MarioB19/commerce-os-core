-- V7 F2 cutover: one profile per existing workspace with data (D-08, D-14, D-23).
-- profiles.id keeps the historical workspace_id byte for byte. The principal
-- workspace (the only one with active owners) becomes «Operación Brandon»; any
-- other workspace is kept in an explicit SUSPENDED quarantine profile and is
-- never merged into the principal. Counts are verified before COMMIT.
CREATE TABLE profile_role_adoptions(
 workspace_id text NOT NULL REFERENCES profiles(id),
 user_id text NOT NULL,
 historical_role text NOT NULL CHECK(historical_role IN('owner','operator','seller','reconciler','analyst','viewer')),
 adopted_role text NOT NULL CHECK(adopted_role IN('owner','operator','viewer')),
 historical_active boolean NOT NULL,
 rule text NOT NULL CHECK(rule IN('D23_OWNER','D23_OPERATOR','D23_READ_ONLY','D23_ACTIVE_SELLER_OR_RECONCILER','D23_NO_ACTIVE_SELLER_OR_RECONCILER')),
 adopted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,user_id),
 FOREIGN KEY(user_id,workspace_id) REFERENCES memberships(user_id,workspace_id)
);
CREATE TRIGGER immutable_profile_role_adoptions BEFORE UPDATE OR DELETE ON profile_role_adoptions FOR EACH ROW EXECUTE FUNCTION immutable_row();
REVOKE ALL ON profile_role_adoptions FROM PUBLIC,commerce_api,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance;
GRANT SELECT ON profile_role_adoptions TO commerce_api;

CREATE TABLE profile_adoption_receipts(
 workspace_id text PRIMARY KEY REFERENCES profiles(id),
 disposition text NOT NULL CHECK(disposition IN('PRINCIPAL','QUARANTINE')),
 memberships bigint NOT NULL CHECK(memberships>=0),
 real_numbers bigint NOT NULL CHECK(real_numbers>=0),
 real_products bigint NOT NULL CHECK(real_products>=0),
 records bigint NOT NULL CHECK(records>=0),
 adopted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_profile_adoption_receipts BEFORE UPDATE OR DELETE ON profile_adoption_receipts FOR EACH ROW EXECUTE FUNCTION immutable_row();
REVOKE ALL ON profile_adoption_receipts FROM PUBLIC,commerce_api,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance;

DO $adoption$
DECLARE relation record; found text[]; workspaces text[]:=ARRAY[]::text[]; owners text[]; principal text; w text;
 quarantine integer:=0; secondary_numbers bigint; own_numbers bigint; own_products bigint; own_records bigint;
 seller_active boolean; reconciler_active boolean; before_memberships jsonb; after_memberships jsonb; mapped bigint;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED';
 END IF;
 LOCK TABLE public.memberships,public.records,public.profiles,public.service_tokens,public.personal_access_tokens IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM public.profiles) THEN RAISE EXCEPTION 'V7_PROFILE_ADOPTION_ALREADY_APPLIED'; END IF;
 FOR relation IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped AND a.attnum>0
  WHERE n.nspname='public' AND c.relkind IN('r','p') AND c.relname NOT IN('profile_role_adoptions','profile_adoption_receipts','profile_session_context')
  ORDER BY c.relname LOOP
  EXECUTE format('SELECT array_agg(DISTINCT workspace_id::text) FROM public.%I',relation.relname) INTO found;
  workspaces:=ARRAY(SELECT DISTINCT x FROM unnest(workspaces||COALESCE(found,ARRAY[]::text[])) x ORDER BY x);
 END LOOP;
 IF cardinality(workspaces)>3 THEN RAISE EXCEPTION 'V7_PROFILE_LIMIT_EXCEEDED'; END IF;
 owners:=ARRAY(SELECT DISTINCT workspace_id FROM public.memberships WHERE role='owner' AND active ORDER BY workspace_id);
 IF cardinality(owners)>1 THEN RAISE EXCEPTION 'V7_PRINCIPAL_PROFILE_AMBIGUOUS'; END IF;
 principal:=CASE WHEN cardinality(owners)=1 THEN owners[1] WHEN cardinality(workspaces)=1 THEN workspaces[1] END;
 SELECT count(*) INTO secondary_numbers FROM public.records WHERE kind='channel_account' AND environment='REAL'
  AND NOT(body ? 'deleted_at') AND workspace_id IS DISTINCT FROM principal;
 FOREACH w IN ARRAY workspaces LOOP
  SELECT count(*) FILTER(WHERE kind='channel_account' AND environment='REAL' AND NOT(body ? 'deleted_at')),
         count(*) FILTER(WHERE kind='product' AND environment='REAL'),count(*)
   INTO own_numbers,own_products,own_records FROM public.records WHERE workspace_id=w;
  IF w=principal THEN
   IF own_numbers>20-secondary_numbers THEN RAISE EXCEPTION 'V7_PLATFORM_NUMBER_LIMIT_EXCEEDED'; END IF;
   INSERT INTO public.profiles(id,business_name,state,timezone,number_limit,product_limit,daily_conversation_limit)
   VALUES(w,'Operación Brandon','ACTIVE','America/Mexico_City',20-secondary_numbers,greatest(own_products,200),300);
  ELSE
   quarantine:=quarantine+1;
   INSERT INTO public.profiles(id,business_name,state,timezone,number_limit,product_limit,daily_conversation_limit)
   VALUES(w,'Datos en cuarentena '||quarantine,'SUSPENDED','America/Mexico_City',own_numbers,own_products,0);
  END IF;
  INSERT INTO public.profile_adoption_receipts(workspace_id,disposition,memberships,real_numbers,real_products,records)
  VALUES(w,CASE WHEN w=principal THEN 'PRINCIPAL' ELSE 'QUARANTINE' END,
   (SELECT count(*) FROM public.memberships WHERE workspace_id=w),own_numbers,own_products,own_records);
 END LOOP;
 IF (SELECT COALESCE(sum(number_limit),0) FROM public.profiles)>20 OR (SELECT count(*) FROM public.profiles)<>cardinality(workspaces) THEN
  RAISE EXCEPTION 'V7_PROFILE_ADOPTION_COUNT_MISMATCH';
 END IF;

 -- D-23 with the live inventory read under the exclusive lock above.
 seller_active:=EXISTS(SELECT 1 FROM public.memberships WHERE role='seller' AND active);
 reconciler_active:=EXISTS(SELECT 1 FROM public.memberships WHERE role='reconciler' AND active);
 SELECT jsonb_agg(jsonb_build_array(user_id,workspace_id,active) ORDER BY user_id,workspace_id) INTO before_memberships FROM public.memberships;
 INSERT INTO public.profile_role_adoptions(workspace_id,user_id,historical_role,adopted_role,historical_active,rule)
 SELECT m.workspace_id,m.user_id,m.role,
  CASE WHEN m.role='owner' THEN 'owner' WHEN m.role='operator' THEN 'operator' WHEN m.role IN('analyst','viewer') THEN 'viewer'
   WHEN m.role='seller' THEN CASE WHEN seller_active THEN 'operator' ELSE 'viewer' END
   WHEN m.role='reconciler' THEN CASE WHEN reconciler_active THEN 'operator' ELSE 'viewer' END END,
  m.active,
  CASE WHEN m.role='owner' THEN 'D23_OWNER' WHEN m.role='operator' THEN 'D23_OPERATOR' WHEN m.role IN('analyst','viewer') THEN 'D23_READ_ONLY'
   WHEN (m.role='seller' AND seller_active) OR (m.role='reconciler' AND reconciler_active) THEN 'D23_ACTIVE_SELLER_OR_RECONCILER'
   ELSE 'D23_NO_ACTIVE_SELLER_OR_RECONCILER' END
 FROM public.memberships m;
 UPDATE public.memberships m SET role=a.adopted_role FROM public.profile_role_adoptions a
  WHERE a.workspace_id=m.workspace_id AND a.user_id=m.user_id AND m.role<>a.adopted_role;
 SELECT jsonb_agg(jsonb_build_array(user_id,workspace_id,active) ORDER BY user_id,workspace_id) INTO after_memberships FROM public.memberships;
 SELECT count(*) INTO mapped FROM public.profile_role_adoptions a JOIN public.memberships m USING(workspace_id,user_id) WHERE m.role=a.adopted_role;
 IF before_memberships IS DISTINCT FROM after_memberships OR mapped<>(SELECT count(*) FROM public.memberships)
  OR EXISTS(SELECT 1 FROM public.memberships WHERE role NOT IN('owner','operator','viewer')) THEN
  RAISE EXCEPTION 'V7_ROLE_ADOPTION_COUNT_MISMATCH';
 END IF;
 IF principal IS NOT NULL AND EXISTS(SELECT 1 FROM public.memberships WHERE workspace_id=principal AND role='owner' AND active)
  IS DISTINCT FROM (cardinality(owners)=1) THEN RAISE EXCEPTION 'V7_PRINCIPAL_OWNER_LOST'; END IF;
END $adoption$;

-- From now on every membership and credential belongs to an existing profile
-- and only V7 roles exist. Historical roles remain in profile_role_adoptions.
ALTER TABLE memberships ADD CONSTRAINT memberships_v7_role CHECK(role IN('owner','operator','viewer'));
ALTER TABLE memberships ADD CONSTRAINT memberships_profile FOREIGN KEY(workspace_id) REFERENCES profiles(id);
ALTER TABLE service_tokens ADD CONSTRAINT service_tokens_profile FOREIGN KEY(workspace_id) REFERENCES profiles(id);
ALTER TABLE personal_access_tokens ADD CONSTRAINT personal_access_tokens_profile FOREIGN KEY(workspace_id) REFERENCES profiles(id);
