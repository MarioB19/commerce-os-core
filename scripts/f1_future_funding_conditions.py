"""Conditional planning limits, not admission and not observed resource usage."""
from decimal import Decimal as D, ROUND_FLOOR, localcontext
import f1_future_monthly_envelope as future


def model():
    with localcontext() as context:
        context.prec = 70
        baseline = future.model()
        rows = {}
        tax = future.RATE['vat_multiplier']
        storage_rate = future.RATE['gcs_gib_hour']
        for month, original in baseline['months'].items():
            parts = original['parts_prevat_usd']
            # Sum the already published bounds. Never release ordinary release
            # backup/restore/rollback capacity or the recurring20GiB snapshots.
            separate_compute_maintenance = (
                D(parts['rollback_compute_95minutes'])
                + D(parts['cold_snapshot_100gib_24h_plus7d']))*tax
            without_maintenance = future.up(D(original['total_gross_usd'])-separate_compute_maintenance)
            old_storage_gross = D(parts['gcs_preserved40gib_and_b02_retained'])*tax
            other_storage_gross = future.up(D(40)*original['calendar_hours']*storage_rate*tax)
            remaining_except_b02 = future.up(without_maintenance-old_storage_gross+other_storage_gross)
            # Floor the admissible capacity; later use must round COST upward.
            capacity = ((D(100)-remaining_except_b02)/(storage_rate*tax)).quantize(
                D('.000000001'), rounding=ROUND_FLOOR)
            positive_capacity = max(D(0), capacity)
            at_bound = future.up(remaining_except_b02+positive_capacity*storage_rate*tax)
            rows[month] = {
                'intact_baseline_gross_usd': original['total_gross_usd'],
                'separate_compute_maintenance_reserve_gross_usd': format(separate_compute_maintenance,'f'),
                'no_new_compute_maintenance_conditional_gross_usd': future.text(without_maintenance),
                'no_new_compute_maintenance_alone_within_100': without_maintenance<=100,
                'remaining_except_regular_b02_storage_gross_usd': future.text(remaining_except_b02),
                'maximum_regular_b02_gib_hours_condition': format(positive_capacity,'f'),
                'maximum_monthly_average_regular_b02_gib_condition': format(
                    (positive_capacity/D(original['calendar_hours'])).quantize(D('.000000001'),rounding=ROUND_FLOOR),'f'),
                'gross_usd_at_conditional_capacity': future.text(at_bound),
                'non_storage_parts_already_exceed_100': capacity<0,
                'supplement_three_objects_storage_reserve_preserved': True,
                'actual_retained_gib_hours': None, 'native_inventory_satisfies_condition': False,
                'production_authorized': False,
            }
        return {
            'schema_version': 1, 'state': 'FUTURE_CONDITIONAL_FUNDING_REQUIREMENTS_ONLY',
            'billing_timezone': 'America/Los_Angeles', 'months': rows,
            'baseline_reserves_modified': False, 'monthly_cap_gross_usd': '100',
            'numbers_target': 20, 'ci_minutes': 420, 'lag_hours': 24,
            'lifecycle_days': 30, 'soft_delete_days': 7, 'pitr_days': 7,
            'all_regular_and_supplement_backup_compute_preserved': True,
            'all_full_and_deployment_gates_preserved': True,
            'snapshot_compression_savings_assumed': False,
            'native_absence_claimed': False, 'deletion_authorized': False,
            'production_authorized': False, 'native_effects': 0,
            'requirements': ['CANONICAL_MONTH_PLAN_EXCLUDES_NEW_COMPUTE_MAINTENANCE',
                'NORMAL_RELEASE_BACKUP_RESTORE_AND_ROLLBACK_GATES_RETAINED',
                'FULL_NORMAL_AND_SOFT_DELETED_GENERATION_BOUND_INVENTORY',
                'NATIVE_ABSENCE_BEFORE_RELEASING_ANY_HISTORICAL_BYTES',
                'FUTURE_BYTE_HOURS_BOUND_WITH_RETENTION_AND_LIFECYCLE_DELAY',
                'LOAD20_AND_WAL_DR_CAPACITY_PROVEN_WITHOUT_UNFUNDED_INFRASTRUCTURE',
                'FRESH_TARIFF_FX_TAX_AND_COMPLETE_MONTH_ECONOMIC_ADMISSION'],
        }
