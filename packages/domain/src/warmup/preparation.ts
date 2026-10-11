import {CURRENT_STANDARD_POLICY,STANDARD_V1_POLICY,STANDARD_V2_POLICY,dailyBudget,type WarmupProfile} from './policy.js';

export const STANDARD_POLICY = CURRENT_STANDARD_POLICY;
export {STANDARD_V1_POLICY,STANDARD_V2_POLICY};
export const MANUAL_TASKS = ['authentic_profile', 'responsible_device', 'consented_contacts', 'human_conversations'] as const;
export type ManualTask = typeof MANUAL_TASKS[number];
export interface Declaration { id?:string; supersedes_id?:string|null; task: ManualTask; status: 'COMPLETED'|'PENDING'|'UNVERIFIABLE'; recorded_at: string; actor: string; source: 'operator_declaration'; local_date: string }
export interface PreparationEvidence {
 policy_version: string; started_at: string; timezone: string; declarations: Declaration[];
 automatic_days: number; stable_since: string|null; last_observed_at: string|null;
 mature_samples: number; delivered: number; confirmed_block: boolean; now: Date;
}
export function localDate(at: Date, timezone: string) {
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at).map(p=>[p.type,p.value]));
 return `${parts.year}-${parts.month}-${parts.day}`;
}
export function calendarDistance(start: string, end: string) { return Math.floor((Date.parse(end+'T12:00:00Z')-Date.parse(start+'T12:00:00Z'))/86400000); }
export function addCalendarDays(date:string,days:number){return new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);}
export function manualPreparation(input: Pick<PreparationEvidence,'started_at'|'timezone'|'declarations'|'now'>) {
 const start=localDate(new Date(input.started_at),input.timezone),today=localDate(input.now,input.timezone);
 const latest=new Map<ManualTask,Declaration>();
 const superseded=new Set(input.declarations.map(d=>d.supersedes_id).filter(Boolean));
 const valid=input.declarations.filter(d=>!d.id||!superseded.has(d.id));
 for(const entry of [...valid].sort((a,b)=>a.recorded_at.localeCompare(b.recorded_at))) {
  if(Date.parse(entry.recorded_at)>input.now.getTime()||Date.parse(entry.recorded_at)<Date.parse(input.started_at)||entry.local_date!==localDate(new Date(entry.recorded_at),input.timezone)||!entry.actor||entry.source!=='operator_declaration')continue;
  latest.set(entry.task,entry);
 }
 const missing=MANUAL_TASKS.filter(task=>latest.get(task)?.status!=='COMPLETED');
 const dates=new Set(valid.filter(d=>d.status==='COMPLETED'&&d.source==='operator_declaration'&&!!d.actor&&Date.parse(d.recorded_at)>=Date.parse(input.started_at)&&Date.parse(d.recorded_at)<=input.now.getTime()&&d.local_date===localDate(new Date(d.recorded_at),input.timezone)).map(d=>d.local_date));
 const elapsed=Math.max(0,calendarDistance(start,today));
 return {ready:elapsed>=4&&dates.size>=4&&missing.length===0,elapsed_days:Math.min(4,elapsed),declared_days:Math.min(4,dates.size),missing_tasks:missing,reason:missing.length?'MANUAL_CHECKLIST_INCOMPLETE':dates.size<4?'FOUR_MANUAL_DATES_REQUIRED':elapsed<4?'MANUAL_DAYS_PENDING':null};
}
export function preparationProgress(input:PreparationEvidence) {
 if(input.policy_version===STANDARD_V2_POLICY){
  const start=localDate(new Date(input.started_at),input.timezone),today=localDate(input.now,input.timezone),elapsed=Math.max(0,calendarDistance(start,today)),nominalDay=elapsed+1,automaticDays=Math.min(14,Math.max(0,input.automatic_days));
  const stable=!!input.stable_since&&Date.parse(input.stable_since)>=Date.parse(input.started_at)&&input.now.getTime()-Date.parse(input.stable_since)>=7*86400000&&!!input.last_observed_at&&input.now.getTime()-Date.parse(input.last_observed_at)>=0&&input.now.getTime()-Date.parse(input.last_observed_at)<3600000;
  const ratio=input.mature_samples>=20?input.delivered/input.mature_samples:null;
  const reason=input.confirmed_block?'CONFIRMED_RESTRICTION':automaticDays<14?'AUTOMATIC_DAYS_PENDING':nominalDay<15?'DAY_15_PENDING':!stable?'STABILITY_NOT_DEMONSTRATED':ratio===null?'MATURE_SAMPLES_PENDING':ratio<.98?'DELIVERY_BELOW_THRESHOLD':null;
  const remaining=Math.max(0,14-elapsed,14-automaticDays),estimated=addCalendarDays(today,remaining),expected=addCalendarDays(start,14);
  return{policy_version:input.policy_version,stage:reason===null?'COMPLETED':nominalDay>=15?'EVALUATION':nominalDay<=4?'INITIAL_AUTOMATIC':'GRADUAL_AUTOMATIC',completed:reason===null,day:Math.min(15,nominalDay),nominal_day:nominalDay,nominal_days:15,manual:null,automatic_days:automaticDays,required_automatic_days:14,stable,delivery_ratio:ratio,mature_samples:input.mature_samples,reason,estimated_completion_date:estimated,delayed:calendarDistance(expected,estimated)>0};
 }
 const manual=manualPreparation(input),elapsed=calendarDistance(localDate(new Date(input.started_at),input.timezone),localDate(input.now,input.timezone));
 const stable=!!input.stable_since&&input.now.getTime()-Date.parse(input.stable_since)>=7*86400000&&!!input.last_observed_at&&input.now.getTime()-Date.parse(input.last_observed_at)>=0&&input.now.getTime()-Date.parse(input.last_observed_at)<3600000;
 const ratio=input.mature_samples>=20?input.delivered/input.mature_samples:null;
 const reason=input.confirmed_block?'CONFIRMED_RESTRICTION':!manual.ready?manual.reason:input.automatic_days<10?'AUTOMATIC_DAYS_PENDING':elapsed<14?'DAY_15_PENDING':!stable?'STABILITY_NOT_DEMONSTRATED':ratio===null?'MATURE_SAMPLES_PENDING':ratio<.98?'DELIVERY_BELOW_THRESHOLD':null;
 const day=manual.ready?Math.min(15,5+input.automatic_days):Math.min(4,elapsed+1);
 return {policy_version:input.policy_version,stage:reason===null?'COMPLETED':!manual.ready?'MANUAL':'GRADUAL',completed:reason===null,day,nominal_days:15,manual,automatic_days:Math.min(10,input.automatic_days),stable,delivery_ratio:ratio,mature_samples:input.mature_samples,reason,
  estimated_completion_date:localDate(new Date(input.now.getTime()+Math.max(0,14-elapsed,10-input.automatic_days+(manual.ready?0:Math.max(0,4-elapsed)))*86400000),input.timezone),delayed:elapsed>=day};
}
/** Fan-out is participation, never extra outgoing messages or independent samples. */
export function groupDayFeasibility(profile:WarmupProfile,day:number,at:Date,participants:number,turnCounts:number[]) {
 const budget=dailyBudget(profile,day,at),phases=[budget.min_messages,budget.max_messages];
 // dailyBudget already applies the weekend factor.
 const minimum=Math.max(1,phases[0]!),maximum=phases[1]!;
 const valid=turnCounts.filter(n=>Number.isInteger(n)&&n>=participants&&n<=20);
 let total=0;const selected:number[]=[];
 for(const n of valid){if(total>=minimum)break;if(total+n<=maximum){selected.push(n);total+=n;}}
 const seconds=total*Math.max(60,Math.ceil(60/profile.rate_per_minute)+profile.jitter_seconds);
 const reason=participants<2?'OWN_PEER_REQUIRED':participants>maximum?'GROUP_TOO_LARGE_FOR_INITIAL_QUOTA':total<minimum?'CONTENT_COVERAGE_INSUFFICIENT':seconds>=(profile.end_hour-profile.start_hour)*3600?'SCHEDULE_COVERAGE_INSUFFICIENT':null;
 return {feasible:reason===null,reason,min_participations:minimum,max_participations:maximum,group_sends:total,sender_max:Math.ceil(total/participants),conversations:selected.length,selected_turn_counts:selected,seconds};
}
