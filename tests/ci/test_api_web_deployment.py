import contextlib
import copy
import importlib.util
import io
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import api_web_deployment as guards
from ci_release import ReleaseError
from deployment_scope import COPY_TARGET, LEGACY_TARGET, deployment_scope


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


vps = load('deploy-ci-vps')


class DeploymentSelectionTests(unittest.TestCase):
    def env(self, target, value=None):
        env = dict(zip(('GCP_PROJECT_ID', 'GCP_INSTANCE', 'GCP_ZONE'), target))
        if value is not None: env['COMMERCE_DEPLOY_SCOPE'] = value
        return env

    def test_legacy_default_and_explicit_scope(self):
        self.assertEqual(deployment_scope(self.env(LEGACY_TARGET)), 'full')
        self.assertEqual(deployment_scope(self.env(COPY_TARGET, 'api-web')), 'api-web')

    def test_copy_requires_explicit_scope_and_full_receipt_not_a_variable(self):
        for mode in (None, '', 'full', 'API-WEB', 'api-web\n', 'anything'):
            with self.subTest(mode=mode), self.assertRaises(ReleaseError):
                deployment_scope(self.env(COPY_TARGET, mode))

    def test_target_fields_cannot_mix_authorized_tuples(self):
        for target in ((COPY_TARGET[0], LEGACY_TARGET[1], COPY_TARGET[2]),
                       (*COPY_TARGET[:2], 'us-east1-c')):
            with self.assertRaises(ReleaseError): deployment_scope(self.env(target, 'api-web'))

    def test_copy_default_failure_precedes_local_or_external_commands(self):
        client = load('deploy-ci-client')
        env = self.env(COPY_TARGET) | {'GITHUB_SHA': 'a' * 40, 'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'}
        with patch.dict(os.environ, env, clear=True), patch.object(client, 'run') as run:
            with self.assertRaisesRegex(ReleaseError, 'EXPLICIT_DEPLOYMENT_SCOPE_REQUIRED'): client.main()
        run.assert_not_called()


class ApiWebOwnerIdentityTests(unittest.TestCase):
    @staticmethod
    def identity(clock='2026-10-07T09:30:00Z'):
        value={'clock_utc':clock,'read_only':'on',
               'sessions':[{'id':str(index),'user_id':'owner-one',
                            'created_at':f'2026-10-06T21:{50+index:02d}:00Z',
                            'updated_at':f'2026-10-06T21:{50+index:02d}:00Z',
                            'expires_at':f'2026-10-07T09:{50+index:02d}:00Z','unexpired':True}
                           for index in range(4)],
               'tokens':[{'id':'pat','user_id':'owner-one','workspace_id':'own-workspace',
                          'allowed_environments':['REAL','SIMULATION'],'version':1,
                          'created_at':'2026-10-01T00:00:00Z','expires_at':'2026-10-30T00:00:00Z',
                          'revoked_at':None,'unexpired':True}],
               'memberships':[{'user_id':name,'workspace_id':'own-workspace','role':'owner','active':True}
                              for name in ('owner-one','owner-two')]}
        for row in value['sessions']:
            row['unexpired']=vps.owner_auth_date(row['expires_at'])>vps.owner_auth_date(clock)
        return value

    def snapshot(self,value):
        with patch.object(vps,'data_env',return_value={'WORKSPACE_ID':'own-workspace'}), \
             patch.object(vps,'database',return_value=json.dumps(value)):
            return vps.owner_auth_snapshot(Path('/release'))

    def expanded_identity(self,clock='2026-10-07T09:30:00Z'):
        value=self.identity(clock)
        value['memberships'].append(dict(value['memberships'][1],user_id='owner-three'))
        for index in (4,5):
            row=dict(value['sessions'][0],id=str(index),user_id='owner-two',
                     created_at=f'2026-10-06T21:{50+index}:00Z',
                     updated_at=f'2026-10-06T21:{50+index}:00Z',
                     expires_at=f'2026-10-07T09:{50+index}:00Z')
            row['unexpired']=vps.owner_auth_date(row['expires_at'])>vps.owner_auth_date(clock)
            value['sessions'].append(row)
        return value

    def test_six_sessions_two_subjects_three_existing_owners_preserve_all_identities(self):
        before=self.snapshot(self.expanded_identity());after=self.snapshot(self.expanded_identity('2026-10-07T10:00:00Z'))
        facts=vps.compare_owner_auth(before,after)
        self.assertEqual(facts['retained_session_rows'],6)
        self.assertEqual(facts['active_owner_users'],3)
        self.assertEqual(facts['expired_sessions'],6)
        self.assertTrue(facts['identity_preserved'])

    def test_foreign_inactive_nonowner_duplicate_or_wrong_workspace_members_stop(self):
        for failure in ('foreign','inactive','nonowner','duplicate','workspace','missing-pat-owner'):
            value=self.expanded_identity()
            if failure=='foreign':value['sessions'][-1]['user_id']='unbound-subject'
            if failure=='inactive':value['memberships'][1]['active']=False
            if failure=='nonowner':value['memberships'][1]['role']='viewer'
            if failure=='duplicate':value['memberships'][2]=dict(value['memberships'][1])
            if failure=='workspace':value['memberships'][1]['workspace_id']='foreign-workspace'
            if failure=='missing-pat-owner':value['tokens'][0]['user_id']='unbound-subject'
            with self.subTest(failure=failure),self.assertRaises(ReleaseError):self.snapshot(value)

    def test_observation_is_bounded_and_empty_sessions_do_not_create_access(self):
        value=self.identity();value['sessions']=[]
        self.assertEqual(vps.compare_owner_auth(value,copy.deepcopy(value))['retained_session_rows'],0)
        for field,maximum in [('sessions',guards.MAX_OWNER_SESSIONS),('memberships',guards.MAX_OWNER_USERS),('tokens',1)]:
            value=self.identity();value[field]=[copy.deepcopy(value[field][0]) for _ in range(maximum+1)]
            with self.subTest(field=field),self.assertRaises(ReleaseError):self.snapshot(value)

    def test_additional_owner_login_or_membership_change_midrelease_is_rejected(self):
        for field in ('sessions','memberships'):
            before=self.expanded_identity();after=self.expanded_identity('2026-10-07T10:00:00Z')
            after[field].pop()
            with self.subTest(field=field),self.assertRaisesRegex(ReleaseError,'COPY_OWNER_AUTH_IDENTITY_CHANGED'):
                vps.compare_owner_auth(before,after)

    def test_aggregate_guard_accepts_bounded_login_count_but_keeps_every_effect_barrier(self):
        base={key:0 for key in guards.BARRIERS}
        base.update(database='commerce',migration_count=65,login_sessions=6,personal_tokens_live=1)
        with patch.object(vps,'database',side_effect=[json.dumps(base),'t']):
            self.assertTrue(guards.database_guard(vps.database,Path('/release')))
        for field in guards.BARRIERS:
            if field in ('login_sessions','personal_tokens_live'):continue
            value=base|{field:1}
            with self.subTest(field=field),patch.object(vps,'database',return_value=json.dumps(value)),self.assertRaises(ReleaseError):
                guards.database_guard(vps.database,Path('/release'))

    def test_aggregate_login_and_pat_counts_reject_invalid_types_bounds_and_extra_tokens(self):
        base={key:0 for key in guards.BARRIERS}
        base.update(database='commerce',migration_count=65,login_sessions=6,personal_tokens_live=1)
        for field,invalid in [('login_sessions',-1),('login_sessions',33),('login_sessions',True),
                              ('login_sessions','6'),('personal_tokens_live',True),('personal_tokens_live',2)]:
            with self.subTest(field=field,invalid=invalid),patch.object(vps,'database',return_value=json.dumps(base|{field:invalid})),self.assertRaises(ReleaseError):
                guards.database_guard(vps.database,Path('/release'))

    def test_two_distinct_owners_and_one_subject_are_preserved_readonly(self):
        value=self.identity()
        with patch.object(vps,'data_env',return_value={'WORKSPACE_ID':'own-workspace'}), \
             patch.object(vps,'database',return_value=json.dumps(value)) as database, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            result=vps.owner_auth_snapshot(Path('/release'))
        self.assertEqual(len({row['user_id'] for row in result['memberships']}),2)
        self.assertEqual({row['user_id'] for row in result['sessions']},{'owner-one'})
        self.assertEqual(output.getvalue(),'')
        query=database.call_args.args[1]
        self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',query)
        self.assertIn("SET LOCAL TimeZone='UTC'",query)
        self.assertTrue(query.endswith('ROLLBACK;'))
        for word in ('INSERT ','UPDATE ','DELETE ','token_hash','email','userAgent','ipAddress'):
            self.assertNotIn(word,query)

    def test_natural_expiry_and_exact_clock_boundary_preserve_identity(self):
        before=self.identity()
        for clock,expired in (('2026-10-07T09:50:00Z',1),('2026-10-07T09:52:30Z',3),('2026-10-07T10:00:00Z',4)):
            with self.subTest(clock=clock):
                after=self.snapshot(self.identity(clock))
                result=vps.compare_owner_auth(before,after)
                self.assertEqual(result['expired_sessions'],expired)
                self.assertEqual(result['active_sessions'],4-expired)
                self.assertTrue(result['identity_preserved'])
                self.assertEqual(result['canonical_renewed_sessions'],0)
                self.assertEqual(set(result),{'retained_session_rows','active_sessions','expired_sessions',
                                             'valid_nonrevoked_pat_rows','active_owner_users',
                                             'identity_preserved','canonical_renewed_sessions'})

    def test_canonical_twelve_hour_renewal_is_allowed_before_old_expiry(self):
        before=self.identity();after=self.identity('2026-10-07T09:40:00Z')
        after['sessions'][0].update(updated_at='2026-10-07T09:35:00Z',expires_at='2026-10-07T21:34:59.999Z')
        result=vps.compare_owner_auth(before,after)
        self.assertEqual(result['canonical_renewed_sessions'],1)
        self.assertEqual(result['active_sessions'],4)

    def test_reordering_rows_does_not_change_private_identity(self):
        before=self.identity();after=copy.deepcopy(before)
        after['sessions'].reverse();after['memberships'].reverse()
        self.assertTrue(vps.compare_owner_auth(before,after)['identity_preserved'])

    def test_clock_flags_and_readonly_marker_cannot_be_fabricated(self):
        for kind in ('active','token','clock-reversed','read-write'):
            before=self.identity();after=self.identity('2026-10-07T10:00:00Z')
            if kind=='active':after['sessions'][0]['unexpired']=True
            if kind=='token':after['tokens'][0]['unexpired']=False
            if kind=='clock-reversed':after=self.identity('2026-10-07T09:20:00Z')
            if kind=='read-write':after['read_only']='off'
            with self.subTest(kind=kind),self.assertRaises(ReleaseError):vps.compare_owner_auth(before,after)

    def test_pat_expiry_revocation_version_permissions_or_identity_drift_stop(self):
        for kind in ('expired','revoked','version','environments','id','extended'):
            before=self.identity();after=self.identity('2026-10-07T10:00:00Z');token=after['tokens'][0]
            if kind=='expired':token.update(expires_at='2026-10-07T09:59:00Z',unexpired=False)
            if kind=='revoked':token['revoked_at']='2026-10-07T09:59:00Z'
            if kind=='version':token['version']=2
            if kind=='environments':token['allowed_environments']=['REAL']
            if kind=='id':token['id']='different-pat'
            if kind=='extended':token['expires_at']='2026-10-31T00:00:00Z'
            with self.subTest(kind=kind),self.assertRaises(ReleaseError):vps.compare_owner_auth(before,after)

    def test_session_id_created_subject_delete_and_owner_drift_stop(self):
        for kind in ('id','created','subject','delete','owner','workspace','duplicate-id'):
            before=self.identity();after=self.identity('2026-10-07T10:00:00Z')
            if kind=='id':after['sessions'][0]['id']='new-session'
            if kind=='created':after['sessions'][0]['created_at']='2026-10-06T21:49:00Z'
            if kind=='subject':after['sessions'][0]['user_id']='owner-two'
            if kind=='delete':after['sessions'].pop()
            if kind=='owner':after['memberships'][1]['user_id']='new-owner'
            if kind=='workspace':after['tokens'][0]['workspace_id']='other-workspace'
            if kind=='duplicate-id':after['sessions'][1]['id']=after['sessions'][0]['id']
            with self.subTest(kind=kind),self.assertRaises(ReleaseError):vps.compare_owner_auth(before,after)

    def test_noncanonical_or_postexpiry_renewal_cannot_revive_a_row(self):
        for kind in ('expiry-only','shortened','early','after-expiry','future','duration','updated-only'):
            before=self.identity();after=self.identity('2026-10-07T10:00:00Z');row=after['sessions'][0]
            if kind=='expiry-only':row.update(expires_at='2026-10-07T21:50:00Z',unexpired=True)
            if kind=='shortened':row['expires_at']='2026-10-07T09:49:00Z'
            if kind=='early':row.update(updated_at='2026-10-06T22:00:00Z',expires_at='2026-10-07T10:00:00Z',unexpired=False)
            if kind=='after-expiry':row.update(updated_at='2026-10-07T09:55:00Z',expires_at='2026-10-07T21:55:00Z',unexpired=True)
            if kind=='future':row.update(updated_at='2026-10-07T10:05:00Z',expires_at='2026-10-07T22:05:00Z',unexpired=True)
            if kind=='duration':row.update(updated_at='2026-10-07T09:35:00Z',expires_at='2026-10-08T09:35:00Z',unexpired=True)
            if kind=='updated-only':row['updated_at']='2026-10-06T21:50:01Z'
            with self.subTest(kind=kind),self.assertRaises(ReleaseError):vps.compare_owner_auth(before,after)


class ApiWebControllerTests(unittest.TestCase):
    def exercise(self, failure=None, migration_change=False):
        calls = []
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name).resolve(); private = base / 'private'; private.mkdir()
        archive = base / 'archive'; archive.write_bytes(b'fixture')
        old = base / 'releases' / 'old'; old.mkdir(parents=True)
        (old / 'RELEASE.json').write_text(json.dumps({'source_sha': guards.SOURCE_SHA}))
        (base / 'current').symlink_to(old, target_is_directory=True)
        (private / 'release.env').write_text('COMMERCE_DEPLOY_SCOPE=api-web\n')
        schema = {str(index) + '.sql': 'b' * 64 for index in range(65)}
        fresh_schema = dict(schema)
        if migration_change: fresh_schema['0.sql'] = 'c' * 64
        sha = 'a' * 40
        baseline = {'state_raw': b'state', 'plan_raw': b'plan', 'services': {}, 'files': {}, 'state': {}}
        fresh = copy.deepcopy(baseline)
        if failure == 'drift': fresh['state_raw'] = b'changed'
        class Lock:
            def __init__(self, name): self.name = name
            def close(self): calls.append('close:' + self.name)
        def ci_lock(_private): calls.append('lock:ci'); return Lock('ci')
        def four(_private):
            calls.append('lock:daily,ci,schedule,maintenance')
            if failure == 'busy': raise BlockingIOError()
            return [Lock('four')]
        def extract(_archive, root, _hash):
            root.mkdir(); (root / 'RELEASE.json').write_text(json.dumps({
                'source_sha': sha, 'run_id': '9', 'migration_hashes': fresh_schema}))
        def phase(root, _report, _owner, value):
            calls.append(value)
            if value == 'activate':
                if failure == 'cleanup': raise vps.DeploymentCleanupError('DEPLOYMENT_CLEANUP_UNCONFIRMED')
                if failure == 'activate': raise ReleaseError('INSTALLER_FAILED')
                (base / 'current').unlink(); (base / 'current').symlink_to(root, target_is_directory=True)
        def rollback(_root, previous, _report):
            calls.append('rollback'); (base / 'current').unlink(); (base / 'current').symlink_to(previous)
            return {'status': 'SUCCEEDED', 'database_restored': False}
        def rebase(*_args):
            calls.append('rebase')
            if failure == 'rebase': raise ReleaseError('COPY_REBASE_CAS_FAILED')
            return {'preserved_runtime_rebased': True}
        mocks = [patch.object(vps, 'BASE', base), patch.object(vps, 'PRIVATE', private),
                 patch.object(vps.signal, 'signal'), patch.object(vps.shutil, 'disk_usage', return_value=type('Usage', (), {'free': 50 * 1024 ** 3})()),
                 patch.object(vps, 'extract_release', side_effect=extract), patch.object(vps, 'migrations', return_value=schema),
                 patch.object(vps, 'raw_policy_snapshot', return_value='same'), patch.object(vps, 'verify_ciclo_maintenance', return_value=True),
                 patch.object(vps,'owner_auth_snapshot',side_effect=[ApiWebOwnerIdentityTests.identity(),
                     ApiWebOwnerIdentityTests.identity('2026-10-07T09:52:30Z'),
                     ApiWebOwnerIdentityTests.identity('2026-10-07T10:00:00Z')]),
                 patch.object(vps, 'preserved_containers', return_value={}), patch.object(vps, 'snapshot_api_deployment_status'),
                 patch.object(vps, 'run_install_phase', side_effect=phase), patch.object(vps, 'rollback_candidate', side_effect=rollback),
                 patch.object(vps, 'smoke', return_value={'healthy_services': 3}),
                 patch.object(guards, 'acquire_locks_for_prepare', side_effect=ci_lock), patch.object(guards, 'acquire_locks', side_effect=four),
                 patch.object(guards, 'snapshot', side_effect=[baseline, fresh]), patch.object(guards, 'database_guard', return_value=True),
                 patch.object(guards, 'verify_predeploy_backup', return_value={'local_ciphertext_readback_verified': True}),
                 patch.object(guards, 'inventory', return_value={}), patch.object(guards, 'compare_after'),
                 patch.object(guards, 'rebase', side_effect=rebase)]
        with contextlib.ExitStack() as stack, contextlib.redirect_stdout(io.StringIO()), patch.dict(os.environ):
            for mock in mocks: stack.enter_context(mock)
            try: vps.publish_api_web(str(archive), 'hash', sha, '9-1', '@not-selected')
            except (ReleaseError, BlockingIOError): pass
        report = json.loads((private / 'deployments' / '9-1' / 'report.json').read_text())
        return calls, report

    def test_new_backup_precedes_unlock_and_four_lock_activation(self):
        calls, report = self.exercise()
        self.assertLess(calls.index('prepare'), calls.index('close:ci'))
        self.assertLess(calls.index('close:ci'), calls.index('lock:daily,ci,schedule,maintenance'))
        self.assertLess(calls.index('lock:daily,ci,schedule,maintenance'), calls.index('activate'))
        self.assertEqual(calls.count('activate'), 1)
        self.assertEqual(report['status'], 'SUCCEEDED')
        self.assertFalse(report['full_runtime_started'])
        self.assertFalse(report['consumers_started'])
        self.assertEqual(report['owner_auth_lifecycle']['expired_sessions'],4)
        self.assertEqual(report['owner_auth_lifecycle']['active_sessions'],0)
        self.assertTrue(report['owner_auth_lifecycle']['identity_preserved'])

    def test_stale_baseline_and_busy_daily_lock_stop_before_activation(self):
        for value in ('drift', 'busy'):
            with self.subTest(value=value):
                calls, report = self.exercise(value)
                self.assertIn('prepare', calls); self.assertNotIn('activate', calls)
                self.assertNotIn('rollback', calls); self.assertEqual(report['status'], 'FAILED')

    def test_schema_mismatch_stops_before_backup_or_runtime_changes(self):
        calls, report = self.exercise(migration_change=True)
        self.assertNotIn('prepare', calls); self.assertNotIn('activate', calls)
        self.assertEqual(report['status'], 'FAILED')

    def test_cleanup_unknown_blocks_rollback_and_rebase(self):
        calls, report = self.exercise('cleanup')
        self.assertEqual(calls.count('activate'), 1)
        self.assertNotIn('rollback', calls); self.assertNotIn('rebase', calls)
        self.assertEqual(report['rollback']['status'], 'BLOCKED')

    def test_known_install_failure_rolls_back_then_rebases_verified_runtime(self):
        calls, report = self.exercise('activate')
        self.assertLess(calls.index('rollback'), calls.index('rebase'))
        self.assertEqual(report['status'], 'FAILED')
        self.assertEqual(report['rollback']['scope'], 'api-web')
        self.assertFalse(report['rollback']['database_restored'])

    def test_interrupted_rebase_never_automatically_rolls_back_or_rebases_again(self):
        calls, report = self.exercise('rebase')
        self.assertNotIn('rollback', calls); self.assertEqual(calls.count('rebase'), 1)
        self.assertEqual(report['rollback']['error'], 'COPY_REBASE_RECONCILIATION_REQUIRED')


class ApiWebReleaseShellTests(unittest.TestCase):
    def run_release(self, action, scope='api-web', held='1'):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); scripts = base / 'scripts'; scripts.mkdir()
            private = base / 'private'; private.mkdir(); assets = base / 'assets'; assets.mkdir()
            for name in ('api', 'ingress', 'automation', 'channel', 'postgres', 'admin'):
                (private / (name + '.env')).write_text('DUMMY=value\n')
            (private / 'api-web-adoption.json').write_text('{}')
            image = 'sha256:' + 'a' * 64
            release = private / 'release.env'
            release.write_text('\n'.join(['COMMERCE_IMAGE=' + image, 'COMMERCE_WEB_IMAGE=' + image,
                'COMMERCE_SECRETS_DIR=' + str(private), 'COMMERCE_PRIVATE_ASSETS_DIR=' + str(assets),
                'COMMERCE_PROXY_NETWORK=existing', 'COMMERCE_ORIGIN=https://example.invalid',
                'COMMERCE_DEPLOY_SCOPE=' + scope]) + '\n')
            log = base / 'calls'
            docker = base / 'docker'
            docker.write_text('''#!/bin/sh
printf 'docker %s\\n' "$*" >> "$CALLS"
case "$*" in *Architecture*) echo amd64;; *Os*) echo linux;; esac
'''); docker.chmod(0o700)
            (scripts / 'compose-release.sh').write_text('''#!/bin/sh
shift
printf 'compose %s\\n' "$*" >> "$CALLS"
''')
            env = dict(os.environ, PATH=str(base) + ':' + os.environ['PATH'], CALLS=str(log),
                       COMMERCE_DEPLOY_SCOPE=scope, COMMERCE_API_WEB_LOCKS_HELD=held)
            result = subprocess.run(['sh', str(ROOT / 'scripts' / 'release.sh'), action, str(release)],
                                    cwd=base, env=env, capture_output=True, text=True)
            return result.returncode, log.read_text() if log.exists() else ''

    def test_deploy_and_rollback_only_recreate_selected_services(self):
        for action in ('deploy', 'rollback'):
            with self.subTest(action=action):
                code, log = self.run_release(action)
                self.assertEqual(code, 0)
                up = [line for line in log.splitlines() if line.startswith('compose up')]
                self.assertEqual(len(up), 1); self.assertTrue(up[0].endswith('api web'))
                for forbidden in ('migrate.ts', 'bootstrap.ts', 'import-legacy', 'compose stop', 'compose pull', 'ownership-isolation'):
                    self.assertNotIn(forbidden, log)

    def test_missing_activation_locks_never_start_services(self):
        code, log = self.run_release('deploy', held='')
        self.assertNotEqual(code, 0); self.assertNotIn('compose up', log)

    def test_unknown_scope_rejects_before_docker(self):
        code, log = self.run_release('deploy', scope='wrong')
        self.assertNotEqual(code, 0); self.assertEqual(log, '')


class ApiWebRebaseTests(unittest.TestCase):
    def test_actual_daily_journal_name_cannot_hide_a_running_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory); run = private / 'daily-b02' / 'runs' / '8-1'; run.mkdir(parents=True)
            (private / 'deployments').mkdir()
            (run / 'report.json').write_text(json.dumps({'status': 'SUCCEEDED'}))
            (run / 'journal.json').write_text(json.dumps({'kind': 'DAILY_B02', 'run_id': '8-1', 'status': 'RUNNING'}))
            with patch.object(guards, 'protected_bytes', side_effect=lambda path: Path(path).read_bytes()):
                with self.assertRaisesRegex(ReleaseError, 'COPY_B02_NONTERMINAL_JOURNAL'):
                    guards.terminal_journals(private)

    def test_prior_task_cleanup_unknown_blocks_new_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory); (private / 'daily-b02' / 'runs').mkdir(parents=True)
            report = private / 'deployments' / '7-1'; report.mkdir(parents=True)
            (report / 'report.json').write_text(json.dumps({'status': 'FAILED'}))
            (report / 'task-prepare.json').write_text(json.dumps({'status': 'CLEANUP_FAILED'}))
            with patch.object(guards, 'protected_bytes', side_effect=lambda path: Path(path).read_bytes()):
                with self.assertRaisesRegex(ReleaseError, 'COPY_PRIOR_TASK_UNCONFIRMED'):
                    guards.terminal_journals(private)

    def test_success_changes_only_runtime_in_plan_and_preserves_old_plan_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory).resolve(); (private / 'daily-b02').mkdir()
            old_plan = {'source_sha': guards.SOURCE_SHA, 'maintenance_image': 'old-image',
                        'canonical_sources': {'old': 'pinned'}, 'original_minimum_ref': {'uid': 2000},
                        'promotion_ref': {'sealed': 'unchanged'}, 'storage_path': '/original',
                        'schedule_enabled': False, 'preserved_runtime': {'old': 'digest'}}
            plan_raw = json.dumps(old_plan).encode(); state = {'preserved_runtime': {'old': 'digest'}}
            state_raw = json.dumps(state).encode()
            plan_path = private / 'daily-b02' / 'plan.json'
            state_path = private / 'api-web-adoption.json'
            values = {plan_path: plan_raw, state_path: state_raw}
            values.update({private / name: b'DUMMY=value\n' for name in guards.FILES})
            rows = {name: {'Id': name * 64, 'Image': 'new', 'Config': {}, 'HostConfig': {},
                          'Mounts': [], 'NetworkSettings': {}, 'State': {'Running': True, 'Paused': False,
                          'Restarting': False, 'Pid': 1, 'StartedAt': 'now'}} for name in 'abcd'}
            before = {'state_raw': state_raw, 'state': state, 'plan_raw': plan_raw}
            writes = []
            def read(path):
                path = Path(path)
                return values[path] if path in values else path.read_bytes()
            def write(path, value):
                writes.append(path); values[path] = json.dumps(value).encode()
            with patch.object(guards, 'protected_bytes', side_effect=read), patch.object(guards, 'terminal_journals'), \
                 patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)):
                report = guards.rebase(private, before, rows, '/new-release', write)
            new_plan = json.loads(values[plan_path])
            for key in old_plan.keys() - {'preserved_runtime'}: self.assertEqual(new_plan[key], old_plan[key])
            self.assertEqual(new_plan['preserved_runtime'], {row['Id']: guards.projection_digest(row) for row in rows.values()})
            history = list((private / 'daily-b02' / 'plan-history').glob('*.json'))
            self.assertEqual(len(history), 1); self.assertEqual(history[0].read_bytes(), plan_raw)
            self.assertNotIn('plan_sha256', report); self.assertTrue(report['transport_configuration_update_required'])
            self.assertEqual(writes, [plan_path, state_path])

    def test_partial_plan_commit_stops_replay_before_second_write(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory).resolve() / 'private'; private.mkdir(); (private / 'daily-b02').mkdir()
            plan_path = private / 'daily-b02' / 'plan.json'; state_path = private / 'api-web-adoption.json'
            old = {'source_sha': guards.SOURCE_SHA, 'preserved_runtime': {'old': 'digest'}}
            old_raw = json.dumps(old).encode(); state_raw = b'{}'
            values = {plan_path: old_raw, state_path: state_raw}
            values.update({private / name: b'DUMMY=value\n' for name in guards.FILES})
            before = {'state_raw': state_raw, 'state': {}, 'plan_raw': old_raw}
            row = {'Id': 'a' * 64, 'Image': 'new', 'Config': {}, 'HostConfig': {}, 'Mounts': [],
                   'NetworkSettings': {}, 'State': {'Running': True, 'Paused': False, 'Restarting': False, 'Pid': 1, 'StartedAt': 'new'}}
            writes = []
            def read(path): return values[Path(path)] if Path(path) in values else Path(path).read_bytes()
            def write(path, value):
                writes.append(path)
                if path == state_path: raise OSError('simulated interrupted state commit')
                values[path] = json.dumps(value).encode()
            with patch.object(guards, 'protected_bytes', side_effect=read), patch.object(guards, 'terminal_journals'), \
                 patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)):
                with self.assertRaises(OSError): guards.rebase(private, before, {'api': row}, '/new', write)
                count = len(writes)
                with self.assertRaisesRegex(ReleaseError, 'COPY_REBASE_CAS_FAILED'):
                    guards.rebase(private, before, {'api': row}, '/new', write)
                self.assertEqual(len(writes), count)
            self.assertNotEqual(values[plan_path], old_raw); self.assertEqual(values[state_path], state_raw)
            old_release = private.parent / 'releases' / 'old'; old_release.mkdir(parents=True)
            (private.parent / 'current').symlink_to(old_release, target_is_directory=True)
            old_state = {'current_release': str(old_release), 'canonical_files': {},
                         'b02_plan_sha256': hashlib.sha256(old_raw).hexdigest()}
            values[private / 'release.env'] = ('COMMERCE_DEPLOY_SCOPE=api-web\nCOMMERCE_SECRETS_DIR=' + str(private) + '\n').encode()
            with patch.object(guards, 'load_state', return_value=(old_state, state_raw)), \
                 patch.object(guards, 'protected_bytes', side_effect=read):
                command = Mock()
                with self.assertRaisesRegex(ReleaseError, 'COPY_B02_PLAN_CHANGED'):
                    guards.snapshot(private, old_release, command)
                command.assert_not_called()

    def test_cas_drift_has_no_write(self):
        before = {'state_raw': b'state', 'plan_raw': b'plan'}
        with patch.object(guards, 'protected_bytes', return_value=b'drift'):
            written = []
            with self.assertRaisesRegex(ReleaseError, 'COPY_REBASE_CAS_FAILED'):
                guards.rebase(Path('/private'), before, {}, '/release', lambda *args: written.append(args))
        self.assertEqual(written, [])


class ApiWebGatewayTests(unittest.TestCase):
    def topology(self, priority=1, route='0100170A'):
        core, proxy, edge = 'commerce-os_core', 'proxy', 'edge'
        rows = {name: {'Internal': name != edge, 'EnableIPv6': False,
                      'IPAM': {'Config': [{'Gateway': '10.23.0.1'}]}} for name in (core, proxy, edge)}
        memberships = {'postgres': [core], 'web': [proxy], 'api': [core, proxy, edge], 'caddy': [proxy, edge]}
        services = {name: {'Id': name, 'NetworkSettings': {'Networks': {
            network: {'GwPriority': priority if network == edge else 0} for network in names}}}
            for name, names in memberships.items()}
        kernel = 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n'
        kernel += 'eth0 00000000 ' + route + ' 0003 0 0 0 00000000 0 0 0\n'
        return services, rows, {'COMMERCE_PROXY_NETWORK': proxy, 'COMMERCE_API_EDGE_NETWORK': edge}, kernel

    def test_actual_edge_default_route_and_priority(self):
        services, rows, env, route = self.topology()
        self.assertTrue(guards.topology_guard(lambda *_args: route, Path('/release'), services, rows, env))

    def test_gateway_priority_drift_stops(self):
        services, rows, env, route = self.topology(priority=0)
        with self.assertRaisesRegex(ReleaseError, 'COPY_API_GATEWAY_PRIORITY_CHANGED'):
            guards.topology_guard(lambda *_args: route, Path('/release'), services, rows, env)

    def test_rendered_priority_does_not_replace_kernel_route_proof(self):
        services, rows, env, route = self.topology(route='0100180A')
        with self.assertRaisesRegex(ReleaseError, 'COPY_API_DEFAULT_GATEWAY_NOT_EDGE'):
            guards.topology_guard(lambda *_args: route, Path('/release'), services, rows, env)

    def test_ipv6_drift_stops(self):
        services, rows, env, route = self.topology(); rows['edge']['EnableIPv6'] = True
        with self.assertRaisesRegex(ReleaseError, 'COPY_NETWORK_ISOLATION_CHANGED'):
            guards.topology_guard(lambda *_args: route, Path('/release'), services, rows, env)


class ApiWebPreservationTests(unittest.TestCase):
    def rows(self):
        return {name: {'Id': name, 'Image': 'image', 'Config': {'Env': ['DUMMY=value']},
                'HostConfig': {'ReadonlyRootfs': True}, 'Mounts': [{'Source': '/original', 'Destination': '/data/private'}],
                'NetworkSettings': {'Networks': {}}, 'State': {'Running': True, 'Paused': False,
                'Restarting': False, 'Pid': 1, 'StartedAt': 'same'}} for name in ('api', 'web', 'postgres', 'caddy')}

    def test_overlay_preserves_only_api_smtp_forwarding_sysctls(self):
        overlay = (ROOT / 'infra/compose/copy-api-web.yaml').read_text()
        api = overlay.split('\n  api:\n', 1)[1].split('\n  web:\n', 1)[0]
        block = re.search(r'    sysctls:\n((?:      [^\n]+\n)+)', api)
        self.assertIsNotNone(block)
        settings = dict(line.strip().split(': ', 1) for line in block.group(1).splitlines())
        self.assertEqual(settings, {'net.ipv4.ip_forward': "'0'", 'net.ipv6.conf.all.forwarding': "'0'"})
        self.assertEqual(overlay.count('    sysctls:'), 1)

    def test_smtp_forwarding_sysctls_cannot_disappear_or_change_on_recreate(self):
        expected = {'net.ipv4.ip_forward': '0', 'net.ipv6.conf.all.forwarding': '0'}
        for actual in ({}, {'net.ipv4.ip_forward': '0'},
                       {**expected, 'net.ipv4.ip_forward': '1'},
                       {**expected, 'net.ipv6.conf.all.forwarding': '1'},
                       {**expected, 'net.ipv4.conf.all.forwarding': '0'}):
            with self.subTest(actual=actual):
                old = self.rows(); old['api']['HostConfig']['Sysctls'] = expected
                new = copy.deepcopy(old); new['api']['HostConfig']['Sysctls'] = actual
                with self.assertRaisesRegex(ReleaseError, 'COPY_APPLICATION_BOUNDARY_CHANGED'):
                    guards.compare_after({'services': old}, new, lambda *_args: '', Path('/release'), Path('/private'))

    def test_assets_mount_or_host_config_drift_is_rejected(self):
        for field, value in (('Mounts', [{'Source': '/other', 'Destination': '/data/private'}]),
                             ('HostConfig', {'ReadonlyRootfs': False})):
            with self.subTest(field=field):
                old = self.rows(); new = copy.deepcopy(old); new['api'][field] = value
                with self.assertRaisesRegex(ReleaseError, 'COPY_APPLICATION_BOUNDARY_CHANGED'):
                    guards.compare_after({'services': old}, new, lambda *_args: '', Path('/release'), Path('/private'))

    def test_profile_key_change_cannot_hide_behind_allowed_deploy_status(self):
        old = self.rows(); new = copy.deepcopy(old); private = Path('/private')
        files = {name: b'DUMMY=value\n' for name in guards.FILES}
        files['release.env'] = b'COMMERCE_PROXY_NETWORK=proxy\nCOMMERCE_API_EDGE_NETWORK=edge\n'
        before = {'services': old, 'files': files,
                  'state': {'network_baseline': {}, 'active_proxy_sha256': 'digest', 'caddy_config_ref': {}}}
        actual = dict(files); actual['api.env'] = b'DUMMY=changed\nCOMMERCE_DEPLOYMENT_STATUS=DEPLOYED\n'
        with patch.object(guards, 'networks', return_value={}), patch.object(guards, 'topology_guard'), \
             patch.object(guards, 'active_proxy_digest', return_value='digest'), patch.object(guards, 'read_reference'), \
             patch.object(guards, 'protected_bytes', side_effect=lambda path: actual[Path(path).name]):
            with self.assertRaisesRegex(ReleaseError, 'COPY_API_SECRET_OR_PROFILE_CHANGED'):
                guards.compare_after(before, new, lambda *_args: '', Path('/release'), private)

    def test_nonterminal_backup_blocks_all_rebase_writes(self):
        before = {'state_raw': b'state', 'plan_raw': b'plan'}
        with patch.object(guards, 'protected_bytes', side_effect=[b'state', b'plan']), \
             patch.object(guards, 'terminal_journals', side_effect=ReleaseError('COPY_B02_NONTERMINAL_JOURNAL')):
            written = []
            with self.assertRaisesRegex(ReleaseError, 'COPY_B02_NONTERMINAL_JOURNAL'):
                guards.rebase(Path('/private'), before, {}, '/release', lambda *args: written.append(args))
        self.assertEqual(written, [])


if __name__ == '__main__':
    unittest.main()
