import {resultCounterNames,resultContributionSchema,resultProjectionSchema,type ResultContribution,type ResultCounter,type ResultGrain} from '../../../contracts/src/result-projection.js';
import {mergeResultLatencies,optionalResultLatencies,resultLatencyDelta} from './result-latency.js';
const max=10n**30n-1n;
export function emptyResultCounters():Record<ResultCounter,string>{return Object.fromEntries(resultCounterNames.map(k=>[k,'0'])) as Record<ResultCounter,string>;}
/** Grain JSON uses an exact schema/order and never a customer/source identifier. */
export function resultGrainKey(input:ResultGrain){return JSON.stringify(resultContributionSchema.shape.grain.parse(input));}
export function mergeResultContributions(input:readonly ResultContribution[]){
 const rows=new Map<string,ResultContribution>();
 for(const raw of input){const item=resultContributionSchema.parse(raw),key=resultGrainKey(item.grain),prior=rows.get(key)??{grain:item.grain,counters:emptyResultCounters()};
  const counters=Object.fromEntries(resultCounterNames.map(k=>{const n=BigInt(prior.counters[k])+BigInt(item.counters[k]);if(n>max)throw Error('RESULT_COUNTER_OVERFLOW');return[k,n.toString()];}))as Record<ResultCounter,string>;rows.set(key,{grain:item.grain,counters,...optionalResultLatencies(mergeResultLatencies([prior.latencies,item.latencies]))});
 }
 return [...rows.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,v])=>v);
}
export function resultProjectionDeltas(before:readonly ResultContribution[],after:readonly ResultContribution[]){
 const old=new Map(mergeResultContributions(before).map(v=>[resultGrainKey(v.grain),v])),next=new Map(mergeResultContributions(after).map(v=>[resultGrainKey(v.grain),v]));
 return [...new Set([...old.keys(),...next.keys()])].sort().map(key=>{const a=old.get(key),b=next.get(key);return{grain:(b??a)!.grain,latency_delta:resultLatencyDelta(a?.latencies,b?.latencies),delta:Object.fromEntries(resultCounterNames.map(k=>[k,(BigInt(b?.counters[k]??'0')-BigInt(a?.counters[k]??'0')).toString()]))as Record<ResultCounter,string>};}).filter(v=>resultCounterNames.some(k=>v.delta[k]!=='0')||Object.values(v.latency_delta).some(h=>Object.keys(h).length));
}
export function applyResultCounterDelta(current:Record<ResultCounter,string>,delta:Record<ResultCounter,string>){
 return Object.fromEntries(resultCounterNames.map(k=>{if(!/^(0|[1-9]\d{0,29})$/.test(current[k])||!/^(-?[1-9]\d{0,29}|0)$/.test(delta[k]))throw Error('RESULT_COUNTER_INVALID');const n=BigInt(current[k])+BigInt(delta[k]);if(n<0n||n>max)throw Error('RESULT_COUNTER_BOUND');return[k,n.toString()];}))as Record<ResultCounter,string>;
}
export function canonicalResultProjection(input:unknown){const q=resultProjectionSchema.parse(input);return{...q,source_id:q.source_id.toLowerCase(),facts:mergeResultContributions(q.facts)};}
export function projectionRevisionDecision(prior:{revision:string;fingerprint:string}|null,next:{revision:string;fingerprint:string}){
 if(!prior)return'APPLY' as const;if(BigInt(next.revision)<BigInt(prior.revision))throw Error('RESULT_SOURCE_STALE');
 if(BigInt(next.revision)===BigInt(prior.revision)){if(next.fingerprint!==prior.fingerprint)throw Error('RESULT_SOURCE_CONFLICT');return'NO_EFFECT' as const;}return'APPLY' as const;
}
