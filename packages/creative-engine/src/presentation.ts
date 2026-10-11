import type {CreativeRecipe,RecipeIssue} from '../../creative-contracts/src/index.js';
import {sha256Value} from './recipe.js';
import {captionCards} from './caption-cards.js';

export const PRESENTATION_POLICY={id:'infoproduct-attraction-led-v2-packshot',version:1,attraction_min_share:.6,ui_max_frames:150,product_max_frames:240,product_max_share:.2,packshot_frames:60,safe_zone:{x:65,y:270,width:950,height:980},caption_bottom:1536,caption_max_words:4};
export const sceneDirectionHash=(scene:CreativeRecipe['scenes'][number])=>sha256Value({direction:scene.direction,kind:scene.kind,role:scene.role,origin:scene.origin,duration_frames:scene.duration_frames,trim_before_frames:scene.trim_before_frames,fit:scene.fit,motion:scene.motion,orientation:'portrait'});
export const packshotDirectionHash=(p:NonNullable<CreativeRecipe['presentation']>['packshot'])=>sha256Value({role:'packshot',origin:p.origin,preset:p.preset,duration_frames:p.duration_frames,orientation:'portrait'});

export function inspectPresentation(r:CreativeRecipe):RecipeIssue[]{
 const issues:RecipeIssue[]=[];const add=(code:string,path:string,message:string)=>issues.push({code,path,message});
 if(r.engine_version==='1.0.0'){if(r.presentation)add('ENGINE_VERSION_REQUIRED','presentation','La presentación nueva requiere motor1.1.0.');return issues;}
 const p=r.presentation;if(!p){add('PRESENTATION_REQUIRED','presentation','La receta1.1 requiere política, copy aprobado, música y packshot.');return issues;}
 const body=r.voice.body_asset;if(!body||!body.media_type?.startsWith('audio/')||body.asset_id===r.voice.asset.asset_id||!r.assets.some(a=>a.asset_id===body.asset_id&&a.sha256===body.sha256))add('BODY_VOICE_REQUIRED','voice.body_asset','Motor1.1 necesita el audio del cuerpo compartido, independiente del hook, con SHA exacto.');
 const asset=(id:string)=>r.assets.find(a=>a.asset_id===id),source=(id:string)=>r.sources.find(s=>s.source_id===id);
 if(source(p.policy_source.source_id)?.sha256!==p.policy_source.sha256)add('POLICY_SOURCE_CHANGED','presentation.policy_source','La política debe coincidir con su fuente versionada.');
 if(r.captions.max_words_per_card<2||r.captions.max_words_per_card>4)add('CAPTION_WORD_LIMIT','captions.max_words_per_card','Subtítulos de2–4 palabras por tarjeta.');
 if(captionCards(r.captions.words,r.captions.max_words_per_card,2).some(c=>c.words.length<2))add('CAPTION_SINGLETON','captions.words','Agrupa cada tarjeta con2–4 palabras; una palabra aislada necesita revisión de alineación.');
 const usedHashes=new Set<string>();let attraction=0,ui=0,uiBlocks=0;
 const attractionOrigins=new Set(['stock','internal-library','magnific-generated-clip','winning-ad']);
 for(const [i,s] of r.scenes.entries()){
  const path=`scenes.${i}`,a=asset(s.asset_id);const isAttraction=s.kind==='video'&&attractionOrigins.has(s.origin??'');
  if(i===0&&(!isAttraction||s.role!=='hook'))add('HOOK_ATTRACTION_REQUIRED',path,'El hook debe abrir con video de atracción revisado.');
  if(isAttraction)attraction+=s.duration_frames;
  if(s.origin==='product-real'){ui+=s.duration_frames;uiBlocks++;if(s.duration_frames>150)add('UI_DURATION',path,'La demostración de producto dura máximo5s.');}
  else if(!isAttraction)add('ATTRACTION_OR_UI_REQUIRED',path,'La narrativa usa video de atracción o la demostración real permitida.');
  if(a?.sha256&&usedHashes.has(a.sha256))add('CLIP_REUSE',path,'No reutilizar los mismos bytes en dos escenas.');if(a?.sha256)usedHashes.add(a.sha256);
  if(!s.direction||!s.visual_review||s.visual_review.asset_sha256!==a?.sha256||s.visual_review.direction_sha256!==sceneDirectionHash(s)||Date.parse(s.visual_review.reviewed_at)>Date.now())add('SCENE_VISUAL_REVIEW_REQUIRED',path,'Revisión visual ligada al clip y dirección/duración/recorte exactos.');
 }
 if(attraction/r.duration_frames<.6)add('ATTRACTION_SHARE','scenes','Mínimo60% de atracción dinámica.');
 if(uiBlocks>1)add('UI_BLOCKS','scenes','Como máximo una demostración UI.');
 if(ui+60>240||(ui+60)/r.duration_frames>.2)add('PRODUCT_EXPOSURE','presentation.packshot','UI más packshot: máximo8s y20%.');
 const shot=p.packshot,shotAsset=asset(shot.asset_id),hookEnd=r.scenes[0]?.duration_frames??0;
 if(!shotAsset?.media_type?.startsWith('image/')||r.scenes.some(s=>s.asset_id===shot.asset_id))add('PACKSHOT_ASSET','presentation.packshot','Packshot de imagen independiente de las escenas.');
 if(shot.start_frame<hookEnd||shot.start_frame+60>=r.duration_frames)add('PACKSHOT_TIMING','presentation.packshot','Un cameo de2s después del hook y con salida antes del final.');
 const backgrounds=r.scenes.filter(s=>s.start_frame<shot.start_frame+60&&s.start_frame+s.duration_frames>shot.start_frame);
 if(backgrounds.some(s=>s.kind!=='video'||!attractionOrigins.has(s.origin??'')))add('PACKSHOT_BACKGROUND','presentation.packshot','El cameo se superpone a video de atracción.');
 if(shot.review.asset_sha256!==shotAsset?.sha256||shot.review.direction_sha256!==packshotDirectionHash(shot)||Date.parse(shot.review.reviewed_at)>Date.now())add('PACKSHOT_REVIEW','presentation.packshot.review','El cameo requiere revisión de bytes y preset exactos.');
 if(!asset(p.music.asset_id)?.media_type?.startsWith('audio/')||p.music.asset_id===r.voice.asset.asset_id)add('MUSIC_ASSET','presentation.music','La música usa un material de audio distinto de la voz.');
 if(p.music.ducked_volume>p.music.volume)add('MUSIC_DUCKING','presentation.music','El volumen bajo voz no puede superar el volumen normal.');
 for(const id of p.music.source_ids)if(!source(id))add('SOURCE_MISSING','presentation.music.source_ids',`Falta fuente${id}.`);
 const roles=new Set(p.overlays.map(o=>o.role)),overlayIds=new Set<string>();for(const role of ['hook','benefit','offer','cta'])if(!roles.has(role as any))add('DISPLAY_ROLE_MISSING','presentation.overlays',`Falta copy visible aprobado de${role}.`);
 for(const [i,o] of p.overlays.entries()){
  const path=`presentation.overlays.${i}`,s=source(o.approval.source_id),b=o.box;
  if(overlayIds.has(o.id))add('DISPLAY_ID_DUPLICATE',path,'Cada overlay tiene ID único.');overlayIds.add(o.id);
  if(o.start_frame+o.duration_frames>r.duration_frames||o.duration_frames<30)add('DISPLAY_TIMING',path,'El copy debe permanecer al menos1s y dentro del video.');
  if(b.x+b.width>1015||b.y+b.height>1250)add('DISPLAY_SAFE_ZONE',path,'El bloque completo debe estar dentro de x65/y270/w950/h980.');
  if(!s||s.sha256!==o.approval.source_sha256||o.approval.text_sha256!==sha256Value(o.text)||Date.parse(o.approval.approved_at)>Date.now())add('DISPLAY_APPROVAL_STALE',path,'Copy visible requiere aprobación del texto exacto y fuente vigente.');
  if(o.role==='hook'&&(o.text!==r.content.hook||o.start_frame!==0))add('HOOK_COPY_PARITY',path,'El hook visible debe coincidir con el hook de la receta desdeframe0.');
  if(o.role==='cta'&&o.text!==r.content.cta)add('CTA_COPY_PARITY',path,'El CTA visible debe coincidir con el CTA de la receta.');
  if(/guía en video|demostración real|vista real|tipo\s*[123]|faceless|avatar-hybrid/iu.test(o.text))add('VISIBLE_INTERNAL_LABEL',path,'No mostrar etiquetas de implementación.');
  const duringShot=o.start_frame<shot.start_frame+60&&o.start_frame+o.duration_frames>shot.start_frame;
  if(duringShot&&b.y<1150&&b.y+b.height>400)add('PACKSHOT_OVERLAY_COLLISION',path,'Reserva el espacio del cameo durante sus2s.');
  for(const other of p.overlays.slice(0,i))if(o.start_frame<other.start_frame+other.duration_frames&&o.start_frame+o.duration_frames>other.start_frame&&b.x<other.box.x+other.box.width&&b.x+b.width>other.box.x&&b.y<other.box.y+other.box.height&&b.y+b.height>other.box.y)add('DISPLAY_COLLISION',path,'Dos bloques visibles se superponen.');
 }
 return issues;
}
