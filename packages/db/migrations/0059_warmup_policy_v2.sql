-- Additive evidence model for standard-15d/v2. Historical v1/legacy rows remain unchanged.
ALTER TABLE warmup_plans ADD COLUMN episode_id uuid REFERENCES warmup_episodes(id);
CREATE INDEX warmup_plans_episode_date ON warmup_plans(episode_id,local_date) WHERE episode_id IS NOT NULL;

-- A credited day is an immutable fact produced by one completed automatic plan.
-- source_plan_id is globally unique here so a day cannot be reused by later migrations.
CREATE TABLE warmup_day_credits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id text NOT NULL,
 environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 episode_id uuid NOT NULL,
 account_id uuid NOT NULL,
 source_plan_id uuid NOT NULL UNIQUE,
 local_date date NOT NULL,
 policy_version text NOT NULL,
 source text NOT NULL CHECK(source='automatic_pipeline'),
 evidence jsonb NOT NULL DEFAULT '{}',
 credited_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(episode_id,local_date),
 FOREIGN KEY(episode_id,workspace_id,environment) REFERENCES warmup_episodes(id,workspace_id,environment),
 FOREIGN KEY(source_plan_id,workspace_id,environment) REFERENCES warmup_plans(id,workspace_id,environment),
 FOREIGN KEY(account_id,workspace_id,environment) REFERENCES warmup_states(account_id,workspace_id,environment)
);
CREATE INDEX warmup_day_credits_account_episode ON warmup_day_credits(account_id,episode_id,local_date);
CREATE TRIGGER immutable_warmup_day_credits BEFORE UPDATE OR DELETE ON warmup_day_credits FOR EACH ROW EXECUTE FUNCTION immutable_row();

GRANT SELECT ON warmup_day_credits TO commerce_api,commerce_automation,commerce_channel,commerce_maintenance;
GRANT INSERT ON warmup_day_credits TO commerce_automation;
