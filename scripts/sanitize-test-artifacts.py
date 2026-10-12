#!/usr/bin/env python3
"""Redact existing local test credentials from reports, including Playwright's ZIP.
Reads private configuration in memory; prints counts only, never credential values.
Run after each browser suite, before retaining or sharing its artifacts.
"""
from pathlib import Path
import base64
import io
import json
import os
import re
import zipfile

PRIVATE = Path(os.environ.get('COMMERCE_CONFIG_DIR', Path.home() / '.config' / 'commerce-os-local'))
VALUES = set()
for config in PRIVATE.glob('*.env'):
    for line in config.read_text().splitlines():
        if '=' not in line or line.lstrip().startswith('#'):
            continue
        name, value = line.split('=', 1)
        value = value.strip().strip('"').strip("'")
        if len(value) >= 8 and re.search(r'TOKEN|PASSWORD|SECRET|ENCRYPTION_KEY|DATABASE_URL|API_KEY', name) and not re.search(r'(?:_DIR|_PATH|_FILE)$', name):
            VALUES.add(value.encode())

counts = {'files_checked': 0, 'files_redacted': 0, 'embedded_members_checked': 0, 'embedded_members_redacted': 0, 'sensitive_occurrences_redacted': 0, 'entered_value_titles_redacted': 0}

def redact(data):
    for signature in [rb'(?<![A-Za-z0-9_])cos_(?:v5_|pat_)?[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])', rb'\bEAA[A-Za-z0-9]{40,}\b']:
        found = len(re.findall(signature, data))
        if found:
            counts['sensitive_occurrences_redacted'] += found
            data = re.sub(signature, b'[REDACTED]', data)
    for value in VALUES:
        found = data.count(value)
        if found:
            counts['sensitive_occurrences_redacted'] += found
            data = data.replace(value, b'[REDACTED]')
    return data

for directory in [Path('test-results'), Path('playwright-report'), Path(os.environ.get('COMMERCE_TEST_EVIDENCE_DIR') or 'test-evidence')]:
    for path in directory.rglob('*'):
        if not path.is_file() or path.suffix not in {'.html', '.md', '.json', '.txt', '.log'}:
            continue
        original = path.read_bytes()
        counts['files_checked'] += 1
        data = redact(original)
        match = re.search(rb'<template id="playwrightReportBase64">data:application/zip;base64,\s*([A-Za-z0-9+/=\s]+)</template>', data)
        if match:
            archive_bytes = io.BytesIO(base64.b64decode(match.group(1)))
            output = io.BytesIO()
            changed = False
            with zipfile.ZipFile(archive_bytes) as source, zipfile.ZipFile(output, 'w') as target:
                for info in source.infolist():
                    content = source.read(info)
                    counts['embedded_members_checked'] += 1
                    clean = redact(content)
                    # The Playwright reporter embeds values in Fill step titles,
                    # even after the input is cleared. Remove all entered values
                    # so credentials rotated before cleanup are protected too.
                    if info.filename.endswith('.json'):
                        payload = json.loads(clean)
                        changed_titles = [False]
                        def clean_steps(value):
                            if isinstance(value, dict):
                                for key, item in value.items():
                                    if key == 'title' and isinstance(item, str) and item.startswith('Fill ') and item != 'Fill [REDACTED]':
                                        value[key] = 'Fill [REDACTED]'
                                        changed_titles[0] = True
                                        counts['entered_value_titles_redacted'] += 1
                                    else:
                                        clean_steps(item)
                            elif isinstance(value, list):
                                for item in value:
                                    clean_steps(item)
                        clean_steps(payload)
                        if changed_titles[0]:
                            clean = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
                    if clean != content:
                        counts['embedded_members_redacted'] += 1
                        changed = True
                    target.writestr(info, clean)
            if changed:
                data = data[:match.start(1)] + base64.b64encode(output.getvalue()) + data[match.end(1):]
        if data != original:
            pending = path.with_name(path.name + '.redacting')
            pending.write_bytes(data)
            pending.replace(path)
            counts['files_redacted'] += 1
print(json.dumps(counts))
