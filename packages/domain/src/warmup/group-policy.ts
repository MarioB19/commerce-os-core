import {createHash} from 'node:crypto';
import {libraryScriptSchema,type LibraryScript,type GroupWarmupConfig} from '../../../contracts/src/group-warmup.js';
import {dailyBudget,warmupProfileSchema} from './policy.js';

export const GROUP_POLICY_VERSION='group-outgoing/v1';
export const LIBRARY_REUSE_DAYS=7;
export function normalizedMessage(text:string){return text.normalize('NFKC').toLocaleLowerCase('es').replace(/[\p{P}\p{S}]/gu,' ').replace(/\s+/g,' ').trim();}
export function messageHash(text:string){return createHash('sha256').update(normalizedMessage(text)).digest('hex');}
export function validateLibrary(scripts:LibraryScript[]){
 const messages=new Set<string>(),labels=new Set<string>();
 for(const raw of scripts){const s=libraryScriptSchema.parse(raw);const label=normalizedMessage(s.label);if(labels.has(label))throw Error('LIBRARY_DUPLICATE_SCRIPT');labels.add(label);
  for(const t of s.turns){const normalized=normalizedMessage(t.text);if(messages.has(normalized))throw Error('LIBRARY_DUPLICATE_MESSAGE');
   if(/https?:\/\/|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\s()-]?){8,}|\{\{|\}\}/i.test(t.text))throw Error('LIBRARY_PERSONAL_DATA_OR_PLACEHOLDER');messages.add(normalized);}
 }
 return{scripts:scripts.length,messages:messages.size,topics:[...new Set(scripts.map(s=>s.topic))].sort(),ai:false as const};
}
export function groupProfile(config:GroupWarmupConfig){return warmupProfileSchema.parse({name:config.name,timezone:config.timezone,start_hour:config.startHour,end_hour:config.endHour,policy_version:'standard-15d/v2'});}
export function groupDailyBudget(config:GroupWarmupConfig,day:number,now:Date,maintenance=false){
 const profile=groupProfile(config),curve=dailyBudget(profile,maintenance?1:day,now);
 const perSender=Math.min(config.senderDailyLimit,curve.max_messages,maintenance?10:100);
 const gap=Math.max(60,Math.ceil(60/profile.rate_per_minute)+profile.jitter_seconds);
 const windowCapacity=Math.floor(((config.endHour-config.startHour)*3600-1)/gap);
 const total=Math.min(config.groupDailyLimit,perSender*config.senderIds.length,windowCapacity);
 // The old curve counted a received turn for every group member. V7.2 credits
 // outgoing evidence, with an explicit feasible minimum for the full chosen
 // window/group cap. Late starts never reduce this minimum or catch up tomorrow.
 return{policy_version:GROUP_POLICY_VERSION,day,per_sender:perSender,total,min_outgoing:Math.min(curve.min_messages,Math.floor(total/config.senderIds.length)),min_conversations:curve.min_conversations};
}
export function libraryCoverage(config:GroupWarmupConfig,scripts:LibraryScript[]){
 const compatible=scripts.filter(s=>s.turns.length>=config.senderIds.length),messages=compatible.reduce((n,s)=>n+s.turns.length,0);
 const maximum=Math.min(config.groupDailyLimit,config.senderDailyLimit*config.senderIds.length),required=Math.ceil(maximum*LIBRARY_REUSE_DAYS*1.2);
 return{compatibleScripts:compatible.length,uniqueMessages:messages,maximumDaily:maximum,requiredMessages:required,days:maximum?messages/maximum:0,sufficient:messages>=required};
}
/** Stable permutation: retries and restarts retain selection; no random API or model. */
export function shuffledLibrary<T extends {content_hash:string}>(rows:T[],seed:string):T[]{return [...rows].sort((a,b)=>messageHash(seed+':'+a.content_hash).localeCompare(messageHash(seed+':'+b.content_hash)));}

/** Reject limits that cannot fit enough complete exchanges for daily evidence.
 * This is a full-window check, independent of when a program starts. */
export function libraryLimitsFeasible(config:GroupWarmupConfig,scripts:LibraryScript[]){
 const lengths=[...new Set(scripts.filter(s=>s.turns.length>=config.senderIds.length).map(s=>s.turns.length))];
 if(!lengths.length)return false;
 for(const day of [1,6,11])for(const date of ['2026-11-06T12:00:00Z','2026-11-08T12:00:00Z']){
  const budget=groupDailyBudget(config,day,new Date(date));
  const possible=new Set([0]);for(let i=1;i<=budget.total;i++)if(lengths.some(n=>possible.has(i-n)))possible.add(i);
  if(budget.min_outgoing<1||Math.floor(Math.max(...possible)/config.senderIds.length)<budget.min_outgoing)return false;
 }
 return true;
}
