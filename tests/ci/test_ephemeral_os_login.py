import base64
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest
import importlib.util
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from ephemeral_os_login import remove_ephemeral_key
spec = importlib.util.spec_from_file_location('backup_cleanup_transport',
    Path(__file__).resolve().parents[2] / 'scripts' / 'b02-backup-ci.py')
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


PUBLIC = 'ssh-ed25519 ' + base64.b64encode(b'owned-test-public-material').decode() + ' runner-comment'
FOREIGN = 'ssh-ed25519 ' + base64.b64encode(b'foreign-test-public-material').decode() + ' unrelated'
OWN_ID = 'a' * 64
FOREIGN_ID = 'b' * 64


def profile():
    return {'name': 'fixture-user', 'sshPublicKeys': {
        OWN_ID: {'key': PUBLIC.rsplit(' ', 1)[0] + ' google-modified-comment', 'fingerprint': OWN_ID},
        FOREIGN_ID: {'key': FOREIGN, 'fingerprint': FOREIGN_ID}}}


class Runner:
    def __init__(self, before, after=None, remove_code=0):
        self.before = before
        self.after = after if after is not None else copy.deepcopy(before)
        self.remove_code = remove_code
        self.calls = []
        self.reads = 0

    def __call__(self, args):
        self.calls.append(args)
        if args == ['gcloud', 'compute', 'os-login', 'describe-profile', '--format=json']:
            value = self.before if self.reads == 0 else self.after
            self.reads += 1
            return subprocess.CompletedProcess(args, 0, value if isinstance(value, str) else json.dumps(value), '')
        return subprocess.CompletedProcess(args, self.remove_code, '', 'private error intentionally ignored')


class CleanupTests(unittest.TestCase):
    def test_observed_resource_id_and_changed_comment_preserve_foreign_key(self):
        before = profile()
        after = copy.deepcopy(before)
        del after['sshPublicKeys'][OWN_ID]
        runner = Runner(before, after)
        self.assertEqual(remove_ephemeral_key(PUBLIC, runner),
                         {'key_absent_verified': True, 'remove_calls': 1, 'profile_reads': 2})
        self.assertEqual(runner.calls[1], ['gcloud', 'compute', 'os-login', 'ssh-keys', 'remove',
                                          '--key=' + OWN_ID, '--quiet'])
        self.assertEqual(after['sshPublicKeys'][FOREIGN_ID], before['sshPublicKeys'][FOREIGN_ID])

    def test_already_absent_has_no_delete(self):
        value = profile()
        del value['sshPublicKeys'][OWN_ID]
        runner = Runner(value)
        self.assertEqual(remove_ephemeral_key(PUBLIC, runner)['remove_calls'], 0)
        self.assertEqual(len(runner.calls), 1)

    def test_missing_key_map_is_absent_but_null_is_unknown(self):
        self.assertEqual(remove_ephemeral_key(PUBLIC, Runner({'name': 'fixture-user'}))['remove_calls'], 0)
        runner = Runner({'name': 'fixture-user', 'sshPublicKeys': None})
        with self.assertRaisesRegex(RuntimeError, 'PROFILE_INVALID'):
            remove_ephemeral_key(PUBLIC, runner)
        self.assertEqual(len(runner.calls), 1)

    def test_duplicate_material_blocks_before_delete(self):
        value = profile()
        value['sshPublicKeys']['c' * 64] = dict(value['sshPublicKeys'][OWN_ID], fingerprint='c' * 64)
        runner = Runner(value)
        with self.assertRaisesRegex(RuntimeError, 'KEY_AMBIGUOUS'):
            remove_ephemeral_key(PUBLIC, runner)
        self.assertEqual(len(runner.calls), 1)

    def test_mismatched_returned_fingerprint_blocks_before_delete(self):
        value = profile()
        value['sshPublicKeys'][OWN_ID]['fingerprint'] = 'c' * 64
        runner = Runner(value)
        with self.assertRaisesRegex(RuntimeError, 'RESOURCE_INVALID'):
            remove_ephemeral_key(PUBLIC, runner)
        self.assertEqual(len(runner.calls), 1)

    def test_invalid_resource_identifier_blocks_before_delete(self):
        value = profile()
        value['sshPublicKeys']['--not-a-fingerprint'] = value['sshPublicKeys'].pop(OWN_ID)
        runner = Runner(value)
        with self.assertRaisesRegex(RuntimeError, 'RESOURCE_INVALID'):
            remove_ephemeral_key(PUBLIC, runner)
        self.assertEqual(len(runner.calls), 1)

    def test_failed_removal_is_never_retried(self):
        runner = Runner(profile(), remove_code=1)
        with self.assertRaisesRegex(RuntimeError, 'KEY_REMOVAL_FAILED'):
            remove_ephemeral_key(PUBLIC, runner)
        self.assertEqual(len(runner.calls), 2)

    def test_successful_command_with_key_still_present_does_not_pass(self):
        runner = Runner(profile())
        with self.assertRaisesRegex(RuntimeError, 'KEY_STILL_REGISTERED'):
            remove_ephemeral_key(PUBLIC, runner)
        self.assertEqual(len(runner.calls), 3)

    def test_reintroduced_material_under_another_id_is_not_absence(self):
        value = profile()
        value['sshPublicKeys']['c' * 64] = value['sshPublicKeys'].pop(OWN_ID)
        runner = Runner(profile(), value)
        with self.assertRaisesRegex(RuntimeError, 'KEY_STILL_REGISTERED'):
            remove_ephemeral_key(PUBLIC, runner)

    def test_profile_identity_changed_is_unknown(self):
        value = profile()
        value['name'] = 'other-user'
        del value['sshPublicKeys'][OWN_ID]
        with self.assertRaisesRegex(RuntimeError, 'PROFILE_IDENTITY_CHANGED'):
            remove_ephemeral_key(PUBLIC, Runner(profile(), value))

    def test_foreign_key_changed_fails_readback(self):
        value = profile()
        del value['sshPublicKeys'][OWN_ID]
        value['sshPublicKeys'][FOREIGN_ID]['key'] += ' changed'
        with self.assertRaisesRegex(RuntimeError, 'OTHER_KEYS_CHANGED'):
            remove_ephemeral_key(PUBLIC, Runner(profile(), value))

    def test_duplicate_json_members_are_unknown(self):
        runner = Runner('{"sshPublicKeys": {}, "sshPublicKeys": {}}')
        with self.assertRaisesRegex(RuntimeError, 'PROFILE_INVALID'):
            remove_ephemeral_key(PUBLIC, runner)
        self.assertEqual(len(runner.calls), 1)

    def test_missing_profile_identity_is_not_proof_of_absence(self):
        runner = Runner({'sshPublicKeys': {}})
        with self.assertRaisesRegex(RuntimeError, 'PROFILE_INVALID'):
            remove_ephemeral_key(PUBLIC, runner)
        self.assertEqual(len(runner.calls), 1)

    def test_invalid_local_key_never_queries_cloud(self):
        runner = Runner(profile())
        with self.assertRaisesRegex(RuntimeError, 'PUBLIC_KEY_INVALID'):
            remove_ephemeral_key('ssh-ed25519 @@@@', runner)
        self.assertEqual(runner.calls, [])

    def test_final_transport_phases_keep_distinct_safe_codes(self):
        for code in ('B02_DISCARD_EXPORT_COMMAND_FAILED', 'B02_OS_LOGIN_CLEANUP_COMMAND_FAILED'):
            process=mock.Mock(pid=7654321,returncode=1,stdin=None,stdout=None,stderr=None)
            process.communicate.return_value=('', 'not exported')
            with self.subTest(code=code), mock.patch.object(transport.subprocess, 'Popen',return_value=process), mock.patch.object(transport.os,'killpg'):
                with self.assertRaisesRegex(RuntimeError, '^' + code + '$'):
                    transport.command(['synthetic-gcloud'], failure_code=code)

    def test_timeout_keeps_final_phase_and_never_retries(self):
        process=mock.Mock(pid=7654321,returncode=None,stdin=None,stdout=None,stderr=None)
        process.communicate.side_effect=subprocess.TimeoutExpired(['synthetic-gcloud'],180)
        with mock.patch.object(transport.subprocess, 'Popen',return_value=process) as called, mock.patch.object(transport.os,'killpg') as groups:
            with self.assertRaisesRegex(RuntimeError, '^B02_OS_LOGIN_CLEANUP_UNKNOWN_PRESERVE$'):
                transport.command(['synthetic-gcloud'], failure_code='B02_OS_LOGIN_CLEANUP_COMMAND_FAILED')
        self.assertEqual(called.call_count, 1);self.assertIs(called.call_args.kwargs['start_new_session'],True)
        self.assertEqual([entry.args[0] for entry in groups.call_args_list],[process.pid,process.pid])

    def test_failure_code_is_closed_before_running_a_command(self):
        with mock.patch.object(transport.subprocess, 'Popen') as called:
            with self.assertRaisesRegex(RuntimeError, '^B02_TRANSPORT_FAILURE_CODE_INVALID$'):
                transport.command(['synthetic-gcloud'], failure_code='private detail')
        called.assert_not_called()


if __name__ == '__main__':
    unittest.main()
