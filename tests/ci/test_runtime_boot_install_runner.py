from copy import deepcopy
from pathlib import Path
import sys
import unittest
sys.path[:0] = [str(Path(__file__).resolve().parents[2]/'scripts')]
import runtime_boot_install as bundle
import runtime_boot_install_runner as runner

ROOT=Path(__file__).resolve().parents[2]

class Adapter:
    def __init__(self):
        self.journal=None;self.targets={};self.effects=[];self.fences=0;self.terminal=None
        self.lose_response=False;self.lose_effect=False;self.reject_fence=None;self.drift=None
    def authorize(self,context,policy):
        self.fences+=1
        if self.fences==self.reject_fence:raise RuntimeError('NATIVE_GATE_EXPIRED')
    def open_journal(self,context):
        if self.journal is None:self.journal={'context':deepcopy(context),'actions':{}}
        return deepcopy(self.journal)
    def read_journal(self):return deepcopy(self.journal)
    def confirm(self,kind,name,raw):
        if self.drift==(kind,name) and len(self.effects)>5:return False
        return self.targets.get((kind,name),False)==raw
    def observe_action(self,action,payload):self.journal['actions'][action]={'payload':payload,'status':'INTENT'}
    def commit_intent(self,action,payload):
        assert action not in self.journal['actions'];self.observe_action(action,payload)
    def dispatch_once(self,kind,name,raw):
        assert self.journal['actions'][kind+':'+name]['status']=='INTENT'
        self.effects.append((kind,name))
        if not self.lose_effect:self.targets[(kind,name)]=raw
        if self.lose_response or self.lose_effect:raise OSError('synthetic lost acknowledgement')
    def confirm_action(self,action,payload):
        assert self.journal['actions'][action]['payload']==payload
        self.journal['actions'][action]['status']='CONFIRMED'
    def unknown(self,action,_failed):assert self.journal['actions'][action]['status']=='INTENT'
    def complete(self,result):self.terminal=result;return result

class InstallRunnerTests(unittest.TestCase):
    def setUp(self):
        self.bundle=bundle.prepare(ROOT,'a'*40);self.policy=runner.sealed({'synthetic':'authority supplied by adapter'})
        self.adapter=Adapter()
    def run_install(self):return runner.run(self.adapter,self.bundle,self.policy)
    def test_effects_order_intent_then_fence_then_install_no_container_start(self):
        result=self.run_install();self.assertEqual(result['status'],'HOST_BOOT_INSTALLED_REBOOT_NOT_VERIFIED')
        self.assertFalse(result['reboot_verified']);self.assertEqual(result['container_starts'],0)
        self.assertEqual(self.adapter.effects[-4:],[('reload','systemd'),('enable','containerd.service'),('enable','docker.service'),('enable',bundle.UNIT)])
        self.assertEqual(self.adapter.fences,len(self.adapter.effects)+2)
    def test_ambiguous_effect_only_reconciles_without_second_dispatch(self):
        self.adapter.lose_effect=True
        with self.assertRaisesRegex(RuntimeError,'UNKNOWN_NO_RETRY'):self.run_install()
        self.adapter.lose_effect=False
        with self.assertRaisesRegex(RuntimeError,'UNKNOWN_NO_RETRY'):self.run_install()
        self.assertEqual(self.adapter.effects,[('directory','base')]);self.assertIsNone(self.adapter.terminal)
    def test_lost_acknowledgement_with_exact_postcondition_can_continue(self):
        self.adapter.lose_response=True;self.run_install();first=list(self.adapter.effects)
        self.run_install();self.assertEqual(self.adapter.effects,first)
    def test_post_cas_fence_rejects_before_first_effect(self):
        self.adapter.reject_fence=2
        with self.assertRaisesRegex(RuntimeError,'NATIVE_GATE_EXPIRED'):self.run_install()
        self.assertEqual(self.adapter.effects,[]);self.assertIn('directory:base',self.adapter.journal['actions'])
    def test_changed_context_never_reuses_old_install_journal(self):
        self.run_install();self.policy=runner.sealed({'changed':'approval'})
        with self.assertRaisesRegex(RuntimeError,'JOURNAL_CHANGED'):self.run_install()
    def test_final_readback_never_trusts_earlier_file_confirmation(self):
        self.adapter.drift=('directory','base')
        with self.assertRaisesRegex(RuntimeError,'FINAL_READBACK_CHANGED'):self.run_install()
        self.assertIsNone(self.adapter.terminal)
    def test_out_of_scope_existing_journal_rejected(self):
        self.run_install();self.adapter.journal['actions']['start:sessions']={}
        with self.assertRaisesRegex(RuntimeError,'ACTION_SCOPE_CHANGED'):self.run_install()
    def test_missing_full_authority_has_zero_effects_or_journal(self):
        self.adapter.reject_fence=1
        with self.assertRaisesRegex(RuntimeError,'NATIVE_GATE_EXPIRED'):self.run_install()
        self.assertEqual(self.adapter.effects,[]);self.assertIsNone(self.adapter.journal)

if __name__=='__main__':unittest.main()
