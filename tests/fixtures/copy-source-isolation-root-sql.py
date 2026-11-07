"""Synthetic-only bridge: exercises the production pure core, never Root CLI."""
from pathlib import Path
import sys
import datetime as dt
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from copy_source_isolation_root import (parse, validate_control, validate_billing, validate_human,
    sql_payload, transaction_sql, require)
value = parse(sys.stdin.buffer.read(65537))
control = validate_control(value['control'])
billing = bytes.fromhex(value['billing_hex'])
# The synthetic driver observes the same PostgreSQL clock as its evidence.
# Host/VM skew must not fabricate either stale or future human attestations.
now = dt.datetime.fromisoformat(value['observed_at'].replace('Z', '+00:00'))
technical = validate_billing(billing, control['billing_ref'], now, expected_actor='synthetic-billing@example.invalid')
human = None
if control['action'] == 'finalize':
    require('human_hex' in value and 'message_hex' in value, 'ISOLATION_HUMAN_REQUIRED_FOR_FINALIZE')
    human = validate_human(bytes.fromhex(value['human_hex']), control['human_ref'],
                           bytes.fromhex(value['message_hex']), control, now)
print(transaction_sql(sql_payload(control, technical, human)))
