import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareIntegrationRoleCleanup} from '../integration-role-custody.mjs';
const database='commerce_test_123_'+'a'.repeat(32);
for(const name of ['commerce_privacy_reference_owner','commerce_privacy_reference_worker']){
const role={oid:'123',name,login:false,superuser:false,bypass:false,create_db:false,create_role:false,replication:false,inherit:false,connection_limit:-1,config:[]};
function client(current=role,foreign=false){return{query:async sql=>({rows:sql.includes('integration-role-snapshot')?[current]:sql.includes('integration-role-memberships')?[]:sql.includes('integration-role-database')?[{oid:'321'}]:sql.includes('integration-role-dependencies')?[{database:foreign?'999':'321',role:'123'}]:assert.fail('UNEXPECTED_SQL')})};}
test('035 cleanup admits only its exact new NOLOGIN NOINHERIT owner',async()=>{const plan=await prepareIntegrationRoleCleanup(client(),{roles:[],memberships:[]},database);assert.deepEqual(plan.created,[role]);});
test('035 owner remains rejected for inheritance, privilege or foreign name drift',async()=>{for(const patch of[{inherit:true},{login:true},{superuser:true},{bypass:true},{create_role:true},{config:['search_path=public']},{name:'unreviewed_owner'}])await assert.rejects(prepareIntegrationRoleCleanup(client({...role,...patch}),{roles:[],memberships:[]},database),/INTEGRATION_NEW_ROLE_UNREVIEWED/);});
test('035 preexisting owner never becomes cleanup authority; foreign dependencies reject',async()=>{assert.deepEqual((await prepareIntegrationRoleCleanup(client(),{roles:[role],memberships:[]},database)).created,[]);await assert.rejects(prepareIntegrationRoleCleanup(client(role,true),{roles:[],memberships:[]},database),/INTEGRATION_ROLE_FOREIGN_DEPENDENCY/);});

}
