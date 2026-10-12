import {z} from 'zod';
import {resultContributionSchema} from '../../../contracts/src/result-projection.js';
import {optionalResultLatencies,emptyResultLatencies} from './result-latency.js';
/** The closed SQL source reader emits at most one response/sale observation per
 * source contribution. A count >1 must never be reconstructed from its mean. */
export function singleSourceLatencies(raw:unknown){
 return z.array(resultContributionSchema).max(1000).parse(raw).map(f=>{
  const latencies=emptyResultLatencies();for(const kind of ['response','sale']as const){const n=BigInt(f.counters[`${kind}_samples`]);if(n>1n)throw Error('RESULT_SOURCE_LATENCY_NOT_SINGLE');if(n===1n)latencies[kind][f.counters[`${kind}_ms_sum`]]='1';}
  return{grain:f.grain,counters:f.counters,...optionalResultLatencies(latencies)};
 });
}
