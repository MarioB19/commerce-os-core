import {remarketingDurationSchema,remarketingPolicySchema} from '../../../contracts/src/sales-flow.js';
import type {RemarketingDuration,RemarketingPolicy,RemarketingSlot} from '../../../contracts/src/sales-flow.js';

export const DEFAULT_REMARKETING_SLOT_IDS=['remarketing_1','remarketing_2','remarketing_3'] as const;
export const DEFAULT_REMARKETING_DELAYS:readonly [RemarketingDuration,RemarketingDuration,RemarketingDuration]=[
 {quantity:2,unit:'hours'},
 {quantity:8,unit:'hours'},
 {quantity:24,unit:'hours'},
];

export type RemarketingStages=RemarketingSlot['stages'];
export type RemarketingStagesBySlot=readonly [RemarketingStages,RemarketingStages,RemarketingStages];
export type NormalizedRemarketingPolicy=Omit<RemarketingPolicy,'slots'>&{maximum:number;slots:(RemarketingSlot&{after_seconds:number})[]};

export function normalizeRemarketingDuration(duration:RemarketingDuration):number{
 const parsed=remarketingDurationSchema.parse(duration);
 const seconds=parsed.quantity*{minutes:60,hours:3600,days:86400}[parsed.unit];
 if(!Number.isSafeInteger(seconds)||seconds<=0)throw new Error('INVALID_REMARKETING_DURATION');
 return seconds;
}

export function enabledRemarketingMaximum(policy:RemarketingPolicy):number{
 return policy.slots.reduce((count,slot)=>count+(slot.enabled?1:0),0);
}

export function normalizeRemarketingPolicy(policy:unknown):NormalizedRemarketingPolicy{
 // Older read models may contain the derived fields emitted by this function.
 // Remove only those two known projections and keep strict validation for every
 // persisted source field so one legacy row cannot poison the global worker.
 let candidate=policy;
 if(policy&&typeof policy==='object'&&!Array.isArray(policy)){
  const{maximum:_legacyMaximum,slots:rawSlots,...raw}=policy as Record<string,unknown>;
  const slots=Array.isArray(rawSlots)?rawSlots.map(item=>{
   if(!item||typeof item!=='object'||Array.isArray(item))return item;
   const{after_seconds:_legacyAfterSeconds,...slot}=item as Record<string,unknown>;
   return slot;
  }):rawSlots;
  candidate={...raw,slots};
 }
 const parsed=remarketingPolicySchema.parse(candidate);
 return{...parsed,maximum:enabledRemarketingMaximum(parsed),slots:parsed.slots.map(slot=>({...slot,after_seconds:normalizeRemarketingDuration(slot.delay)}))};
}

export function createDefaultRemarketingPolicy(stages:RemarketingStagesBySlot):RemarketingPolicy{
 return remarketingPolicySchema.parse({
  schema_version:1,
  policy_id:'remarketing-3-slot',
  policy_revision:1,
  slots:[
   {id:DEFAULT_REMARKETING_SLOT_IDS[0],position:1,enabled:true,delay:DEFAULT_REMARKETING_DELAYS[0],stages:structuredClone(stages[0])},
   {id:DEFAULT_REMARKETING_SLOT_IDS[1],position:2,enabled:false,delay:DEFAULT_REMARKETING_DELAYS[1],stages:structuredClone(stages[1])},
   {id:DEFAULT_REMARKETING_SLOT_IDS[2],position:3,enabled:false,delay:DEFAULT_REMARKETING_DELAYS[2],stages:structuredClone(stages[2])},
  ],
 });
}

/** Updates all windows atomically so intermediate invalid orderings are never published. */
export function replaceRemarketingDurations(policy:RemarketingPolicy,durations:readonly [RemarketingDuration,RemarketingDuration,RemarketingDuration]):RemarketingPolicy{
 const parsed=remarketingPolicySchema.parse(policy);
 return remarketingPolicySchema.parse({...parsed,slots:parsed.slots.map((slot,index)=>({...slot,delay:structuredClone(durations[index]!)}))});
}

export function setRemarketingSlotEnabled(policy:RemarketingPolicy,slotId:string,enabled:boolean,warningAcknowledged=false):RemarketingPolicy{
 const parsed=remarketingPolicySchema.parse(policy);
 if(!parsed.slots.some(slot=>slot.id===slotId))throw new Error('REMARKETING_SLOT_NOT_FOUND');
 return remarketingPolicySchema.parse({...parsed,slots:parsed.slots.map(slot=>slot.id===slotId?{...slot,enabled,...(enabled&&slot.position>1?{warning_acknowledged:warningAcknowledged}:{})}:slot)});
}
