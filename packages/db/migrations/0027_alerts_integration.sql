ALTER TABLE integration_settings DROP CONSTRAINT integration_settings_key_check;
ALTER TABLE integration_settings DROP CONSTRAINT integration_settings_type_check;
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_key_check CHECK(key ~ '^(meta|openai|waha|cloud|fulfillment|alerts):[A-Za-z][A-Za-z0-9_-]{0,63}$');
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_type_check CHECK(type IN('meta','openai','waha','cloud','fulfillment','alerts'));
