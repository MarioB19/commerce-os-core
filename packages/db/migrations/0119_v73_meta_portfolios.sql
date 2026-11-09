-- V7.3: profile-owned multiple Meta connections, selected portfolios and durable
-- per-account read tasks. Additive; existing credentials and insights are retained.
DO $$ BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
END $$;
CREATE TABLE meta_connections(
 workspace_id text NOT NULL REFERENCES profiles(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 alias text NOT NULL CHECK(length(alias) BETWEEN 1 AND 80),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 enabled boolean NOT NULL DEFAULT true,state text NOT NULL DEFAULT 'UNVERIFIED' CHECK(state IN('UNVERIFIED','VERIFIED','INVALID')),
 reason text,checked_at timestamptz,granted_scopes text[] NOT NULL DEFAULT '{}',
 legacy_revision integer,auto_select_pending boolean NOT NULL DEFAULT false,cooldown_until timestamptz,updated_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,legacy_revision) REFERENCES meta_profile_credential_versions(workspace_id,revision)
);
CREATE UNIQUE INDEX meta_one_legacy_connection ON meta_connections(workspace_id) WHERE legacy_revision IS NOT NULL;
CREATE TABLE meta_connection_versions(
 workspace_id text NOT NULL,connection_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 ciphertext text NOT NULL CHECK(ciphertext ~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$'),
 key_hint text NOT NULL CHECK(length(key_hint)=4),created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,connection_id,revision),FOREIGN KEY(workspace_id,connection_id) REFERENCES meta_connections(workspace_id,id)
);
CREATE TRIGGER meta_connection_version_immutable BEFORE UPDATE OR DELETE ON meta_connection_versions FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE meta_portfolios(
 workspace_id text NOT NULL REFERENCES profiles(id),business_id text NOT NULL CHECK(business_id ~ '^[0-9]+$'),name text NOT NULL,
 selected boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,business_id)
);
CREATE FUNCTION guard_meta_portfolio_selection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.business_id) IS DISTINCT FROM (OLD.workspace_id,OLD.business_id) THEN RAISE EXCEPTION 'META_PORTFOLIO_IDENTITY_IMMUTABLE'; END IF;
 IF NEW.selected AND (TG_OP='INSERT' OR NOT OLD.selected) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('meta-portfolios:'||NEW.workspace_id,0));
  IF (SELECT count(*) FROM public.meta_portfolios WHERE workspace_id=NEW.workspace_id AND selected AND business_id<>NEW.business_id)>=5 THEN RAISE EXCEPTION 'META_PORTFOLIO_LIMIT'; END IF;
 END IF;
 NEW.updated_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER meta_portfolio_selection_guard BEFORE INSERT OR UPDATE ON meta_portfolios FOR EACH ROW EXECUTE FUNCTION guard_meta_portfolio_selection();
CREATE TABLE meta_account_access(
 workspace_id text NOT NULL,connection_id uuid NOT NULL,meta_ad_account_id text NOT NULL CHECK(meta_ad_account_id ~ '^act_[0-9]+$'),
 business_id text,name text NOT NULL,currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),timezone text NOT NULL,
 accessible boolean NOT NULL DEFAULT true,credential_revision integer NOT NULL,discovery_id uuid NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,connection_id,meta_ad_account_id),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES meta_connections(workspace_id,id),
 FOREIGN KEY(workspace_id,business_id) REFERENCES meta_portfolios(workspace_id,business_id)
);
CREATE TABLE meta_account_portfolio_history(
 workspace_id text NOT NULL,meta_ad_account_id text NOT NULL,business_id text NOT NULL,
 valid_from date NOT NULL,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 basis text NOT NULL CHECK(basis IN('CURRENT_OWNER_BASELINE','OBSERVED_CHANGE')),
 PRIMARY KEY(workspace_id,meta_ad_account_id,valid_from),
 FOREIGN KEY(workspace_id,business_id) REFERENCES meta_portfolios(workspace_id,business_id)
);
CREATE TRIGGER meta_owner_history_immutable BEFORE UPDATE OR DELETE ON meta_account_portfolio_history FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE meta_read_operations(
 workspace_id text NOT NULL REFERENCES profiles(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 request_key text NOT NULL,request jsonb NOT NULL,actor_id text NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','RUNNING','SYNCED','PARTIAL','UNAVAILABLE','CANCELLED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,request_key)
);
CREATE TABLE meta_read_tasks(
 workspace_id text NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),operation_id uuid NOT NULL,
 connection_id uuid NOT NULL,credential_revision integer NOT NULL,meta_ad_account_id text,business_id text,
 kind text NOT NULL CHECK(kind IN('DISCOVERY','INSIGHTS')),range_from date,range_to date,
 phase text NOT NULL DEFAULT 'ad' CHECK(phase IN('ad','campaign','ads','businesses')),cursor text,seen_cursors text[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','RUNNING','SYNCED','PARTIAL','UNAVAILABLE','CANCELLED')),
 attempts integer NOT NULL DEFAULT 0,priority integer NOT NULL DEFAULT 10,
 lease_token uuid,lease_until timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),issue jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,operation_id) REFERENCES meta_read_operations(workspace_id,id),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES meta_connections(workspace_id,id),
 FOREIGN KEY(workspace_id,business_id) REFERENCES meta_portfolios(workspace_id,business_id),
 CHECK((kind='DISCOVERY' AND meta_ad_account_id IS NULL AND range_from IS NULL AND range_to IS NULL) OR
       (kind='INSIGHTS' AND meta_ad_account_id IS NOT NULL AND business_id IS NOT NULL AND range_from IS NOT NULL AND range_to IS NOT NULL AND meta_ad_account_id ~ '^act_[0-9]+$' AND range_from<=range_to AND range_to-range_from<7))
);
CREATE INDEX meta_read_due ON meta_read_tasks(workspace_id,next_attempt_at,priority,created_at) WHERE status IN('PENDING','RUNNING');
CREATE UNIQUE INDEX meta_read_operation_window ON meta_read_tasks(workspace_id,operation_id,meta_ad_account_id,range_from,range_to) WHERE kind='INSIGHTS';
CREATE UNIQUE INDEX meta_read_operation_discovery ON meta_read_tasks(workspace_id,operation_id,connection_id) WHERE kind='DISCOVERY';
CREATE TABLE meta_read_pages(
 workspace_id text NOT NULL,task_id uuid NOT NULL,phase text NOT NULL,page_number integer NOT NULL,data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,task_id,phase,page_number),FOREIGN KEY(workspace_id,task_id) REFERENCES meta_read_tasks(workspace_id,id)
);
-- Preserve existing configured identities; envelope re-encoding happens inside
-- the owning worker scope before the first request. No plaintext SQL migration.
INSERT INTO meta_connections(workspace_id,alias,enabled,state,reason,checked_at,granted_scopes,legacy_revision,auto_select_pending,updated_by)
 SELECT workspace_id,'Conexión existente',enabled,state,reason,checked_at,granted_scopes,revision,true,updated_by FROM meta_profile_credentials;
DO $isolation$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['meta_connections','meta_connection_versions','meta_portfolios','meta_account_access','meta_account_portfolio_history','meta_read_operations','meta_read_tasks','meta_read_pages'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  EXECUTE format('CREATE POLICY v73_meta_profile ON public.%I USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),''''))',t);
  EXECUTE format('CREATE POLICY v7_api_profile_guard ON public.%I AS RESTRICTIVE TO commerce_api USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),''''))',t);
  EXECUTE format('CREATE POLICY v73_meta_real ON public.%I AS RESTRICTIVE TO commerce_api,commerce_automation USING(current_setting(''app.environment'',true)=''REAL'') WITH CHECK(current_setting(''app.environment'',true)=''REAL'')',t);
 END LOOP;
END $isolation$;
GRANT SELECT,INSERT,UPDATE ON meta_connections,meta_portfolios,meta_read_operations,meta_read_tasks TO commerce_api,commerce_automation;
GRANT SELECT ON meta_account_access,meta_account_portfolio_history TO commerce_api;
GRANT SELECT,INSERT,UPDATE ON meta_account_access TO commerce_automation;
GRANT SELECT,INSERT ON meta_account_portfolio_history TO commerce_automation;
GRANT INSERT,SELECT(workspace_id,connection_id,revision,key_hint,created_by,created_at) ON meta_connection_versions TO commerce_api;
GRANT SELECT,INSERT ON meta_connection_versions TO commerce_automation;
GRANT SELECT,INSERT,DELETE ON meta_read_pages TO commerce_automation;
REVOKE ALL ON FUNCTION guard_meta_portfolio_selection() FROM PUBLIC;

-- Coverage is tied to the currency and local calendar observed at read time.
ALTER TABLE meta_insight_coverage ADD COLUMN currency text, ADD COLUMN timezone text;
UPDATE meta_insight_coverage cv SET currency=a.currency,timezone=a.timezone
 FROM meta_insight_accounts a WHERE (a.workspace_id,a.environment,a.meta_ad_account_id)=(cv.workspace_id,cv.environment,cv.meta_ad_account_id);

CREATE FUNCTION guard_meta_connection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF (NEW.workspace_id,NEW.id,NEW.legacy_revision,NEW.created_at) IS DISTINCT FROM (OLD.workspace_id,OLD.id,OLD.legacy_revision,OLD.created_at) THEN RAISE EXCEPTION 'META_CONNECTION_IDENTITY_IMMUTABLE'; END IF;
 IF NEW.revision<>OLD.revision AND (NEW.revision<>OLD.revision+1 OR NEW.state<>'UNVERIFIED') THEN RAISE EXCEPTION 'META_TOKEN_VERSION_CONFLICT'; END IF;
 NEW.updated_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER meta_connection_guard BEFORE UPDATE ON meta_connections FOR EACH ROW EXECUTE FUNCTION guard_meta_connection();
CREATE TRIGGER meta_connection_no_delete BEFORE DELETE ON meta_connections FOR EACH ROW EXECUTE FUNCTION immutable_row();
REVOKE ALL ON FUNCTION guard_meta_connection() FROM PUBLIC;

-- Platform health sees aggregate validity only, as in 0101/0102.
GRANT SELECT(workspace_id,enabled,state) ON meta_connections TO commerce_platform_owner;
CREATE POLICY platform_meta_connections_state ON meta_connections FOR SELECT TO commerce_platform_owner USING(true);
CREATE OR REPLACE FUNCTION platform_profile_summaries(native_session text,native_user text)
RETURNS TABLE(id text,business_name text,state text,timezone text,number_limit integer,product_limit integer,daily_conversation_limit integer,version integer,
 owners bigint,numbers_registered bigint,numbers_connected bigint,products bigint,variants bigint,offers bigint,ai_unverified bigint,meta_invalid boolean,last_activity_at timestamptz,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM public.platform_admin_actor(native_session,native_user);
 RETURN QUERY SELECT p.id,p.business_name,p.state,p.timezone,p.number_limit,p.product_limit,p.daily_conversation_limit,p.version,
  (SELECT count(*) FROM public.memberships m WHERE m.workspace_id=p.id AND m.role='owner' AND m.active),
  (SELECT count(*) FROM public.records r WHERE r.workspace_id=p.id AND r.environment='REAL' AND r.kind='channel_account' AND NOT(r.body?'deleted_at')),
  (SELECT count(*) FROM public.records r WHERE r.workspace_id=p.id AND r.environment='REAL' AND r.kind='channel_account' AND NOT(r.body?'deleted_at') AND r.body->>'status'='WORKING'),
  (SELECT count(*) FROM public.records r WHERE r.workspace_id=p.id AND r.environment='REAL' AND r.kind='product' AND NOT(r.body?'deleted_at')),
  (SELECT count(*) FROM public.market_variants v WHERE v.workspace_id=p.id AND v.environment='REAL'),
  (SELECT count(*) FROM public.records r WHERE r.workspace_id=p.id AND r.environment='REAL' AND r.kind='offer' AND NOT(r.body?'deleted_at')),
  (SELECT count(*) FROM public.ai_credentials c WHERE c.workspace_id=p.id AND c.environment='REAL' AND c.enabled AND c.state<>'VERIFIED'),
  (EXISTS(SELECT 1 FROM public.meta_connections c WHERE c.workspace_id=p.id AND c.enabled AND c.state='INVALID') OR (NOT EXISTS(SELECT 1 FROM public.meta_connections c WHERE c.workspace_id=p.id) AND COALESCE((SELECT c.enabled AND c.state='INVALID' FROM public.meta_profile_credentials c WHERE c.workspace_id=p.id),false))),
  (SELECT max(e.recorded_at) FROM public.domain_events e WHERE e.workspace_id=p.id AND e.environment='REAL'),
  p.created_at
 FROM public.profiles p ORDER BY p.business_name,p.id;
END $$;
