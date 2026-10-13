import contextlib
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import v7_runtime_env as m  # noqa: E402


def config(tmp):
    return {'compose': ['docker', 'compose', '-f', 'infra/compose/production.yaml'], 'workdir': '/opt/commerce-os/current', 'postgres_service': 'postgres',
            'pg_user': 'commerce', 'database': 'commerce', 'db_host': 'postgres', 'secrets_dir': str(tmp),
            'services': {'api': 'api.env', 'automation': 'automation.env'}}


class Host:
    def __init__(self):
        self.sql = []

    def psql(self, sql):
        self.sql.append(sql)
        return ''


def write(path, text):
    path.write_text(text)
    path.chmod(0o600)


class RuntimeEnvTests(unittest.TestCase):
    def test_creates_each_login_once_and_writes_only_the_services_that_use_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            write(tmp / 'api.env', 'DATABASE_URL=postgres://api\n# comment\n')
            write(tmp / 'automation.env', 'DATABASE_URL=postgres://auto\n')
            host = Host()
            pw = iter(['a' * 64, 'b' * 64, 'c' * 64])
            result = m.logins(config(tmp), host, password=lambda: next(pw))
            self.assertEqual(result, {'ai': 'CONFIGURED', 'results': 'CONFIGURED', 'mail': 'CONFIGURED'})
            api, auto = m.read_env(tmp / 'api.env'), m.read_env(tmp / 'automation.env')
            self.assertEqual(api['AI_DATABASE_URL'], 'postgres://commerce_ai_v7_login:' + 'a' * 64 + '@postgres:5432/commerce')
            self.assertEqual(auto['AI_DATABASE_URL'], api['AI_DATABASE_URL'])
            self.assertNotIn('RESULTS_DATABASE_URL', api)
            self.assertIn('commerce_results_v7_login', auto['RESULTS_DATABASE_URL'])
            self.assertIn('commerce_mail_v7_login', auto['MAIL_DISPATCH_DATABASE_URL'])
            self.assertEqual(api['DATABASE_URL'], 'postgres://api')
            self.assertIn('# comment', (tmp / 'api.env').read_text())
            self.assertIn('NOINHERIT', host.sql[0])
            self.assertIn('GRANT "commerce_ai" TO "commerce_ai_v7_login"', host.sql[0])
            self.assertIn(' INHERIT NOSUPERUSER', host.sql[2])
            for f in tmp.iterdir():
                self.assertEqual(stat.S_IMODE(f.stat().st_mode), 0o600, f.name)
            backups = sorted(f.name for f in tmp.iterdir() if '.before-v7-' in f.name)
            self.assertEqual(len(backups), 4)
            again = m.logins(config(tmp), Host(), password=lambda: 'd' * 64)
            self.assertEqual(again, {'ai': 'KEPT', 'results': 'KEPT', 'mail': 'KEPT'})

    def test_settings_replace_in_place_and_refuse_multiline_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            write(tmp / 'automation.env', 'A_B=1\nMAIL_SERVICE_ORIGIN=old\n')
            m.write_env(tmp / 'automation.env', {'MAIL_SERVICE_ORIGIN': 'https://mail.example', 'NEW_KEY': 'x'})
            self.assertEqual((tmp / 'automation.env').read_text(), 'A_B=1\nMAIL_SERVICE_ORIGIN=https://mail.example\nNEW_KEY=x\n')
            with self.assertRaises(m.EnvError):
                m.write_env(tmp / 'automation.env', {'BAD': 'a\nb'})
            with self.assertRaises(m.EnvError):
                m.write_env(tmp / 'automation.env', {'lower': 'x'})

    def test_merge_takes_only_the_prefixed_keys_from_a_private_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            write(tmp / 'automation.env', 'DATABASE_URL=x\n')
            src = tmp / 'lab.env'
            write(src, 'LAB_ENGINE_URL=postgres://e\nLAB_TRANSPORT_URL=postgres://t\nOTHER=no\n')
            self.assertEqual(m.merge(config(tmp), 'automation', str(src), 'LAB_'), ['LAB_ENGINE_URL', 'LAB_TRANSPORT_URL'])
            env = m.read_env(tmp / 'automation.env')
            self.assertEqual(env['LAB_ENGINE_URL'], 'postgres://e')
            self.assertNotIn('OTHER', env)
            os.chmod(src, 0o644)
            with self.assertRaises(m.EnvError):
                m.merge(config(tmp), 'automation', str(src), 'LAB_')

    def test_generate_escrows_before_writing_and_never_rotates(self):
        import base64
        import hashlib

        class Escrow:
            def __init__(self):
                self.added = []

            def add_version(self, project, name, raw):
                self.added.append((project, name, raw))
                return 'projects/1/secrets/%s/versions/%d' % (name, len(self.added))

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            write(tmp / 'automation.env', '')
            write(tmp / 'api.env', '')
            escrow = Escrow()
            r = m.generate(config(tmp), 'automation', 'MAIL_ENVELOPE_KEY', 'aes256', 'project-c6f43813-9ac9-47ab-9fe', 'commerce-v7-mail-key', host=escrow)
            key = m.read_env(tmp / 'automation.env')['MAIL_ENVELOPE_KEY']
            self.assertEqual(base64.b64decode(key), escrow.added[0][2])
            self.assertEqual(len(escrow.added[0][2]), 32)
            self.assertEqual(r['sha256'], hashlib.sha256(escrow.added[0][2]).hexdigest())
            self.assertNotIn(key, json.dumps(r))
            r = m.generate(config(tmp), 'api', 'INGRESS_RELAY_URL', 'token', 'project-c6f43813-9ac9-47ab-9fe', 'commerce-v7-ingress-relay-token',
                           'https://commerce-v7-ingress-1065291779811.us-east1.run.app/relay/{}', host=escrow)
            url = m.read_env(tmp / 'api.env')['INGRESS_RELAY_URL']
            token = escrow.added[1][2].decode()
            self.assertRegex(token, r'^[A-Za-z0-9_-]{43}$')
            self.assertEqual(url, 'https://commerce-v7-ingress-1065291779811.us-east1.run.app/relay/' + token)
            again = m.generate(config(tmp), 'automation', 'MAIL_ENVELOPE_KEY', 'aes256', 'project-c6f43813-9ac9-47ab-9fe', 'commerce-v7-mail-key', host=escrow)
            self.assertEqual(again['state'], 'KEPT')
            self.assertEqual(len(escrow.added), 2)
            with self.assertRaises(m.EnvError):
                m.generate(config(tmp), 'api', 'X_Y', 'token', 'project-c6f43813-9ac9-47ab-9fe', 'other-secret', host=escrow)
            self.assertEqual(m.crc32c(b'123456789'), 0xe3069283)

    def test_cli_never_prints_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            write(tmp / 'api.env', '')
            cfg = tmp / 'cfg.json'
            cfg.write_text(json.dumps(config(tmp)))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = m.main(['set', str(cfg), 'api', 'INGRESS_RELAY_URL=https://relay.secret-value.example'])
            self.assertEqual(code, 0)
            self.assertNotIn('secret-value', out.getvalue())
            self.assertEqual(json.loads(out.getvalue())['keys'], ['INGRESS_RELAY_URL'])
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(m.main(['set', str(cfg), 'nope', 'A_B=1']), 1)
            self.assertEqual(json.loads(out.getvalue())['error'], 'ENV_SERVICE_UNKNOWN')


if __name__ == '__main__':
    unittest.main()
