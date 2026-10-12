import copy
import datetime as dt
from decimal import Decimal as D, localcontext
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]/'scripts'))
import f1_october_resize_reconciliation as m


def documents():
    vm = {'id': '6334472381123916728', 'machineType': 'fixed/e2-standard-2',
        'status': 'RUNNING', 'scheduling': {'automaticRestart': True},
        'lastStartTimestamp': '2026-10-11T15:30:02.005Z'}
    result = {'status': 'NATIVE_OPERATION_AND_RESOURCE_VERIFIED',
        'resources': {'instance': vm}, 'phase': 'resize',
        'operation': {'status': 'DONE', 'endTime': '2026-10-11T15:24:05.679Z'}}
    start = copy.deepcopy(result)
    start['phase'] = 'start'
    start['operation']['endTime'] = '2026-10-11T15:30:02.094Z'
    return {'billing': {'gross_mxn': '336.01', 'prior_gross_mxn': '329.75',
        'conservative_projection_anchor': '2026-10-11T22:05:00Z',
        'prior_anchor': '2026-10-11T20:32:32.196300+00:00', 'observed_at': '2026-10-11T22:06:28.836Z'},
        'current_vm': copy.deepcopy(vm), 'resize': result, 'start': start,
        'reanchor': {'time_anchor': {'new': '2026-10-11T17:54:34.425567+00:00',
            'native_resize_done': '2026-10-11T15:24:05.679Z'},
            'conservative_limits': {'early_resize_premium_released_usd': '0',
                'remaining_old_future_premium_to18utc_released_usd': '0'},
            'calculation': {'old_compute_pd_ip_hourly_prevat': '0.144502339629',
                'new_compute_pd_ip_hourly_prevat': '0.077490919815',
                'retained_earlier_resize_premium_gross_usd': '0.194953829680755556417800'},
            'preserved_reserves': {'snapshot_usd_including_vat': 1.525476096}},
        'extension': {'conservative_extension': {'new_deadline_utc': '2026-10-11T18:00:00Z',
            'extra_old_instead_of_new_vm_usd_per_hour_including_vat_exact': '0.07773324698424'}},
        'snapshot': {'snapshot': {'id': '929617421950916109', 'diskSizeGb': '100',
            'snapshotType': 'STANDARD', 'status': 'READY', 'storageLocations': ['us-east1'],
            'creationTimestamp': '2026-10-11T15:18:59.038Z', 'storageBytes': '1'}},
        'retirement': {'status': 'EXACT_F1_SNAPSHOT_DELETED_NATIVE_OPERATION_VERIFIED',
            'snapshot_id': '929617421950916109', 'active_snapshot_absent': True,
            'recycle_bin_max_days_reserved': 7, 'trash_deleted': False, 'other_backups_touched': False,
            'at': '2026-10-11T16:22:47.106368Z', 'operation': {'status': 'DONE',
                'operationType': 'delete', 'targetId': '929617421950916109',
                'endTime': '2026-10-11T16:21:56.362Z'}}}


class ReconciliationTests(unittest.TestCase):
    def test_real_arithmetic_keeps_both_scenarios_unadopted(self):
        r = m.review(documents())
        self.assertEqual(r['closed_premium_total_gross_usd'], '0.201983817961906361400000')
        self.assertEqual(D(r['reanchored_before_reconciliation_gross_usd']),
            D('100.1903745013480427939206182390125586690110673407939069947850500871903'))
        self.assertFalse(r['adopted'])
        self.assertFalse(r['production_authorized'])
        self.assertEqual(D(r['snapshot_two_hour_plus_seven_day_reserve_gross_usd']), D('1.350681960'))
        for scenario in r['scenarios'].values():
            self.assertTrue(scenario['within_100'])

    def test_premium_equivalence_proves_no_double_telescoping(self):
        # Original future charges old until18. Prior reconciliation used new
        # after resize, leaving precisely old-new. Subtract that residual once.
        with localcontext() as c:
            c.prec = 70
            begin, resize, anchor, end = map(m.stamp, ('2026-10-11T13:16:00Z',
                '2026-10-11T15:24:05.679Z', '2026-10-11T17:54:34.425567Z', '2026-10-11T18:00:00Z'))
            original = m.hours(begin, end)*m.OLD_RATE*m.VAT
            removed = (m.hours(begin, resize)*m.OLD_RATE + m.hours(resize, anchor)*m.NEW_RATE)*m.VAT
            genuine_remaining = m.hours(anchor, end)*m.NEW_RATE*m.VAT
            residual = original-removed-genuine_remaining
            self.assertLess(abs(residual-D(m.review(documents())['closed_premium_total_gross_usd'])), D('1e-65'))

    def test_immutable_input_and_all_remaining_reserves(self):
        d = documents(); before = copy.deepcopy(d); r = m.review(d)
        self.assertEqual(d, before)
        self.assertEqual((r['ci_total_minutes_kept'],r['ci_consumed_minutes_kept'],r['rollback_minutes_kept'],r['lag_hours_kept']), (420,74,95,24))
        self.assertEqual((r['snapshot_gib_kept'],r['snapshot_trash_days_kept']), (100,7))
        self.assertEqual(r['downtime_discount_usd'], '0')

    def test_compression_never_changes_savings(self):
        d = documents(); a = m.review(d); d['snapshot']['snapshot']['storageBytes'] = str(100*2**30)
        self.assertEqual(m.review(d), a)
        self.assertFalse(a['preview_discount_used'])

    def test_wrong_current_vm_or_restarted_incarnation_rejected(self):
        for key, value in (('id','other'),('machineType','fixed/e2-standard-4'),('status','TERMINATED'),('lastStartTimestamp','2026-10-11T20:00:00Z')):
            d = documents(); d['current_vm'][key] = value
            with self.assertRaisesRegex(ValueError,'VM_CHANGED'): m.review(d)

    def test_pending_resize_rejected(self):
        d = documents(); d['resize']['operation']['status'] = 'RUNNING'
        with self.assertRaisesRegex(ValueError,'COMPUTE_NOT_COMPLETED'): m.review(d)

    def test_already_released_premium_rejected(self):
        for key in documents()['reanchor']['conservative_limits']:
            d = documents(); d['reanchor']['conservative_limits'][key] = '0.01'
            with self.assertRaisesRegex(ValueError,'PREMIUM_ALREADY'): m.review(d)

    def test_unproven_delete_or_absence_rejected(self):
        for field,value in (('active_snapshot_absent',False),('trash_deleted',True),('snapshot_id','reused')):
            d = documents(); d['retirement'][field] = value
            with self.assertRaises(ValueError): m.review(d)

    def test_two_hours_never_assumed_without_native_time_bound(self):
        d = documents(); d['retirement']['at'] = '2026-10-11T17:18:59.038Z'
        with self.assertRaisesRegex(ValueError,'TWO_HOUR_BOUND'): m.review(d)

    def test_future_billing_anchor_or_changed_price_rejected(self):
        d = documents(); d['billing']['observed_at'] = '2026-10-11T22:04:00Z'
        with self.assertRaisesRegex(ValueError,'BILLING_CHANGED'): m.review(d)
        d = documents(); d['reanchor']['calculation']['old_compute_pd_ip_hourly_prevat'] = '.14'
        with self.assertRaisesRegex(ValueError,'PRICE_CHANGED'): m.review(d)


if __name__ == '__main__':
    unittest.main()
