import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pool,withTransaction,getRecord,decrypt,hash,appendEvent,readOperationalSettings} from '@commerce/db';
import {canonicalIdentity} from '@commerce/messaging';
import {providerFor,assertGatewayIsolation,type ProviderFactory} from './providers.js';
import {ownerId} from './dispatch.js';

/** Profile operations are explicit pool-authorized effects. Uncertain changes never retry blindly. */
export async function prepareWarmupProfiles(factory:ProviderFactory=providerFor,owner=ownerId){
 await pool.query("UPDATE warmup_identities SET profile_operation_status='UNKNOWN' WHERE profile_operation_status='APPLYING' AND profile_attempt_at<now()-interval '5 minutes'");
 const candidates=(await pool.query(`SELECT i.id FROM warmup_identities i JOIN warmup_states s ON s.account_id=i.account_id JOIN warmup_pools p ON p.id=s.pool_id WHERE i.profile_verified_at IS NULL AND (i.profile_operation_status IS NULL OR (i.profile_operation_status='UNKNOWN' AND i.profile_review_requested_at IS NOT NULL)) AND p.enabled AND NOT p.paused AND NOT p.breaker_open AND NOT s.paused AND s.enrolled_at IS NOT NULL LIMIT 10`)).rows;
 for(const candidate of candidates){
  const claim=await withTransaction(async c=>{
   const identity=(await c.query("SELECT * FROM warmup_identities WHERE id=$1 AND (profile_operation_status IS NULL OR (profile_operation_status='UNKNOWN' AND profile_review_requested_at IS NOT NULL)) FOR UPDATE SKIP LOCKED",[candidate.id])).rows[0];if(!identity)return;
   const state=(await c.query('SELECT * FROM warmup_states WHERE account_id=$1',[identity.account_id])).rows[0];const p=(await c.query('SELECT * FROM warmup_pools WHERE id=$1 AND enabled AND NOT paused AND NOT breaker_open FOR SHARE',[state.pool_id])).rows[0];if(!p||state.paused||state.confirmed_block||state.status==='QUARANTINED')return;
   const account=await getRecord(c,identity.workspace_id,'channel_account',identity.account_id);if(!account||account.body.status!=='WORKING'||account.body.deleted_at||account.body.identity_verified!==true||account.body.identity_conflict)return;
   if(account.environment==='SIMULATION'&&account.body.provider!=='simulator')return;
   const ownership=(await c.query('SELECT 1 FROM session_ownership WHERE account_id=$1 AND owner_id=$2 AND NOT frozen AND lease_expires_at>now()+interval \'5 seconds\'',[account.id,owner])).rowCount;if(!ownership)return;
   if((await c.query("SELECT 1 FROM manual_controls WHERE workspace_id=$1 AND paused AND (scope_type='workspace' OR (scope_type='channel_account' AND scope_id=$2))",[account.workspace_id,account.id])).rowCount)return;
   const authorization=(await c.query('SELECT * FROM read_locked_operation_authorization($1,$2,$3)',[p.authorization_id,account.workspace_id,account.environment])).rows[0];if(!authorization||authorization.scope?.mode!=='warmup'||authorization.scope?.pool_id!==p.id||!authorization.scope?.account_ids?.includes(account.id))return;
   if(account.environment==='REAL'){const policy=await readOperationalSettings(c,account.workspace_id,account.environment,{lock:'share'});if(policy.body.dispatch_frozen||!policy.body.allow_real_operations||!policy.body.real_sends_enabled||authorization.configuration_version!==policy.version)return;await assertGatewayIsolation(account,c);}
   await c.query("UPDATE warmup_identities SET profile_operation_status='APPLYING',profile_attempt_at=now(),profile_review_requested_at=NULL WHERE id=$1",[identity.id]);return{identity,account,authorization,readOnlyReview:identity.profile_operation_status==='UNKNOWN'};
  });if(!claim)continue;
  let verified=false;
  try{
   const expected=JSON.parse(decrypt(claim.identity.profile_ciphertext));
   if(claim.account.environment==='SIMULATION'){verified=true;}
   else{
    const provider=await factory(claim.account);if(!provider.profile)throw Error('PROFILE_CAPABILITY_UNAVAILABLE');
    const before=await provider.profile();if(hash(canonicalIdentity(before.identity))!==claim.identity.address_fingerprint||hash(before.identity)!==claim.account.body.identity_fingerprint)throw Error('PROFILE_IDENTITY_CHANGED');
    if(claim.authorization.scope.allow_profile_updates&&!claim.readOnlyReview){
     if(!provider.updateProfile)throw Error('PROFILE_CAPABILITY_UNAVAILABLE');let picture;
     if(expected.avatar_asset_id){const asset=await getRecord(pool,claim.account.workspace_id,'asset',expected.avatar_asset_id);if(!asset||asset.environment!==claim.account.environment||asset.body.status!=='READY'||!/^[a-f0-9-]{36}(?:-[a-f0-9]{64})?$/.test(asset.body.storage_key))throw Error('PROFILE_ASSET_INVALID');const root=process.env.PRIVATE_STORAGE_DIR??process.env.ASSET_STORAGE_DIR;if(!root)throw Error('PRIVATE_STORAGE_REQUIRED');picture={bytes:Buffer.from(decrypt(await readFile(join(root,'assets',asset.body.storage_key+'.enc'),'utf8')),'base64'),mimeType:asset.body.mime_type};}
     // Check every PUT: reading the remote profile/assets may outlive a lease or approval.
     const beforeMutation=()=>withTransaction(async c=>{
      const current=await getRecord(c,claim.account.workspace_id,'channel_account',claim.account.id);
      if(!current||current.body.deleted_at||current.body.status!=='WORKING'||['BLOCKED','UNKNOWN'].includes(current.body.health_status)||current.body.identity_verified!==true||current.body.identity_conflict||current.body.identity_fingerprint!==claim.account.body.identity_fingerprint)throw Error('PROFILE_IDENTITY_CHANGED');
      const live=(await c.query(`SELECT 1 FROM warmup_pools p JOIN warmup_states s ON s.pool_id=p.id JOIN warmup_identities i ON i.id=s.identity_id WHERE p.id=$1 AND p.authorization_id=$2 AND p.enabled AND NOT p.paused AND NOT p.breaker_open AND s.account_id=$3 AND NOT s.paused AND NOT s.confirmed_block AND s.status<>'QUARANTINED' AND i.id=$4 AND i.profile_operation_status='APPLYING' AND i.profile_ciphertext=$5`,[claim.authorization.scope.pool_id,claim.authorization.id,current.id,claim.identity.id,claim.identity.profile_ciphertext])).rowCount;
      if(!live)throw Error('PROFILE_AUTHORIZATION_CHANGED');
      const auth=(await c.query('SELECT * FROM read_locked_operation_authorization($1,$2,$3)',[claim.authorization.id,current.workspace_id,current.environment])).rows[0];
      const policy=await readOperationalSettings(c,current.workspace_id,current.environment,{lock:'share'});
      if(!auth||auth.scope?.allow_profile_updates!==true||auth.scope?.mode!=='warmup'||!auth.scope?.account_ids?.includes(current.id)||auth.configuration_version!==policy.version||policy.body.dispatch_frozen||!policy.body.allow_real_operations||!policy.body.real_sends_enabled)throw Error('PROFILE_AUTHORIZATION_CHANGED');
      if(!(await c.query("SELECT 1 FROM session_ownership WHERE account_id=$1 AND owner_id=$2 AND NOT frozen AND lease_expires_at>now()+interval '20 seconds'",[current.id,owner])).rowCount)throw Error('PROFILE_OWNERSHIP_CHANGED');
      if((await c.query("SELECT 1 FROM manual_controls WHERE workspace_id=$1 AND (paused OR suppressed OR takeover) AND (scope_type='workspace' OR (scope_type='channel_account' AND scope_id=$2))",[current.workspace_id,current.id])).rowCount)throw Error('PROFILE_MANUALLY_STOPPED');
      await assertGatewayIsolation(current,c);
     });
     await beforeMutation();await provider.updateProfile({name:expected.name,about:expected.about,picture},beforeMutation);
    }
    const after=await provider.profile();verified=after.name===expected.name&&hash(canonicalIdentity(after.identity))===claim.identity.address_fingerprint;
   }
  }catch{/* Private provider payloads never enter logs or notes. Uncertain update remains inspectable. */}
  await withTransaction(async c=>{await c.query("UPDATE warmup_identities SET profile_verified_at=CASE WHEN $2 THEN now() ELSE NULL END,profile_operation_status=CASE WHEN $2 THEN 'VERIFIED' ELSE 'UNKNOWN' END WHERE id=$1",[claim.identity.id,verified]);await appendEvent(c,{workspace_id:claim.account.workspace_id,environment:claim.account.environment,event_type:verified?'warmup.profile.verified':'warmup.profile.uncertain',aggregate_id:claim.account.id,payload:{identity_id:claim.identity.id,verification:claim.account.environment==='SIMULATION'?'SIMULATED':'PROVIDER_NAME_AND_IDENTITY',read_only_review:claim.readOnlyReview,about_observation:verified&&claim.authorization.scope.allow_profile_updates&&!claim.readOnlyReview?'PROVIDER_UPDATE_ACCEPTED':'NOT_OBSERVABLE',reason:verified?null:'PROFILE_REVIEW_REQUIRED'}});});
 }
 return candidates.length;
}
