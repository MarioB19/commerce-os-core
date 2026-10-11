import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MCL_AD_VOICE_SHA256} from '../../scripts/import-mi-ciclo-listo.js';

const modulePath=path.resolve('scripts/generate-mcl-v2-audios.mjs');
const {AUDIO_GENERATION_CONFIRMATION,AUDIO_TRACKS,MCL_VOICE_ID_SHA256,runAudioGeneration}=await import(modulePath);
const roots:string[]=[];
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

async function temporaryRoot(){const root=await mkdtemp(path.join(tmpdir(),'mcl-audio-generator-'));roots.push(root);return root;}
async function capacity(root:string){const value={version:1,checkedAt:'2026-09-20T12:58:38.857Z',requests:[{method:'GET',endpoint:'/v1/user/subscription',creditConsumption:0}],secretsPersisted:false,subscription:{creditCount:100,creditLimit:100000,status:'active'}};const file=path.join(root,'capacity.json'),bytes=Buffer.from(JSON.stringify(value));await writeFile(file,bytes);return{file,sha256:sha(bytes)};}
async function trackRecord(output:string,track:any,label='verified'){
 const bytes=Buffer.from(`ID3 synthetic ${label} ${track.key}`),file=path.join(output,'audio-final',track.file);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);
 return{key:track.key,path:file,sha256:sha(bytes),mime:'audio/mpeg',approval:'APPROVED',approved_by:'Synthetic AI-assisted review',approved_at:'2026-09-20T13:00:00.000Z',review:{review_kind:'AI_ASSISTED',human_listening:false,text_sha256:sha(track.text),characters:track.text.length,probe:{fixture:true},loudness_first_pass:{fixture:true}}};
}
const azucenaVoiceId='ay4iqk10DLwc8KGSrf2t';
async function existingReview(output:string,count:number){const records=[];for(const track of AUDIO_TRACKS.slice(0,count))records.push(await trackRecord(output,track));await writeFile(path.join(output,'audio-review.json'),JSON.stringify({schema_version:1,status:count===AUDIO_TRACKS.length?'PASS_AI_ASSISTED':'PARTIAL_AI_ASSISTED',voice_id_sha256:sha(azucenaVoiceId),tracks:records}));return records;}

afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

describe('Mi Ciclo Listo paid audio generation boundary',()=>{
 it('pins the same ad voice in generation and publication',()=>{
  expect(MCL_VOICE_ID_SHA256).toBe(MCL_AD_VOICE_SHA256);
  expect(sha(azucenaVoiceId)).toBe(MCL_AD_VOICE_SHA256);
 });
 it('is a zero-network dry-run by default and does not require provider credentials',async()=>{
  const output=path.join(await temporaryRoot(),'output'),fetcher=vi.fn(async()=>{throw new Error('NETWORK_MUST_NOT_RUN');});
  const result=await runAudioGeneration({args:['--output',output],env:{},fetcher});
  expect(result).toMatchObject({mode:'DRY_RUN',external_requests:0,reusable_tracks:[],planned_tracks:AUDIO_TRACKS.map((track:any)=>track.key),planned_characters:AUDIO_TRACKS.reduce((sum:number,track:any)=>sum+track.text.length,0)});expect(fetcher).not.toHaveBeenCalled();
  await expect(readFile(path.join(output,'audio-review.json'))).rejects.toMatchObject({code:'ENOENT'});
 });

 it('rejects apply without exact confirmation or a character limit covering the plan before any POST',async()=>{
  const root=await temporaryRoot(),output=path.join(root,'output'),evidence=await capacity(root),fetcher=vi.fn(async()=>{throw new Error('NETWORK_MUST_NOT_RUN');}),total=AUDIO_TRACKS.reduce((sum:number,track:any)=>sum+track.text.length,0);
  await expect(runAudioGeneration({args:['--apply','--output',output,'--capacity-evidence',evidence.file,'--character-limit',String(total)],env:{ELEVENLABS_API_KEY:'fixture',ELEVENLABS_VOICE_ID:'fixture'},fetcher})).rejects.toThrow('PAID_GENERATION_CONFIRMATION_REQUIRED');
  await expect(runAudioGeneration({args:['--apply','--output',output,'--capacity-evidence',evidence.file,'--confirm',AUDIO_GENERATION_CONFIRMATION],env:{ELEVENLABS_API_KEY:'fixture',ELEVENLABS_VOICE_ID:'fixture'},fetcher})).rejects.toThrow('CHARACTER_LIMIT_REQUIRED');
  await expect(runAudioGeneration({args:['--apply','--output',output,'--capacity-evidence',evidence.file,'--confirm',AUDIO_GENERATION_CONFIRMATION,'--character-limit',String(total-1)],env:{ELEVENLABS_API_KEY:'fixture',ELEVENLABS_VOICE_ID:'fixture'},fetcher})).rejects.toThrow('CHARACTER_LIMIT_BELOW_PLAN');
  expect(fetcher).not.toHaveBeenCalled();
 });

 it('rejects the shared factory voice when it differs from the ad voice',async()=>{
  const root=await temporaryRoot(),output=path.join(root,'output'),evidence=await capacity(root),total=AUDIO_TRACKS.reduce((sum:number,track:any)=>sum+track.text.length,0),generateTrack=vi.fn();
  await expect(runAudioGeneration({args:['--apply','--output',output,'--capacity-evidence',evidence.file,'--confirm',AUDIO_GENERATION_CONFIRMATION,'--character-limit',String(total)],env:{ELEVENLABS_API_KEY:'fixture-key',ELEVENLABS_VOICE_ID:'another-campaign-voice'},generateTrack})).rejects.toThrow('MCL_VOICE_MISMATCH');
  expect(generateTrack).not.toHaveBeenCalled();
 });

 it('reuses verified tracks, checkpoints a partial rerun, and records the capacity evidence hash without network in CI',async()=>{
  const root=await temporaryRoot(),output=path.join(root,'output');await mkdir(output,{recursive:true});const [reused]=await existingReview(output,1),evidence=await capacity(root),generated:string[]=[];
  const generateTrack=vi.fn(async(track:any,context:any)=>{generated.push(track.key);return trackRecord(context.output,track,'generated');});
  const planned=AUDIO_TRACKS.slice(1).reduce((sum:number,track:any)=>sum+track.text.length,0),args=['--apply','--output',output,'--capacity-evidence',evidence.file,'--confirm',AUDIO_GENERATION_CONFIRMATION,'--character-limit',String(planned)];
  const applied=await runAudioGeneration({args,env:{ELEVENLABS_API_KEY:'fixture-key',ELEVENLABS_VOICE_ID:azucenaVoiceId},generateTrack,fetcher:vi.fn(async()=>{throw new Error('NETWORK_MUST_NOT_RUN');}),now:()=>new Date('2026-09-20T14:00:00.000Z')});
  expect(applied).toMatchObject({mode:'APPLIED',status:'PASS_AI_ASSISTED',external_requests:3,reusable_tracks:[reused.key],planned_tracks:AUDIO_TRACKS.slice(1).map((track:any)=>track.key),capacity_evidence_sha256:evidence.sha256});expect(generated).toEqual(AUDIO_TRACKS.slice(1).map((track:any)=>track.key));
  const review=JSON.parse(await readFile(path.join(output,'audio-review.json'),'utf8'));expect(review).toMatchObject({status:'PASS_AI_ASSISTED',capacity_evidence:{path:evidence.file,sha256:evidence.sha256},character_limit:planned,characters_planned:planned,external_requests:3});expect(review.tracks).toHaveLength(AUDIO_TRACKS.length);
  generateTrack.mockClear();const rerun=await runAudioGeneration({args:[...args.slice(0,-1),'0'],env:{},generateTrack,now:()=>new Date('2026-09-20T14:01:00.000Z')});expect(rerun).toMatchObject({mode:'APPLIED',external_requests:0,planned_tracks:[],reusable_tracks:AUDIO_TRACKS.map((track:any)=>track.key)});expect(generateTrack).not.toHaveBeenCalled();
  const rerunReview=JSON.parse(await readFile(path.join(output,'audio-review.json'),'utf8'));expect(rerunReview.capacity_evidence.sha256).toBe(evidence.sha256);expect(rerunReview.credits_requested).toBe(0);
 });
});
