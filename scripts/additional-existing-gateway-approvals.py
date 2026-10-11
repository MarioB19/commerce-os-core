#!/usr/bin/env python3
"""Capture, observe and explicitly seal the installed slot-3 provisioning/adoption."""
import argparse
import json
import os
import re
import sys
import time
import additional_existing_gateway as approvals
from ci_release import ReleaseError


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    for name,args in {
        'capture':('review_id','backup_ref_file','tools_ref_file'),
        'observe':('review_id','run_id','operation_id','pilot_env','administrator_config'),
        'seal':('review_id','observation_sha256'),
        'credentials-observe':('review_id','operation_id','administrator_config'),
        'credentials-seal':('review_id','observation_sha256'),
        'adoption-observe':('review_id','run_id','pilot_approval_ref_file'),
        'adoption-seal':('review_id','observation_sha256'),
    }.items():
        command=commands.add_parser(name)
        for argument in args:command.add_argument(argument)
    values=vars(parser.parse_args());action=values.pop('command');os.umask(0o077)
    with approvals.runtime.deadline_fuse(time.monotonic()+900):
        adapter=approvals.AdoptionNative() if action.startswith('adoption-') else approvals.Native()
        result=getattr(approvals,action.replace('-','_'))(adapter,*values.values())
    print(json.dumps(result,sort_keys=True))


if __name__=='__main__':
    try:main()
    except (Exception,KeyboardInterrupt) as error:
        code=str(error) if isinstance(error,ReleaseError) and re.fullmatch(r'[A-Z0-9_]{1,100}',str(error)) else type(error).__name__
        print(json.dumps({'status':'FAILED','error':code}),file=sys.stderr)
        raise SystemExit(1)
