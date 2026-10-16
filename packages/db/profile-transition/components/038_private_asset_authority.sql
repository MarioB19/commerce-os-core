-- Bind only after generated035 global guards/reference reader and037 row reader.
-- The owner is NOLOGIN/NOINHERIT. No runtime execution or admission is granted.
GRANT EXECUTE ON FUNCTION privacy_reference_fences_assert(),read_privacy_asset_references(uuid,uuid,uuid,uuid),assert_privacy_backup_rows(uuid,uuid,jsonb) TO commerce_privacy_file_owner;
