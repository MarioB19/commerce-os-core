-- Runtime roles do not inherit privileges for tables created after migration 0002.
-- API owns user edits. Automation only advances searches, observations and analyses.
GRANT SELECT,INSERT,UPDATE ON intelligence_searches,intelligence_runs,intelligence_offers,
 intelligence_observations,intelligence_analyses,intelligence_opportunities TO commerce_api;
GRANT SELECT ON intelligence_searches,intelligence_runs,intelligence_offers,
 intelligence_observations,intelligence_analyses TO commerce_automation;
GRANT INSERT ON intelligence_runs,intelligence_offers,intelligence_observations TO commerce_automation;
GRANT UPDATE ON intelligence_searches,intelligence_runs,intelligence_offers,intelligence_analyses TO commerce_automation;
-- Provider settings/reservations/receipts already have bounded grants in 0029.
-- Voice runs in the API and already has SELECT/INSERT/UPDATE in 0031.
