#!/usr/bin/env python3
"""Linux Root only: observe package/runtime, then explicitly seal a reviewed digest."""
import argparse
import json
import os
import re
import sys
import time

from ci_release import ReleaseError
import copy_runtime_approvals as approvals
from copy_runtime_deployment import deadline_fuse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    observe = commands.add_parser('observe')
    for name in ('archive', 'archive_hash', 'source_sha', 'run_id', 'review_id'): observe.add_argument(name)
    seal = commands.add_parser('seal')
    seal.add_argument('review_id'); seal.add_argument('observation_sha256')
    args = parser.parse_args()
    os.umask(0o077)
    adapter = approvals.Native()
    with deadline_fuse(time.monotonic()+900):
        if args.command == 'observe':
            result = approvals.observe(adapter, args.archive, args.archive_hash, args.source_sha, args.run_id, args.review_id)
        else:
            result = approvals.seal(adapter, args.review_id, args.observation_sha256)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try: main()
    except (Exception, KeyboardInterrupt) as error:
        # Never emit private paths, SQL, provider bodies or arbitrary stderr.
        code = str(error) if isinstance(error, ReleaseError) and re.fullmatch(r'[A-Z0-9_]{1,100}', str(error)) else type(error).__name__
        print(json.dumps({'status': 'FAILED', 'error': code}), file=sys.stderr)
        raise SystemExit(1)
