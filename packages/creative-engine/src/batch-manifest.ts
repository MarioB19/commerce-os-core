import {z} from 'zod';
import {intakeHash,inspectRecipeIntake,type PlaybookReceipt,type PlaybookIssue} from './playbook-intake.js';
export const BatchVariantSchema=z.object({variant_id:z.string().regex(/^A0[1-6]-h[1-3]$/),recipe_id:z.string().uuid(),recipe_version:z.number().int().positive(),recipe_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const BatchInputSchema=z.object({variants:z.array(BatchVariantSchema).length(18)}).strict();
export type BatchVariant=z.infer<typeof BatchVariantSchema>;
export type RecipeSnapshot={id:string;version:number;sha256:string;recipe:any};
/** Hook frames are excluded; all authored body presentation fields and scene bytes remain locked. */
export function recipeBodyLock(recipe:any):string{
 const scenes=(recipe.scenes??[]).filter((s:any)=>s.start_frame>=90).map((s:any)=>({...s,id:undefined,source_ids:undefined,start_frame:s.start_frame-90,visual_review:undefined}));
 const ids=new Set([...scenes.map((s:any)=>s.asset_id),recipe.voice?.body_asset?.asset_id,recipe.presentation?.music?.asset_id,recipe.presentation?.packshot?.asset_id].filter(Boolean));
 const assets=(recipe.assets??[]).filter((a:any)=>ids.has(a.asset_id)).map((a:any)=>({asset_id:a.asset_id,sha256:a.sha256}));
 const captions=(recipe.captions?.words??[]).filter((w:any)=>w.startFrame>=90).map((w:any)=>({...w,chunkId:undefined,startFrame:w.startFrame-90,endFrame:w.endFrame-90}));
 const presentation=recipe.presentation?{...recipe.presentation,policy_source:undefined,overlays:(recipe.presentation.overlays??[]).filter((o:any)=>o.start_frame>=90).map((o:any)=>({...o,approval:undefined}))}:undefined;
 return intakeHash({body:recipe.content?.body,product:recipe.content?.product_name,audience:recipe.content?.audience,angle:recipe.content?.angle,cta:recipe.content?.cta,duration:recipe.duration_frames,body_voice:recipe.voice?.body_asset,scenes,assets,captions,font:recipe.font,palette:recipe.palette,presentation});
}
export function inspectBatch(variants:BatchVariant[],snapshots:RecipeSnapshot[],receipt:PlaybookReceipt){
 const issues:PlaybookIssue[]=[],ids=new Set(variants.map(v=>v.variant_id)),recipes=new Set(variants.map(v=>v.recipe_id));
 const expected=Array.from({length:6},(_,i)=>Array.from({length:3},(_,j)=>`A0${i+1}-h${j+1}`)).flat();
 if(variants.length!==18||ids.size!==18||recipes.size!==18||expected.some(id=>!ids.has(id)))issues.push({code:'BATCH_MATRIX_INVALID',field:'variants',message:'Se requieren 18 recetas distintas: A01-A06 con h1-h3, sin duplicados.'});
 const locks=new Map<string,string>(),entries=[];
 for(const v of variants){const row=snapshots.find(r=>r.id===v.recipe_id&&r.version===v.recipe_version&&r.sha256===v.recipe_sha256);if(!row){issues.push({code:'BATCH_RECIPE_VERSION_CHANGED',field:v.variant_id,message:'Falta la revisión exacta de esta receta.'});continue;}
  issues.push(...inspectRecipeIntake(row.recipe,v.variant_id,receipt).map(i=>({...i,field:`${v.variant_id}:${i.field}`})));
  if(!row.recipe.voice?.body_asset)issues.push({code:'BATCH_BODY_VOICE_REQUIRED',field:v.variant_id,message:'Falta el audio del cuerpo con bytes compartidos, sin el hook.'});
  const lock=recipeBodyLock(row.recipe),angle=v.variant_id.split('-')[0]!;
  if(locks.has(angle)&&locks.get(angle)!==lock)issues.push({code:'BATCH_BODY_LOCK_CHANGED',field:angle,message:'El cuerpo, escenas, tiempos, texto visible o recursos difieren dentro del trío.'});locks.set(angle,lock);
  if((row.recipe.scenes??[]).some((s:any)=>s.start_frame<90&&s.start_frame+s.duration_frames>90))issues.push({code:'BATCH_HOOK_BOUNDARY_REQUIRED',field:v.variant_id,message:'Separa el hook de tres segundos del cuerpo para verificar el bloqueo sin ambigüedad.'});
  if((row.recipe.captions?.words??[]).some((w:any)=>w.startFrame<90&&w.endFrame>=90)||(row.recipe.presentation?.overlays??[]).some((o:any)=>o.start_frame<90&&o.start_frame+o.duration_frames>90))issues.push({code:'BATCH_HOOK_BOUNDARY_REQUIRED',field:v.variant_id,message:'Subtítulos y overlays no cruzan la frontera hook/cuerpo.'});
  entries.push({...v,body_lock_sha256:lock,state:'PENDING' as const});
 }
 return{ok:issues.length===0,issues,manifest:{schema_version:1,receipt_sha256:intakeHash(receipt),variants:entries,auto_submit:false,editorial_approval:'PENDING',production_approval:'PENDING'}};
}
