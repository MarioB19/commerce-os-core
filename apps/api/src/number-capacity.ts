import {maskedAlias} from '../../../packages/domain/src/warmup/number-state.js';
import {numberAdministrationRoutes} from './number-administration.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {pool,hash,stableJson,type QueryExecutor} from '@commerce/db';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {capacityCommandSchema,capacityLegacyAdoptionSchema,hostMetricsSchema,pageSchema} from '../../../packages/contracts/src/numbers.js';
import type {Body} from '../../../packages/contracts/src/index.js';
import {principal,envOf,parseBody,mutate,fail,audit,sanitize} from './context.js';
import {capacityReadbackIsFresh,projectGatewayMapping} from './number-capacity-state.js';
import {assertCapacityAccountQuiet,verifiedPhysicalProvision,attachCapacityOperationSlots} from './number-capacity-lifecycle.js';
import {numberNow} from '../../../packages/db/src/number-clock.js';
import {withOperationalReadBudget} from './operational-read-budget.js';
export const NUMBER_SLOT_LIMIT=Math.min(20,Math.max(1,Number(process.env.NUMBER_CAPACITY_LIMIT??20)||20));
/** Physical mappings remain reservations even before legacy rows are adopted. */
async function physicalHostMappings(c:QueryExecutor){
 const rows=(await c.query(`SELECT a.workspace_id,a.id AS account_id,a.version AS account_version,a.body->>'gateway_ref' AS account_gateway_ref,
  s.id AS session_id,s.gateway_id AS session_gateway_ref,s.revision AS session_version,
  own.id AS capacity_slot_id,own.host_ref AS canonical_host_ref,own.slot AS canonical_slot
  FROM records a LEFT JOIN channel_sessions s ON s.account_id=a.id AND s.archived_at IS NULL
  LEFT JOIN number_capacity_slots own ON own.account_id=a.id
  WHERE a.kind='channel_account' AND a.environment='REAL' AND a.body->>'provider'='waha' AND NOT a.body?'deleted_at'
  ORDER BY a.workspace_id,a.id`)).rows;
 return rows.map(projectGatewayMapping);
}
function physicalOwnershipConflicts(mappings:Body[]){
 const owners=new Map<number,Set<string>>();
 for(const mapping of mappings)for(const slot of mapping.physical_slots??[]){const set=owners.get(Number(slot))??new Set<string>();set.add(String(mapping.account_id));owners.set(Number(slot),set);}
 return new Set([...owners].filter(([,accounts])=>accounts.size>1).map(([slot])=>slot));
}
/** Legacy accounts reserve one unambiguous physical gateway without claiming readback. */
async function legacyHostSlots(c:QueryExecutor,mappings?:Body[]){
 const rows=mappings??await physicalHostMappings(c);
 return rows.filter(row=>row.canonical_slot===null&&row.physical_slot!==null&&!row.gateway_slot_mismatch).map(row=>({slot:Number(row.physical_slot),workspace_id:row.workspace_id,account_id:row.account_id,account_version:Number(row.account_version),session_id:row.session_id??null,session_version:row.session_version===null||row.session_version===undefined?null:Number(row.session_version),account_gateway_ref:row.account_gateway_ref??null,session_gateway_ref:row.session_gateway_ref??null}));
}
export async function capacityReserve(c:QueryExecutor,workspace:string,environment:string){
 if(environment==='REAL')await c.query("SELECT pg_advisory_xact_lock(hashtextextended('number-host:primary',0))");
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`capacity:${workspace}:${environment}`]);
 const mappings=environment==='REAL'?await physicalHostMappings(c):[];
 if(mappings.some(row=>row.gateway_slot_mismatch))throw fail(409,'GATEWAY_SLOT_MISMATCH','Concilia gateway y plaza canónica antes de reservar otra capacidad.');
 if(physicalOwnershipConflicts(mappings).size)throw fail(409,'PHYSICAL_SLOT_OWNERSHIP_CONFLICT','Una plaza física aparece vinculada a más de una cuenta.');
 const occupied=environment==='REAL'?[...new Set(mappings.flatMap(row=>row.physical_slots??[]).map(Number))]:[];
 const row=(await c.query("SELECT * FROM number_capacity_slots WHERE workspace_id=$1 AND environment=$2 AND account_id IS NULL AND state IN('AVAILABLE','PREPARED') AND NOT(slot=ANY($3::int[])) ORDER BY slot FOR UPDATE LIMIT 1",[workspace,environment,occupied])).rows[0];if(row)return row;
 const next=(await c.query('SELECT n FROM generate_series(1,$3) n WHERE NOT(n=ANY($4::int[])) AND NOT EXISTS(SELECT 1 FROM number_capacity_slots s WHERE (workspace_id=$1 OR $2=\'REAL\') AND environment=$2 AND host_ref=\'primary\' AND slot=n) ORDER BY n LIMIT 1',[workspace,environment,NUMBER_SLOT_LIMIT,occupied])).rows[0];if(!next)throw fail(409,'CAPACITY_EXHAUSTED','No quedan plazas. Revisa capacidad y operaciones pendientes.');
 return(await c.query('INSERT INTO number_capacity_slots(workspace_id,environment,slot) VALUES($1,$2,$3) RETURNING *',[workspace,environment,next.n])).rows[0];
}
function permission(req:FastifyRequest,write=false){const p=principal(req);assertPermission(p,p.service?write?'channels:capacity':'channels:read':write?'channels:capacity':'sales:read');if(p.resource_ids)throw fail(403,'CAPACITY_WORKSPACE_SCOPE_REQUIRED');return p;}

export function projectCapacityMetrics(input:{slots:Body[];legacy:Body[];sessions:Body[];globallyOccupied:number[];physicalSessionsObserved:number|null;workspace:string;now?:Date}){
 const now=input.now??new Date(),connected=input.sessions.filter(row=>row.observed_state==='CONNECTED'&&row.health_expires_at&&new Date(row.health_expires_at)>now).length;
 const reservedAccounts=new Set([...input.slots.map(slot=>slot.account_id),...input.legacy.filter(row=>row.workspace_id===input.workspace).map(row=>row.account_id)].filter(Boolean).map(String));
 const verifiedSlots=new Set(input.slots.filter(slot=>capacityReadbackIsFresh(slot.readback,now)).map(slot=>Number(slot.slot)));
 const logicalHeadroom=Math.max(0,NUMBER_SLOT_LIMIT-new Set(input.globallyOccupied).size);
 const provisionedAvailable=input.slots.filter(slot=>capacityReadbackIsFresh(slot.readback,now)&&!slot.account_id&&['AVAILABLE','PREPARED'].includes(String(slot.state))).length;
 const physicalSessionsObserved=Number.isInteger(input.physicalSessionsObserved)&&Number(input.physicalSessionsObserved)>=0?Number(input.physicalSessionsObserved):null;
 const readbackUnverified=Math.max(0,input.slots.length-verifiedSlots.size),verificationStatus=input.slots.length===0?'NO_DATA':verifiedSlots.size===input.slots.length?'CURRENT':verifiedSlots.size?'PARTIAL':'STALE';
 const verifiedCount=verificationStatus==='CURRENT'||verificationStatus==='PARTIAL'?verifiedSlots.size:null;
 const availableVerified=verificationStatus==='CURRENT'||verificationStatus==='PARTIAL'?provisionedAvailable:null;
 // The bounded administrator observes current sessions; it does not measure a
 // host maximum. Never turn that occupancy readback into a capacity ceiling.
 return{logical_limit:NUMBER_SLOT_LIMIT,slot_records:input.slots.length,provisioned_verified:verifiedCount,readback_unverified:readbackUnverified,verification_status:verificationStatus,reserved:reservedAccounts.size,connected_sessions:connected,physical_sessions_observed:physicalSessionsObserved,physical_capacity_measured:null,available:availableVerified,headroom:logicalHeadroom,logical_headroom:logicalHeadroom,physical_headroom:null,headroom_basis:'LOGICAL_LIMIT_MINUS_OCCUPIED_SLOTS'};
}

export async function readCapacitySnapshot(c:QueryExecutor,workspace:string,environment:string){
 const now=await numberNow(c,workspace,environment);
 const slots=(await c.query('SELECT * FROM number_capacity_slots WHERE workspace_id=$1 AND environment=$2 ORDER BY host_ref,slot',[workspace,environment])).rows;
 const hostMappings=environment==='REAL'?await physicalHostMappings(c):[],legacy=environment==='REAL'?await legacyHostSlots(c,hostMappings):[];
 const observation=(await c.query('SELECT * FROM number_capacity_observations WHERE workspace_id=$1 AND environment=$2 ORDER BY observed_at DESC LIMIT 1',[workspace,environment])).rows[0]??null;
 const parsedMetrics=hostMetricsSchema.safeParse(observation?.metrics);
 const measurementFresh=!!observation&&parsedMetrics.success&&new Date(observation.expires_at)>now;
 const sessions=(await c.query(`SELECT a.id account_id,a.version account_version,a.body->>'name' alias,a.body->>'status' account_status,a.body->>'engine' engine,a.body->>'gateway_ref' account_gateway_ref,
  s.remote_session_name session,s.gateway_id gateway,s.observed_state,s.raw_state,s.auth_state,s.provider_observed_at,s.revision session_revision,s.last_health_at,s.health_expires_at,
  o.owner_id worker,o.generation,o.lease_expires_at,o.frozen,c.host_ref,c.slot,c.state slot_state,c.readback
  FROM records a LEFT JOIN channel_sessions s ON s.account_id=a.id AND s.archived_at IS NULL
  LEFT JOIN session_ownership o ON o.account_id=a.id::text LEFT JOIN number_capacity_slots c ON c.account_id=a.id
  WHERE a.workspace_id=$1 AND a.environment=$2 AND a.kind='channel_account' AND NOT a.body?'deleted_at' ORDER BY a.created_at`,[workspace,environment])).rows;
 const globallyOccupied=environment==='REAL'
  ?[...new Set([...(await c.query("SELECT DISTINCT slot FROM number_capacity_slots WHERE environment='REAL' AND host_ref='primary'")).rows.map(row=>Number(row.slot)),...hostMappings.flatMap(row=>row.physical_slots??[]).map(Number)])]
  :slots.map(slot=>Number(slot.slot));
 const physicalSessionsObserved=environment==='REAL'&&measurementFresh?parsedMetrics.data.physical_sessions_verified:null;
 const metrics=projectCapacityMetrics({slots,legacy,sessions,globallyOccupied,physicalSessionsObserved,workspace,now});
 return{slots,legacy,hostMappings,observation,measurementFresh,sessions,metrics,now};
}

export async function readCapacityDiscrepancies(c:QueryExecutor,workspace:string,environment:string,observedSnapshot?:Awaited<ReturnType<typeof readCapacitySnapshot>>){
 const snapshot=observedSnapshot??await readCapacitySnapshot(c,workspace,environment),items:Body[]=[];
 const add=(code:string,severity:string,summary:string,details:Body={})=>items.push({id:hash(stableJson({code,...details})).slice(0,24),code,severity,summary,...details});
 const ownershipConflicts=physicalOwnershipConflicts(snapshot.hostMappings);
 for(const row of snapshot.hostMappings.filter(row=>row.workspace_id===workspace)){
  if(row.gateway_slot_mismatch)add('GATEWAY_SLOT_MISMATCH','HIGH','La cuenta, sesión o plaza canónica apuntan a gateways distintos.',{slot:row.canonical_slot,account_id:row.account_id,account_gateway_slot:row.account_slot,session_gateway_slot:row.session_slot,canonical_slot:row.canonical_slot,sources:['records.channel_account','channel_sessions','number_capacity_slots']});
  if((row.physical_slots??[]).some((slot:number)=>ownershipConflicts.has(Number(slot))))add('PHYSICAL_SLOT_OWNERSHIP_CONFLICT','HIGH','La misma plaza física aparece vinculada a más de una cuenta.',{slot:row.physical_slot,account_id:row.account_id,sources:['records.channel_account','channel_sessions']});
  if(row.canonical_slot===null&&row.physical_slot!==null&&!row.gateway_slot_mismatch)add('LEGACY_SLOT_UNREGISTERED','MEDIUM','El gateway legado ocupa una plaza sin inventario canónico.',{slot:Number(row.physical_slot),account_id:row.account_id,account_version:Number(row.account_version),session_version:row.session_version===null?null:Number(row.session_version),adoptable:!ownershipConflicts.has(Number(row.physical_slot)),next_action:'ADOPT_LEGACY_SLOT',sources:['channel_account','channel_session']});
 }
 for(const slot of snapshot.slots){
  if(!slot.account_id)add('SLOT_WITHOUT_ACCOUNT','LOW','La plaza está provisionada o reservada sin número asignado.',{slot:Number(slot.slot),account_id:null,sources:['number_capacity_slots']});
  if(slot.readback?.verified&&!capacityReadbackIsFresh(slot.readback,snapshot.now))add('SLOT_READBACK_STALE','MEDIUM','El readback de la plaza venció.',{slot:Number(slot.slot),account_id:slot.account_id??null,sources:['number_capacity_slots.readback']});
 }
 for(const row of snapshot.sessions){
  if(row.gateway&&!row.slot&&!snapshot.legacy.some(candidate=>candidate.account_id===row.account_id))add('SESSION_WITHOUT_SLOT','HIGH','La sesión no tiene plaza canónica ni reserva legado reconocida.',{slot:null,account_id:row.account_id,sources:['channel_sessions','number_capacity_slots']});
  if(!row.session)add('ACCOUNT_WITHOUT_SESSION','MEDIUM','El número no tiene una sesión de canal persistida.',{slot:row.slot===null?null:Number(row.slot),account_id:row.account_id,sources:['records.channel_account','channel_sessions']});
  if(row.observed_state==='CONNECTED'&&(!row.health_expires_at||new Date(row.health_expires_at)<=snapshot.now))add('CONNECTED_WITHOUT_FRESH_HEALTH','HIGH','La sesión almacenada como conectada no tiene salud vigente.',{slot:row.slot===null?null:Number(row.slot),account_id:row.account_id,sources:['channel_sessions']});
  if(row.observed_state==='CONNECTED'&&(!row.lease_expires_at||new Date(row.lease_expires_at)<=snapshot.now))add('OWNERSHIP_EXPIRED','HIGH','La conexión no tiene un worker con control de sesión vigente.',{slot:row.slot===null?null:Number(row.slot),account_id:row.account_id,sources:['session_ownership']});
  if(row.slot_state==='CONNECTED'&&row.observed_state!=='CONNECTED')add('SLOT_SESSION_STATE_MISMATCH','HIGH','La plaza figura conectada pero la sesión canónica no.',{slot:Number(row.slot),account_id:row.account_id,sources:['number_capacity_slots','channel_sessions']});
 }
 if(environment==='REAL'&&snapshot.metrics.physical_capacity_measured===null)add('PHYSICAL_CAPACITY_NOT_MEASURED','MEDIUM','La capacidad física máxima no está medida; las sesiones verificadas sólo describen ocupación actual.',{slot:null,account_id:null,sources:['number_capacity_observations']});
 const counts=items.reduce((result:Body,item:Body)=>({...result,[item.severity]:Number(result[item.severity]??0)+1}),{HIGH:0,MEDIUM:0,LOW:0});
 return{generated_at:new Date().toISOString(),status:counts.HIGH?'REQUIRES_ATTENTION':items.length?'PARTIAL':'READY',counts,total:items.length,items,metrics:snapshot.metrics};
}
export async function capacityRoutes(app:FastifyInstance){
 await numberAdministrationRoutes(app);
 app.get('/v1/number-capacity',async req=>{const p=permission(req),page=pageSchema.parse(req.query);return withOperationalReadBudget(async c=>{const snapshot=await readCapacitySnapshot(c,p.workspace_id,envOf(req)),{slots,observation}=snapshot;
 const workers=(await c.query("SELECT body FROM records WHERE kind='service_heartbeat' AND workspace_id=$1 AND environment=$2 ORDER BY updated_at DESC LIMIT 20",[p.workspace_id,envOf(req)])).rows;
 const topology=snapshot.sessions.map(r=>({...r,status:r.account_status,alias:maskedAlias(r.alias)}));
 const queue=(await c.query("SELECT kind,status,count(*)::int count,min(created_at) oldest_created_at FROM outbox WHERE workspace_id=$1 AND environment=$2 AND status IN('READY','BLOCKED','SENDING','UNKNOWN') GROUP BY kind,status",[p.workspace_id,envOf(req)])).rows;
 const jobs=(await c.query("SELECT action,state,count(*)::int count,min(created_at) oldest_created_at FROM number_operations WHERE workspace_id=$1 AND environment=$2 AND state NOT IN('SUCCEEDED','CANCELLED') GROUP BY action,state",[p.workspace_id,envOf(req)])).rows;
 return{data:{configured_limit:NUMBER_SLOT_LIMIT,environment:envOf(req),installed_basis:envOf(req)==='SIMULATION'?'SIMULATED_ADAPTER':'GATEWAY_READBACK',metrics:snapshot.metrics,topology:sanitize(topology),queue:sanitize(queue),jobs:sanitize(jobs),api_db_pool:{total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount,max:pool.options.max},installed:snapshot.metrics.provisioned_verified,reserved:snapshot.metrics.reserved,canonical_reserved:slots.filter(s=>s.account_id&&s.state!=='CONNECTED').length,legacy_reserved:snapshot.legacy.filter(row=>row.workspace_id===p.workspace_id).length,in_use:snapshot.metrics.connected_sessions,available:snapshot.metrics.available,headroom:snapshot.metrics.headroom,slots:slots.slice(page.offset,page.offset+page.limit),legacy_reservations:snapshot.legacy.filter(row=>row.workspace_id===p.workspace_id).map(row=>({slot:Number(row.slot),account_id:row.account_id,account_version:row.account_version,session_version:row.session_version,source:'LEGACY_GATEWAY_MAPPING'})),observation:sanitize(observation),workers:sanitize(workers),physical_sessions_observed:snapshot.metrics.physical_sessions_observed,physical_capacity_verified:snapshot.metrics.physical_capacity_measured,measurement_stale:!snapshot.measurementFresh,synthetic_capacity_verified:null},meta:{total:slots.length,next_offset:page.offset+page.limit<slots.length?page.offset+page.limit:null}};});});
 const reconciliation=async(req:FastifyRequest)=>{const p=permission(req);return withOperationalReadBudget(async c=>({data:sanitize(await readCapacityDiscrepancies(c,p.workspace_id,envOf(req)))}));};
 app.get('/v1/number-capacity/reconciliation',reconciliation);
 app.get('/v1/number-capacity/discrepancies',reconciliation);
 app.post('/v1/number-capacity/reconciliation/adopt-legacy',async(req,reply)=>{
  const p=permission(req,true),environment=envOf(req),input=capacityLegacyAdoptionSchema.parse(parseBody(req));if(environment!=='REAL')throw fail(400,'REAL_CAPACITY_ONLY');
  const result=await mutate(req,'number.capacity.adopt-legacy',async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('number-host:primary',0))");await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`capacity:${p.workspace_id}:${environment}`]);
   const accountIds=input.items.map(item=>item.account_id);await c.query("SELECT id FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='channel_account' AND id=ANY($2::uuid[]) FOR UPDATE",[p.workspace_id,accountIds]);await c.query("SELECT id FROM channel_sessions WHERE workspace_id=$1 AND environment='REAL' AND account_id=ANY($2::uuid[]) AND archived_at IS NULL FOR UPDATE",[p.workspace_id,accountIds]);
   const mappings=await physicalHostMappings(c),conflicts=physicalOwnershipConflicts(mappings),adopted:Body[]=[];
   for(const item of input.items){
    const mapping=mappings.find(row=>row.workspace_id===p.workspace_id&&row.account_id===item.account_id);if(!mapping)throw fail(409,'LEGACY_GATEWAY_MAPPING_NOT_FOUND');
    if(Number(mapping.account_version)!==item.expected_account_version)throw fail(409,'VERSION_CONFLICT');
    const sessionVersion=mapping.session_version===null||mapping.session_version===undefined?null:Number(mapping.session_version);if(sessionVersion!==item.expected_session_version)throw fail(409,'SESSION_VERSION_CONFLICT');
    if(mapping.canonical_slot!==null)throw fail(409,'LEGACY_SLOT_ALREADY_ADOPTED');
    if(mapping.gateway_slot_mismatch||mapping.physical_slot===null||Number(mapping.physical_slot)!==item.slot)throw fail(409,'GATEWAY_SLOT_MISMATCH');
    if(conflicts.has(item.slot))throw fail(409,'PHYSICAL_SLOT_OWNERSHIP_CONFLICT');
    if((await c.query("SELECT 1 FROM number_capacity_slots WHERE environment='REAL' AND host_ref='primary' AND slot=$1 FOR UPDATE",[item.slot])).rowCount)throw fail(409,'HOST_SLOT_ALREADY_RESERVED');
    const reconciledAt=new Date().toISOString(),slot=(await c.query("INSERT INTO number_capacity_slots(workspace_id,environment,host_ref,slot,state,account_id,gateway_ref,readback) VALUES($1,'REAL','primary',$2,'RESERVED',$3,$4,$5) RETURNING id,slot,version,state,account_id,gateway_ref,readback",[p.workspace_id,item.slot,item.account_id,'waha-'+String(item.slot).padStart(2,'0'),{verified:false,source:'legacy_gateway_reconciliation',reconciled_at:reconciledAt,evidence_sources:['channel_account','channel_session']}])).rows[0];adopted.push(slot);
   }
   await audit(c,req,'number.capacity.legacy_adopted',p.workspace_id,{account_ids:adopted.map(row=>row.account_id),slots:adopted.map(row=>row.slot),reason:input.reason,external_effects:false},environment);return{data:{adopted,external_effects:false,next_action:'READ_CAPACITY'},status:201};
  });reply.code(result.status??201);return{data:result.data};
 });
 app.post('/v1/number-capacity',async(req,reply)=>{const input=capacityCommandSchema.parse(parseBody(req)),p=permission(req,input.action!=='preview'),environment=envOf(req);
 const preview=async(c:QueryExecutor)=>{
  const now=await numberNow(c,p.workspace_id,environment);
  const slots=(await c.query('SELECT id,slot,version,state,account_id,readback FROM number_capacity_slots WHERE workspace_id=$1 AND environment=$2 ORDER BY slot',[p.workspace_id,environment])).rows,mappings=environment==='REAL'?await physicalHostMappings(c):[],occupied=environment==='REAL'?await legacyHostSlots(c,mappings):[],workspaceMappings=mappings.filter(row=>row.workspace_id===p.workspace_id),adoptedLegacy=slots.filter(slot=>slot.readback?.source==='legacy_gateway_reconciliation').map(slot=>Number(slot.slot)),preserved=[...new Set([...occupied.filter(s=>s.workspace_id===p.workspace_id).map(s=>Number(s.slot)),...adoptedLegacy])],inventoryFloor=Math.max(0,...slots.map(slot=>Number(slot.slot)),...workspaceMappings.flatMap(row=>row.physical_slots??[]).map(Number)),requestedTarget=input.count??(input.action==='preview'?inventoryFloor:Math.max(1,inventoryFloor)),target=Math.max(requestedTarget,inventoryFloor);
  if(target>NUMBER_SLOT_LIMIT)throw fail(409,'CONFIGURED_CAPACITY_LIMIT');
  const add=Math.max(0,target-new Set([...slots.filter(s=>s.slot<=target&&capacityReadbackIsFresh(s.readback,now)).map(s=>Number(s.slot)),...preserved.filter(n=>n<=target)]).size),candidate=(await c.query('SELECT * FROM number_capacity_observations WHERE workspace_id=$1 AND environment=$2 AND expires_at>now() ORDER BY observed_at DESC LIMIT 1',[p.workspace_id,environment])).rows[0],parsed=hostMetricsSchema.safeParse(candidate?.metrics),observation=candidate&&parsed.success?{...candidate,metrics:parsed.data}:undefined;
  const pending=(await c.query("SELECT id,state,action FROM number_operations WHERE workspace_id=$1 AND environment=$2 AND action IN('PROVISION','EXPAND','DRAIN') AND state IN('REQUESTED','RESERVED','PREPARING','HUMAN_ACTION_REQUIRED','UNKNOWN') ORDER BY created_at LIMIT 20",[p.workspace_id,environment])).rows;
  const ownershipConflicts=physicalOwnershipConflicts(mappings),gatewayMismatch=mappings.some(row=>row.gateway_slot_mismatch);
  const measuredBytesPerGateway=observation?.metrics.gateway_count?observation.metrics.measured_gateway_memory_bytes/observation.metrics.gateway_count:null,projectedMemoryBytes=add*Math.max(128*1024*1024,measuredBytesPerGateway??768*1024*1024),projectedDiskBytes=add*512*1024*1024,requiredDiskFreeBytes=1024*1024*1024+projectedDiskBytes,requiredRamMargin=Number(observation?.metrics.required_margin_ram??.25),requiredCpuMargin=Number(observation?.metrics.required_margin_cpu??.3);
  const blockers=environment!=='REAL'?[]:[
   ...(gatewayMismatch?['GATEWAY_SLOT_MISMATCH']:[]),
   ...(ownershipConflicts.size?['PHYSICAL_SLOT_OWNERSHIP_CONFLICT']:[]),
   ...(!observation?['HOST_MEASUREMENT_REQUIRED']:[]),
   ...(pending.some(row=>row.state==='UNKNOWN')?['CAPACITY_OPERATION_UNKNOWN']:pending.length?['CAPACITY_OPERATION_PENDING']:[]),
   ...(observation&&Number(observation.metrics.disk_available_bytes)<requiredDiskFreeBytes?['HOST_DISK_MARGIN_INSUFFICIENT']:[]),
   ...(observation&&(Number(observation.metrics.memory_available_bytes)-projectedMemoryBytes)/Number(observation.metrics.memory_total_bytes)<requiredRamMargin?['HOST_RAM_MARGIN_INSUFFICIENT']:[]),
   ...(observation&&Number(observation.metrics.cpu_busy_ratio)>1-requiredCpuMargin?['HOST_CPU_MARGIN_INSUFFICIENT']:[]),
  ];
  const diff={requested_target:input.count??null,target,target_adjusted_to_inventory:target!==requestedTarget,inventory_floor:inventoryFloor,additional_slots:add,existing_slots:slots,preserved_legacy_slots:preserved,legacy_host_conflict:occupied.some(s=>s.workspace_id!==p.workspace_id&&s.slot<=target),gateway_slot_mismatch:gatewayMismatch,physical_slot_ownership_conflict:ownershipConflicts.size>0,pending_operations:pending.map(row=>({id:row.id,state:row.state,action:row.action})),per_gateway_limits:{memory_mib:768,cpu:.3,disk_mib:512},additional_maxima:{memory_mib:add*768,cpu:add*.3,disk_mib:add*512},maximum_is_not_consumption:true,dimensioning:observation?{measured_bytes_per_gateway:measuredBytesPerGateway,projected_additional_bytes:projectedMemoryBytes,projected_additional_disk_bytes:projectedDiskBytes,required_disk_free_bytes:requiredDiskFreeBytes,required_ram_margin:requiredRamMargin,required_cpu_margin:requiredCpuMargin}:null,host_metrics:observation?.metrics??null,preserves_existing:true,starts_sessions:false};
  return{...diff,review:hash(stableJson(diff)),requires_infrastructure_authorization:environment==='REAL',reason:blockers[0]??null,blockers};
 };
 if(input.action==='preview')return withOperationalReadBudget(async c=>({data:await preview(c)}));
 const result=await mutate(req,'number.capacity.'+input.action,async c=>{if(environment==='REAL')await c.query("SELECT pg_advisory_xact_lock(hashtextextended('number-host:primary',0))");await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`capacity:${p.workspace_id}:${environment}`]);
 if(input.action==='provision_existing'||input.action==='release'){
  if(!input.slot_id||!input.expected_version||!input.account_id||!input.expected_account_version||input.expected_session_version===undefined)throw fail(400,'CAPACITY_BINDING_VERSIONS_REQUIRED');
  const slot=(await c.query('SELECT * FROM number_capacity_slots WHERE id=$1 AND workspace_id=$2 AND environment=$3 FOR UPDATE',[input.slot_id,p.workspace_id,environment])).rows[0];
  if(!slot||slot.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
  if(slot.account_id!==input.account_id)throw fail(409,'CAPACITY_ACCOUNT_BINDING_CHANGED');
  if((await c.query("SELECT 1 FROM number_operations WHERE workspace_id=$1 AND environment=$2 AND (id=$3 OR input->>'slot_id'=$4 OR input->'slot_ids' ? $4) AND state IN('REQUESTED','RESERVED','PREPARING','HUMAN_ACTION_REQUIRED','UNKNOWN') LIMIT 1",[p.workspace_id,environment,slot.operation_id,slot.id])).rowCount)throw fail(409,'CAPACITY_OPERATION_PENDING');
  const binding=await assertCapacityAccountQuiet(c,p.workspace_id,environment,input.account_id,{retired:input.action==='release',expectedAccountVersion:input.expected_account_version,expectedSessionVersion:input.expected_session_version});
  if(input.action==='release'){
   const drain=(await c.query("SELECT * FROM number_operations WHERE workspace_id=$1 AND environment=$2 AND action='DRAIN' AND input->>'slot_id'=$3 AND state='SUCCEEDED' ORDER BY created_at DESC LIMIT 1",[p.workspace_id,environment,slot.id])).rows[0];
   const now=await numberNow(c,p.workspace_id,environment),readback=slot.readback;
   if(slot.state!=='DRAINING'||!drain||!capacityReadbackIsFresh(readback,now)||readback.session_count!==0||readback.connected_sessions!==0||environment==='REAL'&&(drain.result?.outcome!=='VERIFIED'||readback.source!=='bounded_administrator')||environment==='SIMULATION'&&(!drain.result?.simulation||readback.adapter!=='no-network'))throw fail(409,'FRESH_DRAIN_READBACK_REQUIRED');
   await c.query("UPDATE number_capacity_slots SET account_id=NULL,state='PREPARED',version=version+1,updated_at=now() WHERE id=$1",[slot.id]);
   await audit(c,req,'number.capacity.released',slot.id,{account_id:input.account_id,drain_operation_id:drain.id,physical_provision_operation_id:slot.operation_id,reason:input.reason,history_preserved:true,external_effects:0});
   return{data:{slot_id:slot.id,version:slot.version+1,state:'PREPARED',account_id:null,history_preserved:true,next_action:'READ_CAPACITY'}};
  }
  const mapping=environment==='REAL'?(await physicalHostMappings(c)).find(row=>row.workspace_id===p.workspace_id&&row.account_id===input.account_id):undefined;
  if(environment!=='REAL'||binding.account.body.provider!=='waha'||!mapping||mapping.gateway_slot_mismatch||Number(mapping.physical_slot)!==slot.slot)throw fail(409,'CAPACITY_ACCOUNT_BINDING_CHANGED');
  const op=(await c.query("INSERT INTO number_operations(workspace_id,environment,actor_id,action,state,input) VALUES($1,$2,$3,'PROVISION','RESERVED',$4) RETURNING *",[p.workspace_id,environment,p.user.id,{account_id:input.account_id,slot_id:slot.id,existing_account:true,gateway_profile_ref:binding.account.body.gateway_ref,expected_account_version:input.expected_account_version,expected_session_version:input.expected_session_version}])).rows[0];
  const keepPhysical=await verifiedPhysicalProvision(c,slot.operation_id);
  await c.query("UPDATE number_capacity_slots SET state='RESERVED',operation_id=CASE WHEN $3 THEN operation_id ELSE $2 END,version=version+1,updated_at=now() WHERE id=$1",[slot.id,op.id,keepPhysical]);
  await audit(c,req,'number.capacity.existing_provision_requested',op.id,{account_id:input.account_id,slot_id:slot.id,reason:input.reason,external_effects:0});
  return{data:{operation_id:op.id,state:op.state,slot_id:slot.id,next_action:'APPLY_REVIEWED_CAPACITY'},status:202};
 }
 const checked=await preview(c);
 if(input.action!=='drain'&&(await c.query("SELECT 1 FROM number_capacity_slots s JOIN number_operations o ON (o.id=s.operation_id OR o.input->>'slot_id'=s.id::text OR o.input->'slot_ids' ? s.id::text) WHERE s.workspace_id=$1 AND s.environment=$2 AND s.slot<=$3 AND o.state IN('REQUESTED','RESERVED','PREPARING','UNKNOWN','HUMAN_ACTION_REQUIRED') LIMIT 1",[p.workspace_id,environment,checked.target])).rowCount)throw fail(409,'CAPACITY_OPERATION_PENDING');
 if(input.action!=='drain'&&environment==='REAL'&&checked.blockers.some((code:string)=>['GATEWAY_SLOT_MISMATCH','PHYSICAL_SLOT_OWNERSHIP_CONFLICT'].includes(code)))throw fail(409,checked.blockers[0]);
 if(input.action!=='drain'&&environment==='REAL'&&(checked.legacy_host_conflict||(await c.query("SELECT 1 FROM number_capacity_slots WHERE environment='REAL' AND host_ref='primary' AND workspace_id<>$1 AND slot<=$2",[p.workspace_id,checked.target])).rowCount))throw fail(409,'HOST_SLOT_ALREADY_RESERVED');
 if(input.action==='expand'&&(input.review!==checked.review||input.confirmation!=='APPLY_REVIEWED_CAPACITY'))throw fail(409,'CAPACITY_REVIEW_REQUIRED');if(input.action==='expand'&&environment==='REAL'&&checked.reason)throw fail(409,checked.reason);
 if(input.action==='drain'){if(!input.slot_id||!input.expected_version)throw fail(400,'SLOT_VERSION_REQUIRED');const slot=(await c.query('SELECT * FROM number_capacity_slots WHERE id=$1 AND workspace_id=$2 AND environment=$3 FOR UPDATE',[input.slot_id,p.workspace_id,environment])).rows[0];if(!slot||slot.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');if(slot.account_id&&(await c.query("SELECT 1 FROM outbox WHERE account_id=$1 AND status IN('SENDING','UNKNOWN')",[slot.account_id])).rowCount)throw fail(409,'RECONCILIATION_REQUIRED');await c.query("UPDATE number_capacity_slots SET state='DRAINING',version=version+1 WHERE id=$1",[slot.id]);}
 const op=(await c.query('INSERT INTO number_operations(workspace_id,environment,actor_id,action,input) VALUES($1,$2,$3,$4,$5) RETURNING *',[p.workspace_id,environment,p.user.id,input.action==='drain'?'DRAIN':'EXPAND',{...input,effective_target:checked.target,reviewed_diff:checked,apply:input.action==='expand'}])).rows[0];
 if(input.action!=='drain')await attachCapacityOperationSlots(c,p.workspace_id,environment,op.id,Array.from({length:checked.target},(_,i)=>i+1).filter(slot=>!checked.preserved_legacy_slots.includes(slot)));
 await audit(c,req,'number.capacity.requested',op.id,{action:input.action,target:checked.target,requested_target:input.count??null,reason:input.reason});return{data:{operation_id:op.id,state:op.state,target:checked.target,next_action:'READ_OPERATION'},status:202};});return reply.code(result.status??200).send({data:result.data});
 });
}
