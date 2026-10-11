import {it,expect,afterAll} from 'vitest';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {writeOperationalSettings,readOperationalSettings} from '../../packages/db/src/operational-settings.js';
import {defaultOperationalSettings} from '../../packages/contracts/src/index.js';
const workspace='release-'+randomUUID();
afterAll(async()=>pool.end());
it('executes the installer freeze and attestation SQL with real constraints and audit records',async()=>{
 const account=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{provider:'waha',name:'Synthetic release session'}});
 await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,lease_expires_at,frozen) VALUES($1,$2,'old-fixture-owner',3,now()-interval '1 minute',false)",[account.id,workspace]);
 await withTransaction(c=>writeOperationalSettings(c,workspace,'REAL',0,{...defaultOperationalSettings,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true},'fixture'));
 // Explicit recovery fixtures, not evidence of delivery or preparation progress.
 const numberPrograms=[];
 for(const [environment,status]of [['REAL','ACTIVE'],['REAL','COMPLETED'],['SIMULATION','ACTIVE']]){
  const profile=(await pool.query('INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,$2,$3) RETURNING id',[workspace,environment,{policy_version:'standard-15d/v1'}])).rows[0];
  const groupPool=(await pool.query("INSERT INTO warmup_pools(workspace_id,environment,profile_id,enabled,topology) VALUES($1,$2,$3,true,'group') RETURNING id",[workspace,environment,profile.id])).rows[0];
  const draft=(await pool.query("INSERT INTO warmup_programs(workspace_id,environment,actor_id,name,topology,profile_id,account_ids,status,pool_id,review_hash) VALUES($1,$2,'fixture','Recovery fixture','group',$3,$4,$5,$6,$7) RETURNING id",[workspace,environment,profile.id,[account.id],status,groupPool.id,'a'.repeat(64)])).rows[0];
  await pool.query('UPDATE warmup_pools SET program_id=$2 WHERE id=$1',[groupPool.id,draft.id]);numberPrograms.push({id:draft.id,pool_id:groupPool.id,environment,status});
 }
 // Docker isolation behavior is covered by the Python unit suite. Here its
 // verified synthetic evidence is used to exercise the actual generated SQL.
 const program=`import importlib.util,json,tempfile,sys,pathlib,datetime
spec=importlib.util.spec_from_file_location('attestation','scripts/ownership-isolation-receipts.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
queries=[]
def database(release,sql):
 if 'to_regclass' in sql:return 't'
 if 'information_schema.columns' in sql:return '0'
 queries.append(sql);return '[]' if 'row_to_json(c)' in sql else '1'
m.database=database;m.compose=lambda *a,**k:'newcontainer';m.freeze('fixture.env')
m.container_ids=lambda *a:['b'*64]
m.inspect=lambda value:None if value=='a'*64 else {'id':'b'*64,'running':True,'project':'commerce-os','service':'channel-worker'}
snapshot={'captured_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'containers':[{'id':'a'*64,'project':'commerce-os','service':'channel-worker'}],'owners':[{'account_id':sys.argv[1],'workspace_id':sys.argv[2],'previous_owner_id':'old-fixture-owner','generation':3}]}
with tempfile.TemporaryDirectory() as temp:
 p=pathlib.Path(temp)/'proof.json';m.private_write(p,snapshot);m.attest('fixture.env',p)
print(json.dumps(queries))`;
 const statements:string[]=JSON.parse(execFileSync('python3',['-c',program,account.id,workspace],{encoding:'utf8'}));expect(statements).toHaveLength(5);
 for(const sql of statements)await pool.query(sql);
 const settings=await readOperationalSettings(pool,workspace,'REAL');expect(settings.version).toBe(2);expect(settings.body).toMatchObject({dispatch_frozen:true,real_sends_enabled:false,allow_real_operations:false});
 for(const fixture of numberPrograms){const saved=(await pool.query('SELECT status,review_hash FROM warmup_programs WHERE id=$1',[fixture.id])).rows[0],savedPool=(await pool.query('SELECT enabled,paused FROM warmup_pools WHERE id=$1',[fixture.pool_id])).rows[0];expect(saved.status).toBe(fixture.environment==='SIMULATION'?'ACTIVE':fixture.status==='COMPLETED'?'COMPLETED':'PAUSED');if(fixture.environment==='REAL'){expect(savedPool).toEqual({enabled:false,paused:true});if(fixture.status==='ACTIVE')expect(saved.review_hash).toBeNull();}else expect(savedPool.enabled).toBe(true);}
 const receipts=(await pool.query('SELECT * FROM ownership_isolation_receipts WHERE workspace_id=$1',[workspace])).rows;expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({previous_owner_id:'old-fixture-owner',generation:3,method:'container_stopped_and_access_revoked',consumed_at:null});
 expect((await pool.query("SELECT event_type FROM domain_events WHERE workspace_id=$1 ORDER BY event_type",[workspace])).rows.map(x=>x.event_type)).toEqual(['channel.isolation_attested','operational_settings.release_frozen']);
 await pool.query(statements.find(sql=>sql.includes('INSERT INTO ownership_isolation_receipts'))!);expect((await pool.query('SELECT 1 FROM ownership_isolation_receipts WHERE workspace_id=$1',[workspace])).rowCount).toBe(1);
});

it('holds a compatible release without revoking grants and queues only a fenced health read',async()=>{
 const ws='release-hold-'+randomUUID(),account=await putRecord(pool,{workspaceId:ws,environment:'REAL',kind:'channel_account',body:{provider:'waha',name:'Synthetic continuity session',sending_enabled:true}});
 const policy=await withTransaction(c=>writeOperationalSettings(c,ws,'REAL',0,{...defaultOperationalSettings,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true},'fixture'));
 await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,lease_expires_at,frozen) VALUES($1,$2,'old-continuity-owner',4,now()+interval '1 minute',false)",[account.id,ws]);
 const explicitlyFrozen=await putRecord(pool,{workspaceId:ws,environment:'REAL',kind:'channel_account',body:{provider:'waha',name:'Synthetic explicit freeze'}});
 await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,lease_expires_at,frozen) VALUES($1,$2,'frozen-continuity-owner',8,now()+interval '1 minute',true)",[explicitlyFrozen.id,ws]);
 const program=`import importlib.util,json
spec=importlib.util.spec_from_file_location('attestation','scripts/ownership-isolation-receipts.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
queries=[]
m.supports_hold=lambda *_:True
m.database=lambda _,sql:queries.append(sql) or '1|1'
m.hold('fixture.env');m.hold('fixture.env',True);m.release_hold('fixture.env')
print(json.dumps(queries))`;
 const [hold,recoveryHold,release]:string[]=JSON.parse(execFileSync('python3',['-c',program],{encoding:'utf8'}));
 await pool.query(hold!);
 const held=await readOperationalSettings(pool,ws,'REAL');expect(held.version).toBe(policy.version);expect(held.body.dispatch_frozen).toBe(true);expect(held.release_hold).toBe(true);
 const originalBoundary=(await pool.query('SELECT release_hold_at,version,body FROM operational_settings WHERE workspace_id=$1 AND environment=\'REAL\'',[ws])).rows[0];
 await pool.query(recoveryHold!);await pool.query(recoveryHold!);
 expect((await pool.query('SELECT release_hold_at,version,body FROM operational_settings WHERE workspace_id=$1 AND environment=\'REAL\'',[ws])).rows[0]).toEqual(originalBoundary);
 expect((await pool.query('SELECT frozen,release_frozen FROM session_ownership WHERE account_id=$1',[explicitlyFrozen.id])).rows[0]).toEqual({frozen:true,release_frozen:false});
 await expect(pool.query(hold!)).rejects.toThrow('RELEASE_HOLD_ALREADY_ACTIVE');
 expect((await pool.query('SELECT frozen,release_frozen FROM session_ownership WHERE account_id=$1',[account.id])).rows[0]).toEqual({frozen:true,release_frozen:true});
 await pool.query("INSERT INTO ownership_isolation_receipts(account_id,workspace_id,previous_owner_id,generation,method,evidence_sha256,verified_at) VALUES($1,$2,'old-continuity-owner',4,'container_stopped_and_access_revoked',$3,now())",[account.id,ws,'f'.repeat(64)]);
 await pool.query(release!);
 const after=await readOperationalSettings(pool,ws,'REAL');expect(after.version).toBe(policy.version);expect(after.release_hold).toBe(false);expect(after.body.dispatch_frozen).toBe(false);
 expect((await pool.query("SELECT count(*)::int n FROM commands WHERE workspace_id=$1 AND payload->>'type'='check_health' AND status='PENDING'",[ws])).rows[0].n).toBe(1);
 expect((await pool.query('SELECT frozen,release_frozen,lease_expires_at<=now() expired FROM session_ownership WHERE account_id=$1',[account.id])).rows[0]).toMatchObject({frozen:true,release_frozen:true,expired:true});
 expect((await pool.query('SELECT frozen,release_frozen FROM session_ownership WHERE account_id=$1',[explicitlyFrozen.id])).rows[0]).toEqual({frozen:true,release_frozen:false});
 await pool.query(release!);
 expect((await pool.query("SELECT count(*)::int n FROM commands WHERE workspace_id=$1 AND payload->>'type'='check_health'",[ws])).rows[0].n).toBe(1);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[ws])).rows[0].n).toBe(0);
 await pool.query("DELETE FROM commands WHERE workspace_id=$1 AND payload->>'type'='check_health'",[ws]);
});
