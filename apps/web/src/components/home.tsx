import {useEffect,useMemo,useState} from 'react';
import {ArrowRight,Bell,CircleCheck,MessageSquare,Package,ReceiptText,Smartphone,Sparkles,Wallet} from 'lucide-react';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import type {ProfileSalesRow} from '../../../../packages/contracts/src/profile-sales-consumer.js';
import {sessionProfileSales} from '../../../../packages/commerce-client/src/profile-sales.js';
import type {ProfileFence} from '../lib/profile-request.js';
import {loadHome,loadSales,moneyMinor,type Home as HomeData,type Sales} from '../lib/home-data.js';
import {loadOnboarding,updateOnboarding,type Onboarding} from '../lib/profile-integrations.js';
import {Button,ButtonLink,Card,CardHead,EmptyState,ErrorState,Kpi,Progress,Skeleton,Table,TableWrap} from './ui';

/** V7 Inicio (RF-04, canvas «Inicio»): greeting and context, «Siguiente
 * acción» first with the secondary pending items beside it, four figures of
 * the day, recent conversations and the compact setup guide. Figures come
 * from the same persisted results as Resultados; nothing is estimated. */
const nextAction:Record<string,{text:(h:HomeData)=>string;detail:string;href:string;cta:string}>={
 REVIEW_RECEIPTS:{text:h=>`Revisar ${h.pending.receiptsToReview} comprobante${h.pending.receiptsToReview===1?'':'s'}`,detail:'Cada comprobante aprobado entrega el producto al cliente y cuenta como venta.',href:'/sales/receipts',cta:'Revisar comprobantes'},
 RECONNECT_NUMBERS:{text:h=>`Reconectar ${h.numbers.causes.DISCONNECTED} número${h.numbers.causes.DISCONNECTED===1?'':'s'}`,detail:'Un número desconectado no responde a nadie: vuelve a escanear su QR.',href:'/numbers',cta:'Ir a Números'},
 REVIEW_ALERTS:{text:h=>`Revisar ${h.pending.alerts} aviso${h.pending.alerts===1?'':'s'}`,detail:'Hay avisos abiertos sobre tus números.',href:'/numbers',cta:'Ver avisos'},
};
const onboardingSteps=[
 {key:'ai',title:'Conecta tu inteligencia artificial',text:'Guarda la clave de tu proveedor; la verificamos con una consulta mínima.',href:'/account/integrations',cta:'Configurar IA'},
 {key:'meta',title:'Conecta Meta (opcional)',text:'Para consultar tus campañas y resultados. Puedes omitirlo.',href:'/account/integrations#meta',cta:'Conectar Meta'},
 {key:'product',title:'Crea tu primer producto',text:'Un producto con su primera variante de mercado.',href:'/products',cta:'Crear producto'},
 {key:'number',title:'Agrega tu primer número',text:'Vincula un número de WhatsApp escaneando su código QR.',href:'/numbers',cta:'Agregar número'},
] as const;
const stepState={DONE:'done',SKIPPED:'skipped',PENDING:'pending'} as const;
const words:Record<string,string>={OPEN:'Abierta',CLOSED:'Cerrada',PENDING:'Pendiente',PAID:'Pagada',AWAITING_AGREEMENT:'Esperando acuerdo',AWAITING_PAYMENT:'Esperando pago',AWAITING_RECEIPT:'Esperando comprobante',FULFILLED:'Entregada'};
const str=(v:unknown,fallback:string)=>typeof v==='string'&&v?v:fallback;
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
function greeting(timezone:string){const h=Number(new Intl.DateTimeFormat('en-US',{hour:'numeric',hour12:false,timeZone:timezone}).format(new Date()));return h<12?'Buenos días':h<19?'Buenas tardes':'Buenas noches';}
function since(iso:string,timezone:string){try{const d=new Date(iso),diff=Date.now()-d.getTime();if(diff<3600000)return `hace ${Math.max(1,Math.round(diff/60000))} min`;if(diff<86400000)return `hace ${Math.round(diff/3600000)} h`;return new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeZone:timezone}).format(d);}catch{return '';}}

export function Home({selection,role,state,businessName,userName,timezone}:{selection:ProfileFence;role:ProfileRole;state:ProfileState;businessName:string;userName:string;timezone:string}){
 const [home,setHome]=useState<HomeData|null>(null),[sales,setSales]=useState<Sales|null>(null),[salesFailed,setSalesFailed]=useState(false),[error,setError]=useState(''),[tick,setTick]=useState(0);
 useEffect(()=>{const c=new AbortController();setError('');
  loadHome(selection,c.signal).then(v=>{if(!c.signal.aborted)setHome(v);}).catch(e=>{if(!c.signal.aborted)setError(e instanceof Error?e.message:'No se pudo consultar el resumen.');});
  setSalesFailed(false);loadSales(selection,timezone,c.signal).then(v=>{if(!c.signal.aborted)setSales(v);}).catch(()=>{if(!c.signal.aborted)setSalesFailed(true);});
  return()=>c.abort();},[selection.workspaceId,selection.version,timezone,tick]);
 const today=new Intl.DateTimeFormat('es-MX',{weekday:'long',day:'numeric',month:'long',timeZone:timezone}).format(new Date());
 const action=home?.next&&home.next.kind!=='ONBOARDING'?nextAction[home.next.kind]:undefined;
 const causes=home?[home.numbers.causes.DISCONNECTED&&`${home.numbers.causes.DISCONNECTED} desconectado${home.numbers.causes.DISCONNECTED===1?'':'s'}`,home.numbers.causes.PAUSED&&`${home.numbers.causes.PAUSED} en pausa`,home.numbers.causes.NOT_AUTHORIZED&&`${home.numbers.causes.NOT_AUTHORIZED} sin autorización para vender`].filter(Boolean):[];
 const context=home?`${home.numbers.attending} de ${home.numbers.registered} número${home.numbers.registered===1?'':'s'} atendiendo${causes.length?` · ${causes.join(' · ')}`:''}`:'';
 const pending:{label:string;href:string;count:number;icon:typeof Bell}[]=home?[
  {label:'Comprobantes por revisar',href:'/sales/receipts',count:home.pending.receiptsToReview,icon:ReceiptText},
  {label:'Avisos de números',href:'/numbers',count:home.pending.alerts,icon:Bell},
  {label:'Números desconectados',href:'/numbers',count:home.numbers.causes.DISCONNECTED,icon:Smartphone},
 ].filter(p=>p.count>0&&!(action&&action.href===p.href&&action.text(home).includes(p.label.split(' ')[0]!.toLowerCase())))
 :[];
 return <>
  <header className="page-header">
   <div><h1 id="page-title">Inicio · {businessName}</h1><p>{greeting(timezone)}, {userName}. Hoy es {today}{context?`. ${context}.`:'.'}</p></div>
  </header>
  {error&&<ErrorState message={error} onRetry={()=>setTick(t=>t+1)}/>}
  <div className="layout-2-1">
   <Card aria-labelledby="next-title" className="next-action">
    <CardHead id="next-title" title="Siguiente acción" description={home?(action?'Lo que más conviene resolver ahora.':'No hay nada urgente. Tus números están atendiendo.'):undefined}/>
    {!home&&!error&&<Skeleton lines={2}/>}
    {home&&action&&<div className="next-action-body">
     <strong className="next-action-text">{action.text(home)}</strong>
     <p className="muted">{action.detail}</p>
     <ButtonLink href={action.href}>{action.cta}<ArrowRight aria-hidden="true"/></ButtonLink>
    </div>}
    {home&&!action&&<div className="next-action-body">
     <strong className="next-action-text"><CircleCheck aria-hidden="true" style={{color:'var(--success)',verticalAlign:'-4px'}}/> Todo al día</strong>
     <p className="muted">{home.numbers.registered===0?'Agrega un número y asígnale una variante publicada para empezar a vender.':'Puedes revisar las conversaciones recientes o los resultados de la semana.'}</p>
     <div className="cluster"><a href="/sales/inbox" className="btn" data-variant="secondary">Atender conversaciones</a><a href="/results" className="btn" data-variant="ghost">Ver resultados</a></div>
    </div>}
   </Card>
   <Card aria-labelledby="pending-title" compact>
    <CardHead id="pending-title" title="Pendientes" level={3}/>
    {!home&&!error&&<Skeleton lines={3}/>}
    {home&&pending.length===0&&<p className="muted">Sin pendientes secundarios.</p>}
    {home&&pending.length>0&&<ul className="pending-list">{pending.map(p=>{const Icon=p.icon;return <li key={p.label}><a href={p.href}><Icon aria-hidden="true"/><span>{p.label}</span><strong className="num">{p.count}</strong></a></li>;})}</ul>}
    {home&&home.pending.criticalAlerts>0&&<p role="status" className="alert" data-tone="warn">Hay {home.pending.criticalAlerts} aviso{home.pending.criticalAlerts===1?'':'s'} importante{home.pending.criticalAlerts===1?'':'s'} sobre tus números.</p>}
   </Card>
  </div>
  <section aria-label="Cifras de hoy" className="kpi-grid">
   <Kpi icon={<Wallet aria-hidden="true"/>} label="Ingresos de hoy" value={sales?moneyMinor(sales.today.revenue,sales.currency):salesFailed?'Sin datos':'—'} missing={salesFailed} hint={sales?`${sales.today.sales} venta${sales.today.sales==='1'?'':'s'} · ${sales.currency}`:salesFailed?'Los resultados no están disponibles.':'Consultando…'}/>
   <Kpi icon={<Sparkles aria-hidden="true"/>} label="Esta semana" value={sales?moneyMinor(sales.week.revenue,sales.currency):salesFailed?'Sin datos':'—'} missing={salesFailed} hint={sales?`${sales.week.sales} venta${sales.week.sales==='1'?'':'s'} desde el lunes`:salesFailed?'Los resultados no están disponibles.':'Consultando…'}/>
   <Kpi icon={<MessageSquare aria-hidden="true"/>} label="Conversaciones hoy" value={home?String(home.today.conversations):'—'} hint={home?`${home.today.orders} pedido${home.today.orders===1?'':'s'}`:'Consultando…'}/>
   <Kpi icon={<ReceiptText aria-hidden="true"/>} label="Pagos aprobados hoy" value={home?String(home.today.approvedReceipts):'—'} hint={home?(home.pending.receiptsToReview?`${home.pending.receiptsToReview} por revisar`:'Nada por revisar'):'Consultando…'}/>
  </section>
  <div className="layout-2-1">
   <RecentConversations selection={selection} timezone={timezone}/>
   <div className="stack">
    <Setup selection={selection} role={role} state={state}/>
    <MonthGoalCard sales={sales}/>
   </div>
  </div>
 </>;
}

function RecentConversations({selection,timezone}:{selection:ProfileFence;timezone:string}){
 const client=useMemo(()=>sessionProfileSales(selection),[selection.workspaceId,selection.version]);
 const [rows,setRows]=useState<ProfileSalesRow[]|null>(null),[error,setError]=useState(false),[tick,setTick]=useState(0);
 useEffect(()=>{const c=new AbortController();setError(false);client.read({operation:'list',resource:'conversations',environment:'REAL',limit:5,offset:0},c.signal).then(v=>{if(!c.signal.aborted)setRows(v.data);}).catch(()=>{if(!c.signal.aborted)setError(true);});return()=>c.abort();},[client,tick]);
 return <Card aria-labelledby="recent-title">
  <CardHead id="recent-title" title="Conversaciones recientes" actions={<a href="/sales/inbox" className="btn" data-variant="ghost">Ver todas<ArrowRight aria-hidden="true"/></a>}/>
  {rows===null&&!error&&<Skeleton lines={4}/>}
  {error&&<ErrorState message="No se pudo confirmar la lista de conversaciones." onRetry={()=>setTick(t=>t+1)}/>}
  {rows&&rows.length===0&&<EmptyState inline level={3} icon={<MessageSquare aria-hidden="true"/>} title="Todavía no hay conversaciones" description="Cuando un cliente escriba a uno de tus números, aparecerá aquí."/>}
  {rows&&rows.length>0&&<TableWrap><Table><thead><tr><th scope="col">Cliente</th><th scope="col">Estado</th><th scope="col">Última actividad</th><th scope="col"><span className="sr-only">Abrir</span></th></tr></thead>
   <tbody>{rows.map(r=>{const contact=object(r.contact);const title=str(r.name??r.title,str(contact.name,`Conversación ${r.id.slice(-6)}`));const status=typeof r.status==='string'?r.status:typeof r.stage==='string'?r.stage:'';return <tr key={r.id}>
    <td data-label="Cliente"><span className="row-title">{title}</span>{typeof contact.masked==='string'&&<span className="row-sub">{contact.masked}</span>}</td>
    <td data-label="Estado">{words[status]??(status.toLowerCase().replace(/_/g,' ')||'Sin estado')}</td>
    <td data-label="Última actividad">{since(r.updated_at,timezone)}</td>
    <td className="actions"><a href={`/sales/inbox?conversation=${r.id}`}>Abrir<span className="sr-only"> {title}</span></a></td>
   </tr>;})}</tbody></Table></TableWrap>}
 </Card>;
}

function MonthGoalCard({sales}:{sales:Sales|null}){
 if(!sales||!sales.goal)return null;
 const g=sales.goal,revenue=g.label==='Meta de ingresos',fmt=(v:string)=>revenue?moneyMinor(v,sales.currency):v,pct=g.ratio===null?null:Math.round(g.ratio*100);
 return <Card compact aria-labelledby="goal-title">
  <CardHead id="goal-title" title={g.label} level={3} description={`Del ${g.from} al ${g.to}`}/>
  <strong className="kpi-value" style={{fontSize:22}}>{g.actual===null?'Sin datos':fmt(g.actual)} <span className="muted" style={{fontWeight:400,fontSize:16}}>de {fmt(g.target)}</span></strong>
  <Progress value={pct??0} label={g.label} tone={g.met?'success':undefined} valueText={g.met?'Meta cumplida':pct===null?'Sin datos suficientes':`${pct} % del objetivo`}/>
  <p className="muted text-sm">{g.met?'Meta cumplida.':pct===null?'Sin datos suficientes.':`${pct} % del objetivo.`} <a href="/results">Ver en Resultados</a></p>
 </Card>;
}

/** RF-13.c / RF-04.d: four steps derived from saved facts; compact and
 * collapsible, so it never displaces the day's work. */
function Setup({selection,role,state}:{selection:ProfileFence;role:ProfileRole;state:ProfileState}){
 const [data,setData]=useState<Onboarding>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{const controller=new AbortController();setData(undefined);loadOnboarding(selection,controller.signal).then(setData).catch(failure=>{if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:'No se pudo consultar la configuración inicial.');});return()=>controller.abort();},[selection.workspaceId,selection.version]);
 if(error)return <p role="alert" className="alert" data-tone="error">{error}</p>;
 if(!data||data.complete||data.dismissed)return null;
 const owner=role==='owner'&&state==='ACTIVE';
 async function change(input:{metaSkipped?:boolean;dismissed?:boolean}){if(!data||busy)return;setBusy(true);setError('');try{setData(await updateOnboarding(selection,{expectedVersion:data.version,...input}));}catch(failure){setError(failure instanceof Error?failure.message:'No se pudo guardar.');}finally{setBusy(false);}}
 const next=onboardingSteps.find(step=>step.key===data.next),done=onboardingSteps.filter(s=>data.steps[s.key]!=='PENDING').length;
 return <details className="disclosure setup" open aria-labelledby="setup-title">
  <summary><Package aria-hidden="true" size={18} style={{color:'var(--accent)'}}/><span id="setup-title">Puesta en marcha</span><span className="muted" style={{fontWeight:400}}>{done} de {onboardingSteps.length}</span></summary>
  <div className="disclosure-body">
   <Progress value={done} max={onboardingSteps.length} label="Puesta en marcha" valueText={`${done} de ${onboardingSteps.length} pasos`}/>
   <ol className="steps">{onboardingSteps.map(step=>{const value=data.steps[step.key];return <li key={step.key} aria-current={step.key===data.next?'step':undefined} data-state={step.key===data.next?'current':stepState[value]}>
    <div><strong>{step.title}</strong>{step.key===data.next&&<p>{step.text}</p>}</div>
   </li>;})}</ol>
   {next&&<div className="form-actions"><a className="btn" data-variant="secondary" href={next.href}>{next.cta}</a>
    {next.key==='meta'&&owner&&<Button variant="ghost" disabled={busy} onClick={()=>{void change({metaSkipped:true});}}>Omitir Meta por ahora</Button>}</div>}
   {owner&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>{void change({dismissed:true});}}>Ocultar esta guía</Button>}
  </div>
 </details>;
}
