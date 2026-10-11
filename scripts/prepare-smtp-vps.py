#!/usr/bin/env python3
"""Render an uninstalled, send-only Postfix configuration. Never touches /etc/network/DNS.
Inputs are explicit; output is a NEW private directory. No keys are generated here.
"""
import argparse
import ipaddress
import re
from pathlib import Path


def render(hostname, bind, clients, sender):
    if not re.fullmatch(r'[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', hostname):
        raise ValueError('FQDN_REQUIRED')
    binding = ipaddress.ip_address(bind)
    approved = [ipaddress.ip_address(item) for item in clients]
    if binding.version != 4 or not binding.is_private or binding.is_unspecified:
        raise ValueError('EXPLICIT_PRIVATE_BIND_REQUIRED')
    if not approved or any(ip.version != 4 or not ip.is_private or ip.is_unspecified for ip in approved):
        raise ValueError('EXPLICIT_PRIVATE_CLIENTS_REQUIRED')
    if not re.fullmatch(r'[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', sender):
        raise ValueError('CONTROLLED_SENDER_REQUIRED')
    networks = ', '.join(str(ip) + '/32' for ip in approved)
    return f'''# Prepared only. Requires successful TCP25 preflight and approved sender/DNS/DKIM.
myhostname = {hostname}
myorigin = {sender.split('@')[1]}
inet_interfaces = {bind}
inet_protocols = ipv4
mynetworks = {networks}
mydestination =
relay_domains =
relayhost =
smtpd_relay_restrictions = permit_mynetworks, reject
smtpd_client_restrictions = permit_mynetworks, reject
smtpd_sender_restrictions = check_sender_access hash:/etc/postfix/commerce-senders, reject
smtpd_recipient_restrictions = reject_non_fqdn_recipient, reject_unknown_recipient_domain
smtpd_sasl_auth_enable = no
disable_vrfy_command = yes
smtpd_helo_required = yes
smtpd_delay_reject = no
local_transport = error:Local delivery disabled
message_size_limit = 131072
smtpd_client_connection_count_limit = 5
smtpd_client_connection_rate_limit = 30
smtpd_client_message_rate_limit = 20
smtpd_client_recipient_rate_limit = 20
maximal_queue_lifetime = 5m
bounce_queue_lifetime = 5m
minimal_backoff_time = 60s
maximal_backoff_time = 120s
queue_run_delay = 60s
smtp_connect_timeout = 5s
smtp_helo_timeout = 10s
smtp_data_xfer_timeout = 30s
smtp_tls_security_level = may
smtp_tls_loglevel = 0
smtpd_milters = inet:127.0.0.1:8891
non_smtpd_milters = $smtpd_milters
milter_default_action = tempfail
milter_protocol = 6
''', f'{sender} OK\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hostname', required=True)
    parser.add_argument('--bind', required=True)
    parser.add_argument('--client', action='append', required=True)
    parser.add_argument('--sender', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    main_cf, senders = render(args.hostname, args.bind, args.client, args.sender)
    args.output.mkdir(mode=0o700, parents=False, exist_ok=False)
    for name, text in [('main.cf', main_cf), ('commerce-senders', senders)]:
        path = args.output / name
        path.write_text(text)
        path.chmod(0o600)
    print('Prepared private Postfix files; not installed, no mail sent, no DNS/network changes.')


if __name__ == '__main__':
    main()
