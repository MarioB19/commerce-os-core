"""V7.1.1 (27-oct-2026): Docker Compose emits a service's binds in no fixed order.

In production the V7.1 installer created automation-worker with
[/data/private:ro, /data/laboratory:rw]; a plain `up --force-recreate` of the same
release produced [/data/laboratory:rw, /data/private:ro]. The re-adoption refused it
(V7_ADOPTION_HOST_CONFIG_CHANGED) and the installer's boundary comparison would have
refused the next publication at random. The order is neutral; every bind still counts.
"""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'scripts'), str(ROOT/'tests/ci')]
import copy_runtime_deployment as runtime  # noqa: E402
from ci_release import ReleaseError  # noqa: E402
import v7_infra_adoption as m  # noqa: E402

spec = importlib.util.spec_from_file_location('v7_adoption_fixture_binds', ROOT/'tests/ci/test_v7_infra_adoption.py')
ax = importlib.util.module_from_spec(spec); spec.loader.exec_module(ax)

ASSETS = '/opt/commerce-os/private/restored/assets'
PRIVATE = ASSETS+':/data/private:ro'
LAB = ASSETS+'/number-lab:/data/laboratory:rw'


def worker(binds):
    mounts = [{'Type': 'bind', 'Source': ASSETS+'/number-lab', 'Destination': '/data/laboratory', 'Mode': 'rw', 'RW': True, 'Propagation': 'rprivate'},
              {'Type': 'bind', 'Source': ASSETS, 'Destination': '/data/private', 'Mode': 'ro', 'RW': False, 'Propagation': 'rprivate'}]
    return {'HostConfig': {'Binds': list(binds), 'ReadonlyRootfs': True, 'Dns': None}, 'Mounts': mounts,
            'NetworkSettings': {'Networks': {'commerce-os_core': {'NetworkID': 'n'*64, 'Aliases': [], 'GwPriority': 0}}}}


class BindsOrderTests(unittest.TestCase):
    def test_bind_order_is_neutral_and_each_bind_still_counts(self):
        old, new = worker([PRIVATE, LAB]), worker([LAB, PRIVATE])
        self.assertEqual(runtime.engine_neutral_host(old['HostConfig']), runtime.engine_neutral_host(new['HostConfig']))
        for name in ('automation-worker', 'api'):
            self.assertTrue(runtime.application_boundary_equal(name, old, new))
        for binds in ([LAB, PRIVATE, '/etc:/host-etc:ro'], [LAB], [LAB.replace(':rw', ':ro'), PRIVATE], [LAB, PRIVATE.replace(':ro', ':rw')]):
            with self.subTest(binds=binds):
                self.assertNotEqual(runtime.engine_neutral_host(old['HostConfig']), runtime.engine_neutral_host(worker(binds)['HostConfig']))
                self.assertFalse(runtime.application_boundary_equal('api', old, worker(binds)))
        self.assertEqual(runtime.engine_neutral_host({'Binds': None})['Binds'], None)
        self.assertEqual(old['HostConfig']['Binds'], [PRIVATE, LAB])  # the inspected row itself is never reordered

    def test_readoption_accepts_a_recreated_worker_with_reordered_binds(self):
        b = ax.baseline()
        auto = b['by']['automation-worker']
        auto['HostConfig']['Binds'] = [PRIVATE, LAB]
        captured = m.sanitized(auto)
        new = ax.recreate(auto, 611, ['BETTER_AUTH_SECRET=never-printed'])
        new['HostConfig']['Binds'] = [LAB, PRIVATE]
        self.assertEqual(m.compare_recreated('automation-worker', captured, new, allowed_env=m.V7_SETTINGS['automation-worker']),
                         ['BETTER_AUTH_SECRET'])
        changed = copy.deepcopy(new); changed['HostConfig']['Binds'] = [LAB, PRIVATE, '/etc:/host-etc:ro']
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_HOST_CONFIG_CHANGED:automation-worker'):
            m.compare_recreated('automation-worker', captured, changed, allowed_env=m.V7_SETTINGS['automation-worker'])


if __name__ == '__main__':
    unittest.main()
