import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import v7_boot as m  # noqa: E402


def config(tmp):
    return {'workdir': '/opt/commerce-os/current', 'release_env': '/opt/commerce-os/private/release.env', 'services': ['postgres', 'api', 'web'],
            'timeout_seconds': 60, 'receipt': str(Path(tmp) / 'boot' / 'last-boot.json'), 'hold': str(Path(tmp) / 'hold')}


class Runner:
    def __init__(self, sequence):
        self.calls, self.sequence = [], list(sequence)

    def __call__(self, argv, capture_output=True, timeout=None, cwd=None):
        self.calls.append(argv)
        out = ''
        if 'ps' in argv:
            states = self.sequence.pop(0) if len(self.sequence) > 1 else self.sequence[0]
            out = '\n'.join(json.dumps({'Service': s, 'State': st, 'Health': h}) for s, (st, h) in states.items())
        return SimpleNamespace(returncode=0, stdout=out.encode(), stderr=b'')


class Clock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


class BootTests(unittest.TestCase):
    def test_starts_only_the_release_services_and_waits_for_health(self):
        with tempfile.TemporaryDirectory() as tmp:
            c, clock = config(tmp), Clock()
            runner = Runner([{'postgres': ('running', 'starting'), 'api': ('exited', ''), 'web': ('running', '')},
                             {'postgres': ('running', 'healthy'), 'api': ('running', 'healthy'), 'web': ('running', '')}])
            receipt = m.run(c, m.Host(c, runner, clock.now, clock.sleep))
            self.assertEqual(receipt['state'], 'READY')
            up = runner.calls[0]
            self.assertEqual(up[:3], ['sh', 'scripts/compose-release.sh', c['release_env']])
            self.assertEqual(up[3:], ['up', '-d', '--no-recreate', '--no-build', '--pull', 'never', 'postgres', 'api', 'web'])
            self.assertEqual(json.loads(Path(c['receipt']).read_text())['state'], 'READY')
            self.assertEqual(oct(Path(c['receipt']).stat().st_mode & 0o777), '0o600')

    def test_hold_keeps_the_platform_stopped(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = config(tmp)
            Path(c['hold']).write_text('maintenance')
            runner = Runner([{}])
            self.assertEqual(m.run(c, m.Host(c, runner))['state'], 'HELD_FOR_MAINTENANCE')
            self.assertEqual(runner.calls, [])

    def test_reports_not_ready_after_the_timeout(self):
        with tempfile.TemporaryDirectory() as tmp:
            c, clock = config(tmp), Clock()
            runner = Runner([{'postgres': ('running', 'healthy'), 'api': ('restarting', ''), 'web': ('running', '')}])
            receipt = m.run(c, m.Host(c, runner, clock.now, clock.sleep))
            self.assertEqual(receipt['state'], 'NOT_READY')
            self.assertEqual(receipt['services']['api'], {'state': 'restarting', 'health': ''})

    def test_config_is_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            for change in ({'services': ['../x']}, {'timeout_seconds': 5}, {'extra': 1}, {'hold': 'relative'}):
                p = Path(tmp) / 'c.json'
                p.write_text(json.dumps({**config(tmp), **change}))
                with self.assertRaises(m.BootError):
                    m.load_config(str(p))


if __name__ == '__main__':
    unittest.main()
