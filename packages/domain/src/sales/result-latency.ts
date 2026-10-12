import {resultLatenciesSchema,latencyMoments,type ResultLatencies} from '../../../contracts/src/result-latency.js';
const limit=10n**30n-1n;
export const emptyResultLatencies=():ResultLatencies=>({response:{},sale:{}});
/** Stable numeric key order is part of the canonical fingerprint. */
function canonical(v:Record<string,bigint>){return Object.fromEntries(Object.entries(v).filter(([,n])=>n!==0n).sort(([a],[b])=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0).map(([k,n])=>[k,n.toString()]));}
export function mergeResultLatencies(inputs:readonly(ResultLatencies|undefined)[]){
 const result=emptyResultLatencies();for(const kind of ['response','sale']as const){const merged:Record<string,bigint>={};for(const input of inputs){const parsed=resultLatenciesSchema.parse(input??emptyResultLatencies());for(const[k,n]of Object.entries(parsed[kind])){merged[k]=(merged[k]??0n)+BigInt(n);if(merged[k]!>limit)throw Error('RESULT_LATENCY_OVERFLOW');}}result[kind]=canonical(merged);}return result;
}
export function optionalResultLatencies(input:ResultLatencies){return Object.keys(input.response).length||Object.keys(input.sale).length?{latencies:input}:{};}
export function resultLatencyDelta(before:ResultLatencies|undefined,after:ResultLatencies|undefined){
 const a=resultLatenciesSchema.parse(before??emptyResultLatencies()),b=resultLatenciesSchema.parse(after??emptyResultLatencies()),result=emptyResultLatencies();
 for(const kind of ['response','sale']as const)result[kind]=canonical(Object.fromEntries([...new Set([...Object.keys(a[kind]),...Object.keys(b[kind])])].map(k=>[k,BigInt(b[kind][k]??'0')-BigInt(a[kind][k]??'0')])));return result;
}
export function applyResultLatencyDelta(current:ResultLatencies|undefined,delta:ResultLatencies){
 const a=resultLatenciesSchema.parse(current??emptyResultLatencies()),result=emptyResultLatencies();for(const kind of ['response','sale']as const){const next:Record<string,bigint>={};for(const k of new Set([...Object.keys(a[kind]),...Object.keys(delta[kind])])){const raw=delta[kind][k]??'0';if(!/^(0|-?[1-9]\d{0,29})$/.test(raw)||!/^(0|[1-9]\d{0,29})$/.test(k))throw Error('RESULT_LATENCY_DELTA_INVALID');const n=BigInt(a[kind][k]??'0')+BigInt(raw);if(n<0n||n>limit)throw Error('RESULT_LATENCY_BOUND');next[k]=n;}result[kind]=canonical(next);}return result;
}
export function resultLatencyPercentile(histogram:Record<string,string>,samples:string,p:50|95){
 const h=resultLatenciesSchema.parse({response:histogram,sale:{}}).response,n=BigInt(samples);if(n===0n)return{value:null,reason:'NO_DENOMINATOR'};
 if(latencyMoments(h).samples!==n)return{value:null,reason:'LATENCY_COVERAGE_INCOMPLETE'};
 const rank=(n*BigInt(p)+99n)/100n;let seen=0n;for(const[ms,count]of Object.entries(h).sort(([a],[b])=>BigInt(a)<BigInt(b)?-1:1)){seen+=BigInt(count);if(seen>=rank)return{value:ms,reason:null};}throw Error('RESULT_LATENCY_RANK_INVALID');
}
