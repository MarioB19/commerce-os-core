import type {Environment,Body,DomainRecord} from '../../../packages/contracts/src/index.js';
import type {Principal} from '../../../packages/domain/src/core/permissions.js';
import {readiness} from '../../../packages/domain/src/catalog/validation.js';
import {validateWorkflow} from '../../../packages/domain/src/sales/workflow.js';
import {offerSalesFlowAssetIds,workflowAssetIds} from '../../../packages/domain/src/sales/workflow-assets.js';
import {resolveSellerAssignment} from '../../../packages/domain/src/sales/seller-context.js';
import {numberState,maskedAlias} from '../../../packages/domain/src/warmup/number-state.js';
import {preparationProgress,STANDARD_V1_POLICY,STANDARD_V2_POLICY,type Declaration} from '../../../packages/domain/src/warmup/preparation.js';
import {readOperationalSettings} from '../../../packages/db/src/operational-settings.js';
import {commercialAssignmentResourceIds,commercialAssignmentSnapshot,type CommercialAssignment} from '../../../packages/db/src/commercial-assignments.js';
import {integrationDefinitions,validateIntegrationConfig,type IntegrationType} from '../../../packages/db/src/integration-settings.js';
import {readEffectiveHealthBatch,currentEffectiveSignal,currentProviderHealthReady} from '../../../packages/db/src/effective-health.js';
import {numberNow} from '../../../packages/db/src/number-clock.js';
import type {QueryExecutor} from '../../../packages/db/src/index.js';
import {projectAssignmentAuthorization} from './assignment-authorization.js';
import {fail,resourcePermitted} from './context.js';

type PageInput={q?:string;state?:string;offset:number;limit:number};
type OperationalProjection={status:string;connection:string;cause:string;observed_at:unknown;expires_at:unknown;source:string;fresh:boolean;session:Body|null;session_version:number|null;pending_commands:Body[];uncertain_commands:Body[]};
type PreparationProjection={episode:Body|null;progress:Body|null;state:Body|null;policy_version:string|null;declarations?:Declaration[];credits?:number};

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_FILTER_SCAN_LIMIT=100;
const push=<T>(map:Map<string,T[]>,key:string,value:T)=>map.set(key,[...(map.get(key)??[]),value]);
const falseChecks=(checks:Body[])=>checks.filter(check=>!check.ok).map(check=>({code:check.key,text:check.label}));
const ids=(values:unknown[])=>[...new Set(values.filter((value):value is string=>typeof value==='string'&&uuid.test(value)))];
const countersOf=(items:Body[])=>{const counters:Body={};for(const item of items)counters[item.primary_state]=(counters[item.primary_state]??0)+1;return counters;};

function integrationConfigured(row:Body|undefined){
 if(!row?.enabled)return false;
 const type=row.type as IntegrationType,definition=integrationDefinitions.find(candidate=>candidate.type===type);
 if(!definition||definition.secret_fields.some(field=>field.required&&!row.secret_fields?.[field.name]))return false;
 try{validateIntegrationConfig(type,row.config??{},true);return true;}catch{return false;}
}

function salesAiReady(agent:DomainRecord|undefined,integrationByKey:Map<string,Body>){
 if(!agent||agent.body.provider==='deterministic')return true;
 const profile=integrationByKey.get('openai:default');if(!integrationConfigured(profile))return false;
 if(profile?.type!=='openai')return false;
 const inherited=agent.body.provider==='workspace',model=inherited?profile?.config?.model:agent.body.model,limit=inherited?profile?.config?.max_cost_minor:agent.body.max_cost_minor;
 return typeof model==='string'&&!!model.trim()&&Number.isInteger(limit)&&Number(limit)>0;
}

/**
 * Batched list adapter for the canonical operational-state contract. Keep this
 * boundary small so a future shared effective-health resolver can replace the
 * SQL without changing the list projection.
 */
async function listOperationalStates(c:QueryExecutor,workspace:string,environment:Environment,accountIds:string[],now:Date){
 const sessions=(await c.query('SELECT * FROM channel_sessions WHERE workspace_id=$1 AND environment=$2 AND account_id=ANY($3::uuid[]) AND archived_at IS NULL',[workspace,environment,accountIds])).rows;
 const commands=(await c.query(`SELECT * FROM (
  SELECT id,resource_id,status,payload->>'type' type,result->>'error' error,created_at,updated_at,
   CASE WHEN status='PENDING' THEN 'pending' ELSE 'uncertain' END category,
   row_number() OVER(PARTITION BY resource_id,CASE WHEN status='PENDING' THEN 'pending' ELSE 'uncertain' END ORDER BY created_at DESC) position
  FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=ANY($3::text[]) AND kind='channel_command' AND (
   status='PENDING' AND payload->>'type' IN('connect','restart','disconnect','logout','check_health') OR
   status='FAILED' AND payload->>'type' IN('connect','restart','disconnect','logout') AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at')
  )
 ) ranked WHERE position<=20 ORDER BY resource_id,category,created_at DESC`,[workspace,environment,accountIds])).rows;
 const sessionByAccount=new Map(sessions.map(session=>[String(session.account_id),session]));
 const pending=new Map<string,Body[]>(),uncertain=new Map<string,Body[]>();
 for(const command of commands)push(command.category==='pending'?pending:uncertain,String(command.resource_id),command);
 const result=new Map<string,OperationalProjection>();
 for(const accountId of accountIds){
  const session=sessionByAccount.get(accountId),pendingCommands=pending.get(accountId)??[],uncertainCommands=uncertain.get(accountId)??[];
  const fresh=!!session?.health_expires_at&&new Date(session.health_expires_at)>now&&(!session.last_health_at||new Date(session.last_health_at)<=now);
  const stored=String(session?.observed_state??'UNKNOWN'),state=fresh?stored:'UNKNOWN';
  const connection=state==='CONNECTED'?'CONNECTED':state==='QR_REQUIRED'?'QR_REQUIRED':state==='STARTING'||state==='RECONNECTING'?'CONNECTING':state==='STOPPED'?'DISCONNECTED':state==='AUTH_FAILURE'?'AUTH_FAILURE':'UNKNOWN';
  const status=uncertainCommands.length?'UNKNOWN':pendingCommands.length?'IN_PROGRESS':connection==='CONNECTED'?'READY':connection==='CONNECTING'?'IN_PROGRESS':connection==='AUTH_FAILURE'?'BLOCKED':'REQUIRES_ATTENTION';
  const cause=uncertainCommands.length?'REMOTE_OUTCOME_UNKNOWN':pendingCommands.length?'LIFECYCLE_COMMAND_PENDING':!session?'SESSION_NOT_CREATED':!fresh?'SESSION_EVIDENCE_STALE':session.disconnect_reason??(connection==='QR_REQUIRED'?'QR_REQUIRED':connection==='DISCONNECTED'?'SESSION_STOPPED':connection);
  result.set(accountId,{status,connection,cause,observed_at:session?.last_health_at??session?.provider_observed_at??null,expires_at:session?.health_expires_at??null,source:'channel_sessions',fresh,session:session??null,session_version:session?.revision??null,pending_commands:pendingCommands,uncertain_commands:uncertainCommands});
 }
 return result;
}

async function listPreparations(c:QueryExecutor,workspace:string,environment:Environment,accountIds:string[],now:Date){
 const rows=(await c.query(`WITH selected(account_id) AS (SELECT unnest($3::uuid[])), prepared_accounts AS (
  SELECT selected.account_id,to_jsonb(e) episode,
   CASE WHEN s.account_id IS NULL THEN NULL ELSE to_jsonb(s)||jsonb_build_object('config',p.config) END state,
   e.id episode_id,e.policy_version,e.started_at,e.timezone,s.pool_id,s.effective_days,s.stable_since,s.last_observed_at,s.confirmed_block,p.config
  FROM selected
  LEFT JOIN warmup_episodes e ON e.account_id=selected.account_id AND e.workspace_id=$1 AND e.environment=$2 AND e.closed_at IS NULL
  LEFT JOIN warmup_states s ON s.account_id=selected.account_id AND s.workspace_id=$1 AND s.environment=$2
  LEFT JOIN warmup_profiles p ON p.id=s.profile_id AND p.workspace_id=s.workspace_id AND p.environment=s.environment
 ), stats AS (
  SELECT prepared_accounts.account_id,count(o.id)::int samples,count(o.id) FILTER(WHERE o.status IN('DELIVERED','READ'))::int delivered
  FROM prepared_accounts JOIN outbox o ON o.workspace_id=$1 AND o.environment=$2 AND o.kind='warmup' AND o.account_id=prepared_accounts.account_id::text AND o.attempts>0
   AND o.claimed_at>=prepared_accounts.started_at AND o.claimed_at<$4::timestamptz-make_interval(mins=>COALESCE((prepared_accounts.config->>'ack_maturity_minutes')::int,30))
  LEFT JOIN warmup_conversations conversation ON conversation.id::text=o.conversation_id
  LEFT JOIN warmup_pools pool ON pool.id=conversation.pool_id
  WHERE prepared_accounts.episode_id IS NOT NULL AND (prepared_accounts.policy_version<>$5 OR conversation.pool_id=prepared_accounts.pool_id AND pool.purpose='preparation')
  GROUP BY prepared_accounts.account_id
 ), credits AS (
  SELECT prepared_accounts.account_id,count(credit.id)::int days FROM prepared_accounts JOIN warmup_day_credits credit ON credit.episode_id=prepared_accounts.episode_id AND credit.account_id=prepared_accounts.account_id
  WHERE prepared_accounts.policy_version=$5 GROUP BY prepared_accounts.account_id
 ), next_execution AS (
  SELECT prepared_accounts.account_id,min(o.not_before) next_execution_at FROM prepared_accounts
  JOIN outbox o ON o.workspace_id=$1 AND o.environment=$2 AND o.account_id=prepared_accounts.account_id::text AND o.status IN('READY','BLOCKED') AND o.not_before>=$4
  JOIN warmup_conversations conversation ON conversation.id::text=o.conversation_id AND conversation.pool_id=prepared_accounts.pool_id
  WHERE prepared_accounts.state IS NOT NULL GROUP BY prepared_accounts.account_id
 )
 SELECT prepared_accounts.*,COALESCE(stats.samples,0)::int samples,COALESCE(stats.delivered,0)::int delivered,
  COALESCE(credits.days,0)::int automatic_days,next_execution.next_execution_at
 FROM prepared_accounts LEFT JOIN stats USING(account_id) LEFT JOIN credits USING(account_id) LEFT JOIN next_execution USING(account_id)`,[workspace,environment,accountIds,now,STANDARD_V2_POLICY])).rows;
 const episodeIds=rows.map(row=>row.episode_id).filter(Boolean);
 const declarations=episodeIds.length?(await c.query('SELECT *,local_date::text FROM warmup_manual_declarations WHERE episode_id=ANY($1::uuid[]) ORDER BY episode_id,recorded_at,id',[episodeIds])).rows:[];
 const declarationsByEpisode=new Map<string,Declaration[]>();
 for(const declaration of declarations)push(declarationsByEpisode,String(declaration.episode_id),{...declaration,recorded_at:new Date(declaration.recorded_at).toISOString()} as Declaration);
 const result=new Map<string,PreparationProjection>();
 for(const row of rows){
  const accountId=String(row.account_id),episode=row.episode as Body|null,state=row.state as Body|null;
  if(!episode){result.set(accountId,{episode:null,progress:null,state,policy_version:String(state?.config?.policy_version??(state?'legacy-30d/v1':''))||null});continue;}
  const episodeDeclarations=declarationsByEpisode.get(String(episode.id))??[],automaticDays=episode.policy_version===STANDARD_V2_POLICY?Number(row.automatic_days):Number(state?.effective_days??0);
  const progress=preparationProgress({policy_version:String(episode.policy_version),started_at:new Date(String(episode.started_at)).toISOString(),timezone:String(episode.timezone),declarations:episodeDeclarations,automatic_days:automaticDays,stable_since:state?.stable_since?new Date(String(state.stable_since)).toISOString():null,last_observed_at:state?.last_observed_at?new Date(String(state.last_observed_at)).toISOString():null,mature_samples:Number(row.samples),delivered:Number(row.delivered),confirmed_block:state?.confirmed_block===true,now});
  result.set(accountId,{episode,state,progress:{...progress,next_execution_at:row.next_execution_at?new Date(row.next_execution_at).toISOString():null,completed:!!episode.completed_at||progress.completed,environment,temporal_source:environment==='REAL'?'observed':'simulation'},declarations:episode.policy_version===STANDARD_V1_POLICY?episodeDeclarations:[],credits:automaticDays,policy_version:String(episode.policy_version)});
 }
 return result;
}

async function projectList(c:QueryExecutor,p:Principal,environment:Environment,accounts:DomainRecord[]){
 if(!accounts.length)return[];
 const accountIds=accounts.map(account=>account.id),now=await numberNow(c,p.workspace_id,environment);
 const [operational,preparations,healthByAccount,ownershipRows,controlRows,assignmentSnapshot,programRows,settings,uncertainRows,integrationRows]=await Promise.all([
  listOperationalStates(c,p.workspace_id,environment,accountIds,now),
  listPreparations(c,p.workspace_id,environment,accountIds,now),
  readEffectiveHealthBatch(c,{workspaceId:p.workspace_id,environment,accountIds,now}),
  c.query('SELECT account_id,frozen,lease_expires_at FROM session_ownership WHERE workspace_id=$1 AND account_id=ANY($2::text[])',[p.workspace_id,accountIds]).then(result=>result.rows),
  c.query("SELECT scope_type,scope_id FROM manual_controls WHERE workspace_id=$1 AND (scope_type='workspace' AND scope_id=$1 OR scope_type='channel_account' AND scope_id=ANY($2::text[])) AND (paused OR suppressed OR takeover)",[p.workspace_id,accountIds]).then(result=>result.rows),
  commercialAssignmentSnapshot(c,p.workspace_id,environment,accountIds,now),
  c.query(`SELECT DISTINCT ON(member.account_id) member.account_id,program.id,program.status,program.name FROM warmup_programs program
   CROSS JOIN LATERAL unnest(program.account_ids) member(account_id) WHERE program.workspace_id=$1 AND program.environment=$2 AND member.account_id=ANY($3::uuid[]) AND program.status<>'ARCHIVED'
   ORDER BY member.account_id,program.updated_at DESC,program.id`,[p.workspace_id,environment,accountIds]).then(result=>result.rows),
  readOperationalSettings(c,p.workspace_id,environment),
  c.query("SELECT DISTINCT account_id FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=ANY($3::text[]) AND status IN('SENDING','UNKNOWN')",[p.workspace_id,environment,accountIds]).then(result=>result.rows),
  c.query('SELECT key,type,enabled,config,secret_fields FROM integration_settings WHERE workspace_id=$1 AND environment=$2',[p.workspace_id,environment]).then(result=>result.rows),
 ]);
 const assignments=assignmentSnapshot.current.filter(assignment=>commercialAssignmentResourceIds(assignment).every(resourceId=>resourcePermitted(p,resourceId)));
 const primaryCatalogIds=ids(assignments.flatMap(assignment=>[assignment.product_id,assignment.body.offer_version_id,assignment.body.workflow_version_id,assignment.body.agent_version_id]));
 const authorizationIds=[...new Set(assignments.map(assignment=>assignment.authorization_id).filter((value):value is string=>!!value))];
 const [primaryCatalog,authorizations,usageRows]=await Promise.all([
  primaryCatalogIds.length?c.query("SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND id=ANY($3::uuid[]) AND kind=ANY($4::text[])",[p.workspace_id,environment,primaryCatalogIds,['product','offer','workflow','agent']]).then(result=>result.rows as DomainRecord[]):[],
  authorizationIds.length?c.query('SELECT id,created_at,expires_at,scope,revoked_at,configuration_version FROM operation_authorizations WHERE workspace_id=$1 AND environment=$2 AND id=ANY($3::uuid[])',[p.workspace_id,environment,authorizationIds]).then(result=>result.rows):[],
  authorizationIds.length?c.query("SELECT authorization_id,count(*)::int count FROM outbox WHERE authorization_id=ANY($1::uuid[]) AND status IN('SENDING','SENT','DELIVERED','READ','UNKNOWN') GROUP BY authorization_id",[authorizationIds]).then(result=>result.rows):[],
 ]);
	 const primaryById=new Map(primaryCatalog.map(row=>[row.id,row])),secondaryIds=ids(assignments.flatMap(assignment=>{
	  const product=primaryById.get(assignment.product_id),offer=primaryById.get(assignment.body.offer_version_id),workflow=primaryById.get(assignment.body.workflow_version_id),seller=resolveSellerAssignment({binding:assignment.body,offer:offer?.body,product:product?.body,workflow:workflow?.body});
	  return[seller.agent_version_id,...offerSalesFlowAssetIds(offer?.body??{}),...workflowAssetIds(workflow?.body??{}),...(offer?.body.fulfillment??[]).map((item:Body)=>item.asset_id)];
	 }).filter(id=>!primaryById.has(id)));
	 const lineageSeedIds=ids(assignments.flatMap(assignment=>{const product=primaryById.get(assignment.product_id),offer=primaryById.get(assignment.body.offer_version_id),workflow=primaryById.get(assignment.body.workflow_version_id);return[product?.id,offer?.id,offer?.body.product_id,workflow?.body.product_id,workflow?.body.offer_version_id];})).filter(resourceId=>resourcePermitted(p,resourceId));
	 const [secondaryCatalog,lineageRows]=await Promise.all([
	  secondaryIds.length?c.query("SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND id=ANY($3::uuid[]) AND kind=ANY($4::text[])",[p.workspace_id,environment,secondaryIds,['agent','asset']]).then(result=>result.rows as DomainRecord[]):[],
	  lineageSeedIds.length?c.query(`WITH RECURSIVE lineage(seed_id,kind,id,body,path,depth) AS (
	   SELECT r.id,r.kind,r.id,r.body,ARRAY[r.id]::uuid[],0 FROM records r
	   WHERE r.workspace_id=$1 AND r.environment=$2 AND r.id=ANY($3::uuid[]) AND r.kind=ANY(ARRAY['product','offer','workflow'])
	   UNION ALL
	   SELECT lineage.seed_id,parent.kind,parent.id,parent.body,lineage.path||parent.id,lineage.depth+1
	   FROM lineage
	   CROSS JOIN LATERAL (SELECT
	    NULLIF(lineage.body->>'series_id','') AS series_id,
	    lineage.kind='workflow' AND lineage.body->>'status'='DRAFT' AND NULLIF(lineage.body->>'parent_id','') IS NOT NULL AND NULLIF(lineage.body->>'source_version_id','') IS NULL AS standalone,
	    COALESCE(NULLIF(lineage.body->>'source_version_id',''),CASE WHEN lineage.kind='workflow' THEN NULLIF(lineage.body->>'parent_id','') END) AS parent_id
	   ) edge
	   JOIN records parent ON parent.workspace_id=$1 AND parent.environment=$2 AND parent.kind=lineage.kind AND parent.id::text=edge.parent_id
	   WHERE edge.series_id IS NULL AND NOT edge.standalone AND edge.parent_id IS NOT NULL AND lineage.depth<100 AND NOT parent.id=ANY(lineage.path)
	  ), resolved AS (
	   SELECT lineage.seed_id,lineage.depth,CASE
	    WHEN edge.series_id IS NOT NULL THEN edge.series_id
	    WHEN edge.standalone OR edge.parent_id IS NULL THEN lineage.id::text
	   END AS root_id
	   FROM lineage
	   CROSS JOIN LATERAL (SELECT
	    NULLIF(lineage.body->>'series_id','') AS series_id,
	    lineage.kind='workflow' AND lineage.body->>'status'='DRAFT' AND NULLIF(lineage.body->>'parent_id','') IS NOT NULL AND NULLIF(lineage.body->>'source_version_id','') IS NULL AS standalone,
	    COALESCE(NULLIF(lineage.body->>'source_version_id',''),CASE WHEN lineage.kind='workflow' THEN NULLIF(lineage.body->>'parent_id','') END) AS parent_id
	   ) edge
	   WHERE edge.series_id IS NOT NULL OR edge.standalone OR edge.parent_id IS NULL
	  ) SELECT DISTINCT ON(seed_id) seed_id::text,root_id FROM resolved WHERE root_id IS NOT NULL ORDER BY seed_id,depth DESC`,[p.workspace_id,environment,lineageSeedIds]).then(result=>result.rows as Array<{seed_id:string;root_id:string}>):[],
	 ]);
	 const lineageById=new Map(lineageRows.map(row=>[row.seed_id,row.root_id]));
	 const catalogById=new Map([...primaryCatalog,...secondaryCatalog].map(row=>[row.id,row])),integrationByKey=new Map(integrationRows.map(row=>[String(row.key),row]));
 const ownership=new Map(ownershipRows.map(row=>[String(row.account_id),row]));
 const programs=new Map(programRows.map(row=>[String(row.account_id),row]));
 const authorizationById=new Map(authorizations.map(row=>[String(row.id),row])),usageByAuthorization=new Map(usageRows.map(row=>[String(row.authorization_id),Number(row.count)]));
 const assignmentsByAccount=new Map<string,CommercialAssignment[]>();for(const assignment of assignments)push(assignmentsByAccount,String(assignment.account_id),assignment);
 const globalPaused=controlRows.some(row=>row.scope_type==='workspace'&&row.scope_id===p.workspace_id),pausedAccounts=new Set(controlRows.filter(row=>row.scope_type==='channel_account').map(row=>String(row.scope_id))),uncertainAccounts=new Set(uncertainRows.map(row=>String(row.account_id)));
 return accounts.map(account=>{
  const op=operational.get(account.id)!,health=healthByAccount.get(account.id)!,preparation=preparations.get(account.id)??{episode:null,progress:null,state:null,policy_version:null},owner=ownership.get(account.id),program=programs.get(account.id),restricted=currentEffectiveSignal(health,'restriction')?.status==='BLOCKED';
  const connection=op.connection==='CONNECTED'?'CONNECTED':op.connection==='DISCONNECTED'?'DISCONNECTED':'PENDING',paused=globalPaused||pausedAccounts.has(account.id),prepared=preparation.state?preparation.state.status==='GRADUATED':!preparation.episode&&!account.body.number_policy_version;
  const sales=(assignmentsByAccount.get(account.id)??[]).map(assignment=>{
   const product=catalogById.get(assignment.product_id),offer=catalogById.get(assignment.body.offer_version_id),workflow=catalogById.get(assignment.body.workflow_version_id),seller=resolveSellerAssignment({binding:assignment.body,offer:offer?.body,account:account.body,product:product?.body,workflow:workflow?.body}),agent=seller.agent_version_id?catalogById.get(seller.agent_version_id):undefined;
	   const lineageReferences=ids([offer?.body.product_id,workflow?.body.product_id,workflow?.body.offer_version_id]);
	   const visible=product?.kind==='product'&&offer?.kind==='offer'&&workflow?.kind==='workflow'
	    &&[product,offer,workflow].every(row=>resourcePermitted(p,row.id))
	    &&lineageReferences.every(resourceId=>resourcePermitted(p,resourceId))
	    &&(!seller.agent_version_id||agent?.kind==='agent'&&resourcePermitted(p,agent.id));
	   const productLineage=product&&lineageById.get(product.id),offerLineage=offer&&lineageById.get(offer.id);
	   const compatible=visible&&![product,offer,workflow,agent].filter(Boolean).some(row=>row!.body.archived_at||row!.body.status==='ARCHIVED')&&!!productLineage&&lineageById.get(String(offer?.body.product_id))===productLineage&&(!workflow?.body.product_id||lineageById.get(String(workflow.body.product_id))===productLineage)&&(!workflow?.body.offer_version_id||lineageById.get(String(workflow.body.offer_version_id))===offerLineage)&&(!agent?.body.product_id||agent.body.product_id===product?.id)&&(!agent?.body.offer_version_id||agent.body.offer_version_id===offer?.id);
   const assetIds=ids([...(offer?.body.fulfillment??[]).map((item:Body)=>item.asset_id),...offerSalesFlowAssetIds(offer?.body??{}),...workflowAssetIds(workflow?.body??{})]),assets=assetIds.map(id=>catalogById.get(id)),assetsReady=assetIds.length>0&&assets.every(asset=>asset?.kind==='asset'&&asset.environment===environment&&asset.body.status==='READY'),needsFulfillment=assets.some(asset=>asset?.body.kind==='access'&&asset.body.adapter==='webhook');
   const healthReady=currentProviderHealthReady(health,String(account.body.provider)),transportSignal=currentEffectiveSignal(health,'transport'),ownerReady=!!owner&&!owner.frozen&&new Date(owner.lease_expires_at).getTime()>now.getTime()+2000,checks:Body[]=[
    {key:'assignment',label:'Selecciona producto, oferta y flujo compatibles',ok:compatible},
    {key:'offer',label:'Oferta publicada',ok:offer?.body.status==='PUBLISHED'},
    {key:'workflow',label:'Flujo publicado y válido',ok:workflow?.body.status==='PUBLISHED'&&validateWorkflow(workflow.body as any).valid},
    {key:'delivery_payment',label:'Material de entrega y cobro configurados',ok:!!offer&&readiness(offer.body).ready},
    {key:'assets',label:'Archivos y accesos de entrega disponibles',ok:assetsReady},
    ...(needsFulfillment?[{key:'fulfillment',label:'Servicio de entrega configurado',ok:integrationConfigured(integrationByKey.get('fulfillment:default'))}]:[]),
    ...(agent&&agent.body.provider!=='deterministic'?[{key:'ai',label:'Proveedor de IA, modelo y presupuesto configurados',ok:salesAiReady(agent,integrationByKey)}]:[]),
    {key:'provider',label:'Proveedor compatible con el entorno',ok:environment==='REAL'?['waha','cloud'].includes(String(account.body.provider)):account.body.provider==='simulator'},
    ...(environment==='REAL'?[{key:'connection',label:'Conexión del proveedor configurada',ok:integrationConfigured(integrationByKey.get(`${account.body.provider}:${account.body.gateway_ref??'default'}`))}]:[]),
    {key:'operations',label:'Envíos reales habilitados en este entorno',ok:environment!=='REAL'||!settings.body.dispatch_frozen&&settings.body.real_sends_enabled&&settings.body.allow_real_operations},
    {key:'session',label:'Número conectado',ok:op.connection==='CONNECTED'&&op.fresh},
    {key:'ownership',label:'Sesión bajo control del worker o transferencia verificada',ok:ownerReady},
    {key:'identity',label:'Identidad del número verificada',ok:environment!=='REAL'||account.body.provider!=='waha'||account.body.identity_verified===true&&account.body.identity_conflict!==true},
    {key:'health',label:'Estado reciente del canal sin bloqueos',ok:healthReady},
    {key:'identity_health',label:'Evidencia reciente de la identidad conectada',ok:environment!=='REAL'||account.body.provider!=='waha'||transportSignal?.status==='OK'&&(transportSignal.value as Body|undefined)?.identity_fingerprint===account.body.identity_fingerprint},
    {key:'global_pause',label:'Pausa general del workspace liberada',ok:!globalPaused},
    {key:'uncertain',label:'Sin envíos en curso o con resultado incierto',ok:!uncertainAccounts.has(account.id)},
   ];
   const authorization=assignment.authorization_id?authorizationById.get(assignment.authorization_id)??null:null;
   const eligibility=projectAssignmentAuthorization({setup:{checks,sending_enabled:account.body.sending_enabled===true,configuration_version:settings.version},assignment,account,authorization,usage:authorization?usageByAuthorization.get(String(authorization.id))??0:0,now});
   return{assignment_id:assignment.id,product_id:assignment.product_id,name:maskedAlias(product?.body.name??'Producto'),ready:eligibility.ready&&prepared&&op.fresh&&!paused&&ownerReady,checks:falseChecks(checks)};
  });
	  const summary=numberState({restricted,identityConflict:account.body.identity_conflict===true,paused:paused||program?.status==='PAUSED',connection,ownership:!!owner&&!owner.frozen&&account.body.identity_verified===true&&new Date(owner.lease_expires_at)>now,prepared:prepared&&(!!preparation.episode?.completed_at||preparation.state?.status==='GRADUATED'||sales.some(item=>item.ready)),warming:program?.status==='ACTIVE'||preparation.state?.status==='WARMING',reviewed:program?.status==='REVIEWED'||program?.status==='AUTHORIZED',sales});
  return{id:account.id,version:account.version,alias:maskedAlias(account.body.name??'Número'),masked_number:maskedAlias(account.body.masked_number??account.body.name??''),responsible:account.body.responsible??null,...summary,reason_code:restricted?'CONFIRMED_RESTRICTION':account.body.identity_conflict?'IDENTITY_CONFLICT':op.cause??summary.primary_state,connection:{state:connection,canonical_state:op.connection,status:op.status,cause:op.cause,observed_at:op.observed_at,expires_at:op.expires_at,source:op.source},preparation:preparation.progress??{stage:preparation.state?.status==='GRADUATED'?'COMPLETED':preparation.state?'LEGACY':'NOT_STARTED',policy_version:preparation.policy_version,effective_days:preparation.state?.effective_days??0},sales_readiness:sales,program,observed_at:op.observed_at,expires_at:op.expires_at,computed_at:now.toISOString(),source_refs:[{kind:'channel_account',id:account.id},{kind:'channel_session',id:op.session?.id??null,observed_at:op.observed_at}],environment:account.environment};
 });
}

export async function listNumberPage(c:QueryExecutor,p:Principal,environment:Environment,input:PageInput){
 const scopedIds=p.service&&p.resource_ids?p.resource_ids.filter(id=>uuid.test(id)):null,values=[p.workspace_id,environment,input.q??null,scopedIds];
 const where="workspace_id=$1 AND environment=$2 AND kind='channel_account' AND NOT body?'deleted_at' AND ($3::text IS NULL OR strpos(lower(COALESCE(body->>'name','Número')),lower($3))>0) AND ($4::uuid[] IS NULL OR id=ANY($4::uuid[]))";
 // State is derived. Preserve exact filtering only for a bounded candidate set;
 // broad state scans must be narrowed instead of turning one read into an
 // unbounded projection of the entire workspace.
 if(input.state){
  const candidates=(await c.query(`SELECT * FROM records WHERE ${where} ORDER BY created_at,id LIMIT $5`,[...values,STATE_FILTER_SCAN_LIMIT+1])).rows as DomainRecord[];
  if(candidates.length>STATE_FILTER_SCAN_LIMIT)throw fail(422,'STATE_FILTER_TOO_BROAD','Acota la búsqueda antes de filtrar por estado.');
  const projected=await projectList(c,p,environment,candidates),filtered=projected.filter(item=>item.primary_state===input.state),data=filtered.slice(input.offset,input.offset+input.limit);
  return{data,meta:{total:filtered.length,counters:countersOf(data),counters_scope:'page',page_count:data.length,next_offset:input.offset+input.limit<filtered.length?input.offset+input.limit:null}};
 }
 const total=Number((await c.query(`SELECT count(*)::int count FROM records WHERE ${where}`,values)).rows[0]?.count??0);
 const accounts=(await c.query(`SELECT * FROM records WHERE ${where} ORDER BY created_at,id LIMIT $5 OFFSET $6`,[...values,input.limit,input.offset])).rows as DomainRecord[];
 const data=await projectList(c,p,environment,accounts);
 return{data,meta:{total,counters:countersOf(data),counters_scope:'page',page_count:data.length,next_offset:input.offset+input.limit<total?input.offset+input.limit:null}};
}
