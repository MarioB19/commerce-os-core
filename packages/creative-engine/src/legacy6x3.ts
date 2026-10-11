import { z } from 'zod';
import * as legacy from './legacy/contracts.js';
import { runPreflight } from './legacy/preflight.js';
import { inspectRecipe, RecipeBlockedError, sha256Value } from './recipe.js';
import type { CreativeRecipe, RecipeIssue } from '../../creative-contracts/src/index.js';

/** The original schemas/preflight remain byte-identical in legacy/, including 6x3 and claim gates. */
export const LegacyBundleSchema=z.object({brief:legacy.BriefSchema,brandProfile:legacy.BrandProfileSchema,actorProfile:legacy.ActorProfileSchema,voiceProfile:legacy.VoiceProfileSchema,musicProfile:legacy.MusicProfileSchema,productShotProfile:legacy.ProductShotProfileSchema,videoStyleProfile:legacy.VideoStyleProfileSchema,policyProfile:legacy.PolicyProfileSchema,bodyScripts:z.array(legacy.BodyScriptSchema),creativeSpecs:z.array(legacy.CreativeSpecSchema)}).strict();
export interface LegacyDraft {id:string;product_name:string;hook:string;body:string;cta:string;ad_copy:{primary_text:string;headline:string;description:string};direction:string;legacy:{launch_id:string;angle_id:string;hook_id:string;bundle_sha256:string}}
export function importLegacy6x3(input:{bundle:unknown;selected_ids?:string[];recipes?:Record<string,unknown>}):{bundle_sha256:string;drafts:LegacyDraft[];recipes:CreativeRecipe[];issues:RecipeIssue[]} {
  const parsed=LegacyBundleSchema.safeParse(input.bundle);
  if(!parsed.success)throw new RecipeBlockedError(parsed.error.issues.map(i=>({code:'LEGACY_INVALID',path:i.path.join('.'),message:i.message})));
  const bundle=parsed.data,sha=sha256Value(input.bundle),preflight=runPreflight(bundle,{ffmpegAvailable:true});
  const expected=Array.from({length:6},(_,a)=>Array.from({length:3},(_,h)=>`A0${a+1}-h${h+1}`)).flat();
  const ids=bundle.creativeSpecs.map(s=>s.id);
  const issues=preflight.issues.filter(i=>i.severity==='error').map(i=>({code:i.code,path:i.subject??'bundle',message:i.message}));
  if(ids.length!==18||new Set(ids).size!==18||expected.some(id=>!ids.includes(id)))issues.push({code:'LEGACY_MATRIX_INCOMPLETE',path:'creativeSpecs',message:'Importa el playbook completo: A01–A06 con h1–h3. La selección de producción se hace después.'});
  if(issues.length)throw new RecipeBlockedError(issues);
  const selected=input.selected_ids??expected;
  if(new Set(selected).size!==selected.length||selected.some(id=>!expected.includes(id)))throw new RecipeBlockedError([{code:'LEGACY_SELECTION_INVALID',path:'selected_ids',message:'Selecciona variantes únicas existentes.'}]);
  const drafts:LegacyDraft[]=[],recipes:CreativeRecipe[]=[];
  for(const id of selected){const spec=bundle.creativeSpecs.find(s=>s.id===id)!;const script=bundle.bodyScripts.find(s=>s.id===spec.bodyScriptId)!;const ad=bundle.brief.ads?.find(a=>a.bodyId===spec.bodyId&&a.hookId===spec.hook.id);
    if(!ad){issues.push({code:'LEGACY_AD_COPY_MISSING',path:id,message:'Falta copy publicitario canónico; el adaptador no lo inventa.'});continue;}
    const draft:LegacyDraft={id,product_name:bundle.brief.productName,hook:spec.hook.text,body:script.sections.map(s=>s.text).join(' '),cta:spec.cta,ad_copy:{primary_text:ad.primaryText,headline:ad.headline,description:ad.description},direction:spec.hook.visual,legacy:{launch_id:bundle.brief.launchId,angle_id:spec.bodyId,hook_id:spec.hook.id,bundle_sha256:sha}};
    drafts.push(draft);
    if(input.recipes?.[id]){const check=inspectRecipe(input.recipes[id]);if(!check.ok||!check.recipe){issues.push(...check.issues.map(i=>({...i,path:`${id}.${i.path}`})));continue;}
      const r=check.recipe;
      if(r.content.product_name!==draft.product_name||r.content.hook!==draft.hook||r.content.body!==draft.body||r.content.cta!==draft.cta||r.content.ad_copy.primary_text!==draft.ad_copy.primary_text||r.content.ad_copy.headline!==draft.ad_copy.headline||r.content.ad_copy.description!==draft.ad_copy.description)issues.push({code:'LEGACY_CONTENT_MISMATCH',path:id,message:'El contenido difiere del playbook; importa una versión nueva aprobada.'});
      else recipes.push({...r,legacy:draft.legacy});
    }else issues.push({code:'LEGACY_MATERIALS_REQUIRED',path:id,message:'Borrador importado. Completa referencias de materiales, audio, tiempos por palabra y fuentes antes de producir.'});
  }
  return {bundle_sha256:sha,drafts,recipes,issues};
}
