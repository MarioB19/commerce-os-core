from decimal import Decimal as D, localcontext
import pathlib
import sys
import unittest

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/'scripts'))
import f1_future_funding_conditions as m
import f1_future_monthly_envelope as f


class FundingConditionsTests(unittest.TestCase):
    def test_baseline_is_preserved_and_no_automatic_admission(self):
        before=f.model(); r=m.model()
        self.assertEqual(f.model(), before)
        self.assertFalse(r['baseline_reserves_modified'])
        self.assertFalse(r['production_authorized'])
        self.assertFalse(r['native_absence_claimed'])
        self.assertFalse(r['deletion_authorized'])
        for month,row in r['months'].items():
            self.assertEqual(row['intact_baseline_gross_usd'],before['months'][month]['total_gross_usd'])
            self.assertIsNone(row['actual_retained_gib_hours'])
            self.assertFalse(row['native_inventory_satisfies_condition'])

    def test_november_can_only_fit_conditionally_and_december_still_needs_inventory(self):
        r=m.model()['months']
        self.assertEqual(r['2026-11']['no_new_compute_maintenance_conditional_gross_usd'],'98.294982787')
        self.assertEqual(r['2026-12']['no_new_compute_maintenance_conditional_gross_usd'],'101.208844980')
        self.assertTrue(r['2026-11']['no_new_compute_maintenance_alone_within_100'])
        self.assertFalse(r['2026-12']['no_new_compute_maintenance_alone_within_100'])

    def test_byte_hours_threshold_rounds_down_and_cost_rounds_up(self):
        with localcontext() as c:
            c.prec=70
            for row in m.model()['months'].values():
                bound=D(row['maximum_regular_b02_gib_hours_condition'])
                other=D(row['remaining_except_regular_b02_storage_gross_usd'])
                rate=f.RATE['gcs_gib_hour']*f.RATE['vat_multiplier']
                self.assertLessEqual(f.up(other+bound*rate),D(100))
                self.assertGreater(f.up(other+(bound+D('.000000001'))*rate),D(100))

    def test_no_gates_retention_or_operating_capacity_removed(self):
        r=m.model()
        self.assertEqual((r['numbers_target'],r['ci_minutes'],r['lag_hours'],r['lifecycle_days'],r['soft_delete_days'],r['pitr_days']),(20,420,24,30,7,7))
        self.assertTrue(r['all_regular_and_supplement_backup_compute_preserved'])
        self.assertTrue(r['all_full_and_deployment_gates_preserved'])
        self.assertIn('LOAD20_AND_WAL_DR_CAPACITY_PROVEN_WITHOUT_UNFUNDED_INFRASTRUCTURE',r['requirements'])
        self.assertTrue(all(x['supplement_three_objects_storage_reserve_preserved'] for x in r['months'].values()))


if __name__=='__main__':unittest.main()
