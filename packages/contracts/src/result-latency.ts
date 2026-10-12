import {z} from 'zod';
const unsigned=z.string().regex(/^(0|[1-9]\d{0,29})$/),positive=z.string().regex(/^[1-9]\d{0,29}$/);
export const latencyHistogramSchema=z.record(unsigned,positive);
export const resultLatenciesSchema=z.object({response:latencyHistogramSchema,sale:latencyHistogramSchema}).strict();
export type ResultLatencies=z.infer<typeof resultLatenciesSchema>;
/** Missing distributions remain missing; they are never inferred from means. */
export function latencyMoments(values:Record<string,string>){let samples=0n,sum=0n;for(const[ms,n]of Object.entries(values)){samples+=BigInt(n);sum+=BigInt(ms)*BigInt(n);}return{samples,sum};}
export function latencyCoverageValid(input:ResultLatencies|undefined,counters:{response_samples:string;response_ms_sum:string;sale_samples:string;sale_ms_sum:string}){
 for(const kind of ['response','sale']as const){const a=latencyMoments(input?.[kind]??{}),n=BigInt(counters[`${kind}_samples`]),sum=BigInt(counters[`${kind}_ms_sum`]);if(a.samples>n||a.sum>sum||a.samples===n&&a.sum!==sum)return false;}return true;
}
