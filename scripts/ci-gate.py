#!/usr/bin/env python3
import importlib.util,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('changes',Path(__file__).with_name('ci-changes.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
ok=module.final_gate(os.environ.get('CHANGES_RESULT'),os.environ.get('VERIFY_RESULT'),os.environ.get('VERIFY_SCOPE'))
print('Commerce CI gate:', 'PASSED' if ok else 'FAILED (missing, cancelled, or failed required validation)')
sys.exit(0 if ok else 1)
