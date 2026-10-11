import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts'))
import cloudbuild_bounded_logs as m


class BoundedLogsTests(unittest.TestCase):
    def run_child(self, code, *, seconds=5, stdout_limit=128, stderr_limit=64):
        out = io.BytesIO(); err = io.BytesIO()
        with tempfile.TemporaryDirectory() as directory:
            result = m.execute([sys.executable, '-c', code], Path(directory), dict(os.environ), seconds,
                stdout_limit=stdout_limit, stderr_limit=stderr_limit, stdout=out, stderr=err)
        return result, out.getvalue(), err.getvalue()

    def test_under_limit_output_and_nonzero_return_are_preserved(self):
        self.assertEqual(self.run_child('import sys; print("out"); print("err",file=sys.stderr); sys.exit(7)'),
                         (7, b'out\n', b'err\n'))

    def test_exact_limit_is_accepted_without_fabricated_truncation(self):
        self.assertEqual(self.run_child('import os;os.write(1,b"x"*128)')[1], b'x'*128)

    def test_stdout_and_stderr_overflow_fail_and_only_emit_admitted_bytes(self):
        for descriptor, maximum in ((1,128),(2,64)):
            out = io.BytesIO(); err = io.BytesIO()
            with tempfile.TemporaryDirectory() as directory:
                pid = Path(directory)/'pid'
                code = 'import os,time;open('+repr(str(pid))+',"w").write(str(os.getpid()));os.write('+str(descriptor)+',b"x"*10000);time.sleep(30)'
                with self.assertRaises(m.LogLimitExceeded):
                    m.execute([sys.executable,'-c',code], directory, dict(os.environ), 5,
                        stdout_limit=128, stderr_limit=64, stdout=out, stderr=err)
                self.assertEqual(len((out if descriptor==1 else err).getvalue()), maximum)
                with self.assertRaises(ProcessLookupError): os.kill(int(pid.read_text()),0)

    def test_continuous_small_output_still_obeys_wall_deadline(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_child('import os,time\nwhile True: os.write(1,b".");time.sleep(.05)', seconds=.2)

    def test_descendant_holding_pipe_is_killed_on_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            pid = Path(directory)/'child'
            child = 'import os,time;open('+repr(str(pid))+',"w").write(str(os.getpid()));time.sleep(30)'
            code = 'import subprocess,sys;subprocess.Popen([sys.executable,"-c",'+repr(child)+'])'
            with self.assertRaises((subprocess.TimeoutExpired, RuntimeError)) as result:
                m.execute([sys.executable,'-c',code], directory, dict(os.environ), .3, stdout=io.BytesIO(),stderr=io.BytesIO())
            # Reaping orphan children is OS-owned; the process group has been
            # signalled even though its immediate parent had already exited.
            self.assertTrue(pid.exists())
            if isinstance(result.exception, RuntimeError):
                self.assertEqual(str(result.exception), 'OWNED_PROCESS_GROUP_CLEANUP_UNCONFIRMED')

    def test_invalid_bounds_fail_before_spawning(self):
        for kwargs in ({'seconds':0},{'stdout_limit':0},{'stderr_limit':True}):
            with self.assertRaises(ValueError): self.run_child('raise Exception("must not run")', **kwargs)


if __name__ == '__main__': unittest.main()
