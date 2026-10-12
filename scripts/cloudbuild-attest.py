#!/usr/bin/env python3
"""Immutable attestor entrypoint. Candidate checkout is never imported."""
import json
from pathlib import Path
import re
import sys

# -I excludes the script directory; only this fixed, image-owned path is added.
if Path(__file__).resolve() != Path('/opt/trusted/cloudbuild-attest.py'):
    raise SystemExit('ATTESTOR_INSTALLED_PATH_REQUIRED')
sys.path.insert(0, '/opt/trusted')
from cloudbuild_runtime import RuntimeFactory

if len(sys.argv) != 3 or sys.argv[1] != '--gate-build-id':
    raise SystemExit('ATTESTOR_NATIVE_UUID_ARGUMENT_REQUIRED')
try:
    receipt = RuntimeFactory.from_installed_config().run_attestor(sys.argv[2])
    print(json.dumps(receipt, sort_keys=True, separators=(',', ':'), allow_nan=False))
except Exception as error:
    message = str(error)
    raise SystemExit(message if re.fullmatch('[A-Z][A-Z0-9_]{0,119}', message) else 'ATTESTOR_FAILED_PRESERVE') from None
