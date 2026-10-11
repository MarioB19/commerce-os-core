import json, unittest, importlib.util, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
spec=importlib.util.spec_from_file_location('v5_package',ROOT/'scripts/package-ci.py');package=importlib.util.module_from_spec(spec);spec.loader.exec_module(package)

class ProducerRetirementTests(unittest.TestCase):
 def test_native_producer_workflows_are_manual_tombstones(self):
  for name in ('creative-desktop.yml','creative-worker-operation.yml'):
   value=(ROOT/'.github/workflows'/name).read_text()
   self.assertIn('workflow_dispatch:',value)
   self.assertIn('PLATFORM_PRODUCTION_RETIRED',value)
   self.assertIn('exit 1',value)
   for forbidden in ('push:','pull_request:','schedule:','secrets.','uses:','download-artifact','upload-artifact','pnpm','run-pilot','checkout'):
    self.assertNotIn(forbidden,value)
 def test_exclusive_web_pages_removed_shared_local_factory_retained(self):
  for name in ('studio.tsx','studio-recipe.tsx','studio-voice.tsx','creative-settings.tsx'):
   self.assertFalse((ROOT/'apps/web/src/pages'/name).exists())
  for path in ('scripts/creative-engine-render.ts','packages/creative-engine/src/index.ts','apps/commerce-worker/src/api.ts','apps/web/src/pages/creative-shared.tsx'):
   self.assertTrue((ROOT/path).exists(),path)
  # The public contract proves removal/tombstones, not private backup history.
  policy=json.loads((ROOT/'tests/fixtures/public-retirement-policy.json').read_text())
  self.assertEqual(policy['content_profile'],'synthetic-public-v1')
  self.assertIs(policy['backup_observed'],False)
  self.assertEqual(set(policy['retired_pages']),{'studio.tsx','studio-recipe.tsx','studio-voice.tsx','creative-settings.tsx'})
  for name in policy['retired_pages']:
   self.assertFalse((ROOT/'apps/web/src/pages'/name).exists())
  self.assertEqual(set(policy['retired_workflows']),{'creative-desktop.yml','creative-worker-operation.yml'})
 def test_remote_release_excludes_only_explicit_factory_drivers(self):
  for name in package.LOCAL_FACTORY_SCRIPTS:
   self.assertFalse(package.release_source('scripts/'+name))
  for name in ('v5-token-remote.py','v5_token_transport_config.py','install-vps.sh','restore.mjs','creative-library-backup.mjs','creative-library-restore.mjs','creative-intelligence-pilot.mjs','package-creative-mcp.mjs'):
   self.assertTrue(package.release_source('scripts/'+name))
