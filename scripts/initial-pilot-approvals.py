#!/usr/bin/env python3
"""Capture real Root state, observe a canonical operation, explicitly seal its digest."""
import argparse
import json
import os
import re
import sys
import time
import initial_pilot_approvals as approvals
from ci_release import ReleaseError
from copy_runtime_deployment import deadline_fuse


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    capture=commands.add_parser('capture')
    for name in ('review_id','backup_ref_file','tools_ref_file'):capture.add_argument(name)
    observe=commands.add_parser('observe')
    for name in ('review_id','run_id','operation_id','pilot_env','administrator_config'):observe.add_argument(name)
    seal=commands.add_parser('seal')
    for name in ('review_id','observation_sha256'):seal.add_argument(name)
    args=vars(parser.parse_args()); action=args.pop('command')
    os.umask(0o077)
    with deadline_fuse(time.monotonic()+900):
        result=getattr(approvals,action)(approvals.Native(),*args.values())
    print(json.dumps(result,sort_keys=True))


if __name__=='__main__':
    try:main()
    except (Exception,KeyboardInterrupt) as error:
        code=str(error) if isinstance(error,ReleaseError) and re.fullmatch(r'[A-Z0-9_]{1,100}',str(error)) else type(error).__name__
        print(json.dumps({'status':'FAILED','error':code}),file=sys.stderr)
        raise SystemExit(1)
