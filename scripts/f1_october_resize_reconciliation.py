"""Pure, fixed-incident reconciliation proposals; never an economic admission.

The caller verifies raw original hashes before supplying documents. No reported
snapshot storageBytes, credits, downtime or future deletion becomes a discount.
"""
import datetime as dt
from decimal import Decimal as D, localcontext
from f1_october_boundary_review import review as boundary_review

UTC = dt.timezone.utc
OLD_RATE = D('0.144502339629')
NEW_RATE = D('0.077490919815')
VAT = D('1.16')
SNAP_RATE = D('0.000068493')
FX = D('17.81394999988367')


def need(value, code):
    if not value:
        raise ValueError(code)


def stamp(value):
    need(type(value) is str, 'TIME_TYPE')
    result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    need(result.tzinfo is not None, 'TIME_ZONE')
    return result.astimezone(UTC)


def hours(start, end):
    elapsed = end-start
    need(elapsed >= dt.timedelta(0), 'TIME_REVERSED')
    return (D(elapsed.days*86400 + elapsed.seconds) + D(elapsed.microseconds)/1000000)/3600


def validate_documents(docs):
    need(set(docs) == {'billing', 'current_vm', 'resize', 'start', 'reanchor',
        'extension', 'snapshot', 'retirement'}, 'ORIGINAL_SET')
    bill = docs['billing']
    need(bill['gross_mxn'] == '336.01' and bill['prior_gross_mxn'] == '329.75'
        and bill['conservative_projection_anchor'] == '2026-10-11T22:05:00Z'
        and stamp(bill['prior_anchor']) == stamp('2026-10-11T20:32:32.1963Z')
        and stamp(bill['observed_at']) >= stamp(bill['conservative_projection_anchor']), 'BILLING_CHANGED')
    resize, start, current = docs['resize'], docs['start'], docs['current_vm']
    for doc, phase in ((resize, 'resize'), (start, 'start')):
        need(doc['status'] == 'NATIVE_OPERATION_AND_RESOURCE_VERIFIED' and doc['phase'] == phase
            and doc['operation']['status'] == 'DONE' and not doc['operation'].get('error'), 'COMPUTE_NOT_COMPLETED')
    old = resize['resources']['instance']
    started = start['resources']['instance']
    need(old['id'] == started['id'] == current['id'] == '6334472381123916728'
        and old['machineType'] == started['machineType'] == current['machineType']
        and current['machineType'].endswith('/e2-standard-2')
        and current['status'] == started['status'] == 'RUNNING'
        and current['scheduling']['automaticRestart'] is True
        and current['lastStartTimestamp'] == started['lastStartTimestamp'], 'VM_CHANGED')
    resize_at = stamp(resize['operation']['endTime'])
    need(resize_at == stamp('2026-10-11T15:24:05.679Z')
        and resize_at < stamp(start['operation']['endTime']) < stamp(bill['prior_anchor']), 'RESIZE_TIME_CHANGED')
    previous = docs['reanchor']
    need(previous['time_anchor']['new'] == '2026-10-11T17:54:34.425567+00:00'
        and stamp(previous['time_anchor']['native_resize_done']) == resize_at
        and previous['conservative_limits']['early_resize_premium_released_usd'] == '0'
        and previous['conservative_limits']['remaining_old_future_premium_to18utc_released_usd'] == '0', 'PREMIUM_ALREADY_RELEASED_OR_CHANGED')
    need(previous['calculation']['old_compute_pd_ip_hourly_prevat'] == str(OLD_RATE)
        and previous['calculation']['new_compute_pd_ip_hourly_prevat'] == str(NEW_RATE), 'PRICE_CHANGED')
    extension = docs['extension']['conservative_extension']
    need(extension['new_deadline_utc'] == '2026-10-11T18:00:00Z'
        and extension['extra_old_instead_of_new_vm_usd_per_hour_including_vat_exact'] == str((OLD_RATE-NEW_RATE)*VAT), 'EXTENSION_CHANGED')
    snap = docs['snapshot']['snapshot']
    retirement = docs['retirement']
    need(snap['id'] == retirement['snapshot_id'] == '929617421950916109'
        and snap['diskSizeGb'] == '100' and snap['snapshotType'] == 'STANDARD'
        and snap['status'] == 'READY' and snap['storageLocations'] == ['us-east1'], 'SNAPSHOT_CHANGED')
    need(retirement['status'] == 'EXACT_F1_SNAPSHOT_DELETED_NATIVE_OPERATION_VERIFIED'
        and retirement['active_snapshot_absent'] is True
        and retirement['recycle_bin_max_days_reserved'] == 7 and retirement['trash_deleted'] is False
        and retirement['other_backups_touched'] is False, 'SNAPSHOT_RETIREMENT_UNPROVEN')
    operation = retirement['operation']
    need(operation['status'] == 'DONE' and operation['operationType'] == 'delete'
        and operation['targetId'] == snap['id'] and not operation.get('error'), 'DELETE_NOT_COMPLETED')
    created, deleted, absent = stamp(snap['creationTimestamp']), stamp(operation['endTime']), stamp(retirement['at'])
    need(created < deleted <= absent < created+dt.timedelta(hours=2), 'SNAPSHOT_ACTIVE_TWO_HOUR_BOUND')
    need(stamp(bill['observed_at']) > absent, 'BILLING_BEFORE_CLOSURE')
    return resize_at, created, absent


def review(docs):
    with localcontext() as context:
        context.prec = 70
        resize_at, created, absent = validate_documents(docs)
        bill = docs['billing']
        anchor = stamp(bill['conservative_projection_anchor'])
        prior_anchor = stamp(bill['prior_anchor'])
        before = D(boundary_review()['proposed_gross_usd'])
        delta = (D(bill['gross_mxn'])-D(bill['prior_gross_mxn']))/FX*VAT
        elapsed = hours(prior_anchor, anchor)*NEW_RATE*VAT
        reanchored = before + delta - elapsed
        middle = stamp(docs['reanchor']['time_anchor']['new'])
        end = stamp(docs['extension']['conservative_extension']['new_deadline_utc'])
        early = hours(resize_at, middle)*(OLD_RATE-NEW_RATE)*VAT
        tail = hours(middle, end)*(OLD_RATE-NEW_RATE)*VAT
        need(early == D(docs['reanchor']['calculation']['retained_earlier_resize_premium_gross_usd']), 'EARLY_PREMIUM_NOT_REDERIVED')
        old_snapshot = D(100)*D(24+7*24)*SNAP_RATE*VAT
        closed_snapshot = D(100)*D(2+7*24)*SNAP_RATE*VAT
        need(old_snapshot == D(str(docs['reanchor']['preserved_reserves']['snapshot_usd_including_vat'])), 'SNAPSHOT_RESERVE_CHANGED')
        a = reanchored-early-tail
        b = a-old_snapshot+closed_snapshot
        fmt = lambda value: format(value, 'f')
        return {
            'schema_version': 1, 'state': 'OCTOBER_CLOSED_RESIZE_RECONCILIATION_PROPOSED',
            'billing_anchor': anchor.isoformat(), 'billing_observed_at': bill['observed_at'],
            'prior_boundary_corrected_gross_usd': fmt(before), 'positive_billing_delta_gross_usd': fmt(delta),
            'elapsed_future_compute_pd_ip_removed_gross_usd': fmt(elapsed), 'reanchored_before_reconciliation_gross_usd': fmt(reanchored),
            'closed_early_resize_premium_gross_usd': fmt(early), 'closed_remaining_old_premium_to18_gross_usd': fmt(tail),
            'closed_premium_total_gross_usd': fmt(early+tail),
            'snapshot_active_observed_hours_upper_bound': fmt(hours(created, absent)),
            'snapshot_original_reserve_gross_usd': fmt(old_snapshot),
            'snapshot_two_hour_plus_seven_day_reserve_gross_usd': fmt(closed_snapshot),
            'scenarios': {
                'A_PREMIUM_ONLY_SNAPSHOT_24H_PLUS_7D': {'gross_usd': fmt(a), 'margin_usd': fmt(D(100)-a), 'within_100': a <= 100},
                'B_PREMIUM_AND_CLOSED_SNAPSHOT_2H_PLUS_7D': {'gross_usd': fmt(b), 'margin_usd': fmt(D(100)-b), 'within_100': b <= 100},
            },
            'snapshot_gib_kept': 100, 'snapshot_trash_days_kept': 7,
            'snapshot_compressed_bytes_used_for_savings': False, 'preview_discount_used': False,
            'ci_total_minutes_kept': 420, 'ci_consumed_minutes_kept': 74, 'rollback_minutes_kept': 95,
            'lag_hours_kept': 24, 'all_other_reserves_unchanged': True, 'downtime_discount_usd': '0',
            'credits_deducted': False, 'functions_removed': False, 'gates_removed': False,
            'adopted': False, 'production_authorized': False, 'native_effects': 0,
            'one_time_reconciliation_requires_root_adoption': True,
        }
