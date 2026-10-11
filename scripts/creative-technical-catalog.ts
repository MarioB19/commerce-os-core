/** One explicit, hash-bound administrative import; no role changes or publication. */
import {readFile,writeFile,rename,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {pool,withTransaction,putRecord,appendEvent,hash,stableJson,uuid} from '../packages/db/src/index.js';
import {productSchema,offerSchema} from '../packages/contracts/src/index.js';
import {validateOffer} from '../packages/domain/src/catalog/validation.js';

const INPUT_SHA='4b979ac6ac719c7d7cdce11058b520aed0c7c1b2e4c3539bb055edb9a5d8db33';
const AUTHORIZATION='dc6656c7b81d5af72b514a273a6d87d668642f27edba7feae3ef214c09d5aa3b';
const folder=process.env.CREATIVE_PILOT_PRIVATE_DIR??'/pilot-private';
const fail=(code:string)=>Object.assign(new Error(code),{code});
async function privateFile(name:string){const path=join(folder,name);if(!(await stat(path)).isFile()||(await stat(path)).mode&0o077)throw fail('PRIVATE_FILE_REQUIRED');return readFile(path,'utf8');}
async function save(name:string,value:unknown){const path=join(folder,name);await writeFile(path+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);}
async function run(){
 const action=process.argv[2];if(!['prepare','execute'].includes(action))throw fail('EXPLICIT_ACTION_REQUIRED');
 const inputBytes=await privateFile('catalog-input.json');if(hash(inputBytes)!==INPUT_SHA)throw fail('AUTHORIZED_INPUT_HASH_MISMATCH');
 const input=JSON.parse(inputBytes),identities=JSON.parse(await privateFile('technical-identities.json'));
 if(identities.pilot_id!==input.technical_pilot_id||identities.authorization_sha256!==AUTHORIZATION||identities.workspace_id!==process.env.WORKSPACE_ID||Date.parse(identities.expires_at)<=Date.now())throw fail('TECHNICAL_PILOT_BINDING_INVALID');
 if(input.schema_version!==1||input.authority!=='DELEGATED_PILOT'||input.products.length!==2)throw fail('AUTHORIZED_CATALOG_BOUND_REQUIRED');
 const products=input.products.map((p:any)=>{const product=productSchema.parse(p.product),offer=offerSchema.parse(p.offer);validateOffer(offer);if(offer.status!=='DRAFT'||offer.base_amount_minor!==9700||offer.currency!=='MXN'||offer.fulfillment.length||product.initial_offer||product.asset_ids.length||product.references.length||product.knowledge.length)throw fail('DRAFT_WITHOUT_COMMERCIAL_BINDINGS_REQUIRED');return {...p,product,offer};});
 let journal:any;try{journal=JSON.parse(await privateFile('catalog-journal.json'));}catch(error:any){if(error.code!=='ENOENT')throw error;journal={input_sha256:INPUT_SHA,pilot_id:identities.pilot_id,status:'PREPARED',mapping:Object.fromEntries(products.map((p:any)=>[p.key,{product_id:uuid(),offer_id:uuid()}]))};await save('catalog-journal.json',journal);}
 if(journal.input_sha256!==INPUT_SHA||journal.pilot_id!==identities.pilot_id)throw fail('CATALOG_JOURNAL_CONFLICT');
 if(action==='prepare')return {status:'PREPARED',input_sha256:INPUT_SHA,mapping:journal.mapping};
 await withTransaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['creative.technical_catalog:'+identities.pilot_id]);
  const actor=identities.identities.find((i:any)=>i.kind==='administrator');
  if(!actor?.id||!(await c.query("SELECT 1 FROM memberships WHERE user_id=$1 AND workspace_id=$2 AND role='viewer' AND active",[actor.id,identities.workspace_id])).rowCount)throw fail('TECHNICAL_VIEWER_REQUIRED');
  for(const inputProduct of products){
   const ids=journal.mapping[inputProduct.key];
   for(const kind of ['product','offer'] as const){
    const id=ids[kind+'_id'],body=kind==='product'?{...inputProduct.product,status:'DRAFT'}:{...inputProduct.offer,product_id:ids.product_id,status:'DRAFT'};
    const old=(await c.query('SELECT * FROM records WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(old){const proof=(await c.query("SELECT 1 FROM domain_events WHERE aggregate_id=$1 AND workspace_id=$2 AND event_type='creative.technical_catalog.created' AND payload->>'pilot_id'=$3 AND payload->>'input_sha256'=$4",[id,identities.workspace_id,identities.pilot_id,INPUT_SHA])).rowCount;if(!proof||old.workspace_id!==identities.workspace_id||old.environment!=='REAL'||old.kind!==kind||stableJson(old.body)!==stableJson(body))throw fail('CATALOG_RESUME_CONFLICT');continue;}
    await putRecord(c,{id,workspaceId:identities.workspace_id,environment:'REAL',kind,body});
    const provenance={pilot_id:identities.pilot_id,input_sha256:INPUT_SHA,source_recipe_sha256:inputProduct.source_recipe_sha256,source_metadata_sha256:inputProduct.source_metadata_sha256,authorization_sha256:AUTHORIZATION,purpose:'EVALUATION_ONLY',key:inputProduct.key,product_id:ids.product_id,status:'DRAFT'};
    for(const event_type of [kind+'.created','creative.technical_catalog.created'])await appendEvent(c,{workspace_id:identities.workspace_id,environment:'REAL',event_type,aggregate_id:id,actor:{type:'technical_provisioner',authority:'DELEGATED_PILOT',user_id:actor.id},payload:provenance});
   }
  }
 });
 journal.status='CONFIRMED';await save('catalog-journal.json',journal);await save('catalog-mapping.json',journal.mapping);
 return {status:'CONFIRMED',input_sha256:INPUT_SHA,mapping:journal.mapping,created_products:2,created_offers:2,publication:'DRAFT',roles_unchanged:true};
}
try{console.log(JSON.stringify(await run()));}catch(error:any){console.error(JSON.stringify({status:'FAILED',code:/^[A-Z0-9_]+$/.test(error.code??'')?error.code:'TECHNICAL_CATALOG_FAILED'}));process.exitCode=1;}finally{await pool.end();}
