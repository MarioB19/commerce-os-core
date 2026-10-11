import type {Body} from '@commerce/contracts';
import {CAPACITY_READBACK_TTL_MS} from '../../../packages/contracts/src/numbers.js';
export {CAPACITY_READBACK_TTL_MS};

export function capacityReadbackIsFresh(readback:Body|undefined,now=new Date()){
 const observedAt=readback?.observed_at?Date.parse(String(readback.observed_at)):NaN;
 const expiresAt=readback?.expires_at?Date.parse(String(readback.expires_at)):observedAt+CAPACITY_READBACK_TTL_MS;
 return readback?.verified===true&&Number.isFinite(observedAt)&&Number.isFinite(expiresAt)&&observedAt<=now.getTime()+1000&&expiresAt>=observedAt&&expiresAt>now.getTime()&&now.getTime()-observedAt<=CAPACITY_READBACK_TTL_MS;
}

export function gatewaySlot(value:unknown):number|null{
 const text=String(value??'').trim().toLowerCase();
 const match=/^(?:waha-|https?:\/\/waha-)(0[1-9]|1[0-9]|20)(?::3000)?\/?$/.exec(text);
 return match?Number(match[1]):null;
}

export function projectGatewayMapping(row:Body):Body{
 const account_slot=gatewaySlot(row.account_gateway_ref),session_slot=gatewaySlot(row.session_gateway_ref??row.gateway),canonical_slot=row.canonical_slot===null||row.canonical_slot===undefined?null:Number(row.canonical_slot);
 const physical_slots=[...new Set([account_slot,session_slot].filter((slot):slot is number=>slot!==null))].sort((a,b)=>a-b);
 const gateway_slot_mismatch=physical_slots.length>1||(canonical_slot!==null&&physical_slots.some(slot=>slot!==canonical_slot));
 return{...row,account_slot,session_slot,canonical_slot,physical_slots,physical_slot:physical_slots.length===1?physical_slots[0]:null,gateway_slot_mismatch};
}
