#!/usr/bin/env python3
"""Read native bootstrap evidence; publish a GitHub commit status only with --publish.

Run from a reviewed, trusted local checkout, never as a candidate build step.
The local manifest seals source/configuration before submission and binds the
returned build identity afterward. It is not candidate-provided attestation.
No GitHub credential is sent to Cloud Build.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys

# Also supports importlib consumers that load this CLI by absolute path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cloudbuild_full_evidence import (REPOSITORY, PROJECT, GATE, STAGES,
    STEP_DEFAULTS, STEP_OUTPUTS, OPTION_DEFAULTS, EvidenceError, need,
    canonical_hash, digest, validate_manifest, source, expanded, normalize_step,
    validate_native, receipts_from_logs, validate_full_receipt, log_filter,
    evaluate_reader)

import operator_identity


def load_manifest(path):
    need(path.is_file() and not path.is_symlink(), 'TRUSTED_MANIFEST_REQUIRED')
    need(path.stat().st_size <= 1024*1024, 'MANIFEST_TOO_LARGE')
    manifest = json.loads(path.read_text())
    validate_manifest(manifest)
    return manifest


def run_json(argv, data=None):
    result = subprocess.run(argv, input=None if data is None else json.dumps(data),
                            text=True, capture_output=True, timeout=90)
    need(result.returncode == 0, 'EXTERNAL_COMMAND_FAILED')
    return json.loads(result.stdout)


class CliFullReader:
    def __init__(self, gcloud, runner):
        self.gcloud = gcloud
        self.runner = runner
        self.common = ['--project='+PROJECT, '--account='+operator_identity.local_account('cloud_build'), '--format=json']

    def project(self):
        return self.runner([self.gcloud, 'projects', 'describe', PROJECT, *self.common])

    def commit(self, m):
        return self.runner(['gh', 'api', 'repos/'+REPOSITORY+'/git/commits/'+m['source_sha']])

    def build(self, m):
        return self.runner([self.gcloud, 'builds', 'describe', m['build_id'], '--region='+m['region'], *self.common])

    def logs(self, m):
        # gcloud otherwise defaults to one day. This does not extend retention.
        return self.runner([self.gcloud, 'logging', 'read', log_filter(m),
                            '--freshness=90d', '--limit=100', *self.common])


def evaluate(m, gcloud, runner=run_json):
    return evaluate_reader(m, CliFullReader(gcloud, runner))


def publish(m, payload, runner=run_json):
    # This is deliberately a commit status, not a GitHub App check run.
    endpoint = 'repos/'+REPOSITORY+'/statuses/'+m['source_sha']
    result = runner(['gh', 'api', '--method', 'POST', endpoint, '--input', '-'], payload)
    need(type(result.get('id')) is int and result['id'] > 0, 'PUBLISHED_STATUS_ID_MISSING')
    rows = runner(['gh', 'api', 'repos/'+REPOSITORY+'/commits/'+m['source_sha']+'/statuses?per_page=100'])
    need(isinstance(rows, list), 'PUBLISHED_STATUS_READBACK_MISSING')
    matches = [row for row in rows if row.get('id') == result['id']]
    need(len(matches) == 1 and all(matches[0].get(key) == value for key, value in payload.items()),
         'PUBLISHED_STATUS_READBACK_MISMATCH')
    return result['id']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--gcloud', default='gcloud')
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    attempted = False
    try:
        manifest = load_manifest(args.manifest)
        payload = evaluate(manifest, args.gcloud)
        if args.publish:
            # All trust checks run immediately before the one explicit mutation.
            attempted = True
            publish(manifest, payload)
        print(json.dumps({'source_sha': manifest['source_sha'], 'build_id': manifest['build_id'],
                          'published': args.publish, 'commit_status': payload}, sort_keys=True))
        return 0 if payload['state'] == 'success' else 1
    except (EvidenceError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, EvidenceError) else type(error).__name__
        print(json.dumps({'published': None if attempted else False,
                          'publication_attempted': attempted,
                          'status': 'OUTCOME_UNKNOWN' if attempted else 'EVIDENCE_REJECTED', 'code': code}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
