import {createWarmupSimulation,readWarmupSimulation} from '../../../packages/db/src/warmup-simulation.js';
import {cancelUnsentWarmupPool,warmupPreflightRoutes} from './warmup-preflight.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {pool,type QueryExecutor,hash,stableJson,readOperationalSettings} from '../../../packages/db/src/index.js';
import {warmupOverview,registerWarmupIdentity} from '../../../packages/db/src/warmup.js';
import {STANDARD_V2_POLICY,warmupProfileSchema,warmupContentSchema,dailyBudget} from '../../../packages/domain/src/warmup/policy.js';
import {numberNow} from '../../../packages/db/src/number-clock.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {principal,envOf,parseBody,mutate,fail,scopedRecord,audit,assertResource,resourcePermitted,command} from './context.js';
const idOf=(req:FastifyRequest)=>z.object({id:z.string().uuid()}).parse(req.params).id;
function permit(req:FastifyRequest,write=false){const p=principal(req);assertPermission(p,p.service?write?'warmup:manage':'warmup:read':write?'channels:manage':'sales:read');return p;}
const revision=z.number().int().min(1),reason=z.string().trim().min(8).max(500);
async function lockedPool(req:FastifyRequest,c:QueryExecutor,id:string,expectedVersion:number){
 const p=principal(req);assertResource(p,id);
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`warmup-pool:${id}`]);
 const row=(await c.query('SELECT * FROM warmup_pools WHERE id=$1 AND workspace_id=$2 AND environment=$3 FOR UPDATE',[id,p.workspace_id,envOf(req)])).rows[0];
 if(!row)throw fail(404,'NOT_FOUND');if(row.program_id)throw fail(409,'NUMBER_PROGRAM_COMMAND_REQUIRED');if(row.version!==expectedVersion)throw fail(409,'VERSION_CONFLICT');return row;
}
async function ownExperimentalAccount(req:FastifyRequest,c:QueryExecutor,id:string){
 const account=await scopedRecord(req,'channel_account',id,c);
 if(account.body.provider==='cloud')throw fail(400,'CLOUD_WARMUP_NOT_APPLICABLE');
 if(account.body.provider!==(account.environment==='REAL'?'waha':'simulator'))throw fail(400,'WARMUP_PROVIDER_ENVIRONMENT_MISMATCH');
 return account;
}
async function revokePool(c:QueryExecutor,row:any){if(row.authorization_id)await c.query('UPDATE operation_authorizations SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND workspace_id=$2 AND environment=$3',[row.authorization_id,row.workspace_id,row.environment]);}
export async function warmupRoutes(app:FastifyInstance){
 await warmupPreflightRoutes(app);
 app.get('/v1/warmup',async req=>{const p=permit(req);const overview=await warmupOverview(pool,p.workspace_id,envOf(req),p.resource_ids??undefined);if(p.resource_ids&&overview.pool&&!p.resource_ids.includes(overview.pool.id)&&overview.accounts.length===0)return{data:{installed:true,enabled:false,pool:null,accounts:[],plans:[],pair_stats:[],jobs:[],provider_verified:false}};return{data:overview};});
 app.get('/v1/warmup/profiles',async req=>{const p=permit(req);return{data:(await pool.query('SELECT * FROM warmup_profiles WHERE workspace_id=$1 AND environment=$2 AND ($3::text[] IS NULL OR id::text=ANY($3)) ORDER BY created_at DESC',[p.workspace_id,envOf(req),p.resource_ids??null])).rows};});
 app.post('/v1/warmup/profiles',async(req,reply)=>{const p=permit(req,true),config=warmupProfileSchema.parse(parseBody(req));const result=await mutate(req,'warmup.profile.create',async c=>{const row=(await c.query('INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,$2,$3) RETURNING *',[p.workspace_id,envOf(req),config])).rows[0];await audit(c,req,'warmup.profile.created',row.id);return{data:row,status:201};});return reply.code(201).send({data:result.data});});
 app.post('/v1/warmup/pools',async(req,reply)=>{
  const p=permit(req,true),input=z.object({profile_id:z.string().uuid(),account_ids:z.array(z.string().uuid()).min(1).max(100),ownership_confirmed:z.literal(true),allow_small_pool_concentration:z.boolean().default(false),reason}).strict().parse(parseBody(req));
  const result=await mutate(req,'warmup.pool.create',async c=>{
   if(new Set(input.account_ids).size!==input.account_ids.length)throw fail(400,'DUPLICATE_ACCOUNTS');
   if(!(await c.query('SELECT 1 FROM warmup_profiles WHERE id=$1 AND workspace_id=$2 AND environment=$3',[input.profile_id,p.workspace_id,envOf(req)])).rowCount)throw fail(404,'PROFILE_NOT_FOUND');
   for(const id of input.account_ids)await ownExperimentalAccount(req,c,id);
   const row=(await c.query('INSERT INTO warmup_pools(workspace_id,environment,profile_id,allow_small_pool_concentration) VALUES($1,$2,$3,$4) RETURNING *',[p.workspace_id,envOf(req),input.profile_id,input.allow_small_pool_concentration])).rows[0];
   for(const id of input.account_ids)await c.query('INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id) VALUES($1,$2,$3,$4,$5)',[id,p.workspace_id,envOf(req),row.id,input.profile_id]);
   await audit(c,req,'warmup.pool.configured',row.id,{account_ids:input.account_ids,reason:input.reason,enabled:false});return{data:row,status:201};
  });return reply.code(201).send({data:result.data});
 });
	 app.patch('/v1/warmup/pools/:id',async req=>{
	  const p=permit(req,true),id=idOf(req);assertResource(p,id);const input=z.object({expected_version:revision,action:z.enum(['pause','resume','disable','reset_breaker']),reason}).strict().parse(parseBody(req));
	  if(input.action==='reset_breaker'&&(p.service||p.role!=='owner'))throw fail(403,'OWNER_REQUIRED');
	  if(input.action==='resume')throw fail(409,'USE_WARMUP_RESUME_ENDPOINT');
	  const result=await mutate(req,'warmup.pool.control:'+id,async c=>{const row=await lockedPool(req,c,id,input.expected_version);
	   if(input.action==='disable'){await revokePool(c,row);await cancelUnsentWarmupPool(c,id,'WARMUP_SCOPE_DISABLED');}
	   const updated=(await c.query('UPDATE warmup_pools SET enabled=$2,paused=$3,breaker_open=$4,breaker_reason=$5,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[id,input.action==='disable'?false:row.enabled,['pause','disable'].includes(input.action)?true:row.paused,input.action==='reset_breaker'?false:row.breaker_open,input.action==='reset_breaker'?null:row.breaker_reason])).rows[0];
   await audit(c,req,'warmup.pool.'+input.action,id,{reason:input.reason});return{data:updated};});return{data:result.data};
 });
 app.post('/v1/warmup/pools/:id/authorize',async req=>{
  const p=permit(req,true);if(p.service||p.role!=='owner')throw fail(403,'OWNER_REQUIRED');const id=idOf(req);
  const input=z.object({expected_version:revision,confirmation:z.literal('AUTHORIZE_OWN_POOL_ONLY'),content_ids:z.array(z.string().uuid()).min(1).max(1000),expires_at:z.string().datetime({offset:true}),max_messages:z.number().int().min(1).max(50000),allow_profile_updates:z.boolean(),compatible_release_sha:z.string().regex(/^[a-f0-9]{40}$/),provider_evidence:z.string().min(10).max(300),provider_evidence_id:z.string().uuid().optional(),max_cost_minor:z.literal(0).default(0),reason}).strict().parse(parseBody(req));
  const remaining=Date.parse(input.expires_at)-Date.now();if(remaining<=0||remaining>45*86400000)throw fail(400,'INVALID_EXPIRY');
  const result=await mutate(req,'warmup.pool.authorize:'+id,async c=>{await readOperationalSettings(c,p.workspace_id,envOf(req),{lock:'share'});const row=await lockedPool(req,c,id,input.expected_version);if(row.breaker_open)throw fail(409,'BREAKER_REQUIRES_MANUAL_RESET');
   const accountIds=(await c.query("SELECT s.account_id FROM warmup_states s JOIN records a ON a.id=s.account_id WHERE s.pool_id=$1 AND s.paused=false AND s.status<>'QUARANTINED' AND a.body->>'provider'<>'cloud' AND NOT a.body ? 'deleted_at'",[id])).rows.map(r=>r.account_id);
   for(const accountId of accountIds)await ownExperimentalAccount(req,c,accountId);if((await c.query("SELECT 1 FROM warmup_states s JOIN warmup_profiles sp ON sp.id=s.profile_id JOIN warmup_profiles pp ON pp.id=$2 WHERE s.pool_id=$1 AND COALESCE(sp.config->>'policy_version','legacy-30d/v1')<>COALESCE(pp.config->>'policy_version','legacy-30d/v1')",[id,row.profile_id])).rowCount)throw fail(409,'MIGRATED_MEMBERS_REQUIRE_NUMBER_PROGRAM');if(accountIds.length<2)throw fail(409,'AWAITING_PEER');if(accountIds.length<6&&!row.allow_small_pool_concentration)throw fail(409,'CONCENTRATION_EXCEPTION_REQUIRED');
   for(const contentId of input.content_ids)if(!(await c.query('SELECT 1 FROM warmup_content WHERE id=$1 AND workspace_id=$2 AND environment=$3',[contentId,p.workspace_id,envOf(req)])).rowCount)throw fail(404,'CONTENT_NOT_FOUND');
   const requiredCapabilities=new Set<string>(['text',...(input.allow_profile_updates?['profile']:[])]);
   for(const contentId of input.content_ids){const content=(await c.query('SELECT body FROM warmup_content WHERE id=$1 AND workspace_id=$2 AND environment=$3',[contentId,p.workspace_id,envOf(req)])).rows[0];for(const turn of content.body.turns)requiredCapabilities.add(turn.kind);}
   if(envOf(req)==='REAL'){
    if(!input.provider_evidence_id)throw fail(409,'PROVIDER_CAPABILITY_EVIDENCE_REQUIRED');
    const evidence=(await c.query("SELECT details,expires_at FROM operational_evidence WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND kind='provider_capability' AND status='VERIFIED' AND observed_at<=now() AND expires_at>now()",[input.provider_evidence_id,p.workspace_id,envOf(req)])).rows[0];
    if(!evidence||accountIds.some(accountId=>!evidence.details.resource_ids?.includes(accountId))||[...requiredCapabilities].some(capability=>!evidence.details.capabilities?.includes(capability)))throw fail(409,'PROVIDER_CAPABILITY_EVIDENCE_REQUIRED');
    if(Date.parse(input.expires_at)>new Date(evidence.expires_at).getTime())throw fail(409,'PROVIDER_EVIDENCE_EXPIRES_BEFORE_SCOPE');
   }
	   const policy=await readOperationalSettings(c,p.workspace_id,envOf(req),{lock:'share'}),profile=warmupProfileSchema.parse((await c.query('SELECT config FROM warmup_profiles WHERE id=$1',[row.profile_id])).rows[0]?.config);
   if(envOf(req)==='REAL'&&(policy.body.dispatch_frozen||!policy.body.real_sends_enabled||!policy.body.allow_real_operations))throw fail(409,'REAL_OPERATION_NOT_ENABLED');
	   if(profile.policy_version===STANDARD_V2_POLICY){const startedAt=await numberNow(c,p.workspace_id,envOf(req));for(const accountId of accountIds){const state=(await c.query('SELECT status FROM warmup_states WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];if(state?.status==='GRADUATED')continue;let episode=(await c.query('SELECT * FROM warmup_episodes WHERE account_id=$1 AND closed_at IS NULL FOR UPDATE',[accountId])).rows[0];if(episode&&episode.policy_version!==profile.policy_version)throw fail(409,'POLICY_MIGRATION_REQUIRED');if(!episode){const account=await scopedRecord(req,'channel_account',accountId,c);episode=(await c.query('INSERT INTO warmup_episodes(account_id,workspace_id,environment,policy_version,identity_fingerprint,timezone,started_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[accountId,p.workspace_id,envOf(req),profile.policy_version,account.body.identity_fingerprint??hash(accountId),profile.timezone,startedAt,p.user.id])).rows[0];}await c.query("UPDATE warmup_states SET episode_id=$2,enrolled_at=COALESCE(enrolled_at,$3),profile_ready_at=$3,status='WARMING',reason='AUTOMATIC_PREPARATION_AUTHORIZED',paused=false WHERE account_id=$1",[accountId,episode.id,startedAt]);}}
	   const scope={mode:'warmup',pool_id:id,pool_version:row.version+1,account_ids:accountIds,content_ids:input.content_ids,max_messages:input.max_messages,allow_profile_updates:input.allow_profile_updates,compatible_release_sha:input.compatible_release_sha,provider_evidence:input.provider_evidence,provider_evidence_id:input.provider_evidence_id,max_cost_minor:0,policy_version:profile.policy_version};
   await revokePool(c,row);
   const authorization=(await c.query('INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at,configuration_version) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[p.workspace_id,envOf(req),p.user.id,scope,hash(stableJson(scope)),input.expires_at,policy.version])).rows[0];
   await c.query('UPDATE warmup_pools SET authorization_id=$2,enabled=true,paused=false,version=version+1,updated_at=now() WHERE id=$1',[id,authorization.id]);await audit(c,req,'warmup.pool.authorized',id,{authorization_id:authorization.id,scope,reason:input.reason});return{data:{id,version:row.version+1,authorization_id:authorization.id,enabled:true,commercial_permissions_changed:false}};
  });return{data:result.data};
 });
 app.post('/v1/warmup/identities/:id',async req=>{const p=permit(req,true),input=z.object({provider_identity:z.string().min(6).max(80),name:z.string().min(3).max(100),about:z.string().min(3).max(140),avatar_asset_id:z.string().uuid().optional(),ownership_evidence:reason,ownership_confirmed:z.literal(true)}).strict().parse(parseBody(req));const result=await mutate(req,'warmup.identity:'+idOf(req),async c=>{const account=await scopedRecord(req,'channel_account',idOf(req),c);try{const value=await registerWarmupIdentity(c,account,input);await audit(c,req,'warmup.identity.registered',account.id);return{data:{...value,account_id:account.id,workspace_id:p.workspace_id,profile_verified:false}};}catch(e){if(e instanceof Error&&e.message.startsWith('WARMUP_'))throw fail(409,e.message);throw e;}},{privateRequest:true});return{data:result.data};});
 app.get('/v1/warmup/content',async req=>{const p=permit(req);return{data:(await pool.query('SELECT id,content_hash,body,created_at FROM warmup_content WHERE workspace_id=$1 AND environment=$2 AND ($3::text[] IS NULL OR id::text=ANY($3)) ORDER BY created_at DESC',[p.workspace_id,envOf(req),p.resource_ids??null])).rows};});
 app.post('/v1/warmup/content',async(req,reply)=>{const p=permit(req,true),input=warmupContentSchema.parse(parseBody(req));const result=await mutate(req,'warmup.content.create',async c=>{for(const turn of input.turns)if(turn.asset_id){const asset=await scopedRecord(req,'asset',turn.asset_id,c);if(asset.body.status!=='READY'||asset.body.kind!=='file'||(turn.kind==='audio'?!String(asset.body.mime_type).startsWith('audio/'):turn.kind==='image'?!String(asset.body.mime_type).startsWith('image/'):!['application/pdf','application/octet-stream'].includes(asset.body.mime_type)))throw fail(400,'WARMUP_MATERIAL_NOT_READY');}const body={label:input.label,turns:input.turns},contentHash=hash(stableJson(body));const inserted=(await c.query('INSERT INTO warmup_content(workspace_id,environment,content_hash,body,approved_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,environment,content_hash) DO NOTHING RETURNING id,content_hash',[p.workspace_id,envOf(req),contentHash,body,p.user.id])).rows[0];const row=inserted??(await c.query('SELECT id,content_hash FROM warmup_content WHERE workspace_id=$1 AND environment=$2 AND content_hash=$3',[p.workspace_id,envOf(req),contentHash])).rows[0];await audit(c,req,'warmup.content.approved',row.id);return{data:row,status:201};});return reply.code(201).send({data:result.data});});

 app.post('/v1/warmup/pools/:id/members',async(req,reply)=>{
  const p=permit(req,true),id=idOf(req),input=z.object({expected_version:revision,account_ids:z.array(z.string().uuid()).min(1).max(100),ownership_confirmed:z.literal(true),reason}).strict().parse(parseBody(req));
  const result=await mutate(req,'warmup.pool.members:'+id,async c=>{
   const row=await lockedPool(req,c,id,input.expected_version);const added:string[]=[];
   for(const accountId of [...new Set(input.account_ids)].sort()){
    await ownExperimentalAccount(req,c,accountId);
    const existing=(await c.query('SELECT pool_id FROM warmup_states WHERE account_id=$1',[accountId])).rows[0];
    if(existing){if(existing.pool_id!==id)throw fail(409,'ACCOUNT_IN_OTHER_POOL');continue;}
    await c.query('INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id) VALUES($1,$2,$3,$4,$5)',[accountId,p.workspace_id,envOf(req),id,row.profile_id]);added.push(accountId);
   }
   if(added.length){await revokePool(c,row);await c.query('UPDATE warmup_pools SET authorization_id=NULL,enabled=false,version=version+1,updated_at=now() WHERE id=$1',[id]);}
   await audit(c,req,'warmup.members_added',id,{account_ids:added,reason:input.reason,reauthorization_required:added.length>0});
   return{data:{id,version:row.version+(added.length?1:0),added_account_ids:added,reauthorization_required:added.length>0},status:201};
  });reply.code(result.status??201);return{data:result.data};
 });
 app.patch('/v1/warmup/pools/:id/profile',async req=>{
  const p=permit(req,true),id=idOf(req),input=z.object({expected_version:revision,profile_id:z.string().uuid(),reason}).strict().parse(parseBody(req));
  const result=await mutate(req,'warmup.pool.profile:'+id,async c=>{
   const row=await lockedPool(req,c,id,input.expected_version);assertResource(p,input.profile_id);
   const profile=(await c.query('SELECT * FROM warmup_profiles WHERE id=$1 AND workspace_id=$2 AND environment=$3',[input.profile_id,p.workspace_id,envOf(req)])).rows[0];if(!profile)throw fail(404,'PROFILE_NOT_FOUND');
   const previous=(await c.query('SELECT config FROM warmup_profiles WHERE id=$1',[row.profile_id])).rows[0];
   if((await c.query("SELECT 1 FROM warmup_states s JOIN warmup_episodes e ON e.id=s.episode_id WHERE s.pool_id=$1 AND e.closed_at IS NULL AND e.policy_version<>COALESCE($2::text,'legacy-30d/v1') LIMIT 1",[id,profile.config.policy_version])).rowCount)throw fail(409,'MIGRATED_MEMBERS_REQUIRE_NUMBER_PROGRAM');
   if(profile.config.mode!==previous.config.mode&&(await c.query('SELECT 1 FROM warmup_states WHERE pool_id=$1 AND enrolled_at IS NOT NULL LIMIT 1',[id])).rowCount)throw fail(409,'ENROLLED_CURVE_MODE_IMMUTABLE');
   await revokePool(c,row);await c.query('UPDATE warmup_pools SET profile_id=$2,enabled=false,authorization_id=NULL,version=version+1,updated_at=now() WHERE id=$1',[id,input.profile_id]);
   await c.query('UPDATE warmup_states SET profile_id=$2,version=version+1,updated_at=now() WHERE pool_id=$1',[id,input.profile_id]);
   await audit(c,req,'warmup.profile_selected',id,{profile_id:input.profile_id,previous_profile_id:row.profile_id,reason:input.reason,persisted_plans_changed:false});
   return{data:{id,version:row.version+1,profile_id:input.profile_id,reauthorization_required:true,persisted_plans_changed:false}};
  });return{data:result.data};
 });
 app.patch('/v1/warmup/accounts/:id',async req=>{
  permit(req,true);const id=idOf(req),input=z.object({expected_version:revision,action:z.enum(['pause','resume']),reason}).strict().parse(parseBody(req));
  const result=await mutate(req,'warmup.account.control:'+id,async c=>{
   await scopedRecord(req,'channel_account',id,c);
   const ref=(await c.query('SELECT pool_id FROM warmup_states WHERE account_id=$1 AND workspace_id=$2 AND environment=$3',[id,principal(req).workspace_id,envOf(req)])).rows[0];if(!ref)throw fail(404,'NOT_FOUND');
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`warmup-pool:${ref.pool_id}`]);
   const row=(await c.query('SELECT * FROM warmup_states WHERE account_id=$1 FOR UPDATE',[id])).rows[0];if(row.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
   if(row.status==='QUARANTINED'&&input.action==='resume')throw fail(409,'QUARANTINE_REQUIRES_REVIEW');
   const updated=(await c.query("UPDATE warmup_states SET paused=$2,status=$3,reason=$4,version=version+1,updated_at=now() WHERE account_id=$1 RETURNING account_id,pool_id,status,paused,version,effective_days",[id,input.action==='pause',row.status==='GRADUATED'?'GRADUATED':input.action==='pause'?'PAUSED':'AWAITING_CONNECTION',input.reason])).rows[0];
   await audit(c,req,'warmup.account.'+input.action,id,{reason:input.reason});return{data:updated};
  });return{data:result.data};
 });
 app.post('/v1/warmup/accounts/:id/profile-review',async req=>{
  const p=permit(req,true);if(p.service||p.role!=='owner')throw fail(403,'OWNER_REQUIRED');const id=idOf(req),input=z.object({expected_version:revision,reason}).strict().parse(parseBody(req));
  const result=await mutate(req,'warmup.profile.review:'+id,async c=>{
   await scopedRecord(req,'channel_account',id,c);
   const ref=(await c.query('SELECT pool_id FROM warmup_states WHERE account_id=$1 AND workspace_id=$2 AND environment=$3',[id,p.workspace_id,envOf(req)])).rows[0];if(!ref)throw fail(404,'NOT_FOUND');
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`warmup-pool:${ref.pool_id}`]);
   const state=(await c.query('SELECT version FROM warmup_states WHERE account_id=$1 FOR UPDATE',[id])).rows[0];if(state.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
   const identity=(await c.query('SELECT id,profile_operation_status FROM warmup_identities WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 FOR UPDATE',[p.workspace_id,envOf(req),id])).rows[0];
   if(!identity||identity.profile_operation_status!=='UNKNOWN')throw fail(409,'PROFILE_NOT_UNKNOWN');
   await c.query('UPDATE warmup_identities SET profile_review_requested_at=now() WHERE id=$1',[identity.id]);
   await c.query('UPDATE warmup_states SET version=version+1,updated_at=now() WHERE account_id=$1',[id]);
   await audit(c,req,'warmup.profile_review_requested',id,{identity_id:identity.id,reason:input.reason,remote_mutations:false});
   return{data:{account_id:id,version:state.version+1,review_requested:true,profile_operation_status:'UNKNOWN',external_mutations:false}};
  });return{data:result.data};
 });
 app.post('/v1/warmup/pools/:id/reconcile',async(req,reply)=>{
  permit(req,true);const id=idOf(req),input=z.object({expected_version:revision,reason}).strict().parse(parseBody(req));
  const result=await mutate(req,'warmup.pool.reconcile:'+id,async c=>{await lockedPool(req,c,id,input.expected_version);return{data:await command(c,req,'warmup_reconcile',id,input),status:202};});reply.code(result.status??202);return{data:result.data};
 });
 app.get('/v1/warmup/backfill',async req=>{
  const p=permit(req),environment=envOf(req);
  const rows=(await pool.query("SELECT a.id,a.body,a.version,s.status,s.enrolled_at,(SELECT min(e.occurred_at) FROM domain_events e WHERE e.workspace_id=a.workspace_id AND e.environment=a.environment AND e.aggregate_id=a.id::text AND e.event_type='provider.session.observed' AND e.payload->>'status'='WORKING') first_observed_working FROM records a LEFT JOIN warmup_states s ON s.account_id=a.id WHERE a.workspace_id=$1 AND a.environment=$2 AND a.kind='channel_account' AND NOT a.body ? 'deleted_at'",[p.workspace_id,environment])).rows.filter(row=>resourcePermitted(p,row.id));
  return{data:{environment,dry_run:true,external_effects:0,accounts:rows.map(row=>({account_id:row.id,account_version:row.version,current_state:row.status??null,connection_evidence:row.first_observed_working?{source:'PROVIDER_SESSION_EVENT',observed_at:row.first_observed_working}:null,action:row.body.provider==='cloud'?'NOT_APPLICABLE':row.enrolled_at?'KEEP_EXISTING_PROGRESS':row.first_observed_working?'REVIEW_HISTORICAL_EVIDENCE':'AWAIT_CONNECTION_EVIDENCE',backfill_review_href:'/v1/warmup/accounts/'+row.id+'/backfill',effective_days_inferred:0}))}};
 });
 app.post('/v1/warmup/simulate',async(req,reply)=>{const p=permit(req,true);if(envOf(req)!=='SIMULATION')throw fail(400,'SIMULATION_REQUIRED');const input=z.object({seed:z.number().int().min(0).max(2147483647).default(1),at:z.string().datetime({offset:true}).default('2026-09-14T12:00:00.000Z'),participants:z.union([z.literal(2),z.literal(3)]).default(2),fault:z.enum(['none','delay','duplicate','out_of_order','accepted_timeout','rejected','peer_disconnected']).default('none')}).strict().parse(parseBody(req));const result=await mutate(req,'warmup.simulate',async c=>({data:await createWarmupSimulation(c,p.workspace_id,input),status:202}));return reply.code(202).send({data:result.data});});
 app.get('/v1/warmup/simulations/:id',async req=>{const p=permit(req);if(envOf(req)!=='SIMULATION')throw fail(400,'SIMULATION_REQUIRED');const result=await readWarmupSimulation(pool,idOf(req),p.workspace_id);if(!result)throw fail(404,'NOT_FOUND');return{data:result};});
 app.post('/v1/warmup/simulations/:id/control',async req=>{const p=permit(req,true);if(envOf(req)!=='SIMULATION')throw fail(400,'SIMULATION_REQUIRED');const input=z.object({expected_version:revision,action:z.enum(['pause','resume'])}).strict().parse(parseBody(req)),id=idOf(req);const result=await mutate(req,'warmup.simulation.control:'+id,async c=>{const run=(await c.query('SELECT * FROM warmup_simulation_runs WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[id,p.workspace_id])).rows[0];if(!run)throw fail(404,'NOT_FOUND');if(run.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');if(['COMPLETED','ATTENTION'].includes(run.status))throw fail(409,'SIMULATION_REQUIRES_NEW_RUN');await c.query('UPDATE warmup_simulation_runs SET status=$2,version=version+1,updated_at=now() WHERE id=$1',[id,input.action==='pause'?'PAUSED':'RUNNING']);return{data:await readWarmupSimulation(c,id,p.workspace_id)};});return{data:result.data};});
 app.post('/v1/warmup/preview',async req=>{permit(req,true);if(envOf(req)!=='SIMULATION')throw fail(400,'SIMULATION_REQUIRED');const input=z.object({profile:warmupProfileSchema,effective_day:z.number().int().min(1).max(44),at:z.string().datetime({offset:true})}).strict().parse(parseBody(req));return{data:{environment:'SIMULATION',budget:dailyBudget(input.profile,input.effective_day,new Date(input.at)),external_effects:0,observation:'VIRTUAL_ONLY'}};});
}
