import type {DomainRecord} from '@commerce/contracts';
import {encrypt,withTransaction,type QueryExecutor} from '@commerce/db';
import type {NumberLabEnginePorts} from '../../../packages/db/src/number-lab-engine-runtime.js';
import {sealLabValue,openLabValue} from '../../../packages/db/src/number-laboratory.js';
import {readNumberLabMaterial,type NumberLabMaterialReader} from '../../../packages/db/src/number-lab-material-custody.js';
import {z} from 'zod';
import {numberLabVirtualMaterial,numberLabVirtualMaterialHash,numberLabVirtualMaterialPath,labVirtualMaterialSchema} from '../../../packages/domain/src/laboratory/virtual-material.js';
import {labCanonical} from '../../../packages/domain/src/laboratory/number-lab.js';
import type {Body} from '@commerce/contracts';
import type {OutboundMessage} from '@commerce/messaging';
import {SimulatorProvider,type SendResult} from '@commerce/messaging';

/** Closed laboratory adapter. Delivery is synthetic and uses the normal ACK consumers. */
function simulator(account:DomainRecord,transaction:<T>(work:(db:QueryExecutor)=>Promise<T>)=>Promise<T>,seal:(event:object,effectId:string)=>string,grantOnly=false):SimulatorProvider {
 if(account.environment!=='SIMULATION'||account.body.provider!=='simulator')throw new Error('SIMULATION_SCOPE_INVALID');
 const provider=new SimulatorProvider(account.body.simulated_fault==='UNKNOWN'?'AMBIGUOUS':account.body.simulated_fault==='FAILED'?'FAILED':'WORKING');
 const send=provider.send.bind(provider);
 provider.send=message=>transaction(async client=>{
  // Recheck persisted ownership of the graph, not just the factory's account snapshot.
  const scope=(await client.query(`SELECT s.id simulation_id,s.body->>'virtual_now' virtual_now
   FROM outbox e
   JOIN records a ON a.id::text=e.account_id AND a.workspace_id=e.workspace_id AND a.environment=e.environment AND a.kind='channel_account'
   JOIN records c ON c.id::text=e.conversation_id AND c.workspace_id=e.workspace_id AND c.environment=e.environment AND c.kind='conversation'
    AND c.body->>'account_id'=e.account_id AND c.body->>'contact_id'=e.contact_id
   JOIN records contact ON contact.id::text=e.contact_id AND contact.workspace_id=e.workspace_id AND contact.environment=e.environment AND contact.kind='contact'
    AND contact.body->>'identity'=$4
   JOIN records s ON s.id::text=c.body->>'simulation_id' AND s.workspace_id=e.workspace_id AND s.environment=e.environment AND s.kind='simulation'
    AND s.body->>'account_id'=e.account_id AND s.body->>'status' IN('RUNNING','COMPLETED')
   WHERE e.id::text=$1 AND e.account_id=$2 AND e.workspace_id=$3 AND e.environment='SIMULATION'
    AND e.status='SENDING' AND COALESCE(e.payload->>'kind','text')${grantOnly?"='grant'":"<>'grant'"}
    AND a.body->>'provider'='simulator' AND NOT (a.body ? 'deleted_at')
    AND (a.body->'lab_snapshot'='true'::jsonb OR (a.body->>'flow_test_transport'='ISOLATED_SIMULATOR' AND s.body->>'mode'='NUMBER_FLOW_TEST_V1'))
   FOR UPDATE OF e`,[message.effectId,account.id,account.workspace_id,message.recipient])).rows[0];
  const observedAt=Date.parse(String(scope?.virtual_now));
  if(!scope||!Number.isFinite(observedAt))return{status:'REJECTED',reason:'SIMULATION_SCOPE_INVALID'} satisfies SendResult;
  const result=await send(message);
  if(result.status!=='ACCEPTED'||!result.providerMessageId)return result;
  const providerId=result.providerMessageId,eventId=providerId+':catalog-delivered';
  // No effect_id_hint: observations must wait until dispatch persists this provider ID.
  // In particular, an early ACK must not advance SENDING or reconcile UNKNOWN.
  const event={id:eventId,type:'ack',status:'DELIVERED',provider_message_id:providerId,provider_at:new Date(observedAt).toISOString()};
  await client.query(`INSERT INTO inbound_envelopes(workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext,metadata,occurred_at)
   VALUES($1,'SIMULATION',$2,'simulator',$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
  [account.workspace_id,account.id,eventId,seal(event,message.effectId),{source:'catalog_simulator',simulation_id:scope.simulation_id,effect_id:message.effectId,external_network:false,external_effects:false},event.provider_at]);
  return result;
 });
 return provider;
}

export function catalogSimulator(account:DomainRecord):SimulatorProvider{return simulator(account,work=>withTransaction(work),event=>encrypt(event));}
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema=z.object({runId:uuid,operationId:uuid,snapshotSha256:sha,accountId:uuid,conversationId:uuid,variantId:uuid}).strict();
const materialSchema=z.object({id:uuid,source:z.object({id:uuid,revision:z.number().int().positive(),sha256:sha}).strict(),kind:z.enum(['file','link','access']),sha256:sha.nullable(),size_bytes:z.number().int().min(0).max(20971520).nullable(),broker_required:z.literal(true)}).strict();
export interface NumberLabDispatch {readonly kind:'NUMBER_LAB_DISPATCH'}
type DispatchOptions={binding:z.infer<typeof bindingSchema>;materials:readonly z.infer<typeof materialSchema>[];key:Uint8Array;reader?:NumberLabMaterialReader};
const handles=new WeakMap<object,{options:DispatchOptions;used:boolean}>();
function need(v:unknown,c:string):asserts v{if(!v)throw Error(c);}
/** Protected host factory. It has no provider, URL, SQL or public key selector. */
export function createNumberLabDispatch(input:DispatchOptions):NumberLabDispatch{
 const binding=Object.freeze(bindingSchema.parse(input.binding)),materials=z.array(materialSchema).max(6000).parse(input.materials);
 need(input.key.length===32&&new Set(materials.map(m=>m.id)).size===materials.length,'LAB_DISPATCH_CONFIGURATION');
 const h=Object.freeze({kind:'NUMBER_LAB_DISPATCH' as const});handles.set(h,{options:{...input,binding,materials:structuredClone(materials),key:new Uint8Array(input.key)},used:false});return h;
}
export function bindNumberLabDispatch(handle:NumberLabDispatch,ports:NumberLabEnginePorts){
 const state=handle&&handles.get(handle);need(state&&!state.used,'LAB_DISPATCH_REQUIRED');const o=state.options,b=o.binding,w='number-lab:'+b.runId;
 need(ports.workspaceId===w&&ports.binding.runId===b.runId&&ports.binding.operationId===b.operationId&&ports.binding.snapshotSha256===b.snapshotSha256,'LAB_DISPATCH_BINDING');state.used=true;
 const effect=(e:Body)=>need(e.workspace_id===w&&e.environment==='SIMULATION'&&e.account_id===b.accountId&&e.conversation_id===b.conversationId&&e.kind!=='warmup','LAB_DISPATCH_SCOPE');
 const cipher=(effectId:string)=>({workspaceId:w,runId:b.runId,purpose:'result' as const,operationId:uuid.parse(effectId)});
 const descriptor=(m:z.infer<typeof materialSchema>)=>{need(m.kind==='link'||m.kind==='access','LAB_DELIVERY_CHANGED');return numberLabVirtualMaterial({run_id:b.runId,snapshot_sha256:b.snapshotSha256,variant_id:b.variantId,id:m.id,kind:m.kind,source:m.source});};
 const assetFor=async(id:string,db?:QueryExecutor)=>{const m=o.materials.find(m=>m.id===id);need(m,'LAB_DELIVERY_CUSTODY_REQUIRED');
  const read=async(db:QueryExecutor)=>(await db.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='asset' AND id=$2",[w,m.id])).rows[0] as DomainRecord|undefined;const asset=await(db?read(db):ports.transaction(read));
  need(asset&&asset.body.lab_snapshot===true&&asset.body.lab_source?.id===m.source.id&&asset.body.lab_source?.revision===m.source.revision&&asset.body.lab_source?.sha256===m.source.sha256&&asset.body.kind===m.kind&&asset.body.status==='READY','LAB_DELIVERY_CHANGED');
  if(m.kind!=='file')need(labCanonical(labVirtualMaterialSchema.parse(asset.body.lab_delivery))===labCanonical(descriptor(m)),'LAB_DELIVERY_CHANGED');return{m,asset};
 };
 const accessSchema=z.strictObject({kind:z.literal('LAB_ACCESS_GRANT'),material:labVirtualMaterialSchema,effect_id:uuid,grant_id:uuid,account_id:uuid,conversation_id:uuid,contact_id:uuid,material_sha256:sha});
 const accountFor=(account:DomainRecord)=>need(account.workspace_id===w&&account.environment==='SIMULATION'&&account.id===b.accountId&&account.body.provider==='simulator'&&account.body.lab_run_id===b.runId,'LAB_DISPATCH_SCOPE');

 async function prepareMessage(e:Body,contact:DomainRecord,db?:QueryExecutor):Promise<OutboundMessage>{effect(e);need(contact.workspace_id===w&&contact.environment==='SIMULATION'&&contact.id===e.contact_id,'LAB_DISPATCH_SCOPE');
   need(e.payload.kind!=='grant','LAB_DELIVERY_ADAPTER_REQUIRED');
   const message:OutboundMessage={effectId:e.id,recipient:contact.body.identity,kind:e.payload.kind??'text',text:e.payload.text,template:e.payload.template};
   if(e.payload.grant_effect_id){
    const id=uuid.parse(e.payload.grant_effect_id),read=async(db:QueryExecutor)=>(await db.query("SELECT * FROM outbox WHERE workspace_id=$1 AND environment='SIMULATION' AND id=$2",[w,id])).rows[0],grant=await(db?read(db):ports.transaction(read));
    need(grant&&grant.account_id===b.accountId&&grant.conversation_id===b.conversationId&&grant.contact_id===contact.id&&grant.payload.kind==='grant'&&['SENT','DELIVERED','READ'].includes(grant.status)&&grant.provider_message_id==='sim:'+id&&grant.result?.access_ciphertext&&e.predecessor_id===id,'LAB_GRANT_NOT_CONFIRMED');
    const value=accessSchema.parse(openLabValue(cipher(id),JSON.parse(grant.result.access_ciphertext),o.key)),{m}=await assetFor(grant.payload.asset_id,db),expected=descriptor(m);
    need(value.effect_id===id&&value.grant_id===e.payload.fulfillment_id&&value.grant_id===grant.payload.grant_id&&value.account_id===b.accountId&&value.conversation_id===b.conversationId&&value.contact_id===contact.id&&labCanonical(value.material)===labCanonical(expected)&&value.material_sha256===numberLabVirtualMaterialHash(expected),'LAB_GRANT_CHANGED');
    message.kind='text';message.text='Acceso de prueba disponible: '+numberLabVirtualMaterialPath(expected);
   }else if(e.payload.asset_id){const {m,asset}=await assetFor(e.payload.asset_id,db);
    if(m.kind==='file'){need(o.reader&&m.sha256!==null&&m.size_bytes!==null,'LAB_DELIVERY_CUSTODY_REQUIRED');
     need(asset.body.sha256===m.sha256&&asset.body.size_bytes===m.size_bytes&&asset.body.storage_key===m.id+'-'+m.sha256,'LAB_DELIVERY_CHANGED');
     message.media={bytes:await readNumberLabMaterial(o.reader,{id:m.id,sha256:m.sha256,size_bytes:m.size_bytes}),mimeType:asset.body.mime_type,filename:asset.body.name};
    }else{need(m.kind==='link','LAB_ACCESS_GRANT_REQUIRED');message.kind='text';message.text='Enlace de prueba disponible: '+numberLabVirtualMaterialPath(descriptor(m));}
   }return message;
  }

 return Object.freeze({scope:Object.freeze({workspaceId:w,...b}),
  factory(account:DomainRecord){accountFor(account);
   return simulator(account,fn=>ports.transaction(fn),(event,effectId)=>JSON.stringify(sealLabValue(cipher(effectId),{kind:'LAB_PROVIDER_ACK',event},o.key)));},
  prepare:prepareMessage,
  async projection(e:Body,db:QueryExecutor){
   effect(e);if(!['SENT','DELIVERED','READ'].includes(e.status)||!(e.payload.grant_effect_id||o.materials.some(m=>m.id===e.payload.asset_id&&m.kind==='link')))return {};
   need(e.provider_message_id==='sim:'+e.id,'LAB_DELIVERY_CHANGED');const contact=(await db.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='contact' AND id=$2",[w,e.contact_id])).rows[0];need(contact,'LAB_DISPATCH_SCOPE');
   // Uses the projection transaction and no file/provider I/O. A grant remains
   // authenticated by its exact cipher/AAD and causal relationship.
   const message=await prepareMessage(e,contact,db);return{kind:'text',text:message.text};
  },
  async prepareGrant(e:Body,contact:DomainRecord,account:DomainRecord){
   effect(e);accountFor(account);need(contact.workspace_id===w&&contact.environment==='SIMULATION'&&contact.id===e.contact_id&&e.payload.kind==='grant','LAB_DISPATCH_SCOPE');
   const{m,asset}=await assetFor(uuid.parse(e.payload.asset_id));need(m.kind==='access'&&['link','webhook'].includes(asset.body.adapter),'LAB_ACCESS_ADAPTER_REQUIRED');const material=descriptor(m),grantId=uuid.parse(e.payload.grant_id);
   const provider=simulator(account,fn=>ports.transaction(fn),(event,effectId)=>JSON.stringify(sealLabValue(cipher(effectId),{kind:'LAB_PROVIDER_ACK',event},o.key)),true);
   return async()=>{const result=await provider.send({effectId:e.id,recipient:contact.body.identity,kind:'text',text:'Acceso de laboratorio'});return result.status==='ACCEPTED'?{...result,accessCiphertext:JSON.stringify(sealLabValue(cipher(e.id),accessSchema.parse({kind:'LAB_ACCESS_GRANT',material,effect_id:e.id,grant_id:grantId,account_id:b.accountId,conversation_id:b.conversationId,contact_id:contact.id,material_sha256:numberLabVirtualMaterialHash(material)}),o.key))}:result;};
  },
  openEnvelope(e:Body):string{need(e.workspace_id===w&&e.environment==='SIMULATION'&&e.account_id===b.accountId&&e.provider==='simulator'&&e.metadata?.source==='catalog_simulator'&&e.metadata.simulation_id===b.runId,'LAB_ACK_SCOPE');
   const v=openLabValue(cipher(e.metadata.effect_id),JSON.parse(e.payload_ciphertext),o.key) as {kind?:unknown;event?:any};
   need(v?.kind==='LAB_PROVIDER_ACK'&&v.event?.type==='ack'&&v.event.status==='DELIVERED'&&v.event.id===e.provider_event_id&&v.event.provider_message_id==='sim:'+e.metadata.effect_id,'LAB_ACK_CIPHERTEXT');return JSON.stringify(v.event);
  },
 });
}
