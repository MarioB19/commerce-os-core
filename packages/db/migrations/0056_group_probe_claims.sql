ALTER TABLE warmup_groups ADD COLUMN probe_until timestamptz;
ALTER TABLE warmup_groups ADD COLUMN probe_owner text;
ALTER TABLE warmup_groups ADD COLUMN last_probe_at timestamptz;
CREATE INDEX warmup_group_probe_queue ON warmup_groups(last_probe_at NULLS FIRST);
