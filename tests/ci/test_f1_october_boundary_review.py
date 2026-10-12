import datetime as dt
from decimal import Decimal as D, localcontext
import pathlib, sys, unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/'scripts'))
import f1_billing_calendar as c
import f1_october_boundary_review as m


class Boundary(unittest.TestCase):
    def test_pacific_boundaries_not_naive_wall_time(self):
        self.assertEqual(c.month_bounds('2026-11')[0].isoformat(),'2026-11-01T07:00:00+00:00')
        self.assertEqual(c.month_bounds('2026-11')[1].isoformat(),'2026-12-01T08:00:00+00:00')
        self.assertEqual([c.month_hours(x) for x in ('2026-10','2026-11','2026-12')],[744,721,744])

    def test_slot_one_is_october_and_rest_november(self):
        self.assertEqual([c.billing_month(dt.datetime(2026,11,n,6,45,tzinfo=c.UTC)) for n in (1,2,3)],['2026-10','2026-11','2026-11'])

    def test_no_double_charge_compute_already_514_hours(self):
        v=m.review();self.assertEqual(v['original_remaining_hours'],'514.165')
        self.assertEqual(v['compute_pd_ip_boundary_added_gross_usd'],'0')

    def test_full_attempt_and_api_logs_added_outside_prior_reserves(self):
        v=m.review();self.assertEqual(v['supplement_seconds_reserved_in_october'],1920)
        self.assertEqual(D(v['additional_gross_usd']),D('.116041200390625'))
        with localcontext() as ctx:
            ctx.prec=70
            self.assertEqual(D(v['proposed_gross_usd']),D(m.PRIOR_GROSS)+D(v['additional_gross_usd']))

    def test_storage_keeps_all_objects_with_extra_lag_everywhere(self):
        v=m.review();p={k:D(x) for k,x in v['b02_storage_gib_hours'].items()}
        with localcontext() as ctx:
            ctx.prec=70
            self.assertEqual(sum(p.values()),D(v['b02_storage_total_gib_hours']))
        self.assertGreater(p['ordinary_and_f1_future_lag_24h_each'],21*24)
        self.assertGreater(p['supplement_before_boundary_plus_lag_24h'],24)
        self.assertEqual(v['retained_inventory_released_bytes'],0)
        self.assertLess(D(v['b02_storage_total_gib_hours']),14880)

    def test_no_implicit_adoption_credits_quota_or_recovery(self):
        v=m.review();self.assertFalse(v['production_authorized']);self.assertFalse(v['quota_changed'])
        self.assertFalse(v['new_recovery_or_egress_authorized']);self.assertTrue(v['all_prior_reserves_preserved'])
        self.assertEqual(v['native_effects'],0);self.assertTrue(v['all_november_reserves_kept'])

    def test_caller_decimal_context_does_not_truncate(self):
        expected=m.review()
        with localcontext()as ctx:
            ctx.prec=8;self.assertEqual(m.review(),expected)

    def test_calendar_rejects_ambiguous_input(self):
        for month in (True,'2026-13','2026-1','2026-01T00:00Z'):
            with self.assertRaises(ValueError):c.month_bounds(month)
        with self.assertRaises(ValueError):c.billing_month(dt.datetime(2026,11,1))

if __name__=='__main__':unittest.main()
