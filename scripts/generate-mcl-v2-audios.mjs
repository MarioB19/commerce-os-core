import {createHash} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const AUDIO_GENERATION_CONFIRMATION='GENERATE_MCL_V2_AUDIOS_WITH_PAID_PROVIDER';
// The protected production voice binding is retained; public scripts use synthetic text.
// Keep only its identifier hash in the repo; a shared factory env can point to
// another campaign's voice and must never silently select it for this release.
export const MCL_VOICE_ID_SHA256='f28bf3cd446f83bda3178e8a0865387d915ac162a6045deb820f7d9dc525892c';
export const AUDIO_TRACKS=Object.freeze([
 {
  key:'agreement',
  file:'02-acuerdo-mi-ciclo-listo-v2.mp3',
  text:"Este es un guion sintético de prueba. Para comprobar el acuerdo responde: sí, lo quiero. No envíes pagos ni datos reales.",
 },
 {
  key:'collection',
  file:'03-cobro-mi-ciclo-listo-v2.mp3',
  text:"Este es un guion sintético de prueba. Para comprobar el acuerdo responde: sí, lo quiero. No envíes pagos ni datos reales.",
 },
 {
  key:'followup1',
  file:'04-seguimiento-acuerdo-mi-ciclo-listo-v2.mp3',
  text:"Este es un guion sintético de prueba. Para comprobar el acuerdo responde: sí, lo quiero. No envíes pagos ni datos reales.",
 },
 {
  key:'followup2',
  file:'05-seguimiento-pago-mi-ciclo-listo-v2.mp3',
  text:"Este es un guion sintético de prueba. Para comprobar el acuerdo responde: sí, lo quiero. No envíes pagos ni datos reales.",
 },
]);

export const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});

function parseArguments(args){
 const values=new Map(),flags=new Set(),valued=new Set(['--output','--capacity-evidence','--character-limit','--confirm']),standalone=new Set(['--apply','--help']);
 for(let index=0;index<args.length;index++){
  const argument=args[index];
  if(standalone.has(argument)){if(flags.has(argument))throw fail('DUPLICATE_OPTION');flags.add(argument);continue;}
  if(!valued.has(argument))throw fail('UNSUPPORTED_OPTION');
  if(values.has(argument))throw fail('DUPLICATE_OPTION');
  const value=args[++index];if(!value||value.startsWith('--'))throw fail('OPTION_VALUE_REQUIRED');values.set(argument,value);
 }
 const rawLimit=values.get('--character-limit');let characterLimit;
 if(rawLimit!==undefined){if(!/^[0-9]+$/.test(rawLimit))throw fail('CHARACTER_LIMIT_INVALID');characterLimit=Number(rawLimit);if(!Number.isSafeInteger(characterLimit))throw fail('CHARACTER_LIMIT_INVALID');}
 return{
  apply:flags.has('--apply'),help:flags.has('--help'),
  output:resolve(values.get('--output')??'mcl-sales-flow-v2-audio'),
  capacityEvidence:values.get('--capacity-evidence')?resolve(values.get('--capacity-evidence')):undefined,
  characterLimit,confirmation:values.get('--confirm'),
 };
}

function normalize(input,target){
 const measurement=spawnSync('ffmpeg',['-hide_banner','-nostats','-i',input,'-af','loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json','-f','null','-'],{encoding:'utf8'});
 if(measurement.status!==0)throw fail('LOUDNESS_MEASUREMENT_FAILED');
 const match=measurement.stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/g)?.at(-1);
 if(!match)throw fail('LOUDNESS_MEASUREMENT_MISSING');
 const measured=JSON.parse(match);
 const filter=[
  'loudnorm=I=-16:TP=-1.5:LRA=11',
  `measured_I=${measured.input_i}`,
  `measured_TP=${measured.input_tp}`,
  `measured_LRA=${measured.input_lra}`,
  `measured_thresh=${measured.input_thresh}`,
  `offset=${measured.target_offset}`,
  'linear=true','print_format=json',
 ].join(':');
 execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-i',input,'-af',filter,'-ac','1','-ar','44100','-b:a','128k',target]);
 return measured;
}

async function providerGenerate(track,context){
 const response=await context.fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(context.voiceId)}/with-timestamps?output_format=mp3_44100_128`,{
  method:'POST',
  headers:{'Content-Type':'application/json','xi-api-key':context.apiKey},
  body:JSON.stringify({
   text:track.text,
   model_id:'eleven_multilingual_v2',
   voice_settings:{stability:0.92,similarity_boost:0.75,style:0,use_speaker_boost:true,speed:0.88},
  }),
 });
 if(!response.ok)throw fail(`ELEVENLABS_TTS_${response.status}`);
 const payload=await response.json(),raw=Buffer.from(String(payload.audio_base64??''),'base64');
 if(!raw.length)throw fail('ELEVENLABS_AUDIO_EMPTY');
 const rawPath=join(context.output,'raw',track.file),finalPath=join(context.output,'audio-final',track.file);
 await mkdir(dirname(rawPath),{recursive:true});await mkdir(dirname(finalPath),{recursive:true});
 await writeFile(rawPath,raw,{mode:0o600});const measured=normalize(rawPath,finalPath);const final=await readFile(finalPath);
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration,bit_rate:stream=codec_name,sample_rate,channels','-of','json',finalPath],{encoding:'utf8'}));
 const alignment={alignment:payload.alignment,normalized_alignment:payload.normalized_alignment},alignmentPath=join(context.output,'alignment',`${track.key}.json`);
 await mkdir(dirname(alignmentPath),{recursive:true});await writeFile(alignmentPath,JSON.stringify(alignment,null,2)+'\n',{mode:0o600});
 return{
  key:track.key,path:finalPath,sha256:digest(final),mime:'audio/mpeg',approval:'APPROVED',approved_by:'Codex - revisión técnica AI_ASSISTED autorizada por Brandon',approved_at:context.now().toISOString(),
  review:{review_kind:'AI_ASSISTED',human_listening:false,text:track.text,text_sha256:digest(track.text),characters:track.text.length,provider_request_id:response.headers.get('request-id'),alignment_sha256:digest(JSON.stringify(alignment)),raw_sha256:digest(raw),loudness_first_pass:measured,probe},
 };
}

async function readExistingReview(output){
 try{
  const parsed=JSON.parse(await readFile(join(output,'audio-review.json'),'utf8'));
  if(parsed.schema_version!==1||!Array.isArray(parsed.tracks))throw fail('AUDIO_REVIEW_INVALID');
  return parsed;
 }catch(error){
  if(error?.code==='ENOENT')return null;
  if(error?.code)throw error;
  throw fail('AUDIO_REVIEW_INVALID');
 }
}

async function verifiedReuse(track,record,output){
 if(!record)return null;
 const path=join(output,'audio-final',track.file);let bytes;
 try{bytes=await readFile(path);}catch(error){if(error?.code==='ENOENT')throw fail(`VERIFIED_TRACK_MISSING_${track.key.toUpperCase()}`);throw error;}
 if(record.key!==track.key||record.mime!=='audio/mpeg'||record.approval!=='APPROVED'||!record.approved_by||!record.approved_at||record.sha256!==digest(bytes)||record.review?.review_kind!=='AI_ASSISTED'||record.review?.text_sha256!==digest(track.text)||record.review?.characters!==track.text.length)throw fail(`VERIFIED_TRACK_CHANGED_${track.key.toUpperCase()}`);
 return{...record,path};
}

export async function planAudioGeneration(output){
 const existing=await readExistingReview(output),records=new Map();
 for(const record of existing?.tracks??[]){if(records.has(record.key))throw fail('AUDIO_REVIEW_DUPLICATE_TRACK');records.set(record.key,record);}
 const reusable=new Map(),missing=[];
 for(const track of AUDIO_TRACKS){const record=await verifiedReuse(track,records.get(track.key),output);if(record)reusable.set(track.key,record);else missing.push(track);}
 return{
  existing,reusable,missing,
  totalCharacters:AUDIO_TRACKS.reduce((sum,track)=>sum+track.text.length,0),
  plannedCharacters:missing.reduce((sum,track)=>sum+track.text.length,0),
  reusedCharacters:[...reusable.keys()].reduce((sum,key)=>sum+AUDIO_TRACKS.find(track=>track.key===key).text.length,0),
 };
}

async function capacityReceipt(path,plannedCharacters){
 let bytes;try{bytes=await readFile(path);}catch(error){if(error?.code==='ENOENT')throw fail('CAPACITY_EVIDENCE_REQUIRED');throw error;}
 let evidence;try{evidence=JSON.parse(bytes.toString());}catch{throw fail('CAPACITY_EVIDENCE_INVALID');}
 const used=Number(evidence.subscription?.creditCount),limit=Number(evidence.subscription?.creditLimit),available=limit-used;
 if(!Number.isSafeInteger(used)||!Number.isSafeInteger(limit)||used<0||limit<0||available<0||evidence.subscription?.status!=='active'||evidence.secretsPersisted!==false||!Number.isFinite(Date.parse(evidence.checkedAt??'')))throw fail('CAPACITY_EVIDENCE_INVALID');
 if(!Array.isArray(evidence.requests)||evidence.requests.some(request=>request.method!=='GET'||Number(request.creditConsumption)!==0))throw fail('CAPACITY_EVIDENCE_NOT_READ_ONLY');
 if(available<plannedCharacters)throw fail('PROVIDER_CAPACITY_BELOW_PLAN');
 return{path,sha256:digest(bytes),checked_at:evidence.checkedAt,available_characters_at_check:available};
}

async function writeReview(output,{results,plan,capacity,characterLimit,voiceIdHash,externalRequests,now}){
 const ordered=AUDIO_TRACKS.map(track=>results.get(track.key)).filter(Boolean),complete=ordered.length===AUDIO_TRACKS.length;
 const review={
  schema_version:1,status:complete?'PASS_AI_ASSISTED':'PARTIAL_AI_ASSISTED',generated_at:now().toISOString(),provider:'ElevenLabs',model:'eleven_multilingual_v2',voice_id_sha256:voiceIdHash,
  capacity_evidence:capacity,character_limit:characterLimit,characters_total:plan.totalCharacters,characters_planned:plan.plannedCharacters,characters_reused:plan.reusedCharacters,credits_requested:plan.plannedCharacters,
  external_requests:externalRequests,secrets_persisted:false,tracks:ordered,
 };
 await mkdir(output,{recursive:true});const reviewPath=join(output,'audio-review.json'),temporary=reviewPath+'.partial';
 await writeFile(temporary,JSON.stringify(review,null,2)+'\n',{mode:0o600});await rename(temporary,reviewPath);return review;
}

export async function runAudioGeneration({args=[],env=process.env,fetcher=globalThis.fetch,generateTrack=providerGenerate,now=()=>new Date()}={}){
 const options=parseArguments(args);
 if(options.help)return{mode:'HELP',usage:`Dry-run: node scripts/generate-mcl-v2-audios.mjs --output PATH. Apply: add --apply --confirm ${AUDIO_GENERATION_CONFIRMATION} --character-limit N --capacity-evidence PRIVATE_JSON.`};
 const plan=await planAudioGeneration(options.output),summary={output:options.output,total_tracks:AUDIO_TRACKS.length,reusable_tracks:[...plan.reusable.keys()],planned_tracks:plan.missing.map(track=>track.key),total_characters:plan.totalCharacters,planned_characters:plan.plannedCharacters};
 if(!options.apply)return{mode:'DRY_RUN',external_requests:0,...summary,apply_requirements:{confirmation:AUDIO_GENERATION_CONFIRMATION,character_limit_at_least:plan.plannedCharacters,capacity_evidence_required:true}};
 if(options.confirmation!==AUDIO_GENERATION_CONFIRMATION)throw fail('PAID_GENERATION_CONFIRMATION_REQUIRED');
 if(options.characterLimit===undefined)throw fail('CHARACTER_LIMIT_REQUIRED');
 if(options.characterLimit<plan.plannedCharacters)throw fail('CHARACTER_LIMIT_BELOW_PLAN');
 if(!options.capacityEvidence)throw fail('CAPACITY_EVIDENCE_REQUIRED');
 const capacity=await capacityReceipt(options.capacityEvidence,plan.plannedCharacters),results=new Map(plan.reusable),apiKey=env.ELEVENLABS_API_KEY,voiceId=env.ELEVENLABS_VOICE_ID;
 if(plan.missing.length&&(!apiKey||!voiceId))throw fail('ELEVENLABS_CONFIGURATION_REQUIRED');
 if(voiceId&&digest(voiceId)!==MCL_VOICE_ID_SHA256)throw fail('MCL_VOICE_MISMATCH');
 if(plan.missing.length&&capacity.available_characters_at_check<options.characterLimit)throw fail('CHARACTER_LIMIT_EXCEEDS_EVIDENCE');
 const voiceIdHash=voiceId?digest(voiceId):plan.existing?.voice_id_sha256;if(!voiceIdHash)throw fail('VOICE_ID_EVIDENCE_REQUIRED');
 if(voiceIdHash!==MCL_VOICE_ID_SHA256)throw fail('MCL_VOICE_MISMATCH');
 let externalRequests=0;
 for(const track of plan.missing){
  const result=await generateTrack(track,{apiKey,voiceId,output:options.output,fetcher,now});
  const verified=await verifiedReuse(track,result,options.output);results.set(track.key,verified);externalRequests++;
  await writeReview(options.output,{results,plan,capacity,characterLimit:options.characterLimit,voiceIdHash,externalRequests,now});
 }
 const review=await writeReview(options.output,{results,plan,capacity,characterLimit:options.characterLimit,voiceIdHash,externalRequests,now});
 return{mode:'APPLIED',status:review.status,external_requests:externalRequests,capacity_evidence_sha256:capacity.sha256,...summary,tracks:review.tracks.map(result=>({key:result.key,sha256:result.sha256,characters:result.review.characters,reused:plan.reusable.has(result.key)}))};
}

async function main(){process.stdout.write(JSON.stringify(await runAudioGeneration({args:process.argv.slice(2)}))+'\n');}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'MCL_V2_AUDIO_GENERATION_FAILED');process.exitCode=1;});
