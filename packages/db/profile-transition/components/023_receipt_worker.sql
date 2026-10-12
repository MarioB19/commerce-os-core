-- Depends on008/023. Read-only published version references, never catalog writes.
GRANT SELECT(id,workspace_id,environment,body,sha256) ON market_releases TO commerce_automation;
