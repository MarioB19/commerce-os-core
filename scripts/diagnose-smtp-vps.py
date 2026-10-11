#!/usr/bin/env python3
"""Read-only VM SMTP diagnostics: no AUTH/MAIL/RCPT/DATA, no secrets printed.
Run on the VM. Output is safe to retain; do not substitute this for delivery verification.
"""
import concurrent.futures
import json
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import time


def probe(target):
    host, port = target
    start = time.monotonic()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(5)
    result = {'host': host, 'port': port}
    try:
        sock.connect((socket.gethostbyname(host), port))
        if port == 465:
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        result.update(connected=True, greeting_220=sock.recv(512).startswith(b'220'))
    except Exception as error:
        result.update(connected=False, error=type(error).__name__)
    finally:
        sock.close()
    result['elapsed_seconds'] = round(time.monotonic()-start, 2)
    return result


def main():
    targets = [('gmail-smtp-in.l.google.com', 25), ('alt1.gmail-smtp-in.l.google.com', 25), ('smtp.hostinger.com', 587), ('smtp.hostinger.com', 465)]
    listeners = subprocess.run(['ss', '-lnt'], capture_output=True, text=True, check=True).stdout
    # Only presence of SMTP-related configuration is inspected. No values or addresses returned.
    key_count = 0
    for path in Path('/opt/commerce-os/private').glob('**/*.env'):
        try:
            for line in path.read_text().splitlines():
                name = line.partition('=')[0]
                if re.search(r'^(SMTP_|MAIL_HOST|MAIL_PORT|MAIL_USER|MAIL_PASSWORD)', name):
                    key_count += 1
        except (PermissionError, OSError):
            pass
    with concurrent.futures.ThreadPoolExecutor(4) as workers:
        checks = list(workers.map(probe, targets))
    print(json.dumps({'postfix_present': bool(shutil.which('postconf')), 'exim_present': bool(shutil.which('exim')),
                      'smtp_listener_present': bool(re.search(r':(?:25|465|587)\s', listeners)),
                      'smtp_config_key_count': key_count, 'checks': checks, 'mail_sent': False}, indent=2))


if __name__ == '__main__':
    main()
