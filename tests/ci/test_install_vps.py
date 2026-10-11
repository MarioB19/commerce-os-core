from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
INSTALLER = (ROOT / "scripts" / "install-vps.sh").read_text()


class InstallVpsTests(unittest.TestCase):
    def test_candidate_maintenance_image_bootstraps_predeploy_backup(self):
        image_load = INSTALLER.index("docker load --input images.tar.gz")
        image_pin = INSTALLER.index("maintenance=$(docker image inspect commerce-os-maintenance:release")
        backup = INSTALLER.index('sh scripts/maintenance.sh backup "$backup_env"')
        release_update = INSTALLER.index('python3 - "$runtime" "$web" "$maintenance" "$owner_email"')

        self.assertLess(image_load, image_pin)
        self.assertLess(image_pin, backup)
        self.assertLess(backup, release_update)
        self.assertNotIn(
            "sh /opt/commerce-os/current/scripts/maintenance.sh backup",
            INSTALLER,
        )

    def test_candidate_override_is_temporary_and_cleaned_on_failure(self):
        self.assertIn("trap cleanup_backup_env EXIT", INSTALLER)
        self.assertIn("backup_env=$(mktemp /opt/commerce-os/private/predeploy-backup.", INSTALLER)
        self.assertIn("target.chmod(0o600)", INSTALLER)
        self.assertIn("lines[matches[0]] = 'COMMERCE_MAINTENANCE_IMAGE=' + image", INSTALLER)

    def test_exact_release_identity_is_written_to_api_environment(self):
        self.assertIn('RELEASE.json', INSTALLER)
        self.assertIn("re.fullmatch(r'[a-f0-9]{40}',source_sha)", INSTALLER)
        self.assertIn("release_changes.update({'COMMERCE_RELEASE_SHA':source_sha,'COMMERCE_RELEASE_ID':release_id})", INSTALLER)
        self.assertNotIn("update('api.env',{'COMMERCE_DEPLOYMENT_STATUS':'DEPLOYING','COMMERCE_RELEASE_SHA'", INSTALLER)


if __name__ == "__main__":
    unittest.main()
