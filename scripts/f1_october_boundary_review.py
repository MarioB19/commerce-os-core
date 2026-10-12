"""Pure revision13 boundary correction; no economic adoption or quota changes.

Constants are tied to originals by the accompanying evidence producer. The
24-hour uncertainty reserve remains; no present absence or deletion is inferred.
"""
import datetime as dt
from decimal import Decimal as D, localcontext
from f1_billing_calendar import UTC, billing_month, month_bounds, month_hours

PRIOR_GROSS = '99.80522246686234811677679811982547090383461664234'
REPORTED_BYTES = 15967372648
REPORTED_GIB_HOURS_TO_UTC_END = '8038.496672238462'
EXPORT_BYTES = 2**30 + 65536


def review():
    with localcontext() as ctx:
        ctx.prec = 70
        return _review()


def _review():
    start, end = month_bounds('2026-10')
    prior_end = dt.datetime(2026, 11, 1, tzinfo=UTC)
    anchor = dt.datetime(2026, 10, 10, 20, 50, 6, tzinfo=UTC)
    anchor_hours = D(str((end-anchor).total_seconds()))/3600
    assert anchor_hours == D('514.165') and month_hours('2026-10') == 744
    inventory_gib = D(REPORTED_BYTES)/2**30
    maximum_gib = D(EXPORT_BYTES)/2**30
    extra_hours = D(str((end-prior_end).total_seconds()))/3600
    # F1 started after 12:43. Midnight is an earlier conservative bound, not
    # a manufactured native event. Future ordinary slots are still unchanged.
    starts = [dt.datetime(2026, 10, day, 6, 45, tzinfo=UTC) for day in range(12, 32)]
    starts.append(dt.datetime(2026, 10, 11, tzinfo=UTC))
    future_hours = sum(D(str((end-at).total_seconds()))/3600 for at in starts)
    supplement = dt.datetime(2026, 11, 1, 6, 45, tzinfo=UTC)
    supplement_hours = D(str((end-supplement).total_seconds()))/3600
    storage = {
        'historical_to_old_utc_boundary': D(REPORTED_GIB_HOURS_TO_UTC_END),
        'historical_boundary_extension': inventory_gib*extra_hours,
        'historical_lag_24h': inventory_gib*24,
        'ordinary_and_f1_future_to_pacific_boundary': future_hours*maximum_gib,
        'ordinary_and_f1_future_lag_24h_each': len(starts)*24*maximum_gib,
        'supplement_before_boundary_plus_lag_24h': (supplement_hours+24)*maximum_gib,
    }
    used = sum(storage.values())
    storage_reserve = D(20*744)
    assert used < storage_reserve
    # A full 1920-second attempt is retained in October, despite the maximum
    # 15 minutes before its boundary. No portion of November's reserve is freed.
    parts = {
        'b02_whole_attempt_1920s': D(1920)*(2*D('.000018')+8*D('.000002')),
        'b02_25_class_a': D(25)*D('.000005'),
        'b02_100_class_b': D(100)*D('.0000004'),
        'b02_64kib_logs': D(65536)/2**30*D('.5'),
    }
    extra = sum(parts.values())*D('1.16')
    total = D(PRIOR_GROSS)+extra
    return {
        'schema_version': 1, 'state': 'OCTOBER_PACIFIC_BOUNDARY_REVIEW_ONLY',
        'billing_timezone': 'America/Los_Angeles', 'october_hours': 744,
        'october_start_utc': start.isoformat(), 'october_end_utc': end.isoformat(),
        'original_compute_anchor_utc': anchor.isoformat(), 'original_remaining_hours': str(anchor_hours),
        'compute_pd_ip_boundary_added_gross_usd': '0',
        'reason_compute_not_added': 'ORIGINAL_514_165_HOURS_ALREADY_END_AT_PACIFIC_BOUNDARY',
        'supplement_slot_utc': supplement.isoformat(), 'supplement_usage_month': billing_month(supplement),
        'supplement_seconds_reserved_in_october': 1920, 'all_november_reserves_kept': True,
        'additional_prevat_usd': {k:format(v,'f') for k,v in parts.items()},
        'vat_multiplier': '1.16', 'additional_gross_usd': format(extra,'f'),
        'prior_gross_usd': PRIOR_GROSS, 'proposed_gross_usd': format(total,'f'),
        'margin_gross_usd': format(D(100)-total,'f'), 'within_100': total<=100,
        'b02_storage_gib_hours': {k:format(v,'f') for k,v in storage.items()},
        'b02_storage_total_gib_hours': format(used,'f'),
        'b02_storage_reserved_gib_hours': format(storage_reserve,'f'),
        'b02_storage_remaining_gib_hours': format(storage_reserve-used,'f'),
        'fixed_monthly_pools_unchanged': {'internet_gib':30,'cross_region_gib':50,'logging_gib':5,
            'operations_prevat_usd':'2','ingress_prevat_usd':'2','mail_prevat_usd':'2',
            'monitor_prevat_usd':'1','restore_prevat_usd':'1','registry_gib':10},
        'monthly_pool_bytes_still_require_native_admission': True,
        'new_recovery_or_egress_authorized': False, 'lag_reduced': False,
        'retained_inventory_released_bytes': 0, 'all_prior_reserves_preserved': True,
        'native_effects': 0, 'production_authorized': False, 'quota_changed': False,
        'unresolved_gates': ['OCTOBER_ECONOMIC_ADOPTION', 'FRESH_BILLING_REANCHOR',
            'NOVEMBER_DECEMBER_COMPLETE_ENVELOPES', 'CANONICAL_SUPPLEMENT_ADMISSION'],
    }
