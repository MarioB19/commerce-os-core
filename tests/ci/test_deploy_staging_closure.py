"""Import the real fixed staging closure in a checkout-free child process."""
import ast
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CODE = '''import sys, importlib.util, socket, ssl
from pathlib import Path
def no_network(*args, **kwargs):
    raise AssertionError("staging import attempted a network effect")
socket.socket = no_network
stage = Path(sys.argv[1]).resolve(); sys.path.insert(0, str(stage))
for name in ("deploy-ci-vps.py", "runtime-boot.py", "cloudbuild-publish-status.py"):
    spec = importlib.util.spec_from_file_location("closure_"+name.replace("-","_").replace(".","_"), stage/name)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
import runtime_boot_install, runtime_boot_install_host, runtime_boot_install_gate
import runtime_boot_install_runner, runtime_boot_restore_gate
import runtime_boot_admission, runtime_boot_admission_host
import cloudbuild_full_evidence, cloudbuild_release_evidence
cloudbuild_release_evidence.bootstrap()
for module in (runtime_boot_install, runtime_boot_install_host, runtime_boot_install_gate,
               runtime_boot_install_runner, runtime_boot_restore_gate,
               runtime_boot_admission, runtime_boot_admission_host,
               cloudbuild_full_evidence, cloudbuild_release_evidence):
    assert Path(module.__file__).resolve().parent == stage
'''


class StagingClosureTests(unittest.TestCase):
    def test_real_staging_closure_and_missing_boot_dependency(self):
        tree = ast.parse((ROOT/'scripts/deploy-ci-client.py').read_text())
        names = next(ast.literal_eval(node.value) for node in tree.body
            if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name)
                and target.id == 'STAGING_SCRIPTS' for target in node.targets))
        self.assertEqual(len(names), len(set(names)))
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)/'stage'; stage.mkdir()
            for name in names: (stage/name).write_bytes((ROOT/'scripts'/name).read_bytes())
            def child():
                return subprocess.run([sys.executable, '-I', '-B', '-c', CODE, str(stage)],
                    cwd=directory, env={}, capture_output=True, timeout=10)
            complete = child()
            self.assertEqual(complete.returncode, 0, complete.stderr.decode())
            self.assertEqual({path.name for path in stage.iterdir()}, set(names))
            (stage/'runtime_boot_restore_gate.py').unlink()
            missing = child()
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn(b'runtime_boot_restore_gate', missing.stderr)


if __name__ == '__main__': unittest.main()
