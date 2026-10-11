import {z} from 'zod';

export const STANDARD_V1_POLICY='standard-15d/v1' as const;
export const STANDARD_V2_POLICY='standard-15d/v2' as const;
export const CURRENT_STANDARD_POLICY=STANDARD_V2_POLICY;
export const LEGACY_POLICY='legacy-30d/v1' as const;
export const INBOUND_LIGHT_POLICY='inbound-light/v1' as const;
export type WarmupPolicyVersion=typeof STANDARD_V1_POLICY|typeof STANDARD_V2_POLICY|typeof LEGACY_POLICY|typeof INBOUND_LIGHT_POLICY;
export function isStandard15dPolicy(version:unknown):version is typeof STANDARD_V1_POLICY|typeof STANDARD_V2_POLICY{return version===STANDARD_V1_POLICY||version===STANDARD_V2_POLICY;}

export const warmupProfileSchema=z.object({
 name:z.string().min(3).max(100),policy_version:z.enum([STANDARD_V1_POLICY,STANDARD_V2_POLICY,LEGACY_POLICY,INBOUND_LIGHT_POLICY]).default(CURRENT_STANDARD_POLICY),mode:z.enum(['standard','inbound-light']).default('standard'),
 timezone:z.string().refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'IANA_TIMEZONE_REQUIRED'),
 start_hour:z.number().int().min(0).max(22).default(9),end_hour:z.number().int().min(1).max(23).default(18),
 profile_wait_hours:z.number().int().min(12).max(24).default(24),
 weekend_factor:z.number().min(0).max(1).default(0.5),rate_per_minute:z.number().int().min(1).max(10).default(2),
 jitter_seconds:z.number().int().min(0).max(120).default(60),
 ack_maturity_minutes:z.number().int().min(5).max(1440).default(30),min_ack_samples:z.number().int().min(20).max(10000).default(20),
 inbound_light_days:z.number().int().min(7).max(10).default(10),
}).strict().refine(p=>p.end_hour>p.start_hour,'HOURS_MUST_NOT_OVERLAP');
export type WarmupProfile=z.infer<typeof warmupProfileSchema>;
export const legacyStages=[
 {first:1,last:3,conversations:[1,3],messages:[5,15]},
 {first:4,last:7,conversations:[3,6],messages:[20,40]},
 {first:8,last:14,conversations:[6,12],messages:[60,120]},
 {first:15,last:21,conversations:[12,20],messages:[150,300]},
 {first:22,last:30,conversations:[20,30],messages:[300,500]},
] as const;
export const standardStages=[
 {first:1,last:3,conversations:[1,3],messages:[5,15]},
 {first:4,last:6,conversations:[3,6],messages:[20,40]},
 {first:7,last:10,conversations:[6,12],messages:[60,120]},
] as const;
/**
 * v2 adds four conservative automatic days without pulling the previously
 * reviewed nominal-day volume curve forward. Days 5-14 therefore retain the
 * same intensity they had as nominal days 5-14 under v1.
 */
export const standardV2Stages=[
 {first:1,last:7,conversations:[1,3],messages:[5,15]},
 {first:8,last:10,conversations:[3,6],messages:[20,40]},
 {first:11,last:14,conversations:[6,12],messages:[60,120]},
] as const;
export function warmupPolicy(profile:Pick<WarmupProfile,'policy_version'|'mode'|'inbound_light_days'>){
 if(profile.mode==='inbound-light'||profile.policy_version===INBOUND_LIGHT_POLICY)return{version:profile.policy_version,automatic_days:profile.inbound_light_days,evaluation_day:null,manual_days:0,requires_manual:false,fixed_extensions:true,profile_wait:true} as const;
 if(profile.policy_version===STANDARD_V2_POLICY)return{version:profile.policy_version,automatic_days:14,evaluation_day:15,manual_days:0,requires_manual:false,fixed_extensions:false,profile_wait:false} as const;
 if(profile.policy_version===STANDARD_V1_POLICY)return{version:profile.policy_version,automatic_days:10,evaluation_day:15,manual_days:4,requires_manual:true,fixed_extensions:false,profile_wait:true} as const;
 return{version:profile.policy_version,automatic_days:30,evaluation_day:null,manual_days:0,requires_manual:false,fixed_extensions:true,profile_wait:true} as const;
}
export function warmupStage(profile:WarmupProfile,effectiveDay:number){
 const stages=profile.policy_version===LEGACY_POLICY?legacyStages:profile.policy_version===STANDARD_V2_POLICY?standardV2Stages:standardStages;
 return profile.mode==='inbound-light'?stages[0]:stages.find(s=>effectiveDay>=s.first&&effectiveDay<=s.last)??stages.at(-1)!;
}
export function localWindow(profile:WarmupProfile,now:Date){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:profile.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(now).map(p=>[p.type,p.value]));
 const hour=Number(parts.hour);return{date:`${parts.year}-${parts.month}-${parts.day}`,hour,weekend:['Sat','Sun'].includes(parts.weekday!),open:hour>=profile.start_hour&&hour<profile.end_hour};
}
export function dailyBudget(profile:WarmupProfile,effectiveDay:number,now:Date){
 const stages=profile.policy_version===LEGACY_POLICY?legacyStages:profile.policy_version===STANDARD_V2_POLICY?standardV2Stages:standardStages;
 const stage=warmupStage(profile,effectiveDay);
 const factor=localWindow(profile,now).weekend?profile.weekend_factor:1;
 return{day:effectiveDay,phase:profile.mode==='inbound-light'?1:stages.findIndex(s=>s.first===stage.first)+1,min_conversations:Math.floor(stage.conversations[0]*factor),max_conversations:Math.floor(stage.conversations[1]*factor),min_messages:Math.floor(stage.messages[0]*factor),max_messages:Math.floor(stage.messages[1]*factor)};
}
export function breakerDecision(accountIds:readonly string[],failures:readonly {account_id:string;observed_at:string}[],now:Date){
 const members=new Set(accountIds),distinct=new Set(failures.filter(f=>members.has(f.account_id)&&Date.parse(f.observed_at)<=now.getTime()&&Date.parse(f.observed_at)>now.getTime()-86400000).map(f=>f.account_id));
 const ratio=members.size?distinct.size/members.size:null;return{open:ratio!==null&&ratio>=0.2,distinct_failures:distinct.size,population:members.size,ratio};
}
export function graduationDecision(input:{profile:WarmupProfile;effective_days:number;extensions:number;stable_since:string|null;last_observed_at:string|null;mature_samples:number;delivered:number;confirmed_block:boolean;now:Date;manual_ready?:boolean;nominal_day?:number}){
 const policy=warmupPolicy(input.profile),required=policy.automatic_days;
 if(input.confirmed_block)return{status:'QUARANTINED',reason:'CONFIRMED_RESTRICTION'};
 if(policy.requires_manual&&input.manual_ready!==true)return{status:'WARMING',reason:'MANUAL_PREPARATION_REQUIRED'};
 if(policy.evaluation_day!==null&&(input.nominal_day??0)<policy.evaluation_day&&input.effective_days>=required)return{status:'WARMING',reason:'DAY_15_PENDING'};
 if(input.effective_days<required+(policy.fixed_extensions?input.extensions*7:0))return{status:'WARMING',reason:'EFFECTIVE_DAYS_PENDING'};
 const ratio=input.mature_samples>=input.profile.min_ack_samples?input.delivered/input.mature_samples:null;
 const stable=!!input.stable_since&&input.now.getTime()-Date.parse(input.stable_since)>=7*86400000&&!!input.last_observed_at&&input.now.getTime()-Date.parse(input.last_observed_at)>=0&&input.now.getTime()-Date.parse(input.last_observed_at)<3600000;
 if(stable&&ratio!==null&&ratio>=0.98)return{status:'GRADUATED',reason:'OBSERVED_HEALTH_AND_EFFECTIVE_DAYS',ratio};
 return{status:policy.fixed_extensions?(input.extensions<2?'EXTEND':'QUARANTINED'):'WARMING',reason:ratio===null?'ACK_SAMPLE_UNAVAILABLE':!stable?'STABILITY_NOT_DEMONSTRATED':'DELIVERY_BELOW_THRESHOLD',ratio};
}
/** Integer-safe concentration: small pools need an explicit exception; larger pools wait for a feasible allocation. */
export function pairAllowed(input:{pool_size:number;allow_small_pool_concentration:boolean;pair_conversations:number;total_conversations:number;planned_total:number}){
 if(input.pool_size<2)return false;
 if(input.pool_size<6)return input.allow_small_pool_concentration;
 const denominator=input.total_conversations+input.planned_total;
 // Before five conversations exist, 20% is mathematically impossible. Use an unused peer; expose concentration until the sample is sufficient.
 return denominator<5?input.pair_conversations===0:(input.pair_conversations+1)*5<=denominator;
}
export const warmupContentSchema=z.object({label:z.string().min(3).max(100),turns:z.array(z.object({kind:z.enum(['text','image','audio','document']).default('text'),text:z.string().min(1).max(2000).optional(),asset_id:z.string().uuid().optional()}).strict().refine(t=>t.kind==='text'?!!t.text:!!t.asset_id,'CONTENT_REQUIRED')).min(2).max(20),ownership_confirmed:z.literal(true)}).strict();
