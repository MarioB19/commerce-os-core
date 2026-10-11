-- Physical gateway isolation is global across workspaces. The workspace-leading
-- records indexes otherwise scan all historical evidence to find a few accounts.
-- Keep every environment/provider/deleted state eligible for the existing callers.
CREATE INDEX records_channel_account_scan ON records(environment,workspace_id,id)
 WHERE kind='channel_account';

-- Reception needs the last webhook observation, including an expired one. This
-- exact partial predicate also makes a missing webhook an empty index seek.
CREATE INDEX records_health_webhook_lookup ON records(
 workspace_id,environment,(body->>'account_id'),created_at DESC,id DESC
) WHERE kind='health_signal' AND body->'value'->>'kind'='webhook';
