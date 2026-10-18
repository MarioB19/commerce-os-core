import {z} from 'zod';
import {profileRequest,type ProfileFence} from './profile-request.js';
import {sessionResults} from '../../../../packages/commerce-client/src/results.js';
import {profileToday} from './results.js';
import {variantRequest} from './variants.js';

/** Inicio and the shell read the same operational summary (RF-04.a) and the
 * same persisted results as Resultados (RF-04.c). One in-flight read per
 * profile is shared for a few seconds so the sidebar and the page never
 * double-count or double-request. */
export const homeSchema=z.object({timezone:z.string(),
 numbers:z.object({registered:z.number(),connected:z.number(),attending:z.number(),causes:z.object({DISCONNECTED:z.number(),PAUSED:z.number(),NOT_AUTHORIZED:z.number()})}),
 today:z.object({conversations:z.number(),orders:z.number(),approvedReceipts:z.number()}),
 pending:z.object({receiptsToReview:z.number(),alerts:z.number(),criticalAlerts:z.number()}),
 onboarding:z.object({complete:z.boolean(),dismissed:z.boolean(),next:z.string().nullable()}).nullable(),
 next:z.object({kind:z.string(),step:z.string().nullable().optional(),count:z.number().optional()}).nullable()});
export type Home=z.infer<typeof homeSchema>;
export interface Sales {currency:string;today:{revenue:string;sales:string};week:{revenue:string;sales:string};goal:{label:string;actual:string|null;target:string;ratio:number|null;met:boolean|null;to:string;from:string}|null}

const TTL=8000;
const cache=new Map<string,{at:number;promise:Promise<unknown>}>();
function shared<T>(key:string,load:()=>Promise<T>):Promise<T>{
 const now=Date.now(),hit=cache.get(key);
 if(hit&&now-hit.at<TTL)return hit.promise as Promise<T>;
 const promise=load().catch(e=>{cache.delete(key);throw e;});
 cache.set(key,{at:now,promise});return promise;
}
export function invalidateHome(){cache.clear();}
export const loadHome=(fence:ProfileFence,signal?:AbortSignal)=>shared(`home:${fence.workspaceId}:${fence.version}`,()=>profileRequest(fence,'GET','/v2/home',undefined,signal).then(v=>homeSchema.parse(v)));

export function moneyMinor(minor:string|number,currency:string){try{const d=new Intl.NumberFormat('es-MX',{style:'currency',currency}).resolvedOptions().maximumFractionDigits??2;return new Intl.NumberFormat('es-MX',{style:'currency',currency,maximumFractionDigits:d}).format(Number(minor)/10**d);}catch{return String(minor);}}

export const loadSales=(fence:ProfileFence,timezone:string,signal?:AbortSignal)=>shared(`sales:${fence.workspaceId}:${fence.version}`,async():Promise<Sales>=>{
 const client=sessionResults(fence),today=profileToday(timezone),weekday=(new Date(today+'T12:00:00Z').getUTCDay()+6)%7,monday=new Date(Date.parse(today)-weekday*86400000).toISOString().slice(0,10);
 const variants=await variantRequest<{document:{locale:{currency:string}}}[]>(fence,'GET','/v2/variants',undefined,undefined,signal).catch(()=>[]);
 const counts=new Map<string,number>();for(const v of variants){const k=v.document?.locale?.currency;if(k)counts.set(k,(counts.get(k)??0)+1);}
 const currency=[...counts].sort((x,y)=>y[1]-x[1])[0]?.[0]??'MXN';
 const report=await client({operation:'report',filters:{from:monday,to:today,currency,granularity:'day'}},signal);if(report.operation!=='report')throw Error('REPORT');
 const day=report.data.series.find(x=>x.from===today)?.summary.totals,week=report.data.summary.totals;
 const goals=await client({operation:'goals',limit:50},signal);let goal:Sales['goal']=null;
 if(goals.operation==='goals'){const current=goals.data.find(g=>g.active&&g.fields.currency===currency&&g.fields.from<=today&&g.fields.to>=today&&!g.fields.family_id&&['REVENUE','SALES'].includes(g.fields.metric));
  if(current){const p=await client({operation:'progress',id:current.id},signal);if(p.operation==='progress'){const pr=p.data.progress;
   goal={label:current.fields.metric==='REVENUE'?'Meta de ingresos':'Meta de ventas',actual:pr.actual.value,target:pr.target,ratio:pr.progress.value===null?null:Number(pr.progress.value),met:pr.met,to:current.fields.to,from:current.fields.from};}}}
 return {currency,today:{revenue:day?.revenue_minor??'0',sales:day?.sales??'0'},week:{revenue:week.revenue_minor,sales:week.sales},goal};
});
