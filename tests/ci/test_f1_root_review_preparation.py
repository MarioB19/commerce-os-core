"""Pure plans and synthetic source bytes only; never execute a described command."""
import datetime as dt
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'scripts'))
import f1_root_review_preparation as m

NOW = dt.datetime(2026, 10, 12, 2, tzinfo=dt.timezone.utc)


def fixture():
    names = sorted(m.REQUIRED_READERS | m.BACKUP_TOOLS)
    sources = {n: b'# synthetic source\n' for n in names}
    sources['deploy-ci-client.py'] = ('STAGING_SCRIPTS=' + repr(tuple(names)) + '\n').encode()
    sources['copy_runtime_approvals.py'] = ('READERS=' + repr(tuple(sorted(m.REQUIRED_READERS)))
        + '\nTOOLS=' + repr(tuple(sorted(m.BACKUP_TOOLS))) + '\n').encode()
    request = {'source_sha': 'a' * 40, 'source_tree': 'b' * 40,
        'package_build_id': '11111111-1111-4111-8111-111111111111',
        'installation_attempt': '1',
        'archive_sha256': 'c' * 64, 'archive_bytes': 1024, 'review_id': 'synthetic-main',
        'issued_at': NOW.isoformat(), 'expires_at': (NOW + dt.timedelta(hours=2)).isoformat()}
    return request, sources


class Tests(unittest.TestCase):
    def prepare(self, request=None, sources=None):
        default, files = fixture()
        return m.prepare(request or default, sources or files,
            {k: m.sha(v) for k, v in (sources or files).items()}, now=NOW)

    def test_positive_fixed_commands_are_not_authority(self):
        plan = self.prepare()
        self.assertEqual(plan['effects'], 0)
        self.assertFalse(plan['installation_authorized'])
        self.assertTrue(plan['fresh_native_read_required_before_host_mutation'])
        self.assertTrue(plan['native_full_package_required'])
        self.assertEqual(plan['observe_argv'][2], 'observe')
        self.assertEqual(plan['observe_argv'][-1], 'synthetic-main')
        self.assertEqual(m.seal_argv(plan, 'd' * 64, now=NOW)[2:],
            ['seal', 'synthetic-main', 'd' * 64])

    def test_installation_attempt_matches_canonical_decimal_shape(self):
        request, _ = fixture()
        for attempt in ('1', '999999'):
            plan = self.prepare(request={**request, 'installation_attempt': attempt})
            self.assertEqual(plan['installation_run_id'], 'cb-' + request['package_build_id'] + '-' + attempt)
            self.assertEqual(plan['observe_argv'][-2], plan['installation_run_id'])
        for attempt in (None, True, 1, '0', '01', '1000000', '-1', '1\n',
                '22222222-2222-4222-8222-222222222222'):
            with self.subTest(attempt=attempt), self.assertRaisesRegex(RuntimeError, 'ATTEMPT_INVALID'):
                self.prepare(request={**request, 'installation_attempt': attempt})
        legacy = {**request, 'installation_attempt_id': request['installation_attempt']}
        del legacy['installation_attempt']
        with self.assertRaisesRegex(RuntimeError, 'REQUEST_FIELDS'):
            self.prepare(request=legacy)

    def test_real_canonical_identity_when_installer_is_in_closure(self):
        try:
            import ci_provider_evidence as provider
        except ModuleNotFoundError:
            self.skipTest('Installer module is absent on this base; verified separately against integrated source')
        request, _ = fixture()
        for attempt in ('1', '999999'):
            plan = self.prepare(request={**request, 'installation_attempt': attempt})
            expected = provider.cloud_installation_id(request['package_build_id'], int(attempt))
            self.assertEqual(plan['installation_run_id'], expected)
            self.assertIsNotNone(provider.CLOUD_RUN.fullmatch(plan['observe_argv'][-2]))

    def test_hash_drift_before_plan(self):
        request, sources = fixture()
        pins = {k: m.sha(v) for k, v in sources.items()}
        sources['ci_release.py'] += b'# drift\n'
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_CHANGED'):
            m.prepare(request, sources, pins, now=NOW)

    def test_required_dynamic_reader_absent(self):
        _, sources = fixture()
        del sources['deploy-ci-vps.py']
        with self.assertRaisesRegex(RuntimeError, 'CLOSURE_MISSING'):
            self.prepare(sources=sources)

    def test_top_level_local_import_absent(self):
        _, sources = fixture()
        sources['ci_release.py'] = b'import absent_candidate_dependency\n'
        with self.assertRaisesRegex(RuntimeError, 'IMPORT_CLOSURE_MISSING'):
            self.prepare(sources=sources)

    def test_candidate_code_is_parsed_never_executed(self):
        _, sources = fixture()
        sources['ci_release.py'] = b'raise RuntimeError("CANDIDATE_MUST_NOT_EXECUTE")\n'
        self.assertEqual(self.prepare(sources=sources)['effects'], 0)

    def test_computed_catalogue_and_duplicates_fail(self):
        for raw in (b'STAGING_SCRIPTS=compute()\n', b"STAGING_SCRIPTS=('a.py','a.py')\n"):
            with self.assertRaises(RuntimeError):
                m.literal_catalogue(raw, 'STAGING_SCRIPTS')

    def test_path_traversal_and_command_injection_fail(self):
        request, _ = fixture()
        for value in ('../outside', 'x;touch-owned', 'x/y', 'x\nnext'):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'ID_INVALID'):
                self.prepare(request={**request, 'review_id': value})
        with self.assertRaisesRegex(RuntimeError, 'NAME_INVALID'):
            m.literal_catalogue(b"STAGING_SCRIPTS=('../outside.py',)\n", 'STAGING_SCRIPTS')

    def test_pending_native_identity_never_yields_plan(self):
        request, _ = fixture()
        for key in ('source_sha', 'source_tree', 'archive_sha256'):
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'IDENTITY_PENDING'):
                self.prepare(request={**request, key: '0' * len(request[key])})
        for key in ('package_build_id',):
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'UUID_REQUIRED'):
                self.prepare(request={**request, key: None})

    def test_window_two_hours_maximum_and_no_refresh(self):
        request, _ = fixture()
        for delta in (-1, 0, 7201):
            with self.subTest(delta=delta), self.assertRaisesRegex(RuntimeError, 'WINDOW_EXPIRED'):
                self.prepare(request={**request, 'expires_at': (NOW + dt.timedelta(seconds=delta)).isoformat()})
        plan = self.prepare()
        with self.assertRaisesRegex(RuntimeError, 'WINDOW_EXPIRED'):
            m.seal_argv(plan, 'd' * 64, now=NOW + dt.timedelta(hours=2))
        self.assertEqual(plan['issued_at'], request['issued_at'])

    def test_remaining_effect_must_fit_after_final_read(self):
        end = NOW + dt.timedelta(minutes=5)
        m.window(NOW.isoformat(), end.isoformat(), now=NOW, remaining_seconds=299)
        with self.assertRaisesRegex(RuntimeError, 'WINDOW_EXPIRED'):
            m.window(NOW.isoformat(), end.isoformat(), now=NOW + dt.timedelta(seconds=1), remaining_seconds=299)

    def test_archive_bound_strict_integer(self):
        request, _ = fixture()
        for size in (True, 0, 3 * 1024**3 + 1):
            with self.subTest(size=size), self.assertRaisesRegex(RuntimeError, 'ARCHIVE_BOUND'):
                self.prepare(request={**request, 'archive_bytes': size})

    def test_original_files_not_mutated_and_partial_observation_fails(self):
        request, sources = fixture()
        copy = dict(sources)
        plan = self.prepare(request, sources)
        self.assertEqual(sources, copy)
        for value in (None, '0' * 64, 'pending'):
            with self.assertRaisesRegex(RuntimeError, 'OBSERVATION_PIN_REQUIRED'):
                m.seal_argv(plan, value, now=NOW)


if __name__ == '__main__':
    unittest.main()
