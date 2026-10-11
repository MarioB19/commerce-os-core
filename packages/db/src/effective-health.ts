import type {Environment} from '../../contracts/src/index.js';
import type {QueryExecutor} from './index.js';

export const effectiveHealthDimensions=['infrastructure','session','transport','restriction','quality','ownership'] as const;
export type EffectiveHealthDimension=typeof effectiveHealthDimensions[number];
export type EffectiveHealthStatus='OK'|'BLOCKED'|'UNKNOWN'|'WARNING'|'PAUSED';

type InvalidReason='ACCOUNT_SCOPE_INVALID'|'DIMENSION_INVALID'|'STATUS_INVALID'|'OBSERVED_AT_INVALID'|'OBSERVED_AT_FUTURE'|'EXPIRES_AT_INVALID'|'EXPIRY_WINDOW_INVALID';

export type EffectiveHealthSignal={
 id:string;
 account_id:string;
 dimension:EffectiveHealthDimension;
 scope:string;
 status:EffectiveHealthStatus;
 source:string;
 value?:unknown;
 availability?:string;
 observed_at:string;
 expires_at:string;
 created_at:string;
 current:boolean;
 explicit_restriction_clear:boolean;
};

export type InvalidHealthSignal={id:string|null;account_id:string|null;reason:InvalidReason};
export type EffectiveHealthSelection={
 account_id:string;
 signals:EffectiveHealthSignal[];
 by_dimension:Partial<Record<EffectiveHealthDimension,EffectiveHealthSignal>>;
 latest_by_dimension:Partial<Record<EffectiveHealthDimension,EffectiveHealthSignal>>;
 invalid:InvalidHealthSignal[];
 computed_at:string;
};

const dimensionSet=new Set<string>(effectiveHealthDimensions),statusSet=new Set<string>(['OK','BLOCKED','UNKNOWN','WARNING','PAUSED']);
const object=(value:unknown):Record<string,unknown>|undefined=>typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const text=(value:unknown)=>typeof value==='string'&&value.length>0?value:undefined;
const time=(value:unknown)=>{const parsed=typeof value==='string'||value instanceof Date?Date.parse(value instanceof Date?value.toISOString():value):NaN;return Number.isFinite(parsed)?parsed:undefined;};
const signalKey=(signal:EffectiveHealthSignal)=>`${signal.dimension}:${signal.scope}`;
const compareSignals=(a:EffectiveHealthSignal,b:EffectiveHealthSignal)=>Date.parse(b.observed_at)-Date.parse(a.observed_at)||Date.parse(b.created_at)-Date.parse(a.created_at)||b.id.localeCompare(a.id);

function explicitRestrictionClear(status:EffectiveHealthStatus,source:string,value:unknown){
 if(status!=='OK'||source!=='provider_read')return false;
 const latest=object(object(value)?.latest_read);
 return latest?.timelock===true&&latest.capping===true;
}

/** Parse persisted or in-memory evidence without trusting JSON timestamps. */
export function parseEffectiveHealthSignal(candidate:unknown,input:{now:Date;accountId?:string;maxFutureSkewMs?:number}):{signal?:EffectiveHealthSignal;invalid?:InvalidHealthSignal}{
 const row=object(candidate)??{},body=object(row.body)??row,rawId=text(row.id)??text(body.id)??'',rawAccount=text(body.account_id)??input.accountId??'',dimension=text(body.dimension),status=text(body.status),scope=text(body.scope)??'account';
 const invalid=(reason:InvalidReason):{invalid:InvalidHealthSignal}=>({invalid:{id:rawId||null,account_id:rawAccount||null,reason}});
 if(!rawAccount||input.accountId&&rawAccount!==input.accountId)return invalid('ACCOUNT_SCOPE_INVALID');
 if(!dimension||!dimensionSet.has(dimension))return invalid('DIMENSION_INVALID');
 if(!status||!statusSet.has(status))return invalid('STATUS_INVALID');
 const observed=time(body.observed_at);if(observed===undefined)return invalid('OBSERVED_AT_INVALID');
 if(observed>input.now.getTime()+(input.maxFutureSkewMs??0))return invalid('OBSERVED_AT_FUTURE');
 const expires=time(body.expires_at);if(expires===undefined)return invalid('EXPIRES_AT_INVALID');
 if(expires<=observed)return invalid('EXPIRY_WINDOW_INVALID');
 const created=time(row.created_at??body.created_at)??observed,source=text(body.source)??'unknown';
 const normalizedStatus=status as EffectiveHealthStatus;
 return{signal:{id:rawId,account_id:rawAccount,dimension:dimension as EffectiveHealthDimension,scope,status:normalizedStatus,source,value:body.value,availability:text(body.availability),observed_at:new Date(observed).toISOString(),expires_at:new Date(expires).toISOString(),created_at:new Date(created).toISOString(),current:expires>input.now.getTime(),explicit_restriction_clear:explicitRestrictionClear(normalizedStatus,source,body.value)}};
}

/**
 * Pure effective-state selector. Every dimension/scope is governed by its
 * deterministic latest observation. Expired evidence remains available for
 * history but never governs current state. A restriction OK is trusted only
 * when it came from a complete provider read; incomplete clears stay UNKNOWN.
 */
export function selectEffectiveHealth(candidates:unknown[],input:{now?:Date;accountId?:string;maxFutureSkewMs?:number}={}):EffectiveHealthSelection{
 const now=input.now??new Date(),parsed:EffectiveHealthSignal[]=[],invalid:InvalidHealthSignal[]=[];
 for(const candidate of candidates){const result=parseEffectiveHealthSignal(candidate,{now,accountId:input.accountId,maxFutureSkewMs:input.maxFutureSkewMs});if(result.signal)parsed.push(result.signal);else if(result.invalid)invalid.push(result.invalid);}
 const grouped=new Map<string,EffectiveHealthSignal[]>();for(const signal of parsed){const key=signalKey(signal),rows=grouped.get(key)??[];rows.push(signal);grouped.set(key,rows);}
 const signals:EffectiveHealthSignal[]=[],by_dimension:EffectiveHealthSelection['by_dimension']={},latest_by_dimension:EffectiveHealthSelection['latest_by_dimension']={};
 for(const rows of grouped.values()){
  rows.sort(compareSignals);const latest=rows[0]!;if(latest.scope==='account')latest_by_dimension[latest.dimension]=latest;
  const effective=latest.dimension==='restriction'&&latest.status==='OK'&&!latest.explicit_restriction_clear?{...latest,status:'UNKNOWN' as const,explicit_restriction_clear:false}:latest;
  signals.push(effective);if(effective.scope==='account')by_dimension[effective.dimension]=effective;
 }
 signals.sort((a,b)=>effectiveHealthDimensions.indexOf(a.dimension)-effectiveHealthDimensions.indexOf(b.dimension)||a.scope.localeCompare(b.scope));
 return{account_id:input.accountId??parsed[0]?.account_id??'',signals,by_dimension,latest_by_dimension,invalid,computed_at:now.toISOString()};
}

export function currentEffectiveSignal(selection:EffectiveHealthSelection,dimension:EffectiveHealthDimension){const signal=selection.by_dimension[dimension];return signal?.current?signal:undefined;}

/** WAHA mutations require a fresh, complete provider read that explicitly cleared restrictions. */
export function currentRestrictionClear(selection:EffectiveHealthSelection){const signal=currentEffectiveSignal(selection,'restriction');return signal?.status==='OK'&&signal.explicit_restriction_clear;}

export function effectiveHealthBlockers(selection:EffectiveHealthSelection,dimensions:EffectiveHealthDimension[]=['session','transport','restriction','quality']){
 return dimensions.flatMap(dimension=>{const signal=selection.by_dimension[dimension];if(!signal?.current)return[];if(signal.status==='BLOCKED'||signal.status==='UNKNOWN'&&dimension!=='quality')return[`${dimension.toUpperCase()}_${signal.status}`];return[];});
}

/** Provider-specific current evidence required before an external action or a ready projection. */
export function currentProviderHealthReady(selection:EffectiveHealthSelection,provider:string){
 const required=currentEffectiveSignal(selection,provider==='cloud'?'transport':'session');
 if(required?.status!=='OK')return false;
 if(provider==='waha'&&!currentRestrictionClear(selection))return false;
 if(provider==='cloud'){
  const quality=currentEffectiveSignal(selection,'quality');
  if(!quality||quality.availability==='not_available'||!['OK','WARNING'].includes(quality.status))return false;
 }
 return effectiveHealthBlockers(selection).length===0;
}

export async function readEffectiveHealthBatch(c:QueryExecutor,input:{workspaceId:string;environment:Environment;accountIds:string[];now?:Date}){
 const ids=[...new Set(input.accountIds)];const now=input.now??new Date(),result=new Map<string,EffectiveHealthSelection>();
 if(!ids.length)return result;
 // The trigger-maintained projection parses timestamps once without changing
 // source evidence. Seek one valid latest instant per dimension; join only the
 // chosen records, so a growing probe history does not force JSON sorting.
 const rows=(await c.query(`WITH targets(account_id) AS (SELECT unnest($3::text[])),
  dimensions(dimension) AS (SELECT unnest($4::text[]))
  SELECT selected.id,selected.created_at,selected.body
  FROM targets CROSS JOIN dimensions
  CROSS JOIN LATERAL (
   SELECT r.id,r.created_at,r.body
   FROM health_observation_index h JOIN records r ON r.id=h.record_id
   WHERE h.workspace_id=$1 AND h.environment=$2
    AND h.account_id=targets.account_id AND h.dimension=dimensions.dimension
    AND h.scope='account' AND h.status IN('OK','BLOCKED','UNKNOWN','WARNING','PAUSED')
    AND h.observed_at<=$5::timestamptz AND h.expires_at>h.observed_at AND isfinite(h.observed_at) AND isfinite(h.expires_at)
   ORDER BY h.observed_at DESC,h.created_at DESC,h.record_id DESC
   LIMIT 1
  ) selected`,[input.workspaceId,input.environment,ids,effectiveHealthDimensions,now.toISOString()])).rows;
 const byAccount=new Map<string,unknown[]>();for(const row of rows){const account=text(object(row.body)?.account_id);if(!account||!ids.includes(account))continue;const list=byAccount.get(account)??[];list.push(row);byAccount.set(account,list);}
 for(const accountId of ids)result.set(accountId,selectEffectiveHealth(byAccount.get(accountId)??[],{now,accountId}));return result;
}

export async function readEffectiveHealth(c:QueryExecutor,input:{workspaceId:string;environment:Environment;accountId:string;now?:Date}){
 return(await readEffectiveHealthBatch(c,{workspaceId:input.workspaceId,environment:input.environment,accountIds:[input.accountId],now:input.now})).get(input.accountId)!;
}
