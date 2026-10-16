"""Complete fixed Nov/Dec proposal. Pure math; no native permission or deletion.

The historical inventory is a documented native report, not a fresh inventory
or a claim of current size. Caller-provided prices or discounts are forbidden.
"""
from decimal import Decimal as D, ROUND_CEILING, localcontext
import b02_quota_coverage as coverage
from f1_billing_calendar import month_bounds, month_hours, billing_month
import f1_october_boundary_review as october

GIB = 2**30
EXPORT_BYTES = GIB + 65536
REPORTED_B02_BYTES = 15967372648
AFTER_REPORTED_OCTOBER_STARTS = 21
RATE = {
    'compute_hour': D('0.067011419815'), 'disk_gib_hour': D('0.000054795'),
    'ip_hour': D('0.005'), 'gcs_gib_hour': D('0.000027397'),
    'snapshot_gib_hour': D('0.000068493'), 'build_minute': D('0.006'),
    'run_vcpu_second': D('0.000024'), 'run_gib_second': D('0.0000025'),
    'run_request': D('0.0000004'), 'job_vcpu_second': D('0.000018'),
    'job_gib_second': D('0.000002'), 'gcs_class_a': D('0.000005'),
    'gcs_class_b': D('0.0000004'), 'vat_multiplier': D('1.16'),
}
SUPPLEMENT_RATES = dict(vcpu_second='0.000018', gib_second='0.000002', storage_gib_month='0.02',
    cross_region_gib='0.02', internet_gib='0.12', class_a_thousand='0.005',
    class_b_thousand='0.0004', logs_gib='0.50', tax_multiplier='1.16')


def up(value):
    return value.quantize(D('0.000000001'), rounding=ROUND_CEILING)


def text(value):
    return format(up(value), 'f')


def model():
    """Never accepts an October total, a credit or a release of retained bytes."""
    with localcontext() as ctx:
        ctx.prec = 60
        return _model()


def _model():
    supplement = coverage.reserve_supplement([x.isoformat() for x in coverage.NOVEMBER_SLOTS],
        monthly_totals={'2026-11': '0', '2026-12': '0'}, rates=SUPPLEMENT_RATES,
        maximum_export_bytes=EXPORT_BYTES)
    result = {}
    for month, days, regular_starts, accumulated_regular in [('2026-11', 30, 28, 28), ('2026-12', 31, 31, 59)]:
        hours = D(month_hours(month))
        start, end = month_bounds(month)
        # Preserve old inventory and every possible future regular export. The
        # three supplement objects are added separately by reserve_supplement.
        b02_bytes = REPORTED_B02_BYTES + (AFTER_REPORTED_OCTOBER_STARTS + accumulated_regular)*EXPORT_BYTES
        b02_gib = D(b02_bytes)/GIB
        gcs_gib = D(40) + max(D(20), b02_gib)
        auxiliary_storage = hours*D('8.171875')*RATE['gcs_gib_hour']
        operation_parts = {
            'runtime_execution': D(20000)*RATE['run_vcpu_second'] + D(40000)*RATE['run_gib_second'],
            'startup_rejected_cleanup': D(12000)*RATE['run_vcpu_second'] + D(24000)*RATE['run_gib_second'],
            'runtime_requests': D(2000)*RATE['run_request'],
            'gcs_operations': D(10000)*RATE['gcs_class_a'] + D(100000)*RATE['gcs_class_b'],
            'auxiliary_storage_above_existing_source_005': max(D(0), auxiliary_storage-D('.05')),
            'runtime_scheduler': D('.10'), 'publisher_secret': D('.091150848'),
            # Preserve the allocation for setup/IAM/history rather than reuse it.
            'other_protected_operations': D('.000030')+D('.000125')+D('.000060')+D('.000125')+D('.000750'),
        }
        operating = sum(up(v) for v in operation_parts.values())
        coverage.need(operating <= 2, 'FUTURE_OPERATIONS_RESERVE_EXCEEDED')
        parts = {
            'compute_e2_standard2': hours*RATE['compute_hour'],
            'pd_standard_100gib': hours*100*RATE['disk_gib_hour'],
            'ipv4': hours*RATE['ip_hour'],
            'gcs_preserved40gib_and_b02_retained': hours*gcs_gib*RATE['gcs_gib_hour'],
            'snapshot_regional_20gib': hours*20*RATE['snapshot_gib_hour'],
            'internet_30gib': D('3.6'), 'cross_region_50gib': D('1'),
            'ingress': D(2), 'pubsub': D(1), 'operations_including_operating': D(2),
            'registry_10gib': D(1), 'ci_420minutes': 420*RATE['build_minute'],
            'mail_preserved_reference': D(2), 'logging_5gib': D('2.5'),
            'monitor': D(1), 'isolated_restore': D(1),
            'oauth_separate_preserved': D('.091150848'), 'source_storage_existing': D('.05'),
            'shadow_separate_preserved': D('.03'),
            'full24h_billing_lag': D(24)*(RATE['compute_hour']+100*RATE['disk_gib_hour']+RATE['ip_hour']),
            'b02_regular_compute_1920s': D(regular_starts*1920)*(2*RATE['job_vcpu_second']+8*RATE['job_gib_second']),
            'b02_scheduler': D('.1'), 'b02_contingency': D('.5'),
            'rollback_compute_95minutes': D('.228795371'),
            'cold_snapshot_100gib_24h_plus7d': 100*D(192)*RATE['snapshot_gib_hour'],
            # The older marginal proposal uses .02/GiB-month. A 31-day
            # calendar at the hourly tariff is larger; retain the difference.
            'supplement_storage_calendar_topup': 3*D(EXPORT_BYTES)/GIB*max(
                D(0), hours*RATE['gcs_gib_hour']-D('.02')),
        }
        # Round each published line upward, then compose the published lines.
        # This preserves exact conservation even at decimal boundary values.
        before_vat = sum(up(v) for v in parts.values())
        gross = up(before_vat*RATE['vat_multiplier'])
        marginal = D(supplement['monthly'][month]['marginal_gross_usd'])
        total = up(gross+marginal)
        result[month] = {
            'calendar_days': days, 'calendar_hours': int(hours),
            'period_start_utc': start.isoformat(), 'period_end_utc': end.isoformat(),
            'regular_b02_starts': regular_starts,
            'supplement_b02_starts': sum(billing_month(x)==month for x in coverage.NOVEMBER_SLOTS),
            'supplement_compute_attempts_reserved': 3 if month=='2026-11' else 0,
            'supplement_compute_whole_cross_boundary_attempt_retained': month=='2026-11',
            'b02_regular_retained_upper_bytes': b02_bytes,
            'retained_inventory_released_bytes': 0,
            'parts_prevat_usd': {k:text(v) for k,v in parts.items()},
            'operations_allocation_prevat_usd': {k:text(v) for k,v in operation_parts.items()},
            'operations_unallocated_prevat_usd': text(2-operating),
            'previous_gross_usd': text(gross), 'marginal_gross_usd': text(marginal),
            'total_gross_usd': text(total), 'margin_gross_usd': format(D(100)-total,'f'),
            'within_100': total<=100,
        }
    return {
        'schema_version': 2, 'state': 'FUTURE_MONTHLY_ENVELOPES_PROPOSAL_ONLY',
        'billing_timezone': 'America/Los_Angeles',
        'october_boundary_review': october.review(),
        'required_admission_months': ['2026-10','2026-11','2026-12'],
        'legacy_two_month_cost_estimate_is_not_admission': True,
        'months': result, 'ci_minutes_each_month': 420, 'actions_usd': 0, 'numbers_target': 20,
        'vat_multiplier': '1.16', 'credits_deducted': False, 'native_effects': 0,
        'all_months_within_100': all(x['within_100'] for x in result.values()),
        'production_authorized': False, 'october_partial_total_used': False,
        'native_absence_claimed': False, 'deletion_authorized': False,
        'wal_pitr_dr_capacity_proven': False, 'provider_billing_hard_cap_proven': False,
        'source_inventory': {'reported_bytes': REPORTED_B02_BYTES,
            'reported_at': '2026-10-11T12:43:00Z', 'source_kind': 'DOCUMENTED_NATIVE_REPORT_NOT_FRESH_READ',
            'future_october_exports_reserved': AFTER_REPORTED_OCTOBER_STARTS,
            'export_upper_bytes': EXPORT_BYTES},
        'retention': {'lifecycle_days': 30, 'soft_delete_days': 7, 'pitr_days': 7,
            'absence_required_before_storage_release': True, 'no_deletion_assumed_in_projection': True},
        'unresolved_gates': ['FRESH_COMPLETE_NORMAL_AND_SOFT_DELETED_INVENTORY',
            'NATIVE_ABSENCE_BEFORE_ANY_STORAGE_RELEASE', 'COMPRESSED_WAL_AND_REGIONAL_DR_MEASUREMENT',
            'AUXILIARY_RESOURCE_AND_RESPONSE_BYTE_ACCOUNTING', 'ACCOUNT_SKU_FX_TAX_REVALIDATION',
            'OCTOBER_PACIFIC_BOUNDARY_ADOPTION_AND_REANCHOR',
            'CANONICAL_THREE_MONTH_SUPPLEMENT_EXECUTION_ADMISSION'],
    }
