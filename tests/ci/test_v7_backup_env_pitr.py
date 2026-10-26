"""V7.1: backup.env follows the PITR PostgreSQL container (26-oct-2026).

`v7_pitr.py enable` (21-oct) replaced PostgreSQL but left backup.env's
PG_CONTAINER on the previous container. The V7.1 rehearsal's installer then
failed its pre-deploy backup with POSTGRES_NETWORK_INSPECTION_FAILED, and the
re-adoption refused any change to backup.env. These tests fix the one change it
now accepts and the Root command that makes it.
"""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / 'tests/ci')]
from ci_release import ReleaseError  # noqa: E402
import api_web_deployment as native  # noqa: E402
import copy_runtime_deployment as runtime  # noqa: E402
import v7_infra_adoption as m  # noqa: E402
spec = importlib.util.spec_from_file_location('v7_infra_adoption_tests', ROOT / 'tests/ci/test_v7_infra_adoption.py')
t = importlib.util.module_from_spec(spec); spec.loader.exec_module(t)


def with_backup_env(b, container):
    """Baseline whose recorded backup.env pins PG_CONTAINER to `container`."""
    b = copy.deepcopy(b)
    b['files']['backup.env'] = b'BACKUP_DIR=/opt/commerce-os/private/backups\nPG_CONTAINER=' + container.encode() + b'\nPG_NETWORK=commerce-os_core\n'
    b['state']['canonical_files']['backup.env'] = native.reference(m.PRIVATE / 'backup.env', b['files']['backup.env'])
    b['state_raw'] = m.encode(b['state']); b['capture']['state_sha256'] = m.digest(b['state_raw'])
    return b


def pitr_case():
    b = t.baseline(); pg = b['by']['postgres']
    b = with_backup_env(b, pg['Id'])
    new_pg, receipt = t.pitr(pg, 401)
    rows = t.replace(b['rows'], pg, new_pg)
    networks = dict(b['networks'], **{native.PITR_NETWORK: {'Name': native.PITR_NETWORK, 'Id': t.fx.checksum(4343), 'Driver': 'bridge',
                                                             'Internal': False, 'EnableIPv6': False, 'IPAM': {}, 'Options': {}, 'Labels': {}}})
    return b, pg, new_pg, receipt, rows, networks


class BackupEnvAdoptionTests(unittest.TestCase):
    def propose(self, b, rows, networks, files, receipt):
        return t.run(b, rows=rows, networks=networks, files=files, receipt=receipt, policy=None)

    def test_pg_container_moved_to_the_pitr_container_is_adopted(self):
        b, pg, new_pg, receipt, rows, networks = pitr_case()
        files = dict(b['files'], **{'backup.env': b['files']['backup.env'].replace(pg['Id'].encode(), new_pg['Id'].encode())})
        proposal, docs = self.propose(b, rows, networks, files, receipt)
        self.assertEqual(proposal['summary']['backup_env'], 'PG_CONTAINER_REBOUND')
        state = json.loads(docs['state'])
        self.assertEqual(state['canonical_files']['backup.env'], native.reference(m.PRIVATE / 'backup.env', files['backup.env']))

    def test_unchanged_backup_env_is_not_a_transition(self):
        b, pg, new_pg, receipt, rows, networks = pitr_case()
        proposal, _ = self.propose(b, rows, networks, b['files'], receipt)
        self.assertIsNone(proposal['summary']['backup_env'])

    def test_any_other_change_to_backup_env_is_refused(self):
        b, pg, new_pg, receipt, rows, networks = pitr_case()
        moved = b['files']['backup.env'].replace(pg['Id'].encode(), new_pg['Id'].encode())
        for name, raw in (('other line', moved + b'EXTRA=1\n'),
                          ('network', moved.replace(b'PG_NETWORK=commerce-os_core', b'PG_NETWORK=other')),
                          ('other container', b['files']['backup.env'].replace(pg['Id'].encode(), b'f' * 64))):
            with self.subTest(name), self.assertRaises(ReleaseError):
                self.propose(b, rows, networks, dict(b['files'], **{'backup.env': raw}), receipt)

    def test_rebound_needs_the_pitr_receipt_of_this_container(self):
        b, pg, new_pg, receipt, rows, networks = pitr_case()
        old = b['state']['canonical_files']['backup.env']
        moved = b['files']['backup.env'].replace(pg['Id'].encode(), new_pg['Id'].encode())
        self.assertTrue(m.backup_env_rebound(old, moved, receipt, new_pg['Id'], m.PRIVATE / 'backup.env'))
        self.assertFalse(m.backup_env_rebound(old, moved, None, new_pg['Id'], m.PRIVATE / 'backup.env'))
        self.assertFalse(m.backup_env_rebound(old, moved, dict(receipt, state='PITR_PREPARED'), new_pg['Id'], m.PRIVATE / 'backup.env'))
        self.assertFalse(m.backup_env_rebound(old, moved, receipt, 'e' * 64, m.PRIVATE / 'backup.env'))
        twice = moved + b'PG_CONTAINER=' + new_pg['Id'].encode() + b'\n'
        self.assertFalse(m.backup_env_rebound(old, twice, receipt, new_pg['Id'], m.PRIVATE / 'backup.env'))


class RebindCommandTests(unittest.TestCase):
    def run_rebind(self, current, running=True):
        old, new = 'a' * 64, 'b' * 64
        receipt = {'schema_version': 1, 'state': 'PITR_ENABLED', 'before': {'container': old}, 'after': {'container': new}}
        with tempfile.TemporaryDirectory() as tmp:
            private = Path(tmp)
            (private / 'backup.env').write_bytes(b'BACKUP_DIR=/x\nPG_CONTAINER=' + current.encode() + b'\nPG_NETWORK=commerce-os_core\n')
            host = mock.Mock()
            host.private = lambda path, optional=False: (json.dumps(receipt).encode() if Path(path) == m.PITR_RECEIPT
                                                         else Path(path).read_bytes())
            host.rows.return_value = [{'Id': new, 'State': {'Running': running}}]

            def write(path, raw):
                Path(path).write_bytes(raw)
            with mock.patch.object(m, 'PRIVATE', private), mock.patch.object(m, 'write_private', side_effect=write):
                result = m.rebind_backup_env(host)
            return result, (private / 'backup.env').read_bytes(), sorted(p.name for p in private.iterdir())

    def test_rebinds_once_and_keeps_a_copy(self):
        result, raw, names = self.run_rebind('a' * 64)
        self.assertEqual(result['state'], 'BACKUP_ENV_REBOUND')
        self.assertIn(b'PG_CONTAINER=' + b'b' * 64 + b'\n', raw)
        self.assertEqual(len([n for n in names if n.startswith('backup.env.before-v7-pitr-')]), 1)
        self.assertEqual(self.run_rebind('b' * 64)[0]['state'], 'BACKUP_ENV_KEPT')

    def test_refuses_an_unexpected_container_or_absent_pitr_container(self):
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_BACKUP_ENV_UNEXPECTED_CONTAINER'):
            self.run_rebind('c' * 64)
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_PITR_CONTAINER_ABSENT'):
            self.run_rebind('a' * 64, running=False)


class PredeployBoundTests(unittest.TestCase):
    def test_predeploy_backup_bound_is_two_gib(self):
        self.assertEqual(native.PREDEPLOY_BACKUP_MAX_BYTES, 2 * 1024 ** 3)
        source = (ROOT / 'scripts/api_web_deployment.py').read_text()
        self.assertNotIn("36 < info.st_size <= 1024 ** 3", source)


if __name__ == '__main__':
    unittest.main()
