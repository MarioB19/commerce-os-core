"""Bound child logs and wall time; overflow fails the required stage.

Only the driver's owned process group is signalled. This does not prune Docker,
stop other services, suppress failures or treat truncated output as success.
"""
import os
import selectors
import signal
import subprocess
import sys
import time

STDOUT_LIMIT = 4 * 1024 * 1024
STDERR_LIMIT = 1024 * 1024


class LogLimitExceeded(RuntimeError):
    pass


def stop_group(process):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try: os.killpg(process.pid, sig)
        except ProcessLookupError: pass
        except PermissionError:
            raise RuntimeError('OWNED_PROCESS_GROUP_CLEANUP_UNCONFIRMED') from None
        try: process.wait(timeout=2)
        except subprocess.TimeoutExpired: pass
    process.wait(timeout=2)


def execute(argv, cwd, env, seconds, *, umask=0o022, stdout_limit=STDOUT_LIMIT,
            stderr_limit=STDERR_LIMIT, stdout=None, stderr=None):
    if type(seconds) not in (int, float) or not 0 < seconds <= 5700:
        raise ValueError('LOG_COMMAND_TIMEOUT_INVALID')
    if any(type(v) is not int or not 0 < v <= 4 * 1024 * 1024 for v in (stdout_limit, stderr_limit)):
        raise ValueError('LOG_COMMAND_BOUND_INVALID')
    sinks = {'stdout': stdout if stdout is not None else sys.stdout.buffer,
             'stderr': stderr if stderr is not None else sys.stderr.buffer}
    limits = {'stdout': stdout_limit, 'stderr': stderr_limit}; counts = dict.fromkeys(limits, 0)
    deadline = time.monotonic() + seconds
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, umask=umask)
    try:
        with selectors.DefaultSelector() as selector:
            for name in ('stdout', 'stderr'):
                stream = getattr(process, name); os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise subprocess.TimeoutExpired(argv, seconds)
                for event, _ in selector.select(min(.1, remaining)):
                    name = event.data
                    try: raw = os.read(event.fd, min(65536, limits[name] - counts[name] + 1))
                    except BlockingIOError: continue
                    if not raw:
                        selector.unregister(event.fileobj); event.fileobj.close(); continue
                    allowed = min(len(raw), limits[name] - counts[name])
                    if allowed:
                        sinks[name].write(raw[:allowed]); sinks[name].flush(); counts[name] += allowed
                    if allowed != len(raw):
                        raise LogLimitExceeded('REQUIRED_STAGE_' + name.upper() + '_LIMIT')
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise subprocess.TimeoutExpired(argv, seconds)
            return process.wait(timeout=remaining)
    except BaseException:
        stop_group(process)
        raise
    finally:
        for name in ('stdout', 'stderr'):
            stream = getattr(process, name)
            if not stream.closed: stream.close()
