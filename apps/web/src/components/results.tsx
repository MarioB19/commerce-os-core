import {useEffect,useId,useMemo,useRef,useState} from 'react';
import type {z} from 'zod';
import {goalViewSchema,resultsReportSchema,type ResultsCommandResult} from '../../../../packages/contracts/src/results-client.js';
import {goalFieldsSchema,resultFiltersSchema,type GoalFields,type ResultFilters} from '../../../../packages/contracts/src/results.js';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import {sessionResults,type ResultsClient} from '../../../../packages/commerce-client/src/results.js';
import {resultsView,profileToday,moneyText,moneyTarget,type ResultsState} from '../lib/results.js';
import {variantRequest} from '../lib/variants.js';
import {profileRequest} from '../lib/profile-request.js';
import {Alert,Badge,Button,Card,CardHead,EmptyState,Field,Input,Kpi,NativeCheck,NativeSelect,PageHeader,Progress,Segmented,Skeleton,Table,TableWrap} from './ui';

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
function delta(now:number|null,before:number|null,lowerIsBetter=false):{text:string;tone:'good'|'bad'|'flat'}|null{
 if(now===null||before===null||!Number.isFinite(now)||!Number.isFinite(before))return null;
 if(before===0)return now===0?{text:'igual',tone:'flat'}:{text:'nuevo',tone:lowerIsBetter?'bad':'good'};
 const change=(now-before)/Math.abs(before);if(Math.abs(change)<0.005)return{text:'igual',tone:'flat'};
 const good=lowerIsBetter?change<0:change>0;return{text:new Intl.NumberFormat('es-MX',{style:'percent',maximumFractionDigits:0}).format(Math.abs(change)),tone:good?'good':'bad'};
}
function params(){try{const q=new URLSearchParams(window.location.search),out:Partial<ResultFilters>={};for(const k of Object.keys(captions) as (keyof typeof captions)[]){const v=q.get(k);if(v&&/^[A-Za-z0-9 _.:-]{1,160}$/.test(v))(out as Record<string,string>)[k]=v;}const touch=q.get('touch');if(touch==='REMARKETING'||touch==='FIRST_CONTACT')out.touch=touch;return out;}catch{return {};}}

/** Remounting fences all requests, filter selections and goal drafts to the selected profile. */
export function Results(p:ResultsProps){return <SelectedResults key={JSON.stringify([p.selection.workspaceId,p.selection.version,p.timezone,p.role,p.profileState])} {...p}/>;}
function Choice(p:{client:ResultsClient;kind:typeof kinds[keyof typeof kinds];label:string;value:string;onChange:(v:string)=>void;family?:string;disabled?:boolean}){
 const id=useId(),[search,setSearch]=useState(''),[page,setPage]=useState<{data:{id:string;label:string}[];next:string|null}>({data:[],next:null}),[error,setError]=useState(''),[busy,setBusy]=useState(false),flight=useRef<AbortController|null>(null),epoch=useRef(0);
 const query=async(after?:string)=>{const n=++epoch.current;flight.current?.abort();const c=new AbortController();flight.current=c;setBusy(true);setError('');try{const r=await p.client({operation:'options',query:{kind:p.kind,limit:50,...(search?{search}:{}),...(after?{after}:{}),...(p.family?{family_id:p.family}:{})}},c.signal);if(n!==epoch.current||c.signal.aborted)return;if(r.operation!=='options')throw Error('OPTIONS_REQUIRED');setPage(old=>({data:after?[...old.data,...r.data]:r.data,next:r.next}));}catch{if(n===epoch.current&&!c.signal.aborted)setError('No se pudieron consultar las opciones.');}finally{if(n===epoch.current&&!c.signal.aborted)setBusy(false);}};
 useEffect(()=>{setPage({data:[],next:null});void query();return()=>{epoch.current++;flight.current?.abort();};},[p.client,p.kind,p.family]);
 return <Field label={p.label} htmlFor={id} error={error||undefined}>
  <div className="stack-tight">
   <NativeSelect id={id} value={p.value} disabled={p.disabled} onChange={e=>p.onChange(e.target.value)}><option value="">Todos</option>{p.value&&!page.data.some(x=>x.id===p.value)&&<option value={p.value}>Selección actual</option>}{page.data.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</NativeSelect>
   {(page.next||search)&&<div className="field-row"><Input aria-label={'Buscar '+p.label.toLowerCase()} maxLength={80} value={search} placeholder="Buscar…" onChange={e=>setSearch(e.target.value)}/><Button type="button" variant="secondary" size="sm" disabled={busy} onClick={()=>{void query();}}>Buscar</Button>{page.next&&<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={()=>{void query(page.next!);}}>Más</Button>}</div>}
  </div>
 </Field>;
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
  const presetOptions=presets.map(([k,label])=>({value:k,label}));
 return <>
  <PageHeader title="Resultados" description="Cuánto vendiste y cuánto te costó, con las mismas cifras que la API y el conector MCP. Nada se estima: cuando falta un dato, se dice por qué."/>
  <div className="toolbar">
   <Segmented label="Periodo" value={preset} onChange={pick} options={presetOptions}/>
   {currencies.length>1&&<label className="toolbar-sort"><span className="muted text-sm">Moneda</span><NativeSelect aria-label="Moneda" value={filters.currency} onChange={e=>change('currency',e.target.value)}>{currencies.map(v=><option key={v}>{v}</option>)}</NativeSelect></label>}
  </div>
  {preset==='custom'&&<form className="toolbar" onSubmit={e=>{e.preventDefault();run(filters);}}>
   <Field label="Desde"><Input type="date" required value={filters.from} onChange={e=>change('from',e.target.value,false)}/></Field>
   <Field label="Hasta"><Input type="date" required value={filters.to} onChange={e=>change('to',e.target.value,false)}/></Field>
   <Field label="Agrupar por"><NativeSelect value={filters.granularity} onChange={e=>change('granularity',e.target.value as ResultFilters['granularity'],false)}><option value="day">Día</option><option value="week">Semana</option><option value="month">Mes</option></NativeSelect></Field>
   <div className="field"><span className="field-label">&nbsp;</span><Button type="submit" variant="secondary" disabled={reportState.status==='LOADING'}>Ver</Button></div>
  </form>}
  <details className="disclosure" open={cuts>0}><summary>Filtros{cuts?<Badge tone="accent" icon={false}>{cuts}</Badge>:null}</summary>
   <div className="disclosure-body">
    <div className="form-grid">{(Object.keys(captions)as(keyof typeof captions)[]).map(k=><Choice key={k} client={client} kind={kinds[k]} label={captions[k]} value={filters[k]??''} family={k==='variant_id'?filters.family_id:undefined} onChange={v=>change(k,v)}/>)}
     <Field label="Contacto" id={id+'-touch'}><NativeSelect value={filters.touch??''} onChange={e=>change('touch',e.target.value as ResultFilters['touch'])}><option value="">Todos</option><option value="FIRST_CONTACT">Primer contacto</option><option value="REMARKETING">Por seguimiento</option><option value="UNKNOWN">Sin clasificar</option></NativeSelect></Field>
    </div>
    {cuts>0&&<div><Button variant="ghost" size="sm" onClick={()=>{setFilters(old=>{const next:ResultFilters={from:old.from,to:old.to,currency:old.currency,granularity:old.granularity};run(next);return next;});}}>Quitar filtros</Button></div>}
   </div>
  </details>
  {reportState.message&&<Alert tone="info">{reportState.message}</Alert>}{error&&<Alert tone="error">{error}</Alert>}
  {reportState.status==='LOADING'&&!report&&<div className="kpi-grid" aria-hidden="true"><Skeleton block/><Skeleton block/><Skeleton block/><Skeleton block/></div>}
  {report&&<ReportPanel report={report} follow={filters.touch?null:follow} loading={reportState.status==='LOADING'}/>}
  <AiMonth selection={p.selection}/>
  <Card aria-labelledby={id+'-goals'}>
   <CardHead id={id+'-goals'} title="Metas" description="Una meta compara lo vendido con lo que esperas en un periodo." actions={writable&&!editing?<Button disabled={disabled} onClick={()=>{setGoal(null);setFields({from:filters.from,to:filters.to,currency:filters.currency,family_id:filters.family_id??null,variant_id:filters.variant_id??null,metric:'REVENUE'});setTarget('');setActive(true);setEditing(true);}}>Nueva meta</Button>:undefined}/>
   {goalState.message&&<Alert tone={locked?'error':'info'}>{goalState.message}</Alert>}
   {goalState.pending&&<Alert tone="warn" title="Hay una meta guardándose." actions={<><Button size="sm" disabled={busy} onClick={()=>{void goalView.current?.reconcile();}}>Comprobar guardado</Button>{goalState.mayResend&&<Button size="sm" variant="secondary" disabled={busy} onClick={()=>{void goalView.current?.resend();}}>Reenviar la misma solicitud</Button>}</>}/>}
   {goals&&!goals.data.length&&!editing&&<EmptyState inline level={3} title="Todavía no tienes metas" description="Define cuánto esperas vender en un periodo y mide el avance cada día."/>}
   {goals&&goals.data.length>0&&<ul className="item-list">{goals.data.map(g=><li key={g.id}><span className="item-name">{metricNames[g.fields.metric]}</span><span className="muted text-sm">{g.fields.from} a {g.fields.to} · {g.fields.currency}</span>{!g.active&&<Badge tone="neutral" icon={false}>Archivada</Badge>}
    <span className="cluster"><Button variant="ghost" size="sm" disabled={busy||locked} onClick={()=>{void goalView.current?.read({operation:'progress',id:g.id});}}>Ver avance</Button><Button variant="ghost" size="sm" disabled={busy||locked||!writable} onClick={()=>{void goalView.current?.read({operation:'goal',id:g.id});}}>Editar</Button></span></li>)}</ul>}
   {goals?.next&&<div><Button variant="ghost" size="sm" disabled={busy||locked} onClick={()=>{void goalView.current?.read({operation:'goals',limit:25,after:goals.next!});}}>Ver más metas</Button></div>}
   {progress&&<GoalProgress result={progress}/>}
   {goalState.result?.operation!=='goals'&&!editing&&<div><Button variant="secondary" size="sm" disabled={busy||locked} onClick={()=>{setEditing(false);void goalView.current?.read({operation:'goals',limit:25});}}>Volver a las metas</Button></div>}
   {editing&&<form className="form goal-form" onSubmit={e=>{e.preventDefault();setError('');try{const f=goalFieldsSchema.parse({...fields,target:fields.metric==='REVENUE'||fields.metric==='MAX_COST_PER_SALE'?moneyTarget(target,fields.currency):target});void goalView.current?.write(goal?{operation:'update',id:goal.id,body:{expected_version:goal.version,fields:f,active}}:{operation:'create',body:{fields:f}});}catch{setError('Revisa la meta: periodo válido y un objetivo mayor que cero.');}}}>
    <fieldset disabled={disabled} className="plain"><legend>{goal?'Editar meta':'Nueva meta'}</legend>
     <div className="form-grid">
      <Field label="Qué medir"><NativeSelect value={fields.metric} onChange={e=>setFields({...fields,metric:e.target.value as GoalFields['metric']})}>{Object.entries(metricNames).map(([k,v])=><option key={k} value={k}>{v}</option>)}</NativeSelect></Field>
      <Field label={`Objetivo${fields.metric==='REVENUE'||fields.metric==='MAX_COST_PER_SALE'?` (${fields.currency})`:fields.metric==='ROAS'?' (veces lo invertido)':' (número de ventas)'}`}><Input inputMode="decimal" required value={target} onChange={e=>setTarget(e.target.value)}/></Field>
      <Field label="Desde"><Input type="date" required value={fields.from} onChange={e=>setFields({...fields,from:e.target.value})}/></Field>
      <Field label="Hasta"><Input type="date" required value={fields.to} onChange={e=>setFields({...fields,to:e.target.value})}/></Field>
      <Field label="Moneda"><NativeSelect value={fields.currency} onChange={e=>setFields({...fields,currency:e.target.value})}>{[...new Set([...currencies,fields.currency])].map(v=><option key={v}>{v}</option>)}</NativeSelect></Field>
      {goal&&<NativeCheck label="Activa" checked={active} onChange={e=>setActive(e.target.checked)}/>}
     </div>
     <p className="muted text-sm">{fields.family_id?'Se mide sólo para el producto filtrado.':'Se mide para todo el perfil.'} La proyección supone que el ritmo actual sigue igual; no es una promesa.</p>
     <div className="form-actions"><Button type="submit" disabled={disabled}>{goal?'Guardar cambios':'Crear meta'}</Button><Button type="button" variant="secondary" onClick={()=>setEditing(false)}>Cancelar</Button></div>
    </fieldset></form>}
  </Card>
 </>;
}
function GoalProgress({result:r}:{result:Extract<ResultsCommandResult,{operation:'progress'}>['data']}){
 const monetary=['REVENUE','MAX_COST_PER_SALE'].includes(r.goal.fields.metric),c=r.goal.fields.currency,fmt=(v:string)=>monetary?money(v,c):r.goal.fields.metric==='ROAS'?`${Number(v).toFixed(2)}×`:v;
 const ratio=num(r.progress.progress.value),pctValue=ratio===null?0:Math.max(0,Math.min(100,ratio*100));
 return <div className="goal-progress" role="status"><h3>{metricNames[r.goal.fields.metric]} · {r.goal.fields.from} a {r.goal.fields.to}</h3>
  <strong className="kpi-value" style={{fontSize:22}}>{shown(r.progress.actual,fmt)} <span className="muted" style={{fontWeight:400,fontSize:16}}>de {fmt(r.progress.target)}</span></strong>
  <Progress value={pctValue} label={metricNames[r.goal.fields.metric]} tone={r.progress.met?'success':undefined} valueText={r.progress.met===null?'sin datos suficientes':r.progress.met?'meta cumplida':`${pct(r.progress.progress.value)??'—'} del objetivo`}/>
  <p className="muted text-sm">{r.progress.met===null?'Sin datos suficientes':r.progress.met?'Meta cumplida':`${pct(r.progress.progress.value)??'—'} del objetivo`} · Día {r.progress.elapsed_days} de {r.progress.total_days}. Si el ritmo sigue igual: {shown(r.progress.projection,fmt)}.</p></div>;
}
function ReportPanel({report:r,follow,loading}:{report:Report;follow:Report|null;loading:boolean}){
 const s=r.summary,p=r.previous.summary,c=s.currency;
 const kpi=(m:Metric)=>num(m.value);
 const revenue=Number(s.totals.revenue_minor),sales=Number(s.totals.sales);
 const started=Number(s.funnel[0]!.count);
 const followSales=follow?Number(follow.summary.totals.sales):null,followRevenue=follow?follow.summary.totals.revenue_minor:null;
 const max=r.series.reduce((v,x)=>Math.max(v,Number(x.summary.totals.revenue_minor),Number(x.previous.summary.totals.revenue_minor)),1),n=r.series.length;
 const W=Math.max(320,n*28),H=160,pad={l:8,r:8,t:12,b:28},innerH=H-pad.t-pad.b,slot=(W-pad.l-pad.r)/Math.max(1,n);
 const ticks=[0,0.5,1];
 const label=(from:string,to:string)=>from===to?from.slice(5):`${from.slice(5)}–${to.slice(5)}`;
 return <div className="stack" aria-busy={loading} style={{gap:'var(--space-5)',opacity:loading?0.6:1}}>
  <p className="muted text-sm">Del {r.filters.from} al {r.filters.to} · comparado con {r.previous.from} a {r.previous.to}</p>
  <section aria-label="Cifras principales" className="kpi-grid results-cards">
   <Kpi label="Ingresos" value={money(s.totals.revenue_minor,c)??'—'} before={money(p.totals.revenue_minor,c)} delta={delta(revenue,Number(p.totals.revenue_minor))}/>
   <Kpi label="Ventas" value={s.totals.sales} before={p.totals.sales} delta={delta(sales,Number(p.totals.sales))}/>
   <Kpi label="Conversión" missing={s.conversion.value===null} value={shown(s.conversion,v=>pct(v))} delta={delta(kpi(s.conversion),kpi(p.conversion))} hint="De las conversaciones iniciadas, las que pagaron."/>
   <Kpi label="Ticket promedio" missing={s.average_ticket_minor.value===null} value={shown(s.average_ticket_minor,v=>money(v,c))} delta={delta(kpi(s.average_ticket_minor),kpi(p.average_ticket_minor))}/>
  </section>
  <section aria-label="Costos" className="kpi-grid results-cards">
   <Kpi label="Gasto en anuncios" missing={s.spend_minor.value===null} value={shown(s.spend_minor,v=>money(v,c))} delta={delta(kpi(s.spend_minor),kpi(p.spend_minor),true)}/>
   <Kpi label="Costo por venta" missing={s.cost_per_sale_minor.value===null} value={shown(s.cost_per_sale_minor,v=>money(v,c))} delta={delta(kpi(s.cost_per_sale_minor),kpi(p.cost_per_sale_minor),true)} hint="Gasto entre ventas atribuidas a anuncios."/>
   <Kpi label="ROAS" missing={s.roas.value===null} value={shown(s.roas,v=>`${Number(v).toFixed(2)}×`)} delta={delta(kpi(s.roas),kpi(p.roas))} hint="Ingresos atribuidos por cada peso invertido."/>
   <Kpi label="Costo de IA" missing={s.ai.cost.value===null} value={shown(s.ai.cost,v=>usd(v))} delta={delta(kpi(s.ai.cost),kpi(p.ai.cost),true)} hint={`Por conversación ${shown(s.ai.per_conversation,v=>usd(v))} · por venta ${shown(s.ai.per_sale,v=>usd(v))}. Lo paga la clave de tu perfil.`}/>
   <Kpi label="Primera respuesta" missing={s.latency_percentiles.response.p50.value===null} value={shown(s.latency_percentiles.response.p50,v=>duration(v))} hint="Mediana: la mitad de los clientes recibió respuesta en este tiempo o menos."/>
   <Kpi label="Tiempo hasta pagar" missing={s.latency_percentiles.sale.p50.value===null} value={shown(s.latency_percentiles.sale.p50,v=>duration(v))} hint="Mediana desde el primer mensaje hasta el pago."/>
   {follow&&<Kpi label="Ventas por seguimiento" value={String(followSales)} hint={`${money(followRevenue,c)} recuperados con mensajes de seguimiento.`}/>}
  </section>
  <div className="layout-1-2">
   <Card aria-labelledby="results-funnel">
    <CardHead id="results-funnel" title="Embudo" description="Sigue a las conversaciones que empezaron en el periodo. Los ingresos se cuentan el día del pago."/>
    {started===0?<p className="muted">No hubo conversaciones nuevas en el periodo.</p>:<ol className="funnel">{s.funnel.map(x=>{const share=Number(x.count)/started;return <li key={x.stage}>
     <span className="funnel-label">{stages[x.stage]}</span><span className="funnel-count num">{x.count} <small className="muted">{pct(String(share))}</small></span>
     <span className="progress" aria-hidden="true"><span style={{width:`${Math.max(share*100,x.count==='0'?0:1)}%`}}/></span>
    </li>;})}</ol>}
   </Card>
   <Card aria-labelledby="results-series">
    <CardHead id="results-series" title={`Ingresos por ${({day:'día',week:'semana',month:'mes'})[r.filters.granularity]}`} description="Este periodo frente al anterior."/>
    <figure className="chart-figure">
     <svg role="img" aria-label="Ingresos por periodo frente al periodo anterior" viewBox={`0 0 ${W} ${H}`} className="chart">
      {ticks.map(t=><g key={t}><line x1={pad.l} x2={W-pad.r} y1={pad.t+innerH*(1-t)} y2={pad.t+innerH*(1-t)} className="chart-grid"/></g>)}
      {r.series.map((x,i)=>{const a=Number(x.summary.totals.revenue_minor)/max*innerH,b=Number(x.previous.summary.totals.revenue_minor)/max*innerH,x0=pad.l+i*slot,bw=Math.max(3,Math.min(14,slot*0.34));return <g key={x.bucket}><title>{`${x.from}: ${money(x.summary.totals.revenue_minor,c)} (antes ${money(x.previous.summary.totals.revenue_minor,c)})`}</title>
       <rect x={x0+slot/2-bw-1} y={pad.t+innerH-b} width={bw} height={b} rx={2} className="chart-before"/><rect x={x0+slot/2+1} y={pad.t+innerH-a} width={bw} height={a} rx={2} className="chart-now"/>
       {(i===0||i===n-1||(n>8&&i===Math.floor(n/2)))&&<text x={x0+slot/2} y={H-8} textAnchor="middle" className="chart-tick">{label(x.from,x.to)}</text>}</g>;})}
     </svg>
     <figcaption className="chart-legend"><span><i className="chart-swatch now"/>Este periodo</span><span><i className="chart-swatch before"/>Periodo anterior</span><span className="muted">Máximo {money(String(max),c)}</span></figcaption>
    </figure>
    <details className="disclosure quiet"><summary>Ver tabla</summary><div className="disclosure-body"><TableWrap label="Ingresos por periodo"><Table stackMobile={false}><thead><tr><th scope="col">Periodo</th><th scope="col" className="num">Ingresos</th><th scope="col" className="num">Antes</th><th scope="col" className="num">Ventas</th><th scope="col" className="num">Antes</th><th scope="col" className="num">Gasto</th></tr></thead>
     <tbody>{r.series.map(x=><tr key={x.bucket}><th scope="row">{x.from===x.to?x.from:`${x.from} a ${x.to}`}</th><td className="num">{money(x.summary.totals.revenue_minor,c)}</td><td className="num">{money(x.previous.summary.totals.revenue_minor,c)}</td><td className="num">{x.summary.totals.sales}</td><td className="num">{x.previous.summary.totals.sales}</td><td className="num">{shown(x.summary.spend_minor,v=>money(v,c))}</td></tr>)}</tbody></Table></TableWrap></div></details>
   </Card>
  </div>
  <details className="disclosure results-tech"><summary>Detalle técnico</summary>
   <div className="disclosure-body">
    <dl className="facts"><div><dt>Tokens de IA (entrada / salida)</dt><dd>{shown(s.ai.tokens.input,v=>v)} / {shown(s.ai.tokens.output,v=>v)}</dd></div>
     <div><dt>Respuesta p95</dt><dd>{shown(s.latency_percentiles.response.p95,v=>duration(v))}</dd></div><div><dt>Pago p95</dt><dd>{shown(s.latency_percentiles.sale.p95,v=>duration(v))}</dd></div>
     <div><dt>Costo por conversación de anuncio</dt><dd>{shown(s.cost_per_conversation_minor,v=>money(String(Number(v)/1_000_000),c))}</dd></div>
     <div><dt>IA sin atribuir a una conversación</dt><dd>{usd(r.unattributed_ai.cost_microusd)}</dd></div>
     <div><dt>Zona horaria</dt><dd>{r.timezones.join(', ')||r.timezone}</dd></div><div><dt>Actualizado</dt><dd>{new Date(r.measured_at).toLocaleString('es-MX')}</dd></div></dl>
    <p className="muted text-sm">Las pruebas y las reservas de presupuesto de IA no cuentan. Un intento de IA sin consumo confirmado aparece como incompleto, nunca como cero.</p>
   </div>
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
 return <Card aria-labelledby="results-ai">
  <CardHead id="results-ai" title="IA de este periodo de presupuesto" description={`Del ${ai.startsAt.slice(0,10)} al ${ai.endsAt.slice(0,10)}. Lo cobra tu proveedor con tu clave; las pruebas de número y la verificación de la clave se muestran aparte de las ventas.`}/>
  <strong className="kpi-value" style={{fontSize:22}}>{usd(String(ai.usedMicrousd))} <span className="muted" style={{fontWeight:400,fontSize:16}}>de {usd(String(ai.limitMicrousd))} ({pct(String(ratio))})</span></strong>
  <Progress value={ratio*100} label="Presupuesto de IA usado" tone={ratio>0.9?'warn':undefined} valueText={pct(String(ratio))??''}/>
  {ai.breakdown&&ai.breakdown.length>0?<TableWrap label="Uso de IA"><Table><thead><tr><th scope="col">Uso</th><th scope="col">Proveedor y modelo</th><th scope="col">Tipo</th><th scope="col" className="num">Llamadas</th><th scope="col" className="num">Costo</th></tr></thead>
   <tbody>{ai.breakdown.map(b=><tr key={b.provider+b.model+b.task+b.category}><th scope="row">{taskLabels[b.task]??b.task}</th><td data-label="Proveedor y modelo">{b.provider} · {b.model}</td><td data-label="Tipo">{categoryLabels[b.category]??b.category}</td><td data-label="Llamadas" className="num">{b.attempts}</td><td data-label="Costo" className="num">{usd(String(b.chargedMicrousd))}{b.unknownAttempts?` · ${b.unknownAttempts} sin confirmar`:''}</td></tr>)}</tbody></Table></TableWrap>
   :<p className="muted">Todavía no hay llamadas a la IA en este periodo.</p>}
 </Card>;
}
