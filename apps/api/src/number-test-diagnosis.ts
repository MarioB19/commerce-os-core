import type {ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import {readVariant} from '../../../packages/db/src/variant-workspace.js';
import {effectiveReceiptPolicy} from '../../../packages/db/src/receipt-policies.js';
import {laboratoryAiConfiguration,type VariantAiSelection} from '../../../packages/ai-providers/src/variant-ai.js';

/** V7 RF-19.i: what keeps a number from being tested (or from being tested
 * completely), with the screen that fixes each thing. Read only; the same
 * checks the start applies, explained before the person spends anything.
 * BLOCKING stops the test; WARNING lets it run but tells what will not be
 * covered (a partial test is never presented as complete). */
export interface LabProblem {code:string;severity:'BLOCKING'|'WARNING';label:string;fix:{label:string;href:string}|null;variant_id:string|null;variant_name:string|null}
const variantPath=(productId:string,variantId:string,section:string)=>`/products/${productId}/variants/${variantId}/${section}`;
const sectionFor:Record<string,string>={sale_messages:'sale',seller:'sale',offer_price:'offer',materials:'offer',collection:'collection',publish:'sale'};
const sectionLabels:Record<string,string>={sale:'Abrir Venta',offer:'Abrir Oferta',collection:'Abrir Cobro'};
export const AI_FIX={label:'Configurar la IA del perfil',href:'/account/integrations'};
export const RULES_FIX={label:'Abrir reglas de comprobantes',href:'/sales/payments/rules'};

export async function diagnoseNumberTest(db:ProfileExecutor,accountId:string,options:{installed:boolean}){
 const problems:LabProblem[]=[];
 const add=(p:Omit<LabProblem,'variant_id'|'variant_name'>&{variant_id?:string|null;variant_name?:string|null})=>problems.push({variant_id:null,variant_name:null,...p});
 if(!options.installed)add({code:'LAB_NOT_INSTALLED',severity:'BLOCKING',label:'El laboratorio de pruebas no está instalado en este servidor.',fix:null});
 const account=(await db.query("SELECT id FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='channel_account' AND id=$2 AND NOT (body ? 'deleted_at')",[db.workspaceId,accountId])).rows[0];
 if(!account)return null;
 const assignments=(await db.query(`SELECT a.variant_id::text,a.state,b.body->>'valid_from' AS valid_from,b.body->>'valid_to' AS valid_to FROM commercial_assignments a
  JOIN records b ON b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.id=a.binding_id AND b.kind='binding'
  WHERE a.workspace_id=$1 AND a.environment='REAL' AND a.account_id=$2 ORDER BY a.id LIMIT 21`,[db.workspaceId,accountId])).rows;
 const now=Date.now(),active=assignments.filter(a=>a.state==='ACTIVE'&&(!a.valid_from||Date.parse(a.valid_from)<=now)&&(!a.valid_to||Date.parse(a.valid_to)>now));
 if(!assignments.length)add({code:'LAB_ASSIGNMENT_COVERAGE',severity:'BLOCKING',label:'Este número no vende ninguna variante.',fix:{label:'Asignar una variante desde Productos',href:'/products'}});
 else if(!active.length)add({code:'LAB_ASSIGNMENT_NOT_CURRENT',severity:'BLOCKING',label:'La venta de este número no está vigente.',fix:{label:'Revisar los números de la variante',href:'/products'}});
 const selections:Record<string,VariantAiSelection>={};
 for(const a of active){if(!a.variant_id)continue;
  const v=await readVariant(db,'REAL',a.variant_id).catch(()=>null);
  if(!v){add({code:'LAB_SOURCE_NOT_PUBLISHED',severity:'BLOCKING',label:'Una variante asignada ya no existe.',fix:{label:'Revisar Productos',href:'/products'},variant_id:a.variant_id});continue;}
  const name=`${v.product.name} · ${v.document.name}`;selections[v.id]=(v.document as {ai?:VariantAiSelection}).ai??{primary:null,fallback:null};
  for(const m of v.missing){const section=sectionFor[m.code]??'sale';
   add({code:m.code==='publish'?'LAB_SOURCE_NOT_PUBLISHED':'LAB_CONFIGURATION_INCOMPLETE',severity:'BLOCKING',label:m.label,fix:{label:m.code==='publish'?'Publicar la variante':sectionLabels[section]!,href:variantPath(v.product.id,v.id,section)},variant_id:v.id,variant_name:name});}
  if(v.published&&v.unpublished_changes)add({code:'LAB_UNPUBLISHED_CHANGES',severity:'WARNING',label:'La variante tiene cambios sin publicar; la prueba usa lo publicado.',fix:{label:'Publicar los cambios',href:variantPath(v.product.id,v.id,'sale')},variant_id:v.id,variant_name:name});
  const assets=(v.document.offer.fulfillment as {asset_id:string}[]).map(f=>f.asset_id);
  if(assets.length){const ready=(await db.query("SELECT id::text FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='asset' AND id=ANY($2::uuid[]) AND body->>'status'='READY'",[db.workspaceId,assets])).rows.map(r=>r.id);
   if(ready.length<new Set(assets).size)add({code:'LAB_ASSET_NOT_READY',severity:'BLOCKING',label:'Un material de la entrega no está listo.',fix:{label:'Abrir Oferta',href:variantPath(v.product.id,v.id,'offer')},variant_id:v.id,variant_name:name});}
  await db.query('SAVEPOINT lab_diagnosis_rules');
  try{await effectiveReceiptPolicy(db,'REAL',v.id);await db.query('RELEASE SAVEPOINT lab_diagnosis_rules');}
  catch{await db.query('ROLLBACK TO SAVEPOINT lab_diagnosis_rules');add({code:'RECEIPT_POLICY_REQUIRED',severity:'WARNING',label:'Sin reglas de comprobantes: los comprobantes de prueba pasarán a revisión de una persona.',fix:RULES_FIX,variant_id:v.id,variant_name:name});}
 }
 const prefs=(await db.query("SELECT version FROM ai_profile_preferences WHERE workspace_id=$1 AND environment='REAL'",[db.workspaceId])).rows[0];
 if(!prefs)add({code:'LAB_AI_DEPENDENCY_REQUIRED',severity:'BLOCKING',label:'Configura la IA del perfil (clave verificada y modelo predeterminado) para probar el número.',fix:AI_FIX});
 else if(Object.keys(selections).length){const ai=await laboratoryAiConfiguration(db,selections);
  if(!ai.config)add({code:'LAB_AI_DEPENDENCY_REQUIRED',severity:'BLOCKING',label:'La IA del perfil no tiene una clave verificada para el modelo elegido.',fix:AI_FIX});}
 return{account_id:accountId,ready:!problems.some(p=>p.severity==='BLOCKING'),problems};
}
/** RF-19.i during a test: the screen that fixes a failed step or a receipt left to a person. */
const duringFixes:Record<string,{label:string;href:string}>={LAB_SELLER_GRANT_REQUIRED:AI_FIX,LAB_AI_DEPENDENCY_REQUIRED:AI_FIX,RECEIPT_AI_GRANT_REQUIRED:AI_FIX,
 AI_AUTHORITY:AI_FIX,AI_KEY_INVALID:AI_FIX,AI_BUDGET_EXHAUSTED:{label:'Revisar el presupuesto de IA',href:'/account/integrations'},RECEIPT_POLICY_REQUIRED:RULES_FIX};
export function duringFix(code:string|null|undefined){return code?duringFixes[code]??null:null;}
