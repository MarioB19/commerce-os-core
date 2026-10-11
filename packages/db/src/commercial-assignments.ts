import {getRecord,listRecords,hash,stableJson,type QueryExecutor} from './index.js';
import type {Body,DomainRecord,Environment} from '../../contracts/src/index.js';
import {matchAssignedProductAliases} from '../../domain/src/sales/product-routing.js';
export const channelIdentityHash=(account:DomainRecord)=>hash(stableJson({provider:account.body.provider,gateway_ref:account.body.gateway_ref??null,identity_fingerprint:account.body.identity_fingerprint??null}));
export interface CommercialAssignment {id:string;workspace_id:string;environment:Environment;account_id:string;product_id:string;binding_id:string;revision:number;state:string;authorization_id:string|null;authorization_expires_at?:string;authorization_revoked_at?:string;authorization_scope?:Body;body:Body}
export interface LegacyCommercialBinding {id:string;account_id:string;product_id:string;body:Body;created_at:string;updated_at:string}
export interface AccountCommercialAssignmentSnapshot {observed_at:string;has_canonical:boolean;canonical:CommercialAssignment[];current:CommercialAssignment[];legacy?:LegacyCommercialBinding}
export interface CommercialAssignmentSnapshot {observed_at:string;canonical:CommercialAssignment[];current:CommercialAssignment[];legacy:LegacyCommercialBinding[];byAccount:Map<string,AccountCommercialAssignmentSnapshot>}
export async function listAssignments(c:QueryExecutor,workspace:string,environment:Environment,filter:{account_id?:string;product_id?:string;status?:string}={}){
 return (await c.query(`SELECT a.*,b.body,auth.expires_at AS authorization_expires_at,auth.revoked_at AS authorization_revoked_at,auth.scope AS authorization_scope FROM commercial_assignments a JOIN records b ON b.id=a.binding_id LEFT JOIN operation_authorizations auth ON auth.id=a.authorization_id AND auth.workspace_id=a.workspace_id AND auth.environment=a.environment WHERE a.workspace_id=$1 AND a.environment=$2 AND ($3::uuid IS NULL OR a.account_id=$3) AND ($4::uuid IS NULL OR a.product_id=$4) AND ($5::text IS NULL OR a.state=$5) ORDER BY a.created_at,a.id`,[workspace,environment,filter.account_id??null,filter.product_id??null,filter.status??null])).rows as CommercialAssignment[];
}
export async function assignmentFor(c:QueryExecutor,workspace:string,environment:Environment,id:string,lock:false|true|'share'=false){return(await c.query(`SELECT a.*,b.body,auth.expires_at AS authorization_expires_at,auth.revoked_at AS authorization_revoked_at,auth.scope AS authorization_scope FROM commercial_assignments a JOIN records b ON b.id=a.binding_id LEFT JOIN operation_authorizations auth ON auth.id=a.authorization_id AND auth.workspace_id=a.workspace_id AND auth.environment=a.environment WHERE a.workspace_id=$1 AND a.environment=$2 AND a.id=$3 ${lock===true?'FOR UPDATE OF a':lock==='share'?'FOR SHARE OF a':''}`,[workspace,environment,id])).rows[0] as CommercialAssignment|undefined;}
export function activeAt(a:CommercialAssignment,at:string){return a.state==='ACTIVE'&&Date.parse(a.body.valid_from)<=Date.parse(at)&&(!a.body.valid_to||Date.parse(a.body.valid_to)>Date.parse(at));}
/**
 * One database-clock snapshot for every account in a read projection. Canonical
 * rows always suppress legacy fallback, even when they are future, expired,
 * draft or retired. This prevents an older binding from silently replacing a
 * deliberately non-current assignment.
 */
export async function commercialAssignmentSnapshot(c:QueryExecutor,workspace:string,environment:Environment,accountIds?:string[],effectiveAt?:Date):Promise<CommercialAssignmentSnapshot>{
 const ids=accountIds??null,row=(await c.query(`/* commercial_assignment_snapshot */
	  WITH snapshot AS MATERIALIZED(SELECT COALESCE($4::timestamptz,clock_timestamp()) AS observed_at),
  canonical AS MATERIALIZED(
   SELECT a.*,b.body,auth.expires_at AS authorization_expires_at,auth.revoked_at AS authorization_revoked_at,auth.scope AS authorization_scope
   FROM commercial_assignments a
   JOIN records b ON b.id=a.binding_id AND b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.kind='binding'
   LEFT JOIN operation_authorizations auth ON auth.id=a.authorization_id AND auth.workspace_id=a.workspace_id AND auth.environment=a.environment
   WHERE a.workspace_id=$1 AND a.environment=$2 AND ($3::uuid[] IS NULL OR a.account_id=ANY($3))
  ),
	  legacy_candidates AS MATERIALIZED(
	   SELECT b.id,b.workspace_id,b.environment,b.body,b.created_at,b.updated_at,
	    CASE WHEN pg_input_is_valid(b.body->>'account_id','uuid') THEN (b.body->>'account_id')::uuid END AS account_id,
	    CASE WHEN pg_input_is_valid(o.body->>'product_id','uuid') THEN (o.body->>'product_id')::uuid END AS product_id,
	    CASE WHEN pg_input_is_valid(b.body->>'valid_from','timestamp with time zone') THEN (b.body->>'valid_from')::timestamptz END AS valid_from,
	    CASE WHEN pg_input_is_valid(b.body->>'valid_to','timestamp with time zone') THEN (b.body->>'valid_to')::timestamptz END AS valid_to,
	    b.body ? 'valid_to' AS has_valid_to
	   FROM records b
	   JOIN records o ON o.id::text=b.body->>'offer_version_id' AND o.workspace_id=b.workspace_id AND o.environment=b.environment AND o.kind='offer'
	   WHERE b.workspace_id=$1 AND b.environment=$2 AND b.kind='binding'
	    AND NOT (b.body ? 'assignment_id') AND NOT (b.body ? 'ad_id') AND NOT (b.body ? 'ad_set_id') AND NOT (b.body ? 'campaign_id')
	  ), legacy AS MATERIALIZED(
	   SELECT DISTINCT ON (candidate.account_id) candidate.id,candidate.account_id::text AS account_id,candidate.product_id::text AS product_id,candidate.body,candidate.created_at,candidate.updated_at
	   FROM legacy_candidates candidate CROSS JOIN snapshot s
	   WHERE candidate.account_id IS NOT NULL AND candidate.product_id IS NOT NULL AND candidate.valid_from IS NOT NULL
	    AND ($3::uuid[] IS NULL OR candidate.account_id=ANY($3))
	    AND candidate.valid_from<=s.observed_at
	    AND (NOT candidate.has_valid_to OR candidate.valid_to IS NOT NULL AND candidate.valid_to>s.observed_at)
	    AND NOT EXISTS(SELECT 1 FROM commercial_assignments a WHERE a.workspace_id=candidate.workspace_id AND a.environment=candidate.environment AND a.account_id=candidate.account_id)
	   ORDER BY candidate.account_id,candidate.valid_from DESC,candidate.created_at DESC,candidate.id DESC
	  )
  SELECT s.observed_at,
   COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at,a.id) FROM canonical a),'[]'::jsonb) AS canonical,
   COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.account_id,b.created_at,b.id) FROM legacy b),'[]'::jsonb) AS legacy
	  FROM snapshot s`,[workspace,environment,ids,effectiveAt?.toISOString()??null])).rows[0];
 const observed_at=new Date(row.observed_at).toISOString(),canonical=(row.canonical??[]) as CommercialAssignment[],legacy=(row.legacy??[]) as LegacyCommercialBinding[],current:CommercialAssignment[]=[],byAccount=new Map<string,AccountCommercialAssignmentSnapshot>();
 const account=(accountId:string)=>{let value=byAccount.get(accountId);if(!value){value={observed_at,has_canonical:false,canonical:[],current:[]};byAccount.set(accountId,value);}return value;};
 for(const assignment of canonical){const value=account(assignment.account_id);value.has_canonical=true;value.canonical.push(assignment);if(activeAt(assignment,observed_at)){value.current.push(assignment);current.push(assignment);}}
 for(const binding of legacy){const value=account(binding.account_id);if(!value.has_canonical&&!value.legacy)value.legacy=binding;}
 return{observed_at,canonical,current,legacy,byAccount};
}
export function accountAssignmentSnapshot(snapshot:CommercialAssignmentSnapshot,accountId:string){
 return snapshot.byAccount.get(accountId)??{observed_at:snapshot.observed_at,has_canonical:false,canonical:[],current:[]};
}
export function commercialAssignmentResourceIds(assignment:{account_id:string;product_id:string;body:Body}){
 const ids=[assignment.account_id,assignment.product_id,assignment.body.account_id,assignment.body.product_id,assignment.body.offer_version_id,assignment.body.workflow_version_id,assignment.body.agent_version_id,assignment.body.ad_id,assignment.body.ad_set_id,assignment.body.campaign_id];
 for(const rule of assignment.body.entry_rules??[])if(['ad','campaign'].includes(rule.kind))ids.push(rule.value);
 return [...new Set(ids.filter((value):value is string=>typeof value==='string'&&value.length>0))];
}
export function commercialAssignmentNonCurrentReason(assignments:CommercialAssignment[],at:string){
 const active=assignments.filter(a=>a.state==='ACTIVE');
 if(active.some(a=>Date.parse(a.body.valid_from)>Date.parse(at)))return'ASSIGNMENT_NOT_STARTED';
 if(active.some(a=>a.body.valid_to&&Date.parse(a.body.valid_to)<=Date.parse(at)))return'ASSIGNMENT_EXPIRED';
 if(assignments.some(a=>a.state==='DRAFT'))return'ASSIGNMENT_DRAFT';
 if(assignments.some(a=>a.state==='RETIRED'))return'ASSIGNMENT_RETIRED';
 return'ASSIGNMENT_NOT_CURRENT';
}
export function commercialAuthorizationStatus(a:CommercialAssignment|undefined,at:string){
 if(!a?.authorization_id)return'NONE';
 if(a.authorization_revoked_at)return'REVOKED';
 if(!a.authorization_expires_at||Date.parse(a.authorization_expires_at)<=Date.parse(at))return'EXPIRED';
 const scope=a.authorization_scope??{};
 return activeAt(a,at)&&scope.mode==='product_assignment'&&scope.assignment_id===a.id&&scope.assignment_revision===a.revision&&scope.binding_id===a.binding_id&&scope.product_id===a.product_id?'REGISTERED':'INVALIDATED';
}
export async function assignmentGate(c:QueryExecutor,conversation:DomainRecord,effectiveAt?:string){
 if(!effectiveAt&&conversation.environment==='SIMULATION'&&conversation.body.simulation_id){const simulation=await getRecord(c,conversation.workspace_id,'simulation',conversation.body.simulation_id);effectiveAt=simulation?.body.virtual_now;}
 effectiveAt??=new Date().toISOString();
 if(conversation.body.routing_state==='PRODUCT_SELECTION_REQUIRED')return 'PRODUCT_SELECTION_REQUIRED';
 if(conversation.body.assignment_id){const a=await assignmentFor(c,conversation.workspace_id,conversation.environment,conversation.body.assignment_id,'share');if(!a||!activeAt(a,effectiveAt))return 'ASSIGNMENT_RETIRED_OR_EXPIRED';if(a.revision!==conversation.body.assignment_revision||a.binding_id!==conversation.body.binding_id)return 'ASSIGNMENT_CHANGED';}
 for(const[kind,key]of [['workflow','workflow_version_id'],['agent','agent_version_id']] as const){if(!conversation.body[key])continue;const row=(await c.query('SELECT body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind=$3 AND id=$4',[conversation.workspace_id,conversation.environment,kind,conversation.body[key]])).rows[0];if(row?.body.archived_at)return 'CONFIGURATION_RETIRED';}
 return null;
}
export async function physicalChat(c:QueryExecutor,account:DomainRecord,contactId:string){
 return(await c.query(`INSERT INTO physical_chats(workspace_id,environment,account_id,contact_id) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,environment,account_id,contact_id) DO UPDATE SET account_id=EXCLUDED.account_id RETURNING *`,[account.workspace_id,account.environment,account.id,contactId])).rows[0];
}
export function chatLock(workspace:string,account:string,contact:string){return `physical-chat:${workspace}:${account}:${contact}`;}
const normalized=(s:unknown)=>String(s??'').trim().toLowerCase().normalize('NFKC');
export interface RoutingEvidence {text?:string;providerAt:string;referral?:Body;replyTo?:string;media?:unknown;trustedOfferId?:string;trustedWorkflowId?:string}
/** Provider evidence is resolved against persisted scoped records. Raw IDs in message text are never accepted. */
export async function resolveCommercialRoute(c:QueryExecutor,account:DomainRecord,contactId:string,chat:Body,input:RoutingEvidence){
 const assignments=await listAssignments(c,account.workspace_id,account.environment,{account_id:account.id});
 const current=assignments.filter(a=>activeAt(a,input.providerAt));
 const products=new Map((await listRecords(c,account.workspace_id,'product',account.environment)).map(product=>[product.id,product]));
 const offers=new Map((await listRecords(c,account.workspace_id,'offer',account.environment)).map(offer=>[offer.id,offer]));
 const routeAliases=current.map(assignment=>{
  const product=products.get(assignment.product_id),offer=offers.get(assignment.body.offer_version_id);
  const configured=[
   ...(assignment.body.entry_rules??[]).filter((rule:Body)=>rule.kind==='keyword').map((rule:Body)=>rule.value),
   ...(Array.isArray(assignment.body.aliases)?assignment.body.aliases:[]),
   ...(Array.isArray(product?.body.aliases)?product!.body.aliases:[]),
   ...(Array.isArray(offer?.body.entry_aliases)?offer!.body.entry_aliases:[]),
   ...(Array.isArray(offer?.body.sales_flow?.entry_aliases)?offer!.body.sales_flow.entry_aliases:[]),
   product?.body.name,
  ].filter((value):value is string=>typeof value==='string'&&!!value.trim());
  return{product_id:assignment.product_id,aliases:[...new Set(configured)],assignment};
 });
 const routeOptions=routeAliases.map((candidate,index)=>{const productName=String(products.get(candidate.product_id)?.body.name??`Producto ${index+1}`);return{index:index+1,label:`${index+1}. ${productName}`,product_id:candidate.product_id,product_name:productName,assignment_id:candidate.assignment.id,assignment_revision:candidate.assignment.revision};});
 // Pre-V5 journeys can carry only an immutable offer reference. Resolve its
 // product inside the same tenant/environment so the next inbound preserves
 // their order and receipt wait instead of starting a replacement journey.
 const journeys=(await c.query(`SELECT j.*,o.body->>'product_id' AS legacy_product_id FROM records j LEFT JOIN records o ON o.id::text=j.body->>'offer_version_id' AND o.kind='offer' AND o.workspace_id=j.workspace_id AND o.environment=j.environment WHERE j.workspace_id=$1 AND j.environment=$2 AND j.kind='conversation' AND j.body->>'account_id'=$3 AND j.body->>'contact_id'=$4 AND COALESCE(j.body->>'product_id',o.body->>'product_id') IS NOT NULL ORDER BY j.created_at`,[account.workspace_id,account.environment,account.id,contactId])).rows.map(row=>({...row,body:{...row.body,product_id:row.body.product_id??row.legacy_product_id}})) as DomainRecord[];
 const sources:Array<{source:string;product_id:string;assignment?:CommercialAssignment;journey?:DomainRecord;binding?:DomainRecord;match?:Body}>=[];
 if(input.replyTo){const messages=(await c.query(`SELECT body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='message' AND body->>'account_id'=$3 AND body->>'contact_id'=$4 AND body->>'provider_message_id'=$5`,[account.workspace_id,account.environment,account.id,contactId,input.replyTo])).rows;for(const message of messages){const journey=journeys.find(j=>j.id===message.body.conversation_id);if(journey)sources.push({source:'KNOWN_MESSAGE_REPLY',product_id:journey.body.product_id,journey,assignment:current.find(a=>a.id===journey.body.assignment_id)});}}
 let ad:DomainRecord|undefined,adSet:DomainRecord|undefined;
 if(input.referral?.source_id){ad=(await listRecords(c,account.workspace_id,'ad',account.environment)).find(a=>a.body.external_id===String(input.referral!.source_id));adSet=ad?.body.ad_set_id?await getRecord(c,account.workspace_id,'ad_set',ad.body.ad_set_id):undefined;}
 const aliasResolution=matchAssignedProductAliases(input.text??'',routeAliases.map(({product_id,aliases})=>({product_id,aliases})));
 const activeSelection=chat.active_journey_id?await getRecord(c,account.workspace_id,'conversation',chat.active_journey_id):undefined;
 const awaitingWrittenSelection=activeSelection?.environment===account.environment&&activeSelection.body.account_id===account.id&&activeSelection.body.contact_id===contactId&&activeSelection.body.routing_state==='PRODUCT_SELECTION_REQUIRED';
 const writtenOption=!input.media&&awaitingWrittenSelection?normalized(input.text).match(/^(?:(?:opcion|opción|producto)\s+)?([1-9][0-9]*)$/i):null;
 for(const a of current){
  if(ad&&(a.body.ad_id===ad.id||!a.body.ad_id&&adSet&&(a.body.ad_set_id===adSet.id||!a.body.ad_set_id&&a.body.campaign_id===adSet.body.campaign_id)))sources.push({source:'REGISTERED_REFERRAL',product_id:a.product_id,assignment:a});
  for(const rule of a.body.entry_rules??[]){const match=rule.kind==='link'?normalized(input.text)===normalized(rule.value):rule.kind==='ad'?ad?.id===rule.value:rule.kind==='campaign'?adSet?.body.campaign_id===rule.value:false;if(match)sources.push({source:rule.kind==='link'?'EXPLICIT_CUSTOMER_CHOICE':'REGISTERED_REFERRAL',product_id:a.product_id,assignment:a});}
 }
 if(aliasResolution.status!=='NO_MATCH')for(const evidence of aliasResolution.evidence){const candidate=routeAliases.find(item=>item.product_id===evidence.product_id);if(candidate)sources.push({source:'EXPLICIT_CUSTOMER_CHOICE',product_id:candidate.product_id,assignment:candidate.assignment,match:{kind:'alias',aliases:evidence.aliases,normalized_text:aliasResolution.normalized_text}});}
 if(writtenOption){const option=(Array.isArray(activeSelection?.body.routing_options)?activeSelection.body.routing_options:[]).find((item:Body)=>item.index===Number(writtenOption[1])),candidate=option&&routeAliases.find(item=>item.assignment.id===option.assignment_id&&item.assignment.revision===option.assignment_revision);if(candidate)sources.push({source:'EXPLICIT_CUSTOMER_CHOICE',product_id:candidate.product_id,assignment:candidate.assignment,match:{kind:'written_option',index:option.index,label:option.label,presented_assignment_revision:option.assignment_revision}});}
 // Historical bindings remain readable for old installations and tests. Latest means version within one product, never product selection.
 const bindings=(await listRecords(c,account.workspace_id,'binding',account.environment)).filter(b=>b.body.account_id===account.id&&Date.parse(b.body.valid_from)<=Date.parse(input.providerAt)&&(!b.body.valid_to||Date.parse(b.body.valid_to)>Date.parse(input.providerAt))&&!b.body.assignment_id).sort((a,b)=>Date.parse(b.body.valid_from)-Date.parse(a.body.valid_from));
 const matchesReferral=(b:DomainRecord)=>!input.referral&&!b.body.ad_id&&!b.body.ad_set_id||!b.body.ad_id&&!b.body.ad_set_id&&!b.body.campaign_id||!!ad&&(b.body.ad_id===ad.id||!b.body.ad_id&&!!adSet&&(b.body.ad_set_id===adSet.id||!b.body.ad_set_id&&b.body.campaign_id===adSet.body.campaign_id));const specificity=(b:DomainRecord)=>b.body.ad_id?3:b.body.ad_set_id?2:b.body.campaign_id?1:0;
 const legacy=new Map<string,{binding:DomainRecord;offer:DomainRecord}>();for(const binding of bindings.filter(matchesReferral).sort((a,b)=>specificity(b)-specificity(a))){const offer=await getRecord(c,account.workspace_id,'offer',binding.body.offer_version_id);if(!offer?.body.product_id||assignments.some(a=>a.product_id===offer.body.product_id)||legacy.has(offer.body.product_id))continue;legacy.set(offer.body.product_id,{binding,offer});}
 for(const [productId,{binding}]of legacy){if(ad&&(binding.body.ad_id===ad.id||!binding.body.ad_id&&adSet&&(binding.body.ad_set_id===adSet.id||!binding.body.ad_set_id&&binding.body.campaign_id===adSet.body.campaign_id)))sources.push({source:'REGISTERED_REFERRAL',product_id:productId,binding});}
 if(input.trustedOfferId){const offer=await getRecord(c,account.workspace_id,'offer',input.trustedOfferId);if(offer?.environment===account.environment&&offer.body.product_id)sources.push({source:'TRUSTED_SIMULATION',product_id:offer.body.product_id,assignment:current.find(a=>a.body.offer_version_id===offer.id)});}
 const distinct=new Set(sources.map(s=>s.product_id));
 if(distinct.size>1)return{state:'PRODUCT_SELECTION_REQUIRED',reason:aliasResolution.status==='AMBIGUOUS'?'AMBIGUOUS_EXPLICIT_CHOICE':'CONFLICTING_EVIDENCE',sources,choices:current,options:routeOptions};
 if(sources.length){const selected=sources[0]!;const journey=selected.journey??journeys.find(j=>j.body.product_id===selected.product_id&&(!selected.assignment||j.body.assignment_id===selected.assignment.id&&j.body.assignment_revision===selected.assignment.revision));return{state:'RESOLVED',...selected,journey,ad,adSet,choices:current,options:routeOptions};}
 // Generic replies/payment evidence cannot be assigned by latest selection when two journeys exist.
 if(journeys.filter(j=>j.body.status==='OPEN'||!j.body.status).length>1&&(input.media||/^(si|sí|ya pagu[eé]|pagado|listo|acepto|\$?\d+(?:[.,]\d+)?)$/i.test(input.text?.trim()??'')))return{state:'PRODUCT_SELECTION_REQUIRED',reason:'ORDER_CONTEXT_REQUIRED',sources,choices:current,options:routeOptions};
 if(chat.selected_assignment_id){const selected=current.find(a=>a.id===chat.selected_assignment_id);if(selected&&Date.parse(chat.selection_at)<=Date.parse(input.providerAt))return{state:'RESOLVED',source:'EXPLICIT_OPERATOR_CHOICE',product_id:selected.product_id,assignment:selected,journey:journeys.find(j=>j.body.assignment_id===selected.id&&j.body.assignment_revision===selected.revision),choices:current,options:routeOptions};}
 const options=[...current.map(a=>({product_id:a.product_id,assignment:a,binding:undefined as DomainRecord|undefined})),...[...legacy].map(([product_id,{binding}])=>({product_id,assignment:undefined,binding}))];
 if(options.length===1){const selected=options[0]!;return{state:'RESOLVED',source:'SINGLE_UNAMBIGUOUS_ROUTE',...selected,journey:journeys.find(j=>j.body.product_id===selected.product_id&&(!selected.assignment||j.body.assignment_revision===selected.assignment.revision)),choices:current,options:routeOptions};}
 if(!assignments.length&&!options.length){const offerId=input.trustedOfferId??account.body.offer_version_id;const offer=offerId?await getRecord(c,account.workspace_id,'offer',offerId):undefined;if(offer?.body.product_id)return{state:'RESOLVED',source:'LEGACY_SINGLE_ASSIGNMENT',product_id:offer.body.product_id,journey:journeys.find(j=>j.body.product_id===offer.body.product_id),choices:current,options:routeOptions};}
 return{state:'PRODUCT_SELECTION_REQUIRED',reason:options.length?'AMBIGUOUS_PRODUCT':'NO_PRODUCT_ROUTE',sources,choices:current,options:routeOptions};
}
