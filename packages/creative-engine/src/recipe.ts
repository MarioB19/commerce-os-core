import {ENGINE_SOURCE_SHA256} from './engine-source.js';
import {validateIntakeEvidence} from './playbook-intake.js';
import {inspectPresentation,PRESENTATION_POLICY} from './presentation.js';
import { createHash } from 'node:crypto';
import { CreativeRecipeSchema, InputApprovalSchema, ProductionAuthorizationSchema, REMOTION_VERSION, type AssetAttestation, type CreativeRecipe, type RecipeIssue, type RecipeFingerprints, type RenderPlan } from '../../creative-contracts/src/index.js';

export function canonicalJson(value:unknown):string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>`${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
export const sha256Value = (value:unknown):string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const alignmentSha256 = (words:CreativeRecipe['captions']['words']):string => sha256Value(words);
const normalizedWords = (text:string) => text.normalize('NFKC').toLocaleLowerCase('es').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/u).filter(Boolean);
export function recipeFingerprints(recipe:CreativeRecipe,platform='portable'):RecipeFingerprints {
  const prepare=sha256Value({version:1,assets:recipe.assets});
  const voice=sha256Value({version:1,voice:recipe.voice});
  const captions=sha256Value({version:1,captions:recipe.captions,font:recipe.font,...(recipe.presentation?{policy:recipe.presentation.caption_policy}:{})});
  const visualSources=recipe.sources.filter(s=>recipe.scenes.some(x=>x.source_ids.includes(s.source_id))||recipe.presentation?.overlays.some(o=>o.approval.source_id===s.source_id)||recipe.presentation?.music.source_ids.includes(s.source_id)||recipe.presentation?.policy_source.source_id===s.source_id);
  return {recipe:sha256Value(recipe),prepare,voice,captions,
    render:sha256Value({engine:recipe.engine_version,remotion:REMOTION_VERSION,platform,prepare,voice,captions,format:recipe.format,width:recipe.width,height:recipe.height,fps:recipe.fps,duration:recipe.duration_frames,scenes:recipe.scenes,palette:recipe.palette,hook:recipe.content.hook,cta:recipe.content.cta,product:recipe.content.product_name,...(recipe.presentation?{presentation:recipe.presentation,policy:PRESENTATION_POLICY,engine_source_sha256:ENGINE_SOURCE_SHA256,sources:visualSources}:{})}),
    copy:sha256Value({version:1,copy:recipe.content.ad_copy})};
}
export function inspectRecipe(input:unknown,platform='portable'):{ok:boolean;issues:RecipeIssue[];recipe?:CreativeRecipe;fingerprints?:RecipeFingerprints} {
  const parsed=CreativeRecipeSchema.safeParse(input);
  if(!parsed.success) return {ok:false,issues:parsed.error.issues.map(i=>({code:'RECIPE_INVALID',path:i.path.join('.'),message:i.message}))};
  const r=parsed.data, issues:RecipeIssue[]=[];
  const add=(code:string,path:string,message:string)=>issues.push({code,path,message});
  const assetNames=new Set<string>();
  const ids=new Set<string>(),sourceIds=new Set<string>();
  for(const [i,a] of r.assets.entries()){if(assetNames.has(a.asset_id.toLowerCase()))add('ASSET_NAME_COLLISION',`assets.${i}`,'Los IDs de materiales no pueden diferir sólo por mayúsculas.');assetNames.add(a.asset_id.toLowerCase());if(ids.has(a.asset_id))add('ASSET_DUPLICATE',`assets.${i}`,'Cada material debe tener un ID único.');ids.add(a.asset_id);}
  for(const [i,s] of r.sources.entries()){if(sourceIds.has(s.source_id))add('SOURCE_DUPLICATE',`sources.${i}`,'La fuente está duplicada.');sourceIds.add(s.source_id);}
  const source=(references:string[],path:string)=>references.forEach(id=>{if(!sourceIds.has(id))add('SOURCE_MISSING',path,`Falta la fuente ${id}.`);});
  source(r.content.source_ids,'content.source_ids');
  for(const [i,c] of r.claims.entries()) source(c.source_ids,`claims.${i}.source_ids`);
  let next=0;const sceneIds=new Set<string>();
  for(const [i,s] of r.scenes.entries()) {
    if(sceneIds.has(s.id))add('SCENE_DUPLICATE',`scenes.${i}.id`,'La escena está repetida.');sceneIds.add(s.id);
    if(s.start_frame!==next)add('SCENE_COVERAGE',`scenes.${i}.start_frame`,'Las escenas deben cubrir el video sin huecos ni solapamientos.');
    next=s.start_frame+s.duration_frames;
    if(!ids.has(s.asset_id))add('SCENE_ASSET_MISSING',`scenes.${i}.asset_id`,'Falta compartir el material de esta escena.');
    source(s.source_ids,`scenes.${i}.source_ids`);
    const asset=r.assets.find(a=>a.asset_id===s.asset_id);
    if(asset?.media_type && !asset.media_type.startsWith(`${s.kind}/`))add('SCENE_MEDIA_TYPE',`scenes.${i}`,'El tipo de material no coincide con la escena.');
  }
  if(next!==r.duration_frames)add('SCENE_DURATION','scenes','Las escenas deben cubrir toda la duración.');
  const voiceAsset=r.assets.find(a=>a.asset_id===r.voice.asset.asset_id);
  if(!voiceAsset||voiceAsset.sha256!==r.voice.asset.sha256)add('VOICE_ASSET_MISSING','voice.asset','La voz debe estar incluida con su SHA exacto en materiales.');
  if(r.voice.mode==='elevenlabs'&&!r.voice.provider_receipt_id)add('VOICE_RECEIPT_REQUIRED','voice.provider_receipt_id','La voz generada requiere un recibo confirmado del broker.');
  if(r.voice.alignment_sha256!==alignmentSha256(r.captions.words))add('ALIGNMENT_HASH_MISMATCH','voice.alignment_sha256','Los tiempos cambiaron; revisar y registrar una versión de alineación nueva.');
  let prior=-1;
  for(const [i,w] of r.captions.words.entries()){
    if(w.startFrame> w.endFrame||w.startFrame<prior||w.endFrame>=r.duration_frames)add('WORD_TIMING_INVALID',`captions.words.${i}`,'Los tiempos por palabra deben ser crecientes, sin solapamiento salvo frontera compartida de un frame y dentro del video.');
    if(normalizedWords(w.text).length!==1)add('WORD_REQUIRED',`captions.words.${i}.text`,'Cada entrada debe contener una sola palabra, no una frase SRT.');
    prior=w.endFrame;
  }
  if(normalizedWords(r.voice.transcript).join(' ')!==normalizedWords(r.captions.words.map(w=>w.text).join(' ')).join(' '))add('TRANSCRIPT_ALIGNMENT_MISMATCH','captions.words','Las palabras deben corresponder exactamente a la transcripción aprobada.');
  const visible=[r.content.hook,r.content.body,r.content.cta,r.content.product_name,r.voice.transcript,...Object.values(r.content.ad_copy),...(r.presentation?.overlays.map(o=>o.text)??[])].join(' ').normalize('NFKC').toLocaleLowerCase('es');
  for(const claim of r.excluded_claims)if(visible.includes(claim.normalize('NFKC').toLocaleLowerCase('es')))add('EXCLUDED_CLAIM','content',`El contenido incluye un claim excluido: ${claim}`);
  issues.push(...inspectPresentation(r));
  return {ok:issues.length===0,issues,recipe:r,fingerprints:recipeFingerprints(r,platform)};
}
export class RecipeBlockedError extends Error { constructor(public readonly issues:RecipeIssue[]){super(`RECIPE_BLOCKED: ${issues.map(i=>`${i.code} (${i.path})`).join(', ')}`);this.name='RecipeBlockedError';} }
export interface CompileRecipeOptions {platform:string;authorization:unknown;inputApproval:unknown;assets:AssetAttestation[];now?:number;playbookIntake?:unknown}
export function compileRecipe(input:unknown,options:CompileRecipeOptions):RenderPlan {
  const check=inspectRecipe(input,options.platform);if(!check.ok||!check.recipe||!check.fingerprints)throw new RecipeBlockedError(check.issues);
  const recipe=check.recipe,hash=check.fingerprints.recipe,now=options.now??Date.now(),issues:RecipeIssue[]=[];
  issues.push(...validateIntakeEvidence(recipe,options.playbookIntake).map(i=>({code:i.code,path:i.field,message:i.message})));
  const approval=InputApprovalSchema.safeParse(options.inputApproval),authorization=ProductionAuthorizationSchema.safeParse(options.authorization);
  if(!approval.success||approval.data.recipe_sha256!==hash||Date.parse(approval.data.approved_at)>now)issues.push({code:'INPUT_APPROVAL_REQUIRED',path:'input_approval',message:'Se requiere aprobación de entradas ligada a esta receta exacta.'});
  if(!authorization.success||authorization.data.recipe_sha256!==hash||authorization.data.recipe_version!==recipe.recipe_version||Date.parse(authorization.data.expires_at)<=now)issues.push({code:'PRODUCTION_AUTHORIZATION_REQUIRED',path:'authorization',message:'Se requiere autorización vigente para producir esta versión.'});
  for(const asset of recipe.assets){const proof=options.assets.find(a=>a.asset_id===asset.asset_id&&a.sha256===asset.sha256);
    if(!proof||proof.state!=='READY'||proof.permission!=='ALLOWED'||!proof.source_reference)issues.push({code:'ASSET_NOT_AUTHORIZED',path:`assets.${asset.asset_id}`,message:'La biblioteca debe confirmar material durable, hash y derechos de uso.'});
    if(proof?.media_type&&asset.media_type&&proof.media_type!==asset.media_type)issues.push({code:'ASSET_MEDIA_MISMATCH',path:`assets.${asset.asset_id}`,message:'El tipo registrado difiere de la receta.'});
  }
  if(issues.length||!approval.success||!authorization.success)throw new RecipeBlockedError(issues);
  return {schema_version:1,recipe,recipe_sha256:hash,platform:options.platform,engine_version:recipe.engine_version,remotion_version:REMOTION_VERSION,fingerprints:check.fingerprints,input_approval:approval.data,authorization:authorization.data,...(recipe.engine_version==='1.1.0'?{playbook_intake:options.playbookIntake}:{}),asset_attestations:options.assets.filter(a=>recipe.assets.some(b=>b.asset_id===a.asset_id))};
}
/** A review never survives different bytes or a different recipe version. */
export function reviewMatches(review:{master_sha256:string;recipe_sha256:string;status:string}|null,masterSha256:string,recipeSha256:string):boolean {
  return review?.status==='APPROVED'&&review.master_sha256===masterSha256&&review.recipe_sha256===recipeSha256;
}
export function derivativeChanges(previous:CreativeRecipe,next:CreativeRecipe,platform:string){const a=recipeFingerprints(previous,platform),b=recipeFingerprints(next,platform);return Object.fromEntries(Object.keys(b).map(k=>[k,{reused:a[k as keyof RecipeFingerprints]===b[k as keyof RecipeFingerprints],fingerprint:b[k as keyof RecipeFingerprints]}]));}
