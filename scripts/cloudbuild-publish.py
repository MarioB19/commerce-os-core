#!/usr/bin/env python3
"""Fixed native publisher entrypoint. No candidate code or environment selection."""
import json
import os
from pathlib import Path
import signal
import sys

if Path(__file__) != Path('/opt/trusted/cloudbuild-publish.py') or Path(__file__).is_symlink():
    raise SystemExit('PUBLISHER_INSTALLED_PATH_REQUIRED')
sys.path.insert(0, '/opt/trusted')
from cloudbuild_publisher_worker import PublisherWorker

if len(sys.argv) != 3 or sys.argv[1] != '--publisher-build-id':
    raise SystemExit('PUBLISHER_NATIVE_UUID_ARGUMENT_REQUIRED')

def expired(_signal, _frame):
    raise TimeoutError('PUBLISHER_GLOBAL_DEADLINE')

signal.signal(signal.SIGALRM, expired)
signal.alarm(895)
os.umask(0o077)
try:
    result = PublisherWorker.installed().run(sys.argv[2])
    print(json.dumps(result, sort_keys=True, separators=(',', ':'), allow_nan=False))
except Exception:
    print(json.dumps({'status': 'PUBLISHER_STOP_PRESERVE', 'automatic_retry': False, 'installation_proven': False}))
    raise SystemExit(2) from None
finally:
    signal.alarm(0)
