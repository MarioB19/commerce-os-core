import {afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {pool,putRecord,getRecord,hash,encrypt,stableJson,withTransaction,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {canonicalIdentity} from '../../packages/messaging/src/index.js';
import {warmupProfileSchema} from '../../packages/domain/src/warmup/policy.js';
import {commercialWarmupGuard} from '../../packages/db/src/warmup.js';
import {planWarmupPool} from '../../apps/automation-worker/src/warmup.js';
import {gateWarmupDispatch} from '../../apps/channel-worker/src/warmup.js';

afterAll(async()=>pool.end());

// Synthetic REAL records exercise the production guards; no provider or HTTP is invoked.
async function fixture(){
 const workspace='warm-identity-'+randomUUID(),owner='fixture-'+randomUUID(),now=new Date();
 const offset=now.getUTCHours()-12,timezone=`Etc/GMT${offset>=0?'+':''}${offset}`;
 const profile=(await pool.query("INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,'REAL',$2) RETURNING *",[workspace,warmupProfileSchema.parse({policy_version:'legacy-30d/v1',name:'Own identity fixture',timezone,start_hour:0,end_hour:23,profile_wait_hours:12,weekend_factor:1})])).rows[0];
 const group=(await pool.query("INSERT INTO warmup_pools(workspace_id,environment,profile_id,enabled,allow_small_pool_concentration) VALUES($1,'REAL',$2,true,true) RETURNING *",[workspace,profile.id])).rows[0];
 const accounts=[];
 for(const providerIdentity of ['19995550123@c.us','19995550124@c.us']){
  const account=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic owned number',provider:'waha',gateway_ref:'fixture',session:randomUUID(),status:'WORKING',health_status:'OK',sending_enabled:false,identity_verified:true,identity_conflict:false,identity_fingerprint:hash(providerIdentity)}});
  const identity=(await pool.query("INSERT INTO warmup_identities(workspace_id,environment,account_id,address_fingerprint,address_ciphertext,profile_ciphertext,ownership_evidence,profile_verified_at) VALUES($1,'REAL',$2,$3,$4,$5,'Synthetic own number only',now()-interval '25 hours') RETURNING *",[workspace,account.id,hash(canonicalIdentity(providerIdentity)),encrypt(canonicalIdentity(providerIdentity)),encrypt({name:'Owned fixture',about:'No remote operation'})])).rows[0];
  await pool.query("INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,identity_id,profile_id,status,enrolled_at,profile_ready_at) VALUES($1,$2,'REAL',$3,$4,$5,'WARMING',now()-interval '2 days',now()-interval '13 hours')",[account.id,workspace,group.id,identity.id,profile.id]);
  await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,$3,1,false,now()+interval '1 hour')",[account.id,workspace,owner]);
  for(const dimension of ['session','transport'])await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:account.id,dimension,status:'OK',scope:'account',source:'synthetic-fixture',value:dimension==='transport'?{identity_fingerprint:hash(providerIdentity)}:'WORKING',observed_at:now.toISOString(),expires_at:new Date(now.getTime()+3600000).toISOString()}});
  await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:account.id,dimension:'restriction',status:'OK',scope:'account',source:'provider_read',value:{latest_read:{timelock:true,capping:true}},observed_at:now.toISOString(),expires_at:new Date(now.getTime()+3600000).toISOString()}});
  accounts.push({...account,providerIdentity});
 }
 const settings=await withTransaction(async c=>{const initial=await readOperationalSettings(c,workspace,'REAL');return writeOperationalSettings(c,workspace,'REAL',initial.version,{...initial.body,dispatch_frozen:false,allow_real_operations:true,real_sends_enabled:true},'synthetic-fixture');});
 const body={label:'Synthetic own exchange',turns:Array.from({length:6},(_,i)=>({kind:'text',text:'Synthetic turn '+i}))};
 const content=(await pool.query("INSERT INTO warmup_content(workspace_id,environment,content_hash,body,approved_by) VALUES($1,'REAL',$2,$3,'synthetic-fixture') RETURNING *",[workspace,hash(stableJson(body)),body])).rows[0];
 const scope={mode:'warmup',pool_id:group.id,account_ids:accounts.map(a=>a.id),content_ids:[content.id],max_messages:100,allow_profile_updates:false};
 const authorization=(await pool.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at,configuration_version) VALUES($1,'REAL','synthetic-fixture',$2,$3,now()+interval '1 hour',$4) RETURNING id",[workspace,scope,hash(stableJson(scope)),settings.version])).rows[0];
 group.authorization_id=authorization.id;await pool.query('UPDATE warmup_pools SET authorization_id=$2 WHERE id=$1',[group.id,authorization.id]);
 await withTransaction(c=>planWarmupPool(c,group,now));
 await pool.query("UPDATE warmup_turns SET not_before=now()-interval '1 second' WHERE workspace_id=$1",[workspace]);
 await pool.query('UPDATE outbox o SET not_before=t.not_before FROM warmup_turns t WHERE o.id=t.effect_id AND o.workspace_id=$1',[workspace]);
 const effect=(await pool.query('SELECT * FROM outbox WHERE workspace_id=$1 ORDER BY dispatch_sequence LIMIT 1',[workspace])).rows[0];
 const changeVerifiedIdentity=async(accountId:string,providerIdentity:string)=>{
  const current=(await getRecord(pool,workspace,'channel_account',accountId))!;
  const updated=await putRecord(pool,{id:current.id,workspaceId:workspace,environment:'REAL',kind:'channel_account',version:current.version,body:{...current.body,identity_verified:true,identity_conflict:false,identity_fingerprint:hash(providerIdentity)}});
  await pool.query("UPDATE records SET body=jsonb_set(body,'{value}',jsonb_build_object('identity_fingerprint',$2::text)),version=version+1 WHERE workspace_id=$1 AND kind='health_signal' AND body->>'account_id'=$3 AND body->>'dimension'='transport'",[workspace,hash(providerIdentity),accountId]);
  return updated;
 };
 return{workspace,owner,accounts,effect,changeVerifiedIdentity};
}

it.each(['sender','recipient'] as const)('blocks a replaced %s number even when the current session and transport identity are verified',async endpoint=>{
 const f=await fixture();
 expect((await withTransaction(c=>gateWarmupDispatch(c,f.effect,f.owner))).allowed).toBe(true);
 await f.changeVerifiedIdentity(endpoint==='sender'?f.effect.account_id:f.effect.contact_id,'12025550178@c.us');
 expect(await withTransaction(c=>gateWarmupDispatch(c,f.effect,f.owner))).toEqual({allowed:false,reason:'WARMUP_REGISTERED_IDENTITY_CHANGED'});
 expect((await pool.query('SELECT status,attempts FROM outbox WHERE id=$1',[f.effect.id])).rows[0]).toEqual({status:'READY',attempts:0});
});

it('does not transfer graduation or commercial eligibility to a replacement number',async()=>{
 const f=await fixture(),account=f.accounts[0]!;
 await pool.query("UPDATE warmup_states SET status='GRADUATED',effective_days=30,graduated_at=now() WHERE account_id=$1",[account.id]);
 await pool.query('UPDATE warmup_pools SET enabled=false WHERE id=(SELECT pool_id FROM warmup_states WHERE account_id=$1)',[account.id]);
 expect(await commercialWarmupGuard(pool,account)).toBeNull();
 const replacement=await f.changeVerifiedIdentity(account.id,'12025550178@c.us');
 expect(await commercialWarmupGuard(pool,replacement)).toBe('WARMUP_REGISTERED_IDENTITY_CHANGED');
 expect((await pool.query('SELECT status,effective_days FROM warmup_states WHERE account_id=$1',[account.id])).rows[0]).toEqual({status:'GRADUATED',effective_days:30});
});

it('accepts a provider JID representation change for the same registered number',async()=>{
 const f=await fixture();
 for(const account of f.accounts)await f.changeVerifiedIdentity(account.id,account.providerIdentity.replace('@c.us','@s.whatsapp.net'));
 expect((await withTransaction(c=>gateWarmupDispatch(c,f.effect,f.owner))).allowed).toBe(true);
});
