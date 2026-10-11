import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {preschoolWorkflow} from '../packages/domain/src/sales/preschool.js';
// Run with node --env-file=/private/login.env --import tsx scripts/import-preschool.ts SOURCE [--apply].
// SOURCE is the Vibe Marketing project root. Never prints secrets or API bodies.
const source=resolve(process.argv[2]??'../Vibe Marketing'),apply=process.argv.includes('--apply');
const productRoot=join(source,'04 — Campañas/Mi Ciclo Listo (WA)');
const privateEnv=async(name:string)=>parseEnv(await readFile(join(source,'.secrets',name),'utf8'));
const portal=await privateEnv('mi-ciclo-listo-production.env'),bank=await privateEnv('pagos-wa.env');
for(const key of ['MCL_PRODUCTION_URL','MCL_CORE_CODE','MCL_KIT_CODE'])if(!portal[key])throw new Error('PRODUCT_ACCESS_CONFIGURATION_REQUIRED');
for(const key of ['CLABE_ARCUS','TARJETA_SPIN','TITULAR'])if(!bank[key])throw new Error('PRODUCT_BANK_CONFIGURATION_REQUIRED');
const assets=[
 {key:'pitch',name:'Preescolar · audio de presentación',file:'assets/audio-whatsapp/01-pitch-mi-ciclo-listo.mp3',mime:'audio/mpeg'},
 {key:'agreement',name:'Preescolar · audio del acuerdo',file:'assets/audio-whatsapp/02-acuerdo-mi-ciclo-listo.mp3',mime:'audio/mpeg'},
 {key:'collection',name:'Preescolar · audio de cobro',file:'assets/audio-whatsapp/03-cobro-mi-ciclo-listo.mp3',mime:'audio/mpeg'},
 {key:'calendar',name:'Preescolar · Calendario del Ciclo',file:'entregables/02-postpago/calendario-del-ciclo.pdf',mime:'application/pdf'},
];
const inventory=[];for(const asset of assets){const bytes=await readFile(join(productRoot,asset.file));if(!bytes.length||bytes.length>20*1024*1024)throw new Error('PRODUCT_ASSET_SIZE_INVALID');inventory.push({key:asset.key,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
if(!apply){console.log(JSON.stringify({mode:'inventory',product:'Preescolar Listo',currency:'MXN',base_amount_minor:9700,kit_total_minor:10700,files:inventory,access_profiles:2,bank_configured:true,real_messages:0}));process.exit(0);}
const origin=new URL(process.env.BETTER_AUTH_URL??'https://commerce-os.inovaris.online').origin;
if(!origin.startsWith('https://')&&!origin.startsWith('http://localhost:'))throw new Error('HTTPS_API_REQUIRED');
const login=await fetch(origin+'/api/auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({email:process.env.BOOTSTRAP_EMAIL,password:process.env.BOOTSTRAP_PASSWORD})});
if(!login.ok)throw new Error('OWNER_LOGIN_FAILED');const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');if(!cookie)throw new Error('OWNER_SESSION_REQUIRED');
async function api(path:string,body?:unknown,method='POST',key=path){const response=await fetch(origin+'/v1'+path,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie,'Idempotency-Key':'preschool-platform-v1:'+key},...(body===undefined?{}:{body:JSON.stringify({...body as object,environment:'REAL'})})});if(!response.ok)throw new Error(`CATALOG_REQUEST_FAILED_${response.status}_${path.split('/')[1]}`);return(await response.json() as any).data;}
try{
 const ids:Record<string,string>={};
 for(const asset of assets){const bytes=await readFile(join(productRoot,asset.file));const row=await api('/assets',{name:asset.name,kind:'file',adapter:'private_file',mime_type:asset.mime,size_bytes:bytes.length},'POST','asset:'+asset.key);ids[asset.key]=row.id;await api(`/assets/${row.id}/content`,{base64:bytes.toString('base64')},'PUT','upload:'+asset.key);await api(`/assets/${row.id}/complete`,{},'POST','complete:'+asset.key);}
 for(const tier of ['core','kit']){const row=await api('/assets',{name:tier==='core'?'Preescolar · portal Core':'Preescolar · acceso Kit del Grupo',kind:'access',adapter:'link',delivery_reference:JSON.stringify({url:portal.MCL_PRODUCTION_URL,code:portal[tier==='core'?'MCL_CORE_CODE':'MCL_KIT_CODE'],instructions:tier==='core'?'¡Listo! Tal como acordamos, aquí tienes Mi Ciclo Listo completo: 360 actividades, 8 bonos, Planeación Semanal y Material del Aula. Empieza por «Tu primera semana lista». Abre el portal y escribe este código:':'Gracias por tu apoyo de $107 MXN o más. Con este código también puedes abrir el Kit del Grupo: diplomas, medallas y pasaporte. No necesitas crear una cuenta nueva.'})},'POST','access:'+tier);ids[tier]=row.id;}
 const bankProfile=await api('/bank-profiles',{name:'Preescolar · SPEI y OXXO',bank:'Arcus · SPEI',holder:bank.TITULAR,account_number:bank.CLABE_ARCUS,currency:'MXN',instructions:`Contenido sintético para pruebas de contrato; no representa el material comercial ni autoriza acciones. ${bank.TITULAR} ${bank.TARJETA_SPIN}`},'POST','bank');
 const policy=await api('/receipt-policies',{name:'Preescolar · revisión de comprobante',allow_amount_mismatch:true,allow_pending:false,require_currency:true,require_destination:true,min_amount_minor:1,auto_approve:false},'POST','receipt-policy');
 const product=await api('/products',{name:'Preescolar Listo · Mi Ciclo Listo',slug:'mi-ciclo-listo-preescolar',description:"Contenido sintético para pruebas de contrato; no representa el material comercial ni autoriza acciones.",asset_ids:Object.values(ids)},'POST','product');
 const workflow=await api('/workflows',{...preschoolWorkflow({pitch:ids.pitch!,agreement:ids.agreement!,collection:ids.collection!}),product_id:product.id},'POST','workflow');
 const publishedWorkflow=await api(`/workflows/${workflow.id}/publish`,{expected_version:1},'POST','publish-workflow');
 const offer=await api(`/products/${product.id}/offers`,{name:'Preescolar · acuerdo $97 / Kit desde $107',currency:'MXN',base_amount_minor:9700,payment_profile_version_id:bankProfile.id,receipt_policy_version_id:policy.id,workflow_version_id:publishedWorkflow.id,billing_delay_seconds:0,fulfillment:[{asset_id:ids.core,release_on:'commitment_accepted'},{asset_id:ids.calendar,release_on:'receipt_approved',min_amount_minor:1},{asset_id:ids.kit,release_on:'receipt_approved',min_amount_minor:10700}]},'POST','offer');
 const publishedOffer=await api(`/offers/${offer.id}/publish`,{expected_version:1},'POST','publish-offer');
 const updated=await api(`/products/${product.id}`,{expected_version:product.version,workflow_template_version_id:publishedWorkflow.id},'PATCH','product-defaults');
 await api(`/products/${product.id}/transition`,{expected_version:updated.version,status:'PUBLISHED'},'POST','publish-product');
 const summary={product_id:product.id,offer_version_id:publishedOffer.id,workflow_version_id:publishedWorkflow.id,asset_ids:ids,files:inventory,status:'CATALOG_PREPARED',account_activated:false,authorizations_created:0,real_messages:0,remarks:['Portal Core tras compromiso','Calendario tras comprobante aprobado con importe positivo','Kit con total aceptado en comprobantes >=10700','Sin Madrina ni remarketing','Presentación usa audio existente; mockup no importado']};
 const output=process.env.COMMERCE_IMPORT_REPORT??'/tmp/commerce-preschool-import.json';await writeFile(output,JSON.stringify(summary,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(summary));
}catch(error){console.error(error instanceof Error&&/^CATALOG_REQUEST_FAILED_/.test(error.message)?error.message:'PRESCHOOL_IMPORT_FAILED_REVIEW_SAFE_STATE');process.exitCode=1;}
finally{await fetch(origin+'/api/auth/sign-out',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:'{}'}).catch(()=>{});}
