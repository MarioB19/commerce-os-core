-- Identity is owned exclusively by API. Never grant these facts to commercial workers.
REVOKE ALL ON identity_audit,identity_rate_limits,identity_mail_settings,identity_reset_links,identity_mail_jobs FROM PUBLIC,commerce_ingress,commerce_automation,commerce_channel;
GRANT SELECT,INSERT ON identity_audit TO commerce_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON identity_rate_limits,identity_reset_links TO commerce_api;
GRANT SELECT,INSERT,UPDATE ON identity_mail_settings,identity_mail_jobs TO commerce_api;
