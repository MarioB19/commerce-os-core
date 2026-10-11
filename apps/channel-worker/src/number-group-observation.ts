import {pool,withTransaction,getRecord,decrypt,readOperationalSettings,type QueryExecutor} from '@commerce/db';
import {observeGroup} from '../../../packages/db/src/warmup-groups.js';
import {numberNow} from '../../../packages/db/src/number-clock.js';
import {providerFor,type ProviderFactory} from './providers.js';
/** Read-only provider probes, claimed across replicas; independent of dispatch and heartbeat. */
export async function refreshActiveNumberGroups(owner:string,factory:ProviderFactory=providerFor){
 const groups=await withTransaction(async(c:QueryExecutor)=>{
  // Lock all policy scopes in one order before taking any group row lock. The
  // global last_probe_at queue stays fair; held scopes do not consume its five.
  const scopes=(await c.query(`SELECT DISTINCT g.workspace_id,g.environment FROM warmup_groups g
   WHERE(g.probe_until IS NULL OR g.probe_until<now())
   AND EXISTS(SELECT 1 FROM warmup_pools p WHERE p.group_id=g.id AND p.enabled AND NOT p.paused)
   ORDER BY g.workspace_id,g.environment`)).rows;
  const eligible:typeof scopes=[];
  for(const scope of scopes){
   if(scope.environment==='REAL'&&(await readOperationalSettings(c,scope.workspace_id,'REAL',{lock:'share'})).release_hold)continue;
   eligible.push(scope);
  }
  if(!eligible.length)return[];
  return(await c.query(`WITH candidates AS (
 SELECT g.id FROM warmup_groups g WHERE(g.probe_until IS NULL OR g.probe_until<now())
 AND EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS scope(workspace_id text,environment text) WHERE scope.workspace_id=g.workspace_id AND scope.environment=g.environment)
 AND EXISTS(SELECT 1 FROM warmup_pools p WHERE p.group_id=g.id AND p.enabled AND NOT p.paused)
 ORDER BY g.last_probe_at NULLS FIRST,g.id FOR UPDATE SKIP LOCKED LIMIT 5)
 UPDATE warmup_groups g SET probe_until=now()+interval '60 seconds',probe_owner=$1,last_probe_at=now()
 FROM candidates c WHERE g.id=c.id RETURNING g.*`,[owner,JSON.stringify(eligible)])).rows;
 });
 const work=groups.flatMap(g=>g.members.filter((m:any)=>m.account_id).map((m:any)=>({group:g,accountId:m.account_id})));
 const failures=new Set<string>(),deadline=Date.now()+45000;let cursor=0;
 await Promise.all(Array.from({length:Math.min(4,work.length)},async()=>{while(cursor<work.length&&Date.now()<deadline){const item=work[cursor++];try{const account=await getRecord(pool,item.group.workspace_id,'channel_account',item.accountId);if(!account||account.environment!==item.group.environment)throw Error('GROUP_ACCOUNT_SCOPE_INVALID');const observe=async()=>{const provider=await factory(account);if(!provider.group)throw new Error('GROUP_PROVIDER_UNSUPPORTED');return provider.group(decrypt(item.group.group_ciphertext));};const snapshot=account.environment==='REAL'?await withTransaction(async c=>{if((await readOperationalSettings(c,account.workspace_id,'REAL',{lock:'share'})).release_hold)throw new Error('RELEASE_HOLD_ACTIVE');return observe();}):await observe();await withTransaction(async c=>{if(account.environment==='REAL'&&(await readOperationalSettings(c,account.workspace_id,'REAL',{lock:'share'})).release_hold)throw new Error('RELEASE_HOLD_ACTIVE');if(!(await c.query('SELECT id FROM warmup_groups WHERE id=$1 AND probe_owner=$2 AND probe_until>now()',[item.group.id,owner])).rowCount)throw Error('GROUP_PROBE_CLAIM_LOST');return observeGroup(c,account,snapshot,await numberNow(c,account.workspace_id,account.environment));});}catch{failures.add(item.group.id);}}}));
 for(const g of groups)await withTransaction(async c=>{if(g.environment==='REAL'&&(await readOperationalSettings(c,g.workspace_id,'REAL',{lock:'share'})).release_hold)return;await c.query('UPDATE warmup_groups SET probe_until=NULL,probe_owner=NULL WHERE id=$1 AND probe_owner=$2',[g.id,owner]);});
 return{groups:groups.length,failed:failures.size};
}
