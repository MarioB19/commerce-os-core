import {z} from 'zod';
import type {Body} from '../../../contracts/src/index.js';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
/** Only these schema-owned fields identify commercial records. Text, knowledge
 * source IDs and node IDs remain literal data. Account identity is bound by the
 * captured snapshot, never followed into REAL operational/channel state. */
export const labReferenceKinds:Readonly<Record<string,string>>=Object.freeze({
 category_id:'category',product_id:'product',asset_id:'asset',audio_asset_id:'asset',
 pack_image_asset_id:'asset',core_asset_id:'asset',offer_version_id:'offer',
 workflow_version_id:'workflow',workflow_template_version_id:'workflow',
 agent_version_id:'agent',payment_profile_version_id:'bank_profile',
 receipt_policy_version_id:'receipt_policy',campaign_id:'acquisition_campaign',
 ad_set_id:'ad_set',ad_id:'ad',
});
export interface LabConfigurationReference {kind:string;id:string}
export function labConfigurationReferences(body:Body):LabConfigurationReference[]{
 const found=new Map<string,LabConfigurationReference>();let nodes=0;
 const add=(kind:string,value:unknown)=>{const id=uuid.parse(value);found.set(kind+':'+id,{kind,id});};
 const visit=(value:unknown,key:string,depth:number):void=>{
  if(++nodes>20000||depth>32)throw Error('LAB_REFERENCE_GRAPH_LIMIT');
  if(value===null||value===undefined)return;
  if(labReferenceKinds[key]){add(labReferenceKinds[key],value);return;}
  if(key==='asset_ids'){
   if(!Array.isArray(value)||value.length>100)throw Error('LAB_REFERENCE_ARRAY_INVALID');
   for(const id of value)add('asset',id);return;
  }
  if(Array.isArray(value)){for(const item of value)visit(item,'',depth+1);return;}
  if(typeof value==='object')for(const[k,item]of Object.entries(value))visit(item,k,depth+1);
 };
 visit(body,'',0);return [...found.values()].sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id));
}
