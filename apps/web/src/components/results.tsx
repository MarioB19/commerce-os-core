import {useEffect,useId,useMemo,useRef,useState} from 'react';
import type {z} from 'zod';
import {goalViewSchema,resultsReportSchema,type ResultsCommandResult} from '../../../../packages/contracts/src/results-client.js';
import {goalFieldsSchema,resultFiltersSchema,type GoalFields,type ResultFilters} from '../../../../packages/contracts/src/results.js';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import {sessionResults,type ResultsClient} from '../../../../packages/commerce-client/src/results.js';
import {resultsView,profileToday,moneyText,moneyTarget,type ResultsState} from '../lib/results.js';
import {variantRequest} from '../lib/variants.js';
import {profileRequest} from '../lib/profile-request.js';
import {Button} from './ui/button';

/** V7 F7 Resultados (RF-12, RF-04.c, RF-05.d, RF-10.e, RF-14.d, RF-17.c): the
 * same persisted projections as API and MCP, told in operator language. The
 * main view answers «¿cuánto vendí y cuánto me costó?»; filters and the
 * technical detail stay folded. Nothing is estimated: a missing denominator or
 * incomplete spend says why instead of showing zero. */
type Goal=z.infer<typeof goalViewSchema>;type Report=z.infer<typeof resultsReportSchema>;
type Metric={value:string|null;reason:string|null};
export interface ResultsProps{selection:{workspaceId:string;version:number};timezone:string;role:ProfileRole;profileState:ProfileState;}
const captions={family_id:'Producto',variant_id:'Variante',market:'Mercado',account_id:'Número',campaign_id:'Campaña',ad_id:'Anuncio'}as const;
const kinds={family_id:'family',variant_id:'variant',market:'market',account_id:'account',campaign_id:'campaign',ad_id:'ad'}as const;
const stages={started:'Conversaciones iniciadas',responded:'Recibieron respuesta',offered:'Vieron la oferta',collection_sent:'Recibieron datos de pago',receipt_received:'Enviaron comprobante',payment_approved:'Pagaron'};
const metricNames={REVENUE:'Ingresos',SALES:'Ventas',MAX_COST_PER_SALE:'Costo máximo por venta',ROAS:'ROAS mínimo'};
const reasons:Record<string,string>={NO_DENOMINATOR:'Sin datos todavía',LATENCY_COVERAGE_INCOMPLETE:'Tiempos incompletos',SPEND_COVERAGE_INCOMPLETE:'Falta el gasto de algunos días',SPEND_TIMEZONE_MIXED:'Las cuentas de anuncios usan otra zona horaria',SPEND_DIMENSION_NOT_ATTRIBUTABLE:'El gasto no se puede separar con este filtro',SPEND_PRODUCT_MAPPING_INCOMPLETE:'Falta vincular anuncios con productos',SPEND_RECONCILIATION_DIFFERENCE:'El gasto de Meta no cuadra',AI_COST_INCOMPLETE:'Costo de IA incompleto',AI_TOKENS_INCOMPLETE:'Consumo de IA incompleto',NO_SPEND_COVERAGE:'Sin gasto de anuncios conectado',GOAL_NOT_STARTED:'El periodo aún no empieza'};
const empty:ResultsState={status:'IDLE',result:null,pending:null,mayResend:false,message:''};
type Preset='today'|'7'|'30'|'month'|'custom';
const presets:[Preset,string][]=[['today','Hoy'],['7','7 días'],['30','30 días'],['month','Este mes'],['custom','Otro periodo']];
const shift=(day:string,days:number)=>new Date(Date.parse(day)+days*86400000).toISOString().slice(0,10);
function range(preset:Preset,today:string){if(preset==='today')return{from:today,to:today};if(preset==='7')return{from:shift(today,-6),to:today};if(preset==='month')return{from:today.slice(0,8)+'01',to:today};return{from:shift(today,-29),to:today};}
const num=(v:string|null|undefined)=>v===null||v===undefined?null:Number(v);
function money(minor:string|null|undefined,currency:string){if(minor===null||minor===undefined)return null;try{const d=new Intl.NumberFormat('es-MX',{style:'currency',currency}).resolvedOptions().maximumFractionDigits??2;return new Intl.NumberFormat('es-MX',{style:'currency',currency,maximumFractionDigits:d}).format(Number(minor)/10**d);}catch{return minor;}}
const usd=(micro:string|null|undefined)=>micro===null||micro===undefined?null:new Intl.NumberFormat('es-MX',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:Number(micro)<10000?4:2}).format(Number(micro)/1_000_000);
const pct=(ratio:string|null|undefined)=>ratio===null||ratio===undefined?null:new Intl.NumberFormat('es-MX',{style:'percent',maximumFractionDigits:1}).format(Number(ratio));
function duration(ms:string|null|undefined){if(ms===null||ms===undefined)return null;const s=Number(ms)/1000;if(s<60)return `${Math.round(s)} s`;if(s<3600)return `${Math.round(s/60)} min`;if(s<172800)return `${(s/3600).toFixed(1)} h`;return `${(s/86400).toFixed(1)} días`;}
const shown=(m:Metric,format:(v:string)=>string|null)=>m.value===null?reasons[m.reason??'']??'Sin datos comparables':format(m.value)??'—';
function delta(now:number|null,before:number|null,lowerIsBetter=false){
 if(now===null||before===null||!Number.isFinite(now)||!Number.isFinite(before))return null;
 if(before===0)return now===0?{text:'igual',tone:'flat'}:{text:'nuevo',tone:lowerIsBetter?'bad':'good'};
 const change=(now-before)/Math.abs(before);if(Math.abs(change)<0.005)return{text:'igual',tone:'flat'};
 const good=lowerIsBetter?change<0:change>0;return{text:`${change>0?'▲':'▼'} ${new Intl.NumberFormat('es-MX',{style:'percent',maximumFractionDigits:0}).format(Math.abs(change))}`,tone:good?'good':'bad'};
}
function params(){try{const q=new URLSearchParams(window.location.search),out:Partial<ResultFilters>={};for(const k of Object.keys(captions) as (keyof typeof captions)[]){const v=q.get(k);if(v&&/^[A-Za-z0-9 _.:-]{1,160}$/.test(v))(out as Record<string,string>)[k]=v;}const touch=q.get('touch');if(touch==='REMARKETING'||touch==='FIRST_CONTACT')out.touch=touch;return out;}catch{return {};}}

/** Remounting fences all requests, filter selections and goal drafts to the selected profile. */
export function Results(p:ResultsProps){return <SelectedResults key={JSON.stringify([p.selection.workspaceId,p.selection.version,p.timezone,p.role,p.profileState])} {...p}/>;}
function Choice(p:{client:ResultsClient;kind:typeof kinds[keyof typeof kinds];label:string;value:string;onChange:(v:string)=>void;family?:string;disabled?:boolean}){
 const id=useId(),[search,setSearch]=useState(''),[page,setPage]=useState<{data:{id:string;label:string}[];next:string|null}>({data:[],next:null}),[error,setError]=useState(''),[busy,setBusy]=useState(false),flight=useRef<AbortController|null>(null),epoch=useRef(0);
 const query=async(after?:string)=>{const n=++epoch.current;flight.current?.abort();const c=new AbortController();flight.current=c;setBusy(true);setError('');try{const r=await p.client({operation:'options',query:{kind:p.kind,limit:50,...(search?{search}:{}),...(after?{after}:{}),...(p.family?{family_id:p.family}:{})}},c.signal);if(n!==epoch.current||c.signal.aborted)return;if(r.operation!=='options')throw Error('OPTIONS_REQUIRED');setPage(old=>({data:after?[...old.data,...r.data]:r.data,next:r.next}));}catch{if(n===epoch.current&&!c.signal.aborted)setError('No se pudieron consultar las opciones.');}finally{if(n===epoch.current&&!c.signal.aborted)setBusy(false);}};
 useEffect(()=>{setPage({data:[],next:null});void query();return()=>{epoch.current++;flight.current?.abort();};},[p.client,p.kind,p.family]);
 return <div className="results-choice"><label htmlFor={id}>{p.label}</label>
  <select id={id} value={p.value} disabled={p.disabled} onChange={e=>p.onChange(e.target.value)}><option value="">Todos</option>{p.value&&!page.data.some(x=>x.id===p.value)&&<option value={p.value}>Selección actual</option>}{page.data.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select>
  {(page.next||search)&&<div className="results-choice-search"><input aria-label={'Buscar '+p.label.toLowerCase()} maxLength={80} value={search} placeholder="Buscar…" onChange={e=>setSearch(e.target.value)}/><Button type="button" variant="secondary" disabled={busy} onClick={()=>{void query();}}>Buscar</Button>{page.next&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>{void query(page.next!);}}>Más</Button>}</div>}
  {error&&<p role="alert">{error}</p>}</div>;
}
function SelectedResults(p:ResultsProps){
 const id=useId(),client=useMemo(()=>sessionResults(p.selection),[p.selection.workspaceId,p.selection.version]),readView=useRef<ReturnType<typeof resultsView>|null>(null),followView=useRef<ReturnType<typeof resultsView>|null>(null),goalView=useRef<ReturnType<typeof resultsView>|null>(null);
 const today=profileToday(p.timezone),fromUrl=useMemo(params,[]);
 const [preset,setPreset]=useState<Preset>('30'),[currencies,setCurrencies]=useState<string[]>(['MXN']);
 const initial:ResultFilters={...range('30',today),currency:'MXN',granularity:'day',...fromUrl};
 const[filters,setFilters]=useState<ResultFilters>(initial),[reportState,setReportState]=useState(empty),[followState,setFollowState]=useState(empty),[goalState,setGoalState]=useState(empty),[error,setError]=useState(''),[editing,setEditing]=useState(false),[goal,setGoal]=useState<Goal|null>(null),[active,setActive]=useState(true),[target,setTarget]=useState(''),[fields,setFields]=useState<Omit<GoalFields,'target'>>({from:initial.from,to:initial.to,currency:initial.currency,family_id:null,variant_id:null,metric:'REVENUE'});
 const run=(next:ResultFilters)=>{setError('');try{const q=resultFiltersSchema.parse(next);void readView.current?.read({operation:'report',filters:q});
  // Sales recovered by follow-ups (RF-10.e): the same report cut by touch.
  if(!q.touch)void followView.current?.read({operation:'report',filters:{...q,touch:'REMARKETING'}});}catch{setError('Revisa las fechas: el periodo admite hasta 366 días.');}};
 useEffect(()=>{const a=resultsView(client,p.selection.workspaceId),f=resultsView(client,p.selection.workspaceId),b=resultsView(client,p.selection.workspaceId);readView.current=a;followView.current=f;goalView.current=b;
  const offA=a.subscribe(()=>setReportState(a.snapshot())),offF=f.subscribe(()=>setFollowState(f.snapshot())),offB=b.subscribe(()=>setGoalState(b.snapshot()));
  void b.read({operation:'goals',limit:25});
  // The profile's currencies come from its variants; the most used one opens first.
  const c=new AbortController();variantRequest<{document:{locale:{currency:string}}}[]>(p.selection,'GET','/v2/variants',undefined,undefined,c.signal).then(vs=>{
   const counts=new Map<string,number>();for(const v of vs){const k=v.document?.locale?.currency;if(k)counts.set(k,(counts.get(k)??0)+1);}
   const list=[...counts].sort((x,y)=>y[1]-x[1]).map(([k])=>k);const first=list[0]??'MXN';setCurrencies(list.length?list:['MXN']);
   setFilters(old=>{const next={...old,currency:first};run(next);return next;});}).catch(()=>{if(!c.signal.aborted)run(initial);});
  return()=>{c.abort();offA();offF();offB();a.dispose();f.dispose();b.dispose();readView.current=null;followView.current=null;goalView.current=null;};
  },[client,p.selection.workspaceId]);
 useEffect(()=>{const r=goalState.result;if(!r||!['goal','create','update','reconcile'].includes(r.operation)||!('data'in r)||!r.data||Array.isArray(r.data)||!('fields'in r.data))return;const g=r.data as Goal;setGoal(g);setFields(g.fields);setTarget(g.fields.metric==='REVENUE'||g.fields.metric==='MAX_COST_PER_SALE'?moneyText(g.fields.target,g.fields.currency).split(' ')[0]!:g.fields.target);setActive(g.active);setEditing(true);},[goalState.result]);
 const report=reportState.result?.operation==='report'?reportState.result.data:null,follow=followState.result?.operation==='report'?followState.result.data:null;
 const writable=p.profileState==='ACTIVE'&&p.role!=='viewer',busy=goalState.status==='WRITING'||goalState.status==='LOADING',locked=!!goalState.pending,disabled=!writable||busy||locked;
 function change<K extends keyof ResultFilters>(key:K,value:ResultFilters[K],apply=true){setFilters(old=>{const next={...old,[key]:value};if(value==='')delete next[key];if(key==='family_id')delete next.variant_id;if(apply)run(next);return next;});}
 function pick(next:Preset){setPreset(next);if(next==='custom')return;const r=range(next,today);setFilters(old=>{const f={...old,...r,granularity:next==='today'?'day' as const:old.granularity};run(f);return f;});}
 const goals=goalState.result?.operation==='goals'?goalState.result:null,progress=goalState.result?.operation==='progress'?goalState.result.data:null;
 const cuts=(Object.keys(captions) as (keyof typeof captions)[]).filter(k=>filters[k]).length+(filters.touch?1:0);
 return <section aria-labelledby={id} className="results-v7">
  <header className="results-head"><h1 id={id}>Resultados</h1>
   <div className="results-presets" role="group" aria-label="Periodo">{presets.map(([k,label])=><button key={k} type="button" aria-pressed={preset===k} onClick={()=>pick(k)}>{label}</button>)}</div>
   {currencies.length>1&&<label className="results-currency">Moneda<select value={filters.currency} onChange={e=>change('currency',e.target.value)}>{currencies.map(v=><option key={v}>{v}</option>)}</select></label>}
  </header>
  {preset==='custom'&&<form className="results-custom" onSubmit={e=>{e.preventDefault();run(filters);}}>
   <label>Desde<input type="date" required value={filters.from} onChange={e=>change('from',e.target.value,false)}/></label><label>Hasta<input type="date" required value={filters.to} onChange={e=>change('to',e.target.value,false)}/></label>
   <label>Agrupar por<select value={filters.granularity} onChange={e=>change('granularity',e.target.value as ResultFilters['granularity'],false)}><option value="day">Día</option><option value="week">Semana</option><option value="month">Mes</option></select></label>
   <Button type="submit" disabled={reportState.status==='LOADING'}>Ver</Button></form>}
  <details className="results-filters" open={cuts>0}><summary>Filtros{cuts?` (${cuts})`:''}</summary>
   <div className="results-filter-grid">{(Object.keys(captions)as(keyof typeof captions)[]).map(k=><Choice key={k} client={client} kind={kinds[k]} label={captions[k]} value={filters[k]??''} family={k==='variant_id'?filters.family_id:undefined} onChange={v=>change(k,v)}/>)}
    <div className="results-choice"><label htmlFor={id+'-touch'}>Contacto</label><select id={id+'-touch'} value={filters.touch??''} onChange={e=>change('touch',e.target.value as ResultFilters['touch'])}><option value="">Todos</option><option value="FIRST_CONTACT">Primer contacto</option><option value="REMARKETING">Por seguimiento</option><option value="UNKNOWN">Sin clasificar</option></select></div>
   </div>
   {cuts>0&&<Button variant="ghost" onClick={()=>{setFilters(old=>{const next:ResultFilters={from:old.from,to:old.to,currency:old.currency,granularity:old.granularity};run(next);return next;});}}>Quitar filtros</Button>}
  </details>
  {reportState.message&&<p role="status">{reportState.message}</p>}{error&&<p role="alert">{error}</p>}
  {reportState.status==='LOADING'&&!report&&<p role="status">Consultando resultados…</p>}
  {report&&<ReportPanel report={report} follow={filters.touch?null:follow} loading={reportState.status==='LOADING'}/>}
  <AiMonth selection={p.selection}/>
  <section className="results-goals" aria-labelledby={id+'-goals'}><h2 id={id+'-goals'}>Metas</h2>
   {goalState.message&&<p role={locked?'alert':'status'}>{goalState.message}</p>}
   {goalState.pending&&<div><p>Hay una meta guardándose.</p><Button disabled={busy} onClick={()=>{void goalView.current?.reconcile();}}>Comprobar guardado</Button>{goalState.mayResend&&<Button variant="secondary" disabled={busy} onClick={()=>{void goalView.current?.resend();}}>Reenviar la misma solicitud</Button>}</div>}
   {goals&&!goals.data.length&&<p>Todavía no tienes metas. Una meta compara lo vendido con lo que esperas en un periodo.</p>}
   {goals&&goals.data.length>0&&<ul className="results-goal-list">{goals.data.map(g=><li key={g.id}><span><strong>{metricNames[g.fields.metric]}</strong> · {g.fields.from} a {g.fields.to} · {g.fields.currency}{g.active?'':' · archivada'}</span>
    <span><Button variant="ghost" disabled={busy||locked} onClick={()=>{void goalView.current?.read({operation:'progress',id:g.id});}}>Ver avance</Button><Button variant="ghost" disabled={busy||locked||!writable} onClick={()=>{void goalView.current?.read({operation:'goal',id:g.id});}}>Editar</Button></span></li>)}</ul>}
   {goals?.next&&<Button variant="ghost" disabled={busy||locked} onClick={()=>{void goalView.current?.read({operation:'goals',limit:25,after:goals.next!});}}>Ver más metas</Button>}
   {progress&&<GoalProgress result={progress}/>}
   <div className="results-goal-actions">{goalState.result?.operation!=='goals'&&<Button variant="secondary" disabled={busy||locked} onClick={()=>{setEditing(false);void goalView.current?.read({operation:'goals',limit:25});}}>Volver a las metas</Button>}
    {writable&&<Button disabled={disabled} onClick={()=>{setGoal(null);setFields({from:filters.from,to:filters.to,currency:filters.currency,family_id:filters.family_id??null,variant_id:filters.variant_id??null,metric:'REVENUE'});setTarget('');setActive(true);setEditing(true);}}>Nueva meta</Button>}</div>
   {editing&&<form className="results-goal-form" onSubmit={e=>{e.preventDefault();setError('');try{const f=goalFieldsSchema.parse({...fields,target:fields.metric==='REVENUE'||fields.metric==='MAX_COST_PER_SALE'?moneyTarget(target,fields.currency):target});void goalView.current?.write(goal?{operation:'update',id:goal.id,body:{expected_version:goal.version,fields:f,active}}:{operation:'create',body:{fields:f}});}catch{setError('Revisa la meta: periodo válido y un objetivo mayor que cero.');}}}>
    <fieldset disabled={disabled}><legend>{goal?'Editar meta':'Nueva meta'}</legend>
     <label>Qué medir<select value={fields.metric} onChange={e=>setFields({...fields,metric:e.target.value as GoalFields['metric']})}>{Object.entries(metricNames).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
     <label>Objetivo{fields.metric==='REVENUE'||fields.metric==='MAX_COST_PER_SALE'?` (${fields.currency})`:fields.metric==='ROAS'?' (veces lo invertido)':' (número de ventas)'}<input inputMode="decimal" required value={target} onChange={e=>setTarget(e.target.value)}/></label>
     <label>Desde<input type="date" required value={fields.from} onChange={e=>setFields({...fields,from:e.target.value})}/></label><label>Hasta<input type="date" required value={fields.to} onChange={e=>setFields({...fields,to:e.target.value})}/></label>
     <label>Moneda<select value={fields.currency} onChange={e=>setFields({...fields,currency:e.target.value})}>{[...new Set([...currencies,fields.currency])].map(v=><option key={v}>{v}</option>)}</select></label>
     {goal&&<label className="results-inline"><input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)}/> Activa</label>}
     <p className="variant-hint">{fields.family_id?'Se mide sólo para el producto filtrado.':'Se mide para todo el perfil.'} La proyección supone que el ritmo actual sigue igual; no es una promesa.</p>
     <div className="results-goal-actions"><Button type="submit" disabled={disabled}>{goal?'Guardar cambios':'Crear meta'}</Button><Button type="button" variant="secondary" onClick={()=>setEditing(false)}>Cancelar</Button></div>
    </fieldset></form>}
  </section>
 </section>;
}
function GoalProgress({result:r}:{result:Extract<ResultsCommandResult,{operation:'progress'}>['data']}){
 const monetary=['REVENUE','MAX_COST_PER_SALE'].includes(r.goal.fields.metric),c=r.goal.fields.currency,fmt=(v:string)=>monetary?money(v,c):r.goal.fields.metric==='ROAS'?`${Number(v).toFixed(2)}×`:v;
 const ratio=num(r.progress.progress.value),width=ratio===null?0:Math.max(0,Math.min(100,ratio*100));
 return <div className="results-goal-progress" role="status"><h3>{metricNames[r.goal.fields.metric]} · {r.goal.fields.from} a {r.goal.fields.to}</h3>
  <div className="results-bar" aria-hidden="true"><span style={{width:`${width}%`}} className={r.progress.met?'met':''}/></div>
  <p><strong>{shown(r.progress.actual,fmt)}</strong> de {fmt(r.progress.target)} · {r.progress.met===null?'sin datos suficientes':r.progress.met?'meta cumplida':`${pct(r.progress.progress.value)??'—'} del objetivo`}</p>
  <p className="variant-hint">Día {r.progress.elapsed_days} de {r.progress.total_days}. Si el ritmo sigue igual: {shown(r.progress.projection,fmt)}.</p></div>;
}
function Card({label,value,before,change,hint,missing}:{label:string;value:string;before?:string|null;change?:{text:string;tone:string}|null;hint?:string;missing?:boolean}){
 return <div className="results-card"><span className="results-card-label">{label}</span><strong className={missing?'results-card-missing':'results-card-value'}>{value}</strong>
  {(change||before)&&<span className="results-card-delta">{change&&<span className={`results-delta-${change.tone}`}>{change.text}</span>}{before?` antes ${before}`:''}</span>}
  {hint&&<span className="results-card-hint">{hint}</span>}</div>;
}
function ReportPanel({report:r,follow,loading}:{report:Report;follow:Report|null;loading:boolean}){
 const s=r.summary,p=r.previous.summary,c=s.currency;
 const kpi=(m:Metric)=>num(m.value);
 const revenue=Number(s.totals.revenue_minor),sales=Number(s.totals.sales);
 const started=Number(s.funnel[0]!.count);
 const followSales=follow?Number(follow.summary.totals.sales):null,followRevenue=follow?follow.summary.totals.revenue_minor:null;
 const max=r.series.reduce((v,x)=>Math.max(v,Number(x.summary.totals.revenue_minor),Number(x.previous.summary.totals.revenue_minor)),1),n=r.series.length,width=Math.max(1,n)*24;
 return <div className="results-report" aria-busy={loading}>
  <p className="results-period">Del {r.filters.from} al {r.filters.to} · comparado con {r.previous.from} a {r.previous.to}</p>
  <div className="results-cards">
   <Card label="Ingresos" value={money(s.totals.revenue_minor,c)??'—'} before={money(p.totals.revenue_minor,c)} change={delta(revenue,Number(p.totals.revenue_minor))}/>
   <Card label="Ventas" value={s.totals.sales} before={p.totals.sales} change={delta(sales,Number(p.totals.sales))}/>
   <Card label="Conversión" missing={s.conversion.value===null} value={shown(s.conversion,v=>pct(v))} change={delta(kpi(s.conversion),kpi(p.conversion))} hint="De las conversaciones iniciadas, las que pagaron."/>
   <Card label="Ticket promedio" missing={s.average_ticket_minor.value===null} value={shown(s.average_ticket_minor,v=>money(v,c))} change={delta(kpi(s.average_ticket_minor),kpi(p.average_ticket_minor))}/>
   <Card label="Gasto en anuncios" missing={s.spend_minor.value===null} value={shown(s.spend_minor,v=>money(v,c))} change={delta(kpi(s.spend_minor),kpi(p.spend_minor),true)}/>
   <Card label="Costo por venta" missing={s.cost_per_sale_minor.value===null} value={shown(s.cost_per_sale_minor,v=>money(v,c))} change={delta(kpi(s.cost_per_sale_minor),kpi(p.cost_per_sale_minor),true)} hint="Gasto entre ventas atribuidas a anuncios."/>
   <Card label="ROAS" missing={s.roas.value===null} value={shown(s.roas,v=>`${Number(v).toFixed(2)}×`)} change={delta(kpi(s.roas),kpi(p.roas))} hint="Ingresos atribuidos por cada peso invertido."/>
   <Card label="Costo de IA" missing={s.ai.cost.value===null} value={shown(s.ai.cost,v=>usd(v))} change={delta(kpi(s.ai.cost),kpi(p.ai.cost),true)} hint={`Por conversación ${shown(s.ai.per_conversation,v=>usd(v))} · por venta ${shown(s.ai.per_sale,v=>usd(v))}. Lo paga la clave de tu perfil.`}/>
   <Card label="Primera respuesta" missing={s.latency_percentiles.response.p50.value===null} value={shown(s.latency_percentiles.response.p50,v=>duration(v))} hint="Mediana: la mitad de los clientes recibió respuesta en este tiempo o menos."/>
   <Card label="Tiempo hasta pagar" missing={s.latency_percentiles.sale.p50.value===null} value={shown(s.latency_percentiles.sale.p50,v=>duration(v))} hint="Mediana desde el primer mensaje hasta el pago."/>
   {follow&&<Card label="Ventas por seguimiento" value={String(followSales)} hint={`${money(followRevenue,c)} recuperados con mensajes de seguimiento.`}/>}
  </div>
  <section aria-labelledby="results-funnel" className="results-funnel"><h2 id="results-funnel">Embudo</h2>
   {started===0?<p>No hubo conversaciones nuevas en el periodo.</p>:<ol>{s.funnel.map(x=>{const share=Number(x.count)/started;return <li key={x.stage}>
    <span className="results-funnel-label">{stages[x.stage]}</span><span className="results-bar" aria-hidden="true"><span style={{width:`${Math.max(share*100,x.count==='0'?0:1)}%`}}/></span>
    <span className="results-funnel-count">{x.count} <small>{pct(String(share))}</small></span></li>;})}</ol>}
   <p className="variant-hint">Sigue a las conversaciones que empezaron en el periodo. Los ingresos se cuentan el día del pago.</p></section>
  <section aria-labelledby="results-series" className="results-series"><h2 id="results-series">Ingresos por {({day:'día',week:'semana',month:'mes'})[r.filters.granularity]}</h2>
   <svg role="img" aria-label="Ingresos por periodo frente al periodo anterior" viewBox={'0 0 '+width+' 110'} preserveAspectRatio="none" className="results-chart">
    {r.series.map((x,i)=>{const a=Number(x.summary.totals.revenue_minor)/max*100,b=Number(x.previous.summary.totals.revenue_minor)/max*100;return <g key={x.bucket}><title>{`${x.from}: ${money(x.summary.totals.revenue_minor,c)} (antes ${money(x.previous.summary.totals.revenue_minor,c)})`}</title>
     <rect x={i*24+2} y={105-b} width={9} height={b} className="results-chart-before"/><rect x={i*24+12} y={105-a} width={9} height={a} className="results-chart-now"/></g>;})}
   </svg><p className="results-legend"><span className="results-legend-now"/>Este periodo <span className="results-legend-before"/>Periodo anterior</p>
   <details><summary>Ver tabla</summary><div className="results-table"><table><thead><tr><th>Periodo</th><th>Ingresos</th><th>Antes</th><th>Ventas</th><th>Antes</th><th>Gasto</th></tr></thead>
    <tbody>{r.series.map(x=><tr key={x.bucket}><th>{x.from===x.to?x.from:`${x.from} a ${x.to}`}</th><td>{money(x.summary.totals.revenue_minor,c)}</td><td>{money(x.previous.summary.totals.revenue_minor,c)}</td><td>{x.summary.totals.sales}</td><td>{x.previous.summary.totals.sales}</td><td>{shown(x.summary.spend_minor,v=>money(v,c))}</td></tr>)}</tbody></table></div></details>
  </section>
  <details className="results-tech"><summary>Detalle técnico</summary>
   <dl><div><dt>Tokens de IA (entrada / salida)</dt><dd>{shown(s.ai.tokens.input,v=>v)} / {shown(s.ai.tokens.output,v=>v)}</dd></div>
    <div><dt>Respuesta p95</dt><dd>{shown(s.latency_percentiles.response.p95,v=>duration(v))}</dd></div><div><dt>Pago p95</dt><dd>{shown(s.latency_percentiles.sale.p95,v=>duration(v))}</dd></div>
    <div><dt>Costo por conversación de anuncio</dt><dd>{shown(s.cost_per_conversation_minor,v=>money(String(Number(v)/1_000_000),c))}</dd></div>
    <div><dt>IA sin atribuir a una conversación</dt><dd>{usd(r.unattributed_ai.cost_microusd)}</dd></div>
    <div><dt>Zona horaria</dt><dd>{r.timezones.join(', ')||r.timezone}</dd></div><div><dt>Actualizado</dt><dd>{new Date(r.measured_at).toLocaleString('es-MX')}</dd></div></dl>
   <p className="variant-hint">Las pruebas y las reservas de presupuesto de IA no cuentan. Un intento de IA sin consumo confirmado aparece como incompleto, nunca como cero.</p>
  </details>
 </div>;
}

/** RF-14.d / RF-19.l: this month's AI budget by provider, model and use. */
interface AiUsage {aiCost:{startsAt:string;endsAt:string;limitMicrousd:number;usedMicrousd:number;breakdown?:{provider:string;model:string;task:string;category:string;attempts:number;measuredMicrousd:number;unknownAttempts:number;chargedMicrousd:number}[]}|null}
const taskLabels:Record<string,string>={'sales.chat':'Responder en la conversación','receipt.document':'Leer comprobantes','audio.transcribe':'Transcribir audios','laboratory.chat':'Probar número','credential.verify':'Verificar la clave'};
const categoryLabels:Record<string,string>={OPERATION:'Venta',NUMBER_TEST:'Prueba de número',KEY_CHECK:'Verificación'};
function AiMonth({selection}:{selection:{workspaceId:string;version:number}}){
 const [usage,setUsage]=useState<AiUsage|null>(null);
 useEffect(()=>{const c=new AbortController();profileRequest<AiUsage>(selection,'GET','/v2/usage',undefined,c.signal).then(setUsage).catch(()=>undefined);return()=>c.abort();},[selection.workspaceId,selection.version]);
 const ai=usage?.aiCost;if(!ai)return null;
 const ratio=ai.limitMicrousd>0?Math.min(1,ai.usedMicrousd/ai.limitMicrousd):0;
 return <section className="results-funnel" aria-labelledby="results-ai"><h2 id="results-ai">IA de este periodo de presupuesto</h2>
  <p><strong>{usd(String(ai.usedMicrousd))}</strong> de {usd(String(ai.limitMicrousd))} ({pct(String(ratio))}) · del {ai.startsAt.slice(0,10)} al {ai.endsAt.slice(0,10)}</p>
  <span className="results-bar" aria-hidden="true"><span style={{width:`${ratio*100}%`}}/></span>
  {ai.breakdown&&ai.breakdown.length>0?<div className="results-table"><table><thead><tr><th>Uso</th><th>Proveedor y modelo</th><th>Tipo</th><th>Llamadas</th><th>Costo</th></tr></thead>
   <tbody>{ai.breakdown.map(b=><tr key={b.provider+b.model+b.task+b.category}><th>{taskLabels[b.task]??b.task}</th><td>{b.provider} · {b.model}</td><td>{categoryLabels[b.category]??b.category}</td><td>{b.attempts}</td><td>{usd(String(b.chargedMicrousd))}{b.unknownAttempts?` · ${b.unknownAttempts} sin confirmar`:''}</td></tr>)}</tbody></table></div>
   :<p className="variant-hint">Todavía no hay llamadas a la IA en este periodo.</p>}
  <p className="variant-hint">Lo cobra tu proveedor con tu clave. Las pruebas de número y la verificación de la clave se muestran aparte de las ventas.</p>
 </section>;
}
