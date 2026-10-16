import datetime as dt
from decimal import Decimal
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('coverage',Path(__file__).resolve().parents[2]/'scripts/b02_quota_coverage.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class CoverageTests(unittest.TestCase):
 def history(self):
  return [{'run_id':f'{n+1}-1','started_at':f'2026-10-{7+n//4:02}T12:{n:02}:00+00:00','status':'FAILED'if n%2 else'SUCCEEDED','sha256':f'{n+1:064x}'}for n in range(17)]
 def forecast(self,records=None,observed='2026-10-11T19:00:00+00:00'):
  return m.forecast(self.history()if records is None else records,observed_at=observed,valid_from='2026-10-05T00:00:00+00:00',valid_until='2026-11-04T00:00:00+00:00')
 def rates(self):return dict(vcpu_second='0.000018',gib_second='0.000002',storage_gib_month='0.02',cross_region_gib='0.02',internet_gib='0.12',class_a_thousand='0.005',class_b_thousand='0.0004',logs_gib='0.50',tax_multiplier='1.16')
 def cost(self,total='90',**kw):return m.reserve_supplement([x.isoformat()for x in m.NOVEMBER_SLOTS],monthly_totals={'2026-11':total,'2026-12':total},rates=self.rates(),maximum_export_bytes=2**30+65536,**kw)
 def test_exact_three_missing_no_failed_run_refund(self):
  r=self.forecast();self.assertEqual(r['historical_starts'],17);self.assertEqual(r['uncovered_slots'],[x.isoformat()for x in m.NOVEMBER_SLOTS]);self.assertEqual(sum(x['base_admitted']for x in r['slots']),20);self.assertFalse(r['production_authorized'])
 def test_order_independent_complete_hashes_preserved(self):
  old=self.history();self.assertEqual(self.forecast(old),self.forecast(list(reversed(old))));self.assertEqual(self.forecast()['ledger_hashes'],{x['run_id']:x['sha256']for x in old})
 def test_running_and_reconciled_failed_count_too(self):
  rows=self.history();rows[0]['status']='RUNNING';rows[1]['status']='FAILED_RECONCILED';self.assertEqual(self.forecast(rows)['uncovered_slots'],self.forecast()['uncovered_slots'])
 def test_duplicate_future_and_naive_rejected(self):
  old=self.history()
  for rows in [old+[old[0]],old+[dict(old[0],run_id='99-1',started_at='2027-01-01T00:00:00Z')],old+[dict(old[0],run_id='99-1',started_at='2026-10-01T00:00:00')]]:
   with self.assertRaises(RuntimeError):self.forecast(rows)
 def test_inclusive_thirty_day_boundary(self):
  rows=[dict(x,started_at='2026-10-02T06:45:00+00:00')for x in self.history()]
  rows +=[dict(rows[0],run_id=f'{100+n}-1',sha256=f'{100+n:064x}')for n in range(20)]
  r=self.forecast(rows,'2026-11-01T06:44:00+00:00');self.assertFalse(r['slots'][0]['base_admitted']);self.assertTrue(r['slots'][1]['base_admitted'])
 def test_elapsed_slots_not_caught_up(self):
  r=self.forecast(observed='2026-10-12T06:46:00+00:00');self.assertEqual(r['slots'][0]['slot'],'2026-10-13T06:45:00+00:00')
 def test_financial_end_does_not_renew(self):
  with self.assertRaisesRegex(RuntimeError,'WINDOW'):m.forecast(self.history(),observed_at='2026-10-11T19:00:00Z',valid_from='2026-10-05T00:00:00Z',valid_until='2026-11-05T00:00:00Z')
 def test_due_slot_cannot_be_recast_as_future(self):
  with self.assertRaisesRegex(RuntimeError,'ALREADY_DUE'):self.forecast(observed='2026-10-12T06:45:00+00:00')
 def test_cost_keeps_compute_transfer_operations_logs_and_tax(self):
  r=self.cost();self.assertEqual(Decimal(r['monthly']['2026-11']['parts_pre_tax_usd']['compute'])*Decimal('1.16'),Decimal('0.34744320000'));self.assertGreater(Decimal(r['monthly']['2026-11']['marginal_gross_usd']),Decimal('0.8'));self.assertEqual(r['nominal_last_retention_until'],'2026-12-10T06:45:00+00:00');self.assertEqual(r['storage_reserved_until'],'2027-01-01T00:00:00+00:00');self.assertFalse(r['refund']);self.assertFalse(r['base_quota_changed']);self.assertFalse(r['production_authorized'])
 def test_cost_fails_over_cap_and_no_october_envelope(self):
  with self.assertRaisesRegex(RuntimeError,'OVER_BUDGET'):self.cost('99.5')
  with self.assertRaisesRegex(RuntimeError,'NOVEMBER'):m.reserve_supplement([x.isoformat()for x in m.NOVEMBER_SLOTS],monthly_totals={'2026-10':'90'},rates=self.rates(),maximum_export_bytes=2**30+65536)
 def test_exact_slot_bound_not_extra_manual_capacity(self):
  with self.assertRaisesRegex(RuntimeError,'EXACT_SLOTS'):m.reserve_supplement(['2026-11-01T06:45:00Z'],monthly_totals={'2026-11':'90'},rates=self.rates(),maximum_export_bytes=2**30+65536)
 def test_amounts_are_decimal_and_nonnegative(self):
  for value in [1.2,'NaN','-1','Infinity','1e9',True]:
   with self.assertRaises(RuntimeError):m.money(value)
 def test_reserves_all_bytes_for_both_full_months_and_recovery_in_each(self):
  r=self.cost();nov=r['monthly']['2026-11']['parts_pre_tax_usd'];dec=r['monthly']['2026-12']['parts_pre_tax_usd']
  expected=m.rounded(Decimal(3)*Decimal(2**30+65536)/Decimal(2**30)*Decimal('0.02'))
  self.assertEqual(nov['storage'],expected);self.assertEqual(dec['storage'],expected)
  self.assertEqual(dec['compute'],'0.000000000');self.assertEqual(dec['class_a'],'0.000000000')
  for key in ('recovery_download','cross_region','class_b','logs'):self.assertEqual(nov[key],dec[key])
  self.assertTrue(r['native_absence_required_before_release']);self.assertFalse(r['provider_deletion_deadline_proven']);self.assertTrue(r['october_budget_not_modelled']);self.assertFalse(r['admission_compatible'])
 def test_missing_december_budget_is_not_treated_as_zero(self):
  with self.assertRaisesRegex(RuntimeError,'DECEMBER_ENVELOPES'):
   m.reserve_supplement([x.isoformat()for x in m.NOVEMBER_SLOTS],monthly_totals={'2026-11':'90'},rates=self.rates(),maximum_export_bytes=2**30+65536)
 def test_december_alone_can_block_the_supplement(self):
  with self.assertRaisesRegex(RuntimeError,'OVER_BUDGET'):
   m.reserve_supplement([x.isoformat()for x in m.NOVEMBER_SLOTS],monthly_totals={'2026-11':'80','2026-12':'99.9'},rates=self.rates(),maximum_export_bytes=2**30+65536)
 def test_lifecycle_and_soft_delete_are_not_shortened_at_financial_end(self):
  r=self.cost();self.assertEqual(r['lifecycle_days'],30);self.assertEqual(r['soft_delete_days'],7)
  self.assertGreater(m.timestamp(r['nominal_last_retention_until']),m.FINANCIAL_END+dt.timedelta(days=7))
if __name__=='__main__':unittest.main()
