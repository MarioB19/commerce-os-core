"""Real cleanup module exercised with a strict native-metadata port, no database."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest
ROOT=Path(__file__).resolve().parents[2]
MODULE=(ROOT/'scripts/integration-role-custody.mjs').as_uri()
class RoleCustodyTests(unittest.TestCase):
    def exercise(self, scenario):
        source="""
import {captureIntegrationRoles,prepareIntegrationRoleCleanup,finishIntegrationRoleCleanup} from MODULE;
const scenario=SCENARIO,queries=[],database='commerce_test_123_'+ 'a'.repeat(32);
const base={oid:'10',name:'postgres',login:true,superuser:true,bypass:true,create_db:true,create_role:true,replication:true,inherit:true,connection_limit:-1,config:[]};
const fresh={oid:'20',name:'commerce_ai',login:false,superuser:false,bypass:false,create_db:false,create_role:false,replication:false,inherit:true,connection_limit:-1,config:[]};
let roles=[structuredClone(base)],memberships=[],present=true,deps=[],error=null,result=null;
const client={async query(sql){queries.push(sql);if(sql.includes('integration-role-snapshot'))return{rows:structuredClone(roles)};
 if(sql.includes('integration-role-memberships'))return{rows:structuredClone(memberships)};
 if(sql.includes('integration-role-database'))return{rows:present?[{oid:'30'}]:[]};
 if(sql.includes('integration-role-dependencies'))return{rows:structuredClone(deps)};
 if(sql.startsWith('DROP ROLE')){roles=roles.filter(r=>r.oid!=='20');return{};}throw Error('UNEXPECTED_SQL');}};
try{
 if(scenario==='preexisting')roles.push(structuredClone(fresh));
 const baseline=await captureIntegrationRoles(client);
 if(scenario!=='preexisting')roles.push(structuredClone(fresh));
 if(scenario==='unknown')roles[1].name='unknown';
 if(scenario==='results_reader'){roles[1].name='commerce_results_reader';roles[1].inherit=false;}
 if(scenario==='results_reader_wrong_inherit')roles[1].name='commerce_results_reader';
 if(scenario==='result_custody'){roles[1].name='commerce_result_custody';roles[1].inherit=false;}
 if(scenario==='result_custody_wrong_inherit')roles[1].name='commerce_result_custody';
 if(scenario==='quota_owner'){roles[1].name='commerce_quota_owner';roles[1].inherit=false;}
 if(scenario==='quota_owner_wrong_inherit')roles[1].name='commerce_quota_owner';
 if(scenario==='global_budget_reader'){roles[1].name='commerce_global_budget_reader';roles[1].inherit=false;}
 if(scenario==='global_budget_reader_wrong_inherit')roles[1].name='commerce_global_budget_reader';
 if(scenario==='lab')roles[1].name='commerce_number_lab';
 if(scenario==='lab_owner')roles[1].name='commerce_number_lab_owner';
 if(scenario==='lab_wrong_inherit'){roles[1].name='commerce_number_lab';roles[1].inherit=false;}
 if(scenario==='login')roles[1].login=true;
 if(scenario==='config')roles[1].config=['test_setting=1'];
 if(scenario==='baseline_change')roles[0].login=false;
 if(scenario==='membership')memberships=[{role:'20',member:'10'}];
 if(scenario==='foreign')deps=[{database:'99',role:'20'}];
 else if(scenario!=='preexisting')deps=[{database:'30',role:'20'}];
 const plan=await prepareIntegrationRoleCleanup(client,baseline,database);
 present=scenario==='retained';deps=scenario==='remaining'?[{database:'99',role:'20'}]:[];
 if(scenario==='late_drift')roles[1].bypass=true;
 result=await finishIntegrationRoleCleanup(client,plan);
}catch(e){error=e.message;}
console.log(JSON.stringify({queries,error,result,roles}));
""".replace('MODULE',json.dumps(MODULE)).replace('SCENARIO',json.dumps(scenario))
        result=subprocess.run([shutil.which('node'),'--input-type=module','-e',source],capture_output=True,text=True,timeout=20,cwd=ROOT)
        self.assertEqual(result.returncode,0,result.stderr)
        return json.loads(result.stdout)
    def test_removes_only_a_reviewed_new_role_after_database_is_gone(self):
        r=self.exercise('success');self.assertIsNone(r['error']);self.assertEqual(r['result']['roles'],['commerce_ai']);self.assertEqual([q for q in r['queries'] if q.startswith('DROP')],['DROP ROLE "commerce_ai"']);self.assertEqual(len(r['roles']),1)
    def test_reviewed_laboratory_roles_require_their_original_inheritance(self):
        for scenario, name in [('lab','commerce_number_lab'),('lab_owner','commerce_number_lab_owner')]:
            r=self.exercise(scenario);self.assertIsNone(r['error']);self.assertEqual(r['result']['roles'],[name])
        r=self.exercise('lab_wrong_inherit');self.assertIsNotNone(r['error']);self.assertFalse(any(q.startswith('DROP') for q in r['queries']))
    def test_reviewed_results_reader_is_non_inheriting(self):
        r=self.exercise('results_reader');self.assertIsNone(r['error']);self.assertEqual(r['result']['roles'],['commerce_results_reader'])
        r=self.exercise('results_reader_wrong_inherit');self.assertIsNotNone(r['error']);self.assertFalse(any(q.startswith('DROP') for q in r['queries']))
    def test_reviewed_result_custody_is_non_inheriting(self):
        r=self.exercise('result_custody');self.assertIsNone(r['error']);self.assertEqual(r['result']['roles'],['commerce_result_custody'])
        r=self.exercise('result_custody_wrong_inherit');self.assertIsNotNone(r['error']);self.assertFalse(any(q.startswith('DROP') for q in r['queries']))
    def test_reviewed_quota_owner_is_non_inheriting(self):
        r=self.exercise('quota_owner');self.assertIsNone(r['error']);self.assertEqual(r['result']['roles'],['commerce_quota_owner'])
        r=self.exercise('quota_owner_wrong_inherit');self.assertIsNotNone(r['error']);self.assertFalse(any(q.startswith('DROP') for q in r['queries']))
    def test_reviewed_global_budget_reader_is_non_inheriting(self):
        r=self.exercise('global_budget_reader');self.assertIsNone(r['error']);self.assertEqual(r['result']['roles'],['commerce_global_budget_reader'])
        r=self.exercise('global_budget_reader_wrong_inherit');self.assertIsNotNone(r['error']);self.assertFalse(any(q.startswith('DROP') for q in r['queries']))
    def test_preexisting_role_is_preserved(self):
        r=self.exercise('preexisting');self.assertIsNone(r['error']);self.assertEqual(r['result']['roles'],[]);self.assertEqual(len(r['roles']),2);self.assertFalse(any(q.startswith('DROP') for q in r['queries']))
    def test_all_uncertain_or_foreign_shapes_fail_without_role_deletion(self):
        for scenario in ['unknown','login','config','baseline_change','membership','foreign','retained','remaining','late_drift']:
            with self.subTest(scenario=scenario):
                r=self.exercise(scenario);self.assertIsNotNone(r['error']);self.assertFalse(any(q.startswith('DROP') for q in r['queries']))
if __name__=='__main__':unittest.main()
