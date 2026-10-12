import copy,datetime as dt,importlib.util,pathlib,sys,unittest
S=pathlib.Path(__file__).resolve().parents[2]/'scripts';sys.path.insert(0,str(S))
s=importlib.util.spec_from_file_location('supplement',S/'b02_supplement_admission.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Supplement(unittest.TestCase):
 def setUp(self):
  self.expected=dict(source_sha='a'*40,plan_sha256='b'*64,binding_sha256='c'*64,economic_sha256='d'*64,cost_proposal_sha256='e'*64)
  self.records=[{'run_id':'gcp-'+format(i,'032x'),'started_at':f'2026-10-11T00:{i:02d}:00+00:00','status':'SUCCEEDED','sha256':format(i,'064x')}for i in range(37)]
  self.ad={'schema_version':3,'billing_timezone':'America/Los_Angeles','kind':'B02_NOVEMBER_SCHEDULED_SUPPLEMENT','issued_at':'2026-10-31T00:00:00+00:00','expires_at':'2026-11-04T00:00:00+00:00','financial_valid_until':'2026-11-04T00:00:00+00:00',**self.expected,'baseline':copy.deepcopy(self.records[:17]),'slots':[s.isoformat()for s in m.NOVEMBER_SLOTS],'monthly':{month:{'previous_gross_usd':'80','marginal_gross_usd':'1','total_gross_usd':'81'}for month in ('2026-10','2026-11','2026-12')}}
  self.context={'run_id':'gcp-'+'f'*32,'execution_uid':'ffffffff-ffff-ffff-ffff-ffffffffffff','mode':'SCHEDULED','slot':self.ad['slots'][0],'source_sha':'a'*40};self.claims=[];self.now='2026-11-01T06:46:00+00:00'
 def evaluate(self):return m.evaluate(self.ad,expected=self.expected,records=self.records,context=self.context,claims=self.claims,now=self.now)
 def test_exact_supplement_retains_history_and_requires_native_dispatch(self):
  before=copy.deepcopy(self.records);v=self.evaluate();self.assertEqual(v['rolling_starts_before'],37);self.assertFalse(v['execution_authorized']);self.assertFalse(v['automatic_retry']);self.assertEqual(before,self.records)
 def test_no_manual_wrong_source_or_fourth_day(self):
  for key,value in [('mode','MANUAL'),('source_sha','f'*40),('slot','2026-11-04T06:45:00+00:00')]:
   original=self.context[key];self.context[key]=value
   with self.subTest(key=key),self.assertRaises(RuntimeError):self.evaluate()
   self.context[key]=original
 def test_failed_and_unknown_claim_consumes_slot(self):
  self.records[20]['status']='FAILED';self.claims=[{'slot':self.context['slot'],'run_id':'gcp-'+'e'*32,'sha256':'a'*64}]
  with self.assertRaisesRegex(RuntimeError,'SLOT_ALREADY_CONSUMED'):self.evaluate()
 def test_own_claim_valid_for_execute_not_another_slot(self):
  self.claims=[{'slot':self.context['slot'],'run_id':self.context['run_id'],'sha256':'a'*64}];self.evaluate();self.claims[0]['slot']=self.ad['slots'][1]
  with self.assertRaisesRegex(RuntimeError,'SLOT_ALREADY_CONSUMED'):self.evaluate()
 def test_baseline_cannot_be_removed_or_refunded(self):
  for change in ('remove','status','sha'):
   old=copy.deepcopy(self.records)
   if change=='remove':self.records.pop(0)
   elif change=='status':self.records[0]['status']='FAILED_RECONCILED'
   else:self.records[0]['sha256']='e'*64
   with self.subTest(change=change),self.assertRaisesRegex(RuntimeError,'HISTORY_CHANGED'):self.evaluate()
   self.records=old
 def test_other_binding_and_spend_cannot_be_adopted_by_client(self):
  self.ad['binding_sha256']='e'*64
  with self.assertRaisesRegex(RuntimeError,'IDENTITY_CHANGED'):self.evaluate()
  self.ad['binding_sha256']=self.expected['binding_sha256'];self.ad['monthly']['2026-11']['total_gross_usd']='101'
  with self.assertRaisesRegex(RuntimeError,'GROSS_BUDGET'):self.evaluate()
 def test_no_financial_window_extension_or_expiry_reuse(self):
  for key in ('expires_at','financial_valid_until'):
   old=self.ad[key];self.ad[key]='2026-11-05T00:00:00+00:00'
   with self.subTest(key=key),self.assertRaisesRegex(RuntimeError,'FINANCIAL_WINDOW'):self.evaluate()
   self.ad[key]=old
  self.now='2026-11-04T00:00:00+00:00'
  with self.assertRaisesRegex(RuntimeError,'FINANCIAL_WINDOW'):self.evaluate()
 def test_not_extra_manual_capacity_when_base_available(self):
  self.records=self.records[:36]
  with self.assertRaisesRegex(RuntimeError,'ROLLING_SCOPE'):self.evaluate()
 def test_fortieth_start_rejected(self):
  self.records.extend([{'run_id':'gcp-'+format(100+i,'032x'),'started_at':f'2026-10-31T00:0{i}:00+00:00','status':'FAILED','sha256':format(i,'064x')}for i in range(3)])
  with self.assertRaisesRegex(RuntimeError,'ROLLING_SCOPE'):self.evaluate()
 def test_already_started_execution_only_existing_canonical_readback(self):
  self.records.append({'run_id':self.context['run_id'],'started_at':self.now,'status':'RUNNING','sha256':'c'*64})
  with self.assertRaisesRegex(RuntimeError,'EXISTING_JOURNAL'):self.evaluate()
 def test_delayed_schedule_not_new_window(self):
  self.now='2026-11-01T07:15:00+00:00'
  with self.assertRaisesRegex(RuntimeError,'SLOT_WINDOW'):self.evaluate()
 def test_extra_fields_and_duplicate_claims_rejected(self):
  self.ad['manual_allowed']=True
  with self.assertRaisesRegex(RuntimeError,'FIELDS'):self.evaluate()
  self.ad.pop('manual_allowed');row={'slot':self.context['slot'],'run_id':self.context['run_id'],'sha256':'a'*64};self.claims=[row,row]
  with self.assertRaisesRegex(RuntimeError,'DUPLICATE'):self.evaluate()
 def test_missing_or_unfunded_december_cannot_authorize_november(self):
  self.ad['monthly'].pop('2026-12')
  with self.assertRaisesRegex(RuntimeError,'MONTHLY_ENVELOPES'):self.evaluate()
  self.ad['monthly']['2026-12']={'previous_gross_usd':'99.9','marginal_gross_usd':'1','total_gross_usd':'100.9'}
  with self.assertRaisesRegex(RuntimeError,'GROSS_BUDGET'):self.evaluate()
 def test_legacy_single_month_admission_is_rejected(self):
  self.ad['schema_version']=1
  with self.assertRaisesRegex(RuntimeError,'KIND'):self.evaluate()
 def test_legacy_two_months_and_wrong_timezone_rejected(self):
  self.ad['schema_version']=2
  with self.assertRaisesRegex(RuntimeError,'KIND'):self.evaluate()
  self.ad['schema_version']=3;self.ad['billing_timezone']='UTC'
  with self.assertRaisesRegex(RuntimeError,'BILLING_TIMEZONE'):self.evaluate()
  self.ad['billing_timezone']='America/Los_Angeles';self.ad['monthly'].pop('2026-10')
  with self.assertRaisesRegex(RuntimeError,'MONTHLY_ENVELOPES'):self.evaluate()
 def test_october_budget_can_block_first_and_later_slots(self):
  self.ad['monthly']['2026-10']['total_gross_usd']='100.1'
  for index in (0,1,2):
   self.context['slot']=self.ad['slots'][index];self.now=self.ad['slots'][index]
   with self.assertRaisesRegex(RuntimeError,'GROSS_BUDGET'):self.evaluate()
 def test_monthly_fields_and_conservation_are_closed(self):
  self.ad['monthly']['2026-12']['total_gross_usd']='80'
  with self.assertRaisesRegex(RuntimeError,'GROSS_BUDGET'):self.evaluate()
  self.ad['monthly']['2026-12']['credit']='10'
  with self.assertRaisesRegex(RuntimeError,'MONTHLY_FIELDS'):self.evaluate()
 def test_cost_producer_preserves_high_precision_previous_in_consumed_fields(self):
  import b02_quota_coverage as coverage
  from decimal import Decimal
  rates=dict(vcpu_second='0.000018',gib_second='0.000002',storage_gib_month='0.02',cross_region_gib='0.02',internet_gib='0.12',class_a_thousand='0.005',class_b_thousand='0.0004',logs_gib='0.50',tax_multiplier='1.16')
  cost=coverage.reserve_supplement(self.ad['slots'],monthly_totals={x:'90.0000000001'for x in ('2026-11','2026-12')},rates=rates,maximum_export_bytes=2**30+65536)
  self.ad['monthly']={month:{k:v for k,v in row.items()if k!='parts_pre_tax_usd'}for month,row in cost['monthly'].items()}
  with self.assertRaisesRegex(RuntimeError,'MONTHLY_ENVELOPES'):self.evaluate()
  self.ad['monthly']['2026-10']={'previous_gross_usd':'80','marginal_gross_usd':'1','total_gross_usd':'81'}
  self.evaluate()
  for row in self.ad['monthly'].values():self.assertGreaterEqual(Decimal(row['total_gross_usd']),Decimal(row['previous_gross_usd'])+Decimal(row['marginal_gross_usd']))
  with self.assertRaisesRegex(RuntimeError,'OVER_BUDGET'):
   coverage.reserve_supplement(self.ad['slots'],monthly_totals={'2026-11':'99.0950424141','2026-12':'90'},rates=rates,maximum_export_bytes=2**30+65536)
if __name__=='__main__':unittest.main()
