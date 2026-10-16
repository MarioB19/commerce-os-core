from copy import deepcopy
from decimal import Decimal as D, localcontext
import pathlib,sys,unittest
S=pathlib.Path(__file__).resolve().parents[2]/'scripts';sys.path.insert(0,str(S))
import f1_future_monthly_envelope as m
import b02_quota_coverage as q

class FutureEnvelope(unittest.TestCase):
 def setUp(self):self.value=m.model()
 def test_complete_calendar_not_october_partial(self):
  self.assertEqual(set(self.value['months']),{'2026-11','2026-12'})
  self.assertEqual([x['calendar_hours']for x in self.value['months'].values()],[721,744])
  self.assertFalse(self.value['october_partial_total_used']);self.assertEqual(self.value['ci_minutes_each_month'],420)
 def test_daily_compute_includes_supplement_once_not_twice(self):
  for month,days in [('2026-11',30),('2026-12',31)]:
   r=self.value['months'][month];self.assertEqual(r['regular_b02_starts']+r['supplement_b02_starts'],days)
   regular=D(r['parts_prevat_usd']['b02_regular_compute_1920s'])
   extra=D(3*1920)*D('.000052')if month=='2026-11'else D(0)
   expected=days+(1 if month=='2026-11'else 0)
   self.assertEqual(regular+extra,D(expected*1920)*D('.000052'))
   self.assertEqual(r['supplement_compute_whole_cross_boundary_attempt_retained'],month=='2026-11')
 def test_preserves_all_reserves_without_credits_or_free_tiers(self):
  required={'compute_e2_standard2','pd_standard_100gib','ipv4','gcs_preserved40gib_and_b02_retained','snapshot_regional_20gib','internet_30gib','cross_region_50gib','ingress','pubsub','operations_including_operating','registry_10gib','ci_420minutes','mail_preserved_reference','logging_5gib','monitor','isolated_restore','oauth_separate_preserved','source_storage_existing','shadow_separate_preserved','full24h_billing_lag','b02_regular_compute_1920s','b02_scheduler','b02_contingency','rollback_compute_95minutes','cold_snapshot_100gib_24h_plus7d'}
  for row in self.value['months'].values():
   self.assertEqual(set(row['parts_prevat_usd']),required|{'supplement_storage_calendar_topup'})
   self.assertTrue(all(D(row['parts_prevat_usd'][k])>0 for k in required))
   self.assertEqual(row['parts_prevat_usd']['ci_420minutes'],'2.520000000')
   self.assertEqual(row['parts_prevat_usd']['mail_preserved_reference'],'2.000000000')
  self.assertFalse(self.value['credits_deducted']);self.assertEqual(self.value['numbers_target'],20)
 def test_supplement_storage_hourly_calendar_shortfall_is_reserved(self):
  self.assertEqual(self.value['months']['2026-11']['parts_prevat_usd']['supplement_storage_calendar_topup'],'0.000000000')
  self.assertGreater(D(self.value['months']['2026-12']['parts_prevat_usd']['supplement_storage_calendar_topup']),0)
  required=D(3)*D(m.EXPORT_BYTES)/m.GIB*(D(744)*m.RATE['gcs_gib_hour']-D('.02'))
  self.assertGreaterEqual(D(self.value['months']['2026-12']['parts_prevat_usd']['supplement_storage_calendar_topup']),required)
 def test_operations_are_allocated_inside_two_without_borrowing_ingress(self):
  for row in self.value['months'].values():
   p=row['operations_allocation_prevat_usd'];self.assertEqual(p['runtime_execution'],'0.580000000')
   self.assertEqual(p['startup_rejected_cleanup'],'0.348000000')
   self.assertEqual(p['gcs_operations'],'0.090000000')
   self.assertEqual(sum(D(v)for v in p.values())+D(row['operations_unallocated_prevat_usd']),D(2))
   self.assertEqual(D(row['parts_prevat_usd']['ingress']),2)
 def test_no_age_based_release_normal_or_soft_deleted(self):
  before=self.value['source_inventory']['reported_bytes']
  for month,count in [('2026-11',49),('2026-12',80)]:
   row=self.value['months'][month];self.assertEqual(row['b02_regular_retained_upper_bytes'],before+count*m.EXPORT_BYTES)
   self.assertEqual(row['retained_inventory_released_bytes'],0)
  self.assertFalse(self.value['native_absence_claimed']);self.assertFalse(self.value['deletion_authorized'])
  self.assertEqual(self.value['retention']['soft_delete_days'],7)
 def test_published_rounding_conserves_lines_vat_and_supplement(self):
  for row in self.value['months'].values():
   gross=D(row['previous_gross_usd']);parts=sum(D(v)for v in row['parts_prevat_usd'].values())
   self.assertGreaterEqual(gross,parts*D('1.16'))
   self.assertEqual(D(row['total_gross_usd']),gross+D(row['marginal_gross_usd']))
   self.assertEqual(D(row['margin_gross_usd'])+D(row['total_gross_usd']),100)
 def test_decimal_context_cannot_make_budget_appear_lower(self):
  with localcontext()as ctx:
   ctx.prec=8;value=m.model()
  self.assertEqual(value,self.value)
 def test_december_over_budget_is_reported_not_forced_to_pass(self):
  self.assertFalse(self.value['months']['2026-12']['within_100'])
  self.assertGreater(D(self.value['months']['2026-12']['total_gross_usd']),100)
  self.assertFalse(self.value['all_months_within_100']);self.assertFalse(self.value['production_authorized'])
 def test_existing_supplement_gate_rejects_this_unfunded_month(self):
  previous={k:r['previous_gross_usd']for k,r in self.value['months'].items()}
  with self.assertRaisesRegex(RuntimeError,'OVER_BUDGET'):
   q.reserve_supplement([x.isoformat()for x in q.NOVEMBER_SLOTS],monthly_totals=previous,rates=m.SUPPLEMENT_RATES,maximum_export_bytes=m.EXPORT_BYTES)
 def test_historical_f1_snapshot_and_restore_are_not_claimed_repeated(self):
  self.assertEqual(self.value['native_effects'],0);self.assertFalse(self.value['wal_pitr_dr_capacity_proven'])
  self.assertFalse(self.value['provider_billing_hard_cap_proven'])
 def test_october_has_separate_original_review_not_zero_or_a_future_baseline(self):
  import f1_october_boundary_review as o
  self.assertEqual(self.value['october_boundary_review'],o.review())
  self.assertEqual(self.value['required_admission_months'],['2026-10','2026-11','2026-12'])
  self.assertEqual(self.value['billing_timezone'],'America/Los_Angeles')
  self.assertTrue(self.value['legacy_two_month_cost_estimate_is_not_admission'])
 def test_november_contains_the_december_first_utc_slot(self):
  import datetime as dt
  from f1_billing_calendar import billing_month,UTC
  self.assertEqual(billing_month(dt.datetime(2026,12,1,6,45,tzinfo=UTC)),'2026-11')
  self.assertEqual(self.value['months']['2026-11']['regular_b02_starts'],28)
 def test_no_mutable_parameters_for_credits_or_october_total(self):
  with self.assertRaises(TypeError):m.model(october_total='99.8')
  with self.assertRaises(TypeError):m.model(credit='10')

if __name__=='__main__':unittest.main()
