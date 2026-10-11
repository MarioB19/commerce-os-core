-- Search projection of immutable health evidence. Parsing JSON timestamps on
-- every read forced a history sort; typed instants retain offset semantics and
-- permit a bounded index seek. The source records/versions remain unchanged.
CREATE TABLE health_observation_index (
 record_id uuid PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
 workspace_id text NOT NULL,
 environment text NOT NULL,
 account_id text,
 dimension text,
 scope text NOT NULL,
 status text,
 source text,
 observed_at timestamptz,
 expires_at timestamptz,
 created_at timestamptz NOT NULL
);

CREATE FUNCTION index_health_observation() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.kind='health_signal' THEN
  INSERT INTO public.health_observation_index(record_id,workspace_id,environment,account_id,dimension,scope,status,source,observed_at,expires_at,created_at)
  VALUES(NEW.id,NEW.workspace_id,NEW.environment,NEW.body->>'account_id',NEW.body->>'dimension',COALESCE(NEW.body->>'scope','account'),NEW.body->>'status',NEW.body->>'source',
   CASE WHEN pg_input_is_valid(NEW.body->>'observed_at','timestamp with time zone') THEN (NEW.body->>'observed_at')::timestamptz END,
   CASE WHEN pg_input_is_valid(NEW.body->>'expires_at','timestamp with time zone') THEN (NEW.body->>'expires_at')::timestamptz END,NEW.created_at)
  ON CONFLICT(record_id) DO UPDATE SET account_id=EXCLUDED.account_id,dimension=EXCLUDED.dimension,scope=EXCLUDED.scope,status=EXCLUDED.status,source=EXCLUDED.source,observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER index_health_observation AFTER INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION index_health_observation();

INSERT INTO health_observation_index(record_id,workspace_id,environment,account_id,dimension,scope,status,source,observed_at,expires_at,created_at)
SELECT id,workspace_id,environment,body->>'account_id',body->>'dimension',COALESCE(body->>'scope','account'),body->>'status',body->>'source',
 CASE WHEN pg_input_is_valid(body->>'observed_at','timestamp with time zone') THEN (body->>'observed_at')::timestamptz END,
 CASE WHEN pg_input_is_valid(body->>'expires_at','timestamp with time zone') THEN (body->>'expires_at')::timestamptz END,created_at
FROM records WHERE kind='health_signal';

CREATE INDEX health_observation_current_idx ON health_observation_index(
 workspace_id,environment,account_id,dimension,observed_at DESC,created_at DESC,record_id DESC
) WHERE scope='account' AND status IN('OK','BLOCKED','UNKNOWN','WARNING','PAUSED') AND expires_at>observed_at;
CREATE INDEX health_observation_history_idx ON health_observation_index(workspace_id,environment,account_id,dimension,observed_at);
-- Runtime can only derive this projection through writes to its owned records.
REVOKE ALL ON health_observation_index FROM PUBLIC;
GRANT SELECT ON health_observation_index TO commerce_api,commerce_automation,commerce_channel;
ANALYZE health_observation_index;
