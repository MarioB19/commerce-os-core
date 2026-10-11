import io
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_source_limits as m


class LimitsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}

    def run_child(self, source):
        return m.run_git([sys.executable, '-I', '-S', '-c', source],
                         cwd=self.root, environment=self.environment)

    def test_bounded_child_stdout_is_returned_and_stderr_not_retained(self):
        result = self.run_child("import sys; print('proof'); print('private diagnostic', file=sys.stderr)")
        self.assertEqual(result.returncode, 0); self.assertEqual(result.stdout, b'proof\n')
        self.assertNotIn('private', repr(result))

    def test_stdout_and_stderr_floods_close_operation(self):
        for target, constant, code in [(1, 'MAX_STDOUT_BYTES', 'SOURCE_STDOUT_LIMIT'),
                                       (2, 'MAX_STDERR_BYTES', 'SOURCE_STDERR_LIMIT')]:
            with self.subTest(target=target), patch.object(m, constant, 64):
                with self.assertRaisesRegex(m.EvidenceError, '^' + code + '$'):
                    self.run_child(f'import os; os.write({target}, b"x"*4096)')

    def test_wall_timeout_terminates_owned_process_and_preserves_evidence(self):
        (self.root / 'evidence').write_text('preserve')
        start = time.monotonic()
        with patch.object(m, 'MAX_WALL_SECONDS', 0.15):
            with self.assertRaisesRegex(m.EvidenceError, 'SOURCE_WALL_LIMIT'):
                self.run_child('import time; time.sleep(30)')
        self.assertLess(time.monotonic() - start, 5)
        self.assertEqual((self.root / 'evidence').read_text(), 'preserve')

    def test_storage_links_and_size_are_rejected(self):
        (self.root / 'file').write_bytes(b'x'*65)
        with patch.object(m, 'MAX_STORAGE_BYTES', 64):
            with self.assertRaisesRegex(m.EvidenceError, 'SOURCE_STORAGE_LIMIT'): m.storage_bytes(self.root)
        (self.root / 'link').symlink_to(self.root / 'file')
        with self.assertRaisesRegex(m.EvidenceError, 'SOURCE_STORAGE_LINK_OR_DEVICE'): m.storage_bytes(self.root)

    def test_cpu_and_process_rss_exceedance_are_rejected(self):
        for counters, code in [((m.MAX_CPU_SECONDS+1, 0), 'SOURCE_CPU_LIMIT'),
                               ((0, m.MAX_PROCESS_RSS_BYTES+1), 'SOURCE_PROCESS_MEMORY_LIMIT')]:
            budget = m.AcquisitionBudget(self.root)
            with patch.object(m, 'linux_group_usage', return_value=counters):
                with self.assertRaisesRegex(m.EvidenceError, code): budget.check(group=123)

    def test_writer_rejects_before_oversized_write_reaches_stream(self):
        output = io.BytesIO(); writer = m.LimitedWriter(output, 5)
        writer.write(b'abcd')
        with self.assertRaisesRegex(m.EvidenceError, 'SOURCE_ARCHIVE_SIZE_REQUIRES_ADMISSION'):
            writer.write(b'ef')
        self.assertEqual(output.getvalue(), b'abcd')

    def test_storage_scan_is_throttled_and_forced_for_final_receipt(self):
        budget = m.AcquisitionBudget(self.root)
        with patch.object(m, 'storage_bytes', return_value=10) as measure:
            budget.check(); budget.check(); budget.check(); self.assertEqual(measure.call_count, 1)
            receipt = budget.receipt(); self.assertEqual(measure.call_count, 2)
        self.assertTrue(receipt['storage_is_sampled_not_network_byte_cap'])


if __name__ == '__main__': unittest.main()
