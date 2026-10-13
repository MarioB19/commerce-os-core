import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {pool,withTransaction,stableJson,type QueryExecutor} from '../../../packages/db/src/index.js';
import {bumpOperationalRevision,readOperationalSettings} from '../../../packages/db/src/operational-settings.js';
import {integrationDefinitions,integrationMetadata,integrationPatchSchema,listIntegrationSettings,readIntegrationSettings,privateIntegrationDigest,publicSettingText,saveIntegrationSetting,splitIntegrationKey,type IntegrationPatch} from '../../../packages/db/src/integration-settings.js';
import {audit,envOf,fail,parseBody,idempotencyActor,principal,assertResource} from './context.js';
/** Owner sessions, or a service token with the exact integrations scope. */
export function integrationPermission(req:FastifyRequest,scope:'read'|'write'|'verify',key?:string){const p=principal(req);if(p.service){if(!p.scopes.includes(`integrations:${scope}`))throw fail(403,'INTEGRATION_SCOPE_REQUIRED');if(key)assertResource(p,key);}else if(p.role!=='owner')throw fail(403,'OWNER_REQUIRED');return p;}
async function frozenProfileCanEnable(client:QueryExecutor,workspace:string,environment:string,key:string,patch:IntegrationPatch,commerciallyFrozen:boolean,accounts:{id:string;body:Record<string,unknown>}[]){
 if(environment!=='REAL'||!commerciallyFrozen||!accounts.length||!patch.enabled||patch.capacity_operation_id||Object.keys(patch.secrets).length||patch.clear_secrets.length)return false;
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`integration:${workspace}:${environment}:${key}`]);
 const previous=await readIntegrationSettings(client,workspace,'REAL',key,{secrets:false});
 if(!previous||previous.enabled||previous.version!==patch.expected_version||previous.label!==patch.label||stableJson(previous.config)!==stableJson(patch.config))return false;
 for(const account of accounts){
  if(account.body.sending_enabled!==false)return false;
  const session=(await client.query("SELECT desired_state,operational_pause,recovery_enabled,archived_at,health_probe_until>now() AS probing FROM channel_sessions WHERE account_id=$1 AND workspace_id=$2 AND environment='REAL' FOR UPDATE",[account.id,workspace])).rows[0];
  const ownership=(await client.query('SELECT frozen,lease_expires_at>now() AS live FROM session_ownership WHERE account_id=$1 AND workspace_id=$2 FOR UPDATE',[account.id,workspace])).rows[0];
  if(!session||session.archived_at||session.desired_state!=='STOPPED'||session.operational_pause!==true||session.recovery_enabled!==false||session.probing||!ownership||ownership.frozen!==true||ownership.live)return false;
  if((await client.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND environment='REAL' AND resource_id=$2 AND kind='channel_command' AND (status='PENDING' OR (status='FAILED' AND payload->>'type' IN('connect','restart','disconnect','logout') AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at'))) LIMIT 1",[workspace,account.id])).rowCount)return false;
  if((await client.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND environment='REAL' AND account_id=$2 AND status IN('SENDING','UNKNOWN') LIMIT 1",[workspace,account.id])).rowCount)return false;
  if((await client.query("SELECT 1 FROM domain_events e WHERE e.workspace_id=$1 AND e.environment='REAL' AND e.aggregate_id=$2 AND e.event_type='provider.media.observed' AND NOT EXISTS(SELECT 1 FROM domain_events f WHERE f.workspace_id=e.workspace_id AND f.environment=e.environment AND f.aggregate_id=e.aggregate_id AND f.causation_id=e.id::text AND (f.event_type='channel.media.stored' OR (f.event_type='channel.media.download_failed' AND f.payload->'terminal'='true'::jsonb))) LIMIT 1",[workspace,account.id])).rowCount)return false;
  if((await client.query("SELECT 1 FROM warmup_groups g WHERE g.workspace_id=$1 AND g.environment='REAL' AND g.members @> jsonb_build_array(jsonb_build_object('account_id',$2::text)) AND (g.probe_until>now() OR EXISTS(SELECT 1 FROM warmup_pools p WHERE p.group_id=g.id AND p.enabled AND NOT p.paused)) LIMIT 1",[workspace,account.id])).rowCount)return false;
  if((await client.query("SELECT 1 FROM number_operations WHERE workspace_id=$1 AND environment='REAL' AND state IN('REQUESTED','RESERVED','PREPARING','UNKNOWN') AND (input->>'account_id'=$2 OR input->'account_ids' ? $2) LIMIT 1",[workspace,account.id])).rowCount)return false;
 }
 return true;
}
async function gatewayCanChange(client:QueryExecutor,workspace:string,environment:string,key:string,patch:IntegrationPatch,commerciallyFrozen:boolean){const{type,reference}=splitIntegrationKey(key);if(type!=='waha'&&type!=='cloud')return;const accounts=(await client.query("SELECT id,body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='channel_account' AND NOT (body ? 'deleted_at') AND body->>'provider'=$3 AND COALESCE(body->>'gateway_ref',upper($3))=$4 ORDER BY id FOR UPDATE",[workspace,environment,type,reference])).rows;
 // Enabling retained credentials under a frozen, quiet local session is not a
 // transport edit. Never infer that the historical account status is current.
 if(await frozenProfileCanEnable(client,workspace,environment,key,patch,commerciallyFrozen,accounts))return;
 for(const account of accounts){if(!['NEW','STOPPED','DISCONNECTED'].includes(account.body.status??'NEW'))throw fail(409,'INTEGRATION_DISCONNECT_REQUIRED','Desconecta primero las cuentas que utilizan este perfil; una clave guardada no rota automáticamente la autenticación del gateway.');if((await client.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND status='PENDING'",[workspace,environment,account.id])).rowCount)throw fail(409,'INTEGRATION_CHANNEL_COMMAND_PENDING','Espera a que termine la operación del canal antes de cambiar su conexión.');}
}
function validationError(error:unknown):never {if(error instanceof z.ZodError)throw fail(400,'INTEGRATION_SETTINGS_INVALID','Revisa los campos de la conexión; no se guardaron cambios.');const code=error instanceof Error&&/^INTEGRATION_[A-Z_]+$/.test(error.message)?error.message:undefined;if(code){const status=code.includes('VERSION')?409:400;throw fail(status,code,code.includes('VERSION')?'La conexión cambió. Actualiza antes de guardar.':code.includes('SECRET_REQUIRED')?'Completa los secretos obligatorios antes de habilitar la conexión.':code.includes('TOPOLOGY')?'Selecciona un gateway de la infraestructura disponible.':'La configuración no cumple el contrato seguro de este proveedor.');}throw error;}
export async function integrationSettingsRoutes(app:FastifyInstance){
 app.get('/v1/settings/integrations',{schema:{tags:['Settings'],summary:'Conexiones operativas sin revelar secretos'}},async(req,reply)=>{const actor=integrationPermission(req,'read');reply.header('Cache-Control','no-store');return{data:{definitions:integrationDefinitions,profiles:(await listIntegrationSettings(pool,actor.workspace_id,envOf(req))).filter(row=>!actor.service||!actor.resource_ids||actor.resource_ids.includes(row.key)).map(integrationMetadata)}};});
 app.post('/v1/settings/integrations/:key/disable',{bodyLimit:4096,config:{rateLimit:{max:30,timeWindow:'1 minute'}},schema:{tags:['Settings'],summary:'Deshabilita un perfil de canal sin atribuir estado remoto'}},async(req,reply)=>{
  const key=String((req.params as {key:string}).key),actor=integrationPermission(req,'write',key),environment=envOf(req);
  let input:{expected_version:number;reason:string};try{const{type}=splitIntegrationKey(key);if(type!=='waha'&&type!=='cloud')throw fail(400,'CHANNEL_INTEGRATION_REQUIRED');input=z.object({expected_version:z.number().int().positive(),reason:z.string().trim().min(3).max(240)}).strict().parse(parseBody(req));}catch(error){return validationError(error);}
  const idempotency=req.headers['idempotency-key'];if(typeof idempotency!=='string'||!/^[-a-zA-Z0-9_]{8,160}$/.test(idempotency))throw fail(400,'IDEMPOTENCY_KEY_REQUIRED');
  const operation='integration.settings.disable',idemActor=idempotencyActor(actor),digest=privateIntegrationDigest({environment,key,input});
  try{const result=await withTransaction(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${actor.workspace_id}:${idemActor}:${operation}:${idempotency}`]);
   const cached=(await client.query('SELECT request_hash,response,status_code FROM idempotency WHERE workspace_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4',[actor.workspace_id,idemActor,operation,idempotency])).rows[0];if(cached){if(cached.response?._retained)throw fail(410,'IDEMPOTENT_RESULT_RETAINED');if(cached.request_hash!==digest)throw fail(409,'IDEMPOTENCY_CONFLICT');return{data:cached.response,status:cached.status_code};}
   const release=await readOperationalSettings(client,actor.workspace_id,environment,{lock:'update'});if(environment==='REAL'&&release.release_hold)throw fail(409,'RELEASE_HOLD_ACTIVE');
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`integration:${actor.workspace_id}:${environment}:${key}`]);
   const previous=await readIntegrationSettings(client,actor.workspace_id,environment,key,{secrets:false});if(!previous)throw fail(404,'INTEGRATION_PROFILE_NOT_FOUND');if(previous.version!==input.expected_version)throw fail(409,'INTEGRATION_VERSION_CONFLICT');
   const operational=previous.enabled?await bumpOperationalRevision(client,actor.workspace_id,environment,actor.user.id):await readOperationalSettings(client,actor.workspace_id,environment);
   const profile=previous.enabled?await saveIntegrationSetting(client,actor.workspace_id,environment,key,{expected_version:previous.version,label:previous.label,enabled:false,config:previous.config,secrets:{},clear_secrets:[],reason:input.reason},actor.user.id):previous;
   const data={...integrationMetadata(profile),operational_revision:operational.version,operation_review_required:previous.enabled,remote_state:'UNOBSERVED',changed:previous.enabled};
   await audit(client,req,'integration.settings_disabled',key,{key,profile_revision:profile.version,operational_revision:operational.version,changed:previous.enabled,remote_state:'UNOBSERVED',reason:publicSettingText(input.reason)});
   await client.query('INSERT INTO idempotency(workspace_id,actor_id,operation,key,request_hash,response,status_code) VALUES($1,$2,$3,$4,$5,$6,$7)',[actor.workspace_id,idemActor,operation,idempotency,digest,data,200]);return{data,status:200};
  });reply.header('Cache-Control','no-store').code(result.status);return{data:result.data};}catch(error){return validationError(error);}
 });
 app.put('/v1/settings/integrations/:key',{bodyLimit:32768,config:{rateLimit:{max:30,timeWindow:'1 minute'}},schema:{tags:['Settings'],summary:'Reemplaza configuración operativa cifrada con revisión explícita'}},async(req,reply)=>{
  const actor=integrationPermission(req,'write',String((req.params as {key:string}).key)),environment=envOf(req);let key:string,patch:IntegrationPatch;try{key=z.string().parse((req.params as {key:string}).key);splitIntegrationKey(key);patch=integrationPatchSchema.parse(parseBody(req));}catch(error){return validationError(error);}
  const idempotency=req.headers['idempotency-key'];if(typeof idempotency!=='string'||!/^[-a-zA-Z0-9_]{8,160}$/.test(idempotency))throw fail(400,'IDEMPOTENCY_KEY_REQUIRED','Incluye una clave de idempotencia válida.');
  const digest=privateIntegrationDigest({environment,key,patch}),operation='integration.settings.update',idemActor=idempotencyActor(actor);
  try{const result=await withTransaction(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${actor.workspace_id}:${idemActor}:${operation}:${idempotency}`]);
   const cached=(await client.query('SELECT request_hash,response,status_code FROM idempotency WHERE workspace_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4',[actor.workspace_id,idemActor,operation,idempotency])).rows[0];if(cached){if(cached.response?._retained)throw fail(410,'IDEMPOTENT_RESULT_RETAINED','La edición ya fue registrada; consulta el perfil actual.');if(cached.request_hash!==digest)throw fail(409,'IDEMPOTENCY_CONFLICT','La clave pertenece a una edición diferente.');return{data:cached.response,status:cached.status_code};}
   const release=await readOperationalSettings(client,actor.workspace_id,environment,{lock:'update'});if(environment==='REAL'&&release.release_hold)throw fail(409,'RELEASE_HOLD_ACTIVE');
   let isolatedProvision=false;
   if(patch.capacity_operation_id){
    if(!(actor.service?actor.scopes:actor.permissions).some(scope=>scope==='*'||scope==='channels:capacity:agent'))throw fail(403,'CAPACITY_AGENT_REQUIRED');
    await readOperationalSettings(client,actor.workspace_id,environment,{lock:'update'});
    const allowed=(await client.query(`SELECT 1 FROM number_operations o JOIN number_capacity_slots s ON s.id::text=o.input->>'slot_id' JOIN records a ON a.id=s.account_id
     WHERE o.id=$1 AND o.workspace_id=$2 AND o.environment=$3 AND o.action='PROVISION' AND ((o.state='PREPARING' AND o.lease_until>now() AND o.lease_owner=$4) OR (o.state='UNKNOWN' AND (s.readback->>'observed_at')::timestamptz>now()-interval '60 seconds' AND s.readback->>'source'='bounded_administrator' AND s.readback->>'session_count'='0'))
     AND s.readback->>'verified'='true' AND a.body->>'provider'='waha' AND a.body->>'status'='NEW' AND COALESCE((a.body->>'identity_verified')::boolean,false)=false AND COALESCE((a.body->>'sending_enabled')::boolean,false)=false
     AND $5='waha:'||(a.body->>'gateway_ref') AND NOT EXISTS(SELECT 1 FROM integration_settings i WHERE i.workspace_id=o.workspace_id AND i.environment=o.environment AND i.key=$5)
     AND NOT EXISTS(SELECT 1 FROM outbox x WHERE x.account_id=a.id::text)`,[patch.capacity_operation_id,actor.workspace_id,environment,'capacity-agent:'+(actor.token_id??actor.user.id),key])).rowCount;
    if(!allowed||patch.expected_version!==0)throw fail(409,'INITIAL_PROVISION_SCOPE_REQUIRED');isolatedProvision=true;
   }
   const operational=key==='openai:assistant'||isolatedProvision?await readOperationalSettings(client,actor.workspace_id,environment):await bumpOperationalRevision(client,actor.workspace_id,environment,actor.user.id);await gatewayCanChange(client,actor.workspace_id,environment,key,patch,release.body.dispatch_frozen===true&&release.body.real_sends_enabled===false&&release.body.allow_real_operations===false);const profile=await saveIntegrationSetting(client,actor.workspace_id,environment,key,patch,actor.user.id);const data={...integrationMetadata(profile),operational_revision:operational.version,operation_review_required:key!=='openai:assistant'&&!isolatedProvision,capacity_operation_id:patch.capacity_operation_id??null};
   await audit(client,req,'integration.settings_updated',key,{key,profile_revision:profile.version,operational_revision:operational.version,enabled:profile.enabled,capacity_operation_id:patch.capacity_operation_id??null,isolated_initial_provision:isolatedProvision,changed_secret_fields:[...Object.keys(patch.secrets),...patch.clear_secrets],reason:publicSettingText(patch.reason)});
   await client.query('INSERT INTO idempotency(workspace_id,actor_id,operation,key,request_hash,response,status_code) VALUES($1,$2,$3,$4,$5,$6,$7)',[actor.workspace_id,idemActor,operation,idempotency,digest,data,200]);return{data,status:200};
  });reply.header('Cache-Control','no-store').code(result.status);return{data:result.data};}catch(error){return validationError(error);}
 });
}
