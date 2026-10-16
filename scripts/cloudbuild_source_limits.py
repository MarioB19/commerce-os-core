"""Bounds for trusted source acquisition; never executes a candidate command."""
from contextvars import ContextVar
from dataclasses import dataclass
import os
from pathlib import Path
import resource
import selectors
import signal
import stat
import subprocess
import sys
import time
from cloudbuild_full_evidence import EvidenceError, need

MAX_WALL_SECONDS = 420
MAX_CPU_SECONDS = 180
MAX_STORAGE_BYTES = 1024 * 1024 * 1024
MAX_PROCESS_RSS_BYTES = 512 * 1024 * 1024
MAX_CHILD_ADDRESS_BYTES = 384 * 1024 * 1024
MAX_CHILD_FILE_BYTES = 200 * 1024 * 1024
MAX_STDOUT_BYTES = 4 * 1024 * 1024
MAX_STDERR_BYTES = 64 * 1024
CURRENT = ContextVar('commerce_source_acquisition', default=None)
# Limits are installed by a fresh trusted Python process before exec. Avoid
# preexec_fn in the HTTP server's threaded process. Tokens stay in env, not argv.
LAUNCHER = '''import os,resource,sys
resource.setrlimit(resource.RLIMIT_CPU,(120,120))
resource.setrlimit(resource.RLIMIT_FSIZE,(209715200,209715200))
resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
if sys.platform=='linux':resource.setrlimit(resource.RLIMIT_AS,(402653184,402653184))
os.execvpe(sys.argv[1],sys.argv[1:],os.environ)
'''


def children_cpu():
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return usage.ru_utime + usage.ru_stime


def storage_bytes(root):
    total = 0
    for folder, directories, files in os.walk(root, followlinks=False):
        for name in [*directories, *files]:
            path = Path(folder) / name
            try: value = path.lstat()
            except FileNotFoundError: continue  # Git atomically renames its own temp files.
            need(stat.S_ISDIR(value.st_mode) or (stat.S_ISREG(value.st_mode) and value.st_nlink == 1),
                 'SOURCE_STORAGE_LINK_OR_DEVICE')
            if stat.S_ISREG(value.st_mode): total += value.st_size
            need(total <= MAX_STORAGE_BYTES, 'SOURCE_STORAGE_LIMIT')
    return total


def linux_group_usage(group):
    """Read only counters for this newly created process group; no argv/env."""
    if sys.platform != 'linux': return 0.0, 0
    cpu = 0.0; memory = 0; ticks = os.sysconf('SC_CLK_TCK'); page = os.sysconf('SC_PAGE_SIZE')
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit(): continue
        try:
            raw = (entry / 'stat').read_text()
            fields = raw.rsplit(')', 1)[1].split()
            if int(fields[2]) != group: continue
            # Own utime/stime plus already waited-for descendants. An active
            # descendant's counters remain separate. Race overcount is safe.
            cpu += sum(int(fields[i]) for i in (11, 12, 13, 14)) / ticks
            memory += max(0, int(fields[21])) * page
        except (FileNotFoundError, ProcessLookupError): continue
    return cpu, memory


class AcquisitionBudget:
    def __init__(self, root):
        self.root = Path(root); self.start = time.monotonic(); self.parent_start = time.process_time()
        self.children_start = children_cpu(); self.peak_storage = 0; self.peak_child_rss = 0
        self.cpu_seconds = 0.0
        self.last_storage_check = float('-inf')

    def check(self, group=None, *, force_storage=False):
        moment = time.monotonic()
        active_cpu, active_rss = linux_group_usage(group) if group is not None else (0.0, 0)
        self.cpu_seconds = time.process_time() - self.parent_start + children_cpu() - self.children_start + active_cpu
        if force_storage or moment - self.last_storage_check >= 0.1:
            self.peak_storage = max(self.peak_storage, storage_bytes(self.root))
            self.last_storage_check = moment
        self.peak_child_rss = max(self.peak_child_rss, active_rss)
        need(time.monotonic() - self.start <= MAX_WALL_SECONDS, 'SOURCE_WALL_LIMIT')
        need(self.cpu_seconds <= MAX_CPU_SECONDS, 'SOURCE_CPU_LIMIT')
        need(active_rss <= MAX_PROCESS_RSS_BYTES, 'SOURCE_PROCESS_MEMORY_LIMIT')

    def receipt(self):
        self.check(force_storage=True)
        return {'wall_seconds': round(time.monotonic() - self.start, 6),
                'cpu_seconds': round(self.cpu_seconds, 6), 'peak_storage_bytes': self.peak_storage,
                'peak_observed_child_rss_bytes': self.peak_child_rss,
                'linux_child_memory_limits_enforced': sys.platform == 'linux',
                'live_group_cpu_monitoring_enforced': sys.platform == 'linux',
                'limits': {'wall_seconds': MAX_WALL_SECONDS, 'cpu_seconds': MAX_CPU_SECONDS,
                           'storage_bytes': MAX_STORAGE_BYTES, 'child_group_rss_bytes': MAX_PROCESS_RSS_BYTES,
                           'child_address_bytes': MAX_CHILD_ADDRESS_BYTES, 'child_file_bytes': MAX_CHILD_FILE_BYTES},
                'process_poll_interval_seconds': 0.05,
                'storage_sampling_target_seconds': 0.1,
                'storage_is_sampled_not_network_byte_cap': True}


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: bytes


def run_git(command, *, cwd, environment):
    budget = CURRENT.get()
    own_budget = budget is None
    if own_budget: budget = AcquisitionBudget(cwd)
    budget.check()
    process = subprocess.Popen([sys.executable, '-I', '-S', '-c', LAUNCHER, *command], cwd=cwd,
                               env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True)
    output = bytearray(); errors = 0; selected = selectors.DefaultSelector()
    selected.register(process.stdout, selectors.EVENT_READ, 'stdout')
    selected.register(process.stderr, selectors.EVENT_READ, 'stderr')
    try:
        while selected.get_map() or process.poll() is None:
            budget.check(process.pid)
            for key, _events in selected.select(timeout=0.05):
                data = os.read(key.fd, 64 * 1024)
                if not data: selected.unregister(key.fileobj); continue
                if key.data == 'stdout':
                    need(len(output) + len(data) <= MAX_STDOUT_BYTES, 'SOURCE_STDOUT_LIMIT'); output.extend(data)
                else:
                    errors += len(data); need(errors <= MAX_STDERR_BYTES, 'SOURCE_STDERR_LIMIT')
        result = process.wait(timeout=1); budget.check()
        return ProcessResult(result, bytes(output))
    except BaseException:
        # Terminate only this newly created Git process group, including helper
        # processes. Evidence files and all unrelated processes are retained.
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        process.wait(timeout=5)
        raise
    finally:
        selected.close(); process.stdout.close(); process.stderr.close()


class LimitedWriter:
    def __init__(self, stream, maximum): self.stream = stream; self.maximum = maximum; self.written = 0
    def write(self, data):
        need(self.written + len(data) <= self.maximum, 'SOURCE_ARCHIVE_SIZE_REQUIRES_ADMISSION')
        budget = CURRENT.get()
        if budget is not None: budget.check()
        count = self.stream.write(data); self.written += count; return count
    def flush(self): return self.stream.flush()
    def tell(self): return self.written


class BudgetReader:
    def __init__(self, stream): self.stream = stream
    def read(self, size=-1):
        budget = CURRENT.get()
        if budget is not None: budget.check()
        return self.stream.read(size)
    def seek(self, *args): return self.stream.seek(*args)
    def tell(self): return self.stream.tell()
