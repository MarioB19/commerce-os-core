import {useEffect,useState} from 'react';
import {z} from 'zod';
import {profileRequest,type ProfileFence} from '../lib/profile-request.js';
import {sessionResults} from '../../../../packages/commerce-client/src/results.js';
import {profileToday} from '../lib/results.js';
import {variantRequest} from '../lib/variants.js';

/** RF-04.a: Inicio separates connection, aptitude to attend and sales done,
 * with operator-language causes and one next step. */
const homeSchema=z.object({timezone:z.string(),
 numbers:z.object({registered:z.number(),connected:z.number(),attending:z.number(),causes:z.object({DISCONNECTED:z.number(),PAUSED:z.number(),NOT_AUTHORIZED:z.number()})}),
 today:z.object({conversations:z.number(),orders:z.number(),approvedReceipts:z.number()}),
 pending:z.object({receiptsToReview:z.number(),alerts:z.number(),criticalAlerts:z.number()}),
 onboarding:z.object({complete:z.boolean(),dismissed:z.boolean(),next:z.string().nullable()}).nullable(),
 next:z.object({kind:z.string(),step:z.string().nullable().optional(),count:z.number().optional()}).nullable()});
type Home=z.infer<typeof homeSchema>;
const nextAction:Record<string,{text:(h:Home)=>string;href:string}>={
 REVIEW_RECEIPTS:{text:h=>`Revisar ${h.pending.receiptsToReview} comprobante${h.pending.receiptsToReview===1?'':'s'}`,href:'/sales/receipts'},
 RECONNECT_NUMBERS:{text:h=>`Reconectar ${h.numbers.causes.DISCONNECTED} número${h.numbers.causes.DISCONNECTED===1?'':'s'}`,href:'/numbers'},
 REVIEW_ALERTS:{text:h=>`Revisar ${h.pending.alerts} aviso${h.pending.alerts===1?'':'s'}`,href:'/numbers'},
};
export function ProfileHome({selection}:{selection:ProfileFence}){
 const [home,setHome]=useState<Home>(),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();setHome(undefined);setError('');
  profileRequest(selection,'GET','/v2/home',undefined,controller.signal).then(v=>setHome(homeSchema.parse(v))).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'No se pudo consultar el resumen.');});
  return()=>controller.abort();},[selection.workspaceId,selection.version]);
 if(error)return <p role="alert">{error}</p>;
 if(!home)return <p role="status">Consultando el resumen…</p>;
 const causes=[home.numbers.causes.DISCONNECTED&&`${home.numbers.causes.DISCONNECTED} desconectado${home.numbers.causes.DISCONNECTED===1?'':'s'}`,home.numbers.causes.PAUSED&&`${home.numbers.causes.PAUSED} en pausa`,home.numbers.causes.NOT_AUTHORIZED&&`${home.numbers.causes.NOT_AUTHORIZED} sin autorización para vender`].filter(Boolean);
 const action=home.next&&home.next.kind!=='ONBOARDING'?nextAction[home.next.kind]:undefined;
 return <div className="profile-home">
  {action&&<a className="button-primary" href={action.href}>{action.text(home)}</a>}
  {/* RF-04.b/RF-17.g: pending receipts stay one click away even while the setup guide leads. */}
  {home.pending.receiptsToReview>0&&action!==nextAction.REVIEW_RECEIPTS&&<p className="profile-home-pending"><a href="/sales/receipts">{nextAction.REVIEW_RECEIPTS!.text(home)}</a></p>}
  <HomeSales selection={selection} timezone={home.timezone}/>
  <dl className="profile-home-stats">
   <div><dt>Números conectados</dt><dd>{home.numbers.connected} de {home.numbers.registered}</dd></div>
   <div><dt>Atendiendo</dt><dd>{home.numbers.attending}</dd>{causes.length>0&&<dd className="cause">{causes.join(' · ')}</dd>}</div>
   <div><dt>Conversaciones hoy</dt><dd>{home.today.conversations}</dd></div>
   <div><dt>Pedidos hoy</dt><dd>{home.today.orders}</dd></div>
   <div><dt>Pagos aprobados hoy</dt><dd>{home.today.approvedReceipts}</dd></div>
   <div><dt>Comprobantes por revisar</dt><dd>{home.pending.receiptsToReview>0?<a href="/sales/receipts">{home.pending.receiptsToReview}</a>:0}</dd></div>
  </dl>
  {home.pending.criticalAlerts>0&&<p role="status">Hay {home.pending.criticalAlerts} aviso{home.pending.criticalAlerts===1?'':'s'} importante{home.pending.criticalAlerts===1?'':'s'} sobre tus números.</p>}
 </div>;
}

/** RF-04.c: today and this week against the active goal, from the same
 * persisted results as Resultados (never a separate count). */
interface Sales {currency:string;today:{revenue:string;sales:string};week:{revenue:string;sales:string};goal:{label:string;actual:string|null;target:string;ratio:number|null;met:boolean|null;to:string}|null}
const money=(minor:string,currency:string)=>{try{const d=new Intl.NumberFormat('es-MX',{style:'currency',currency}).resolvedOptions().maximumFractionDigits??2;return new Intl.NumberFormat('es-MX',{style:'currency',currency,maximumFractionDigits:d}).format(Number(minor)/10**d);}catch{return minor;}};
function HomeSales({selection,timezone}:{selection:ProfileFence;timezone:string}){
 const [data,setData]=useState<Sales|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{const c=new AbortController();(async()=>{try{
  const client=sessionResults(selection),today=profileToday(timezone),weekday=(new Date(today+'T12:00:00Z').getUTCDay()+6)%7,monday=new Date(Date.parse(today)-weekday*86400000).toISOString().slice(0,10);
  const variants=await variantRequest<{document:{locale:{currency:string}}}[]>(selection,'GET','/v2/variants',undefined,undefined,c.signal).catch(()=>[]);
  const counts=new Map<string,number>();for(const v of variants){const k=v.document?.locale?.currency;if(k)counts.set(k,(counts.get(k)??0)+1);}
  const currency=[...counts].sort((x,y)=>y[1]-x[1])[0]?.[0]??'MXN';
  const report=await client({operation:'report',filters:{from:monday,to:today,currency,granularity:'day'}},c.signal);if(report.operation!=='report')throw Error('REPORT');
  const day=report.data.series.find(x=>x.from===today)?.summary.totals,week=report.data.summary.totals;
  const goals=await client({operation:'goals',limit:50},c.signal);let goal:Sales['goal']=null;
  if(goals.operation==='goals'){const current=goals.data.find(g=>g.active&&g.fields.currency===currency&&g.fields.from<=today&&g.fields.to>=today&&!g.fields.family_id&&['REVENUE','SALES'].includes(g.fields.metric));
   if(current){const p=await client({operation:'progress',id:current.id},c.signal);if(p.operation==='progress'){const pr=p.data.progress;
    goal={label:current.fields.metric==='REVENUE'?'Meta de ingresos':'Meta de ventas',actual:pr.actual.value,target:pr.target,ratio:pr.progress.value===null?null:Number(pr.progress.value),met:pr.met,to:current.fields.to};}}}
  if(!c.signal.aborted)setData({currency,today:{revenue:day?.revenue_minor??'0',sales:day?.sales??'0'},week:{revenue:week.revenue_minor,sales:week.sales},goal});
 }catch{if(!c.signal.aborted)setFailed(true);}})();return()=>c.abort();},[selection.workspaceId,selection.version,timezone]);
 if(failed)return null;
 if(!data)return <p role="status" className="variant-hint">Consultando ventas…</p>;
 const g=data.goal,revenueGoal=g?.label==='Meta de ingresos',width=g?.ratio===null||g?.ratio===undefined?0:Math.max(0,Math.min(100,g.ratio*100));
 return <section className="home-sales" aria-label="Ventas">
  <div><span>Hoy</span><strong>{money(data.today.revenue,data.currency)}</strong><small>{data.today.sales} venta{data.today.sales==='1'?'':'s'}</small></div>
  <div><span>Esta semana</span><strong>{money(data.week.revenue,data.currency)}</strong><small>{data.week.sales} venta{data.week.sales==='1'?'':'s'}</small></div>
  {g?<div className="home-sales-goal"><span>{g.label} (hasta {g.to})</span><strong>{g.actual===null?'Sin datos':revenueGoal?money(g.actual,data.currency):g.actual} de {revenueGoal?money(g.target,data.currency):g.target}</strong>
   <span className="results-bar" aria-hidden="true"><span style={{width:`${width}%`}} className={g.met?'met':''}/></span><small>{g.met?'Meta cumplida':g.ratio===null?'Sin datos suficientes':`${Math.round(g.ratio*100)} % del objetivo`}</small></div>
   :<div className="home-sales-goal"><span>Meta</span><a href="/results">Define una meta en Resultados</a></div>}
  <a className="home-sales-link" href="/results">Ver resultados</a>
 </section>;
}
