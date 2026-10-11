#!/usr/bin/env python3
"""Observe a completed canonical pilot, then explicitly seal its Root/B02 adoption."""
import argparse
import json
import os
import re
import sys
import time
import initial_pilot_adoption_approvals as approvals
from ci_release import ReleaseError
from copy_runtime_deployment import deadline_fuse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    observe = commands.add_parser('observe')
    for name in ('review_id', 'run_id', 'pilot_approval_ref_file'): observe.add_argument(name)
    seal = commands.add_parser('seal')
    for name in ('review_id', 'observation_sha256'): seal.add_argument(name)
    args = vars(parser.parse_args()); action = args.pop('command')
    os.umask(0o077)
    with deadline_fuse(time.monotonic()+900):
        result = getattr(approvals, action)(approvals.Native(), *args.values())
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try: main()
    except (Exception, KeyboardInterrupt) as error:
        code = str(error) if isinstance(error, ReleaseError) and re.fullmatch(r'[A-Z0-9_]{1,100}', str(error)) else type(error).__name__
        print(json.dumps({'status': 'FAILED', 'error': code}), file=sys.stderr)
        raise SystemExit(1)
