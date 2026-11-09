import {useCallback,useEffect,useRef,useState} from 'react';
import type {ProfileFence} from '../lib/profile-request.js';
import type {MetaInventoryView} from '../../../../packages/contracts/src/meta-portfolios.js';
import {campaignCsv} from '../../../../packages/contracts/src/campaign-export.js';
import {variantRequest,errorText} from '../lib/variants.js';
import {profileToday} from '../lib/results.js';
import {Alert,Badge,Button,Card,CardHead,EmptyState,Input,Kpi,NativeSelect,PageHeader,Segmented,Skeleton,Table,TableWrap} from './ui';
import {Download,Megaphone,RefreshCw} from 'lucide-react';

interface Row {id?:string;name:string;kind?:string;portfolio_id?:string|null;meta_ad_account_id?:string|null;timezone?:string;campaign_id?:string|null;ad_id?:string|null;spend_minor:number|null;net_spend_observed_minor?:number|null;revenue_minor:number;attributed_revenue_minor:number;sales:number;attributed_sales:number;conversations:string|null;impressions:string|null;clicks:string|null;roas:number|null;cpa_minor:number|null;ctr?:number|null;cpc_minor?:number|null;cpm_minor?:number|null;cost_per_meta_conversation_minor?:number|null;quality?:{status:string}}
interface Sync {credential:string;last_sync:{status:string;requested_at:string;updated_at:string;issues:string[]}|null}
interface View {connected:boolean;note?:string;sync?:Sync;inventory?:MetaInventoryView;accounts:{id:string;name:string;currency:string;timezone:string;status:string;last_success_at:string|null}[];
 report:{filters:{currency:string;from:string;to:string};summary:Row;groups:{accounts:Row[];portfolios:Row[];campaigns:Row[];ads:Row[];products:Row[]};quality:{status:string;today_included?:boolean;blockers?:string[];unattributed:{sales:number;revenue_minor:number}}}|null}
type Preset='7'|'30'|'90'|'month'|'custom';
const shift=(day:string,d:number)=>new Date(Date.parse(day)+d*86400000).toISOString().slice(0,10);
const times=(v:number|null)=>v===null?'—':`${v.toFixed(2)}×`;
function money(minor:number|null|undefined,currency:string){if(minor==null)return'—';try{const d=new Intl.NumberFormat('es-MX',{style:'currency',currency}).resolvedOptions().maximumFractionDigits??2;return new Intl.NumberFormat('es-MX',{style:'currency',currency,maximumFractionDigits:d}).format(minor/10**d);}catch{return String(minor);}}
function spend(row:Row,currency:string){if(row.spend_minor!==null)return money(row.spend_minor,currency);return row.net_spend_observed_minor!=null?`${money(row.net_spend_observed_minor,currency)} *`:'Sin dato';}
const states:Record<string,string>={PENDING:'Cargando',RUNNING:'Cargando',SYNCED:'Completa',PARTIAL:'Parcial',UNAVAILABLE:'Sin dato',NOT_READ:'Sin leer',STALE:'Lectura vencida',CANCELLED:'Cancelada'};
function savedFilters(workspaceId:string){const q=new URLSearchParams(window.location.search);return q.get('meta_profile')===workspaceId?q:new URLSearchParams();}
export function Campaigns(props:{selection:ProfileFence;timezone:string}){return <CampaignReport key={`${props.selection.workspaceId}:${props.selection.version}`} {...props}/>;}
function CampaignReport({selection,timezone}:{selection:ProfileFence;timezone:string}){
 const [saved]=useState(()=>savedFilters(selection.workspaceId)),today=profileToday(timezone);
 const [preset,setPreset]=useState<Preset>(()=>{const p=saved.get('period');return ['7','30','90','month','custom'].includes(p??'')?p as Preset:'30';});
 const [currency,setCurrency]=useState(saved.get('currency')??'MXN'),[portfolio,setPortfolio]=useState(saved.get('portfolio_id')??''),[account,setAccount]=useState(saved.get('meta_ad_account_id')??''),[campaign,setCampaign]=useState(saved.get('campaign_id')??'');
 const [customFrom,setCustomFrom]=useState(saved.get('from')??shift(today,-29)),[customTo,setCustomTo]=useState(saved.get('to')??today);
 const [view,setView]=useState<View|null>(null),[viewQuery,setViewQuery]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[syncNote,setSyncNote]=useState('');
 const generation=useRef(0),from=preset==='custom'?customFrom:preset==='month'?today.slice(0,8)+'01':shift(today,-(Number(preset)-1)),to=preset==='custom'?customTo:today;
 const valid=!!from&&!!to&&from<=to&&(Date.parse(to)-Date.parse(from))/86400000<3660;
 const query=new URLSearchParams({from,to,currency,granularity:'day',...(portfolio?{portfolio_id:portfolio}:{}),...(account?{meta_ad_account_id:account}:{}),...(campaign?{campaign_id:campaign}:{})}).toString();
 const load=useCallback(async(signal?:AbortSignal)=>{if(!valid)return;const n=++generation.current;setBusy(true);setError('');
  try{const next=await variantRequest<View>(selection,'GET','/v2/campaigns?'+query,undefined,undefined,signal);if(!signal?.aborted&&generation.current===n){setView(next);setViewQuery(query);}}
  catch(e){if(!signal?.aborted&&generation.current===n)setError(errorText(e,'No se pudieron consultar las campañas.'));}
  finally{if(!signal?.aborted&&generation.current===n)setBusy(false);}},[selection,query,valid]);
 useEffect(()=>{const c=new AbortController();void load(c.signal);return()=>{c.abort();generation.current++;};},[load]);
 const pending=view?.inventory?.operations.some(o=>o.pending>0)??false;
 useEffect(()=>{if(!pending)return;const c=new AbortController(),timer=setInterval(()=>void load(c.signal),10000);return()=>{clearInterval(timer);c.abort();};},[pending,load]);
 useEffect(()=>{const q=new URLSearchParams(query);q.set('period',preset);q.set('meta_profile',selection.workspaceId);window.history.replaceState(null,'',window.location.pathname+'?'+q);},[query,preset,selection.workspaceId]);
 async function refresh(){setSyncNote('');try{
  if(view?.inventory?.counts.selectedPortfolios){await variantRequest(selection,'POST','/v2/meta/sync',{operationId:crypto.randomUUID(),...(portfolio?{portfolio_id:portfolio}:{}),...(account?{meta_ad_account_id:account}:{}),...(Date.parse(to)-Date.parse(from)<90*86400000?{from,to}:{})});}
  else await variantRequest(selection,'POST','/v2/campaigns/sync',{},crypto.randomUUID());
  setSyncNote('Lectura solicitada. El progreso se actualizará automáticamente.');await load();
 }catch(e){setSyncNote(errorText(e,'No se pudo pedir la lectura. Sólo el dueño del perfil puede hacerlo.'));}}
 function exportCsv(){if(!view?.report||viewQuery!==query)return;const url=URL.createObjectURL(new Blob(['\uFEFF',campaignCsv(view.report)],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`commerce-meta-${from}-${to}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 const r=viewQuery===query?view?.report:null,s=r?.summary,inventory=view?.inventory,accounts=inventory?.accounts.filter(a=>!portfolio||a.portfolioId===portfolio)??view?.accounts.map(a=>({...a,portfolioId:null}))??[];
 const currencies=[...new Set([currency,...(view?.accounts.map(a=>a.currency)??[])])],portfolios=inventory?.portfolios.filter(p=>p.selected||p.id===portfolio)??[];
 const selectPortfolio=(id:string)=>{setPortfolio(id);setAccount('');setCampaign('');};
 const selectAccount=(id:string)=>{setAccount(id);setCampaign('');};
 return <>
  <PageHeader title="Campañas" description="Gasto y resultados de Meta junto a las ventas aprobadas de Commerce OS, por portafolio y cuenta publicitaria." actions={<div className="cluster">{view?.connected&&<Button variant="secondary" disabled={busy||!valid} onClick={()=>void refresh()}><RefreshCw aria-hidden="true"/>Actualizar datos de Meta</Button>}{r&&<Button variant="secondary" disabled={busy} onClick={exportCsv}><Download aria-hidden="true"/>Exportar CSV</Button>}</div>}/>
  <div className="toolbar">
   <label>Portafolio<NativeSelect aria-label="Portafolio" value={portfolio} onChange={e=>selectPortfolio(e.target.value)}><option value="">Todos</option>{portfolios.map(p=><option key={p.id} value={p.id}>{p.name} · {p.id.slice(-6)}</option>)}</NativeSelect></label>
   <label>Cuenta publicitaria<NativeSelect aria-label="Cuenta publicitaria" value={account} onChange={e=>selectAccount(e.target.value)}><option value="">Todas</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name} · {a.id.slice(-6)}</option>)}</NativeSelect></label>
   <label>Moneda<NativeSelect aria-label="Moneda" value={currency} onChange={e=>setCurrency(e.target.value)}>{currencies.map(c=><option key={c}>{c}</option>)}</NativeSelect></label>
   <Segmented label="Periodo" value={preset} onChange={setPreset} options={[{value:'7',label:'7 días'},{value:'30',label:'30 días'},{value:'90',label:'90 días'},{value:'month',label:'Este mes'},{value:'custom',label:'Personalizado'}]}/>
   {preset==='custom'&&<><label>Desde<Input aria-label="Desde" type="date" value={customFrom} onChange={e=>setCustomFrom(e.target.value)}/></label><label>Hasta<Input aria-label="Hasta" type="date" value={customTo} onChange={e=>setCustomTo(e.target.value)}/></label></>}
  </div>
  {campaign&&<Button variant="ghost" onClick={()=>setCampaign('')}>Quitar filtro de campaña · {campaign}</Button>}
  {!valid&&<Alert tone="warn">Elige un periodo válido, de hasta diez años. Cada solicitud de carga admite hasta 90 días.</Alert>}
  {error&&<Alert tone="error">{error}</Alert>}{!view&&!error&&<Skeleton block/>}
  {view&&!view.connected&&<EmptyState icon={<Megaphone aria-hidden="true"/>} title="Conecta Meta" description="Revisa tus conexiones para actualizar los resultados. El histórico disponible se conserva." action={<a href="/account/integrations" className="btn" data-variant="default">Ir a Integraciones</a>}/>}
  {syncNote&&<Alert tone="info" role="status">{syncNote}</Alert>}
  {inventory&&<p className="muted text-sm" role="status">{inventory.counts.selectedPortfolios} portafolios seleccionados · {inventory.counts.includedAccounts} cuentas incluidas · {pending?'Cargando bloques de Meta. Puedes seguir consultando.':'Sin lecturas pendientes.'} <a href="/account/integrations" style={{textDecoration:'underline'}}>Ver conexiones y cobertura</a></p>}
  {s&&r&&<div className="stack" aria-busy={busy} style={{gap:'var(--space-5)',opacity:busy?0.6:1}}>
   {r.quality.today_included&&<Alert tone="info">El periodo incluye el día de hoy; sus resultados todavía pueden cambiar.</Alert>}
   {r.quality.blockers?.includes('MIXED_TIMEZONES')&&<Alert tone="warn">Hay cuentas con calendarios distintos. Los importes observados se muestran por zona; selecciona una cuenta para ver ratios comparables.</Alert>}
   <section aria-label="Resumen" className="kpi-grid">
    <Kpi label="Gasto de Meta" value={spend(s,currency)} hint={s.spend_minor===null?'* Importe observado; faltan datos comparables.':undefined}/>
    <Kpi label="Ventas atribuidas" value={String(s.attributed_sales)} hint="Pagos aprobados en Commerce OS."/>
    <Kpi label="Ingresos atribuidos" value={money(s.attributed_revenue_minor,currency)}/>
    <Kpi label="ROAS Commerce" value={times(s.roas)} missing={s.roas===null}/>
    <Kpi label="Costo por venta" value={s.cpa_minor===null?(s.attributed_sales===0?'Sin ventas':'Sin dato'):money(s.cpa_minor,currency)} missing={s.cpa_minor===null}/>
    <Kpi label="Conversaciones de Meta" value={s.conversations??'Sin dato'} missing={s.conversations===null}/>
   </section>
   <ResultTable title="Por portafolio" rows={r.groups.portfolios??[]} currency={currency} drill={row=>selectPortfolio(row.id!)} />
   <ResultTable title="Por cuenta" rows={r.groups.accounts??[]} currency={currency} drill={row=>selectAccount(row.meta_ad_account_id!)} />
   <ResultTable title="Por campaña" rows={r.groups.campaigns} currency={currency} drill={row=>{if(row.campaign_id){setAccount(row.meta_ad_account_id??'');setCampaign(row.campaign_id);}}}/>
   <details className="disclosure quiet"><summary>Por anuncio ({r.groups.ads.length})</summary><ResultTable title="Por anuncio" rows={r.groups.ads} currency={currency}/></details>
   <details className="disclosure quiet"><summary>Por producto</summary><ResultTable title="Por producto" rows={r.groups.products} currency={currency}/></details>
   <Card><CardHead title="Sin atribución"/><p>{r.quality.unattributed.sales} ventas · {money(r.quality.unattributed.revenue_minor,currency)}. {portfolio||account?'Este ámbito sólo incluye ventas con cuenta verificable.':'Las ventas sin evidencia de anuncio permanecen en el perfil; no se reparten entre portafolios.'}</p></Card>
   <p className="muted text-sm">Meta: gasto, impresiones, clics (todos) y conversaciones reportadas. Commerce OS: pagos aprobados, excluyendo pruebas, falsos y duplicados. El ROAS compara ingresos aprobados en el periodo con gasto de ese periodo; no sigue una cohorte de clics. * Importe parcial observado. Los ratios se recalculan desde totales.</p>
  </div>}
 </>;
}
function ResultTable({title,rows,currency,drill}:{title:string;rows:Row[];currency:string;drill?:(row:Row)=>void}){
 return <Card><CardHead title={title}/>{rows.length===0?<p className="muted">Sin actividad en este ámbito.</p>:<TableWrap label={title}><Table><thead><tr><th scope="col">Nombre</th><th scope="col">Calidad</th><th scope="col" className="num">Gasto</th><th scope="col" className="num">Conversaciones</th><th scope="col" className="num">Costo / conversación</th><th scope="col" className="num">Ventas atribuidas</th><th scope="col" className="num">Ingresos atribuidos</th><th scope="col" className="num">ROAS</th><th scope="col">Más métricas</th></tr></thead><tbody>{rows.map((row,i)=><tr key={`${row.id??row.name}:${row.timezone}:${row.portfolio_id}:${i}`}>
  <th scope="row">{drill?<Button variant="ghost" onClick={()=>drill(row)}>{row.name}</Button>:row.name}<span className="muted text-sm" style={{display:'block'}}>{row.id??row.meta_ad_account_id} {row.timezone}</span></th>
  <td data-label="Calidad"><Badge tone={row.quality?.status==='SYNCED'?'success':'warn'}>{states[row.quality?.status??'']??'Ver cobertura'}</Badge></td>
  <td data-label="Gasto" className="num">{spend(row,currency)}</td><td data-label="Conversaciones" className="num">{row.conversations??'Sin dato'}</td><td data-label="Costo / conversación" className="num">{money(row.cost_per_meta_conversation_minor,currency)}</td>
  <td data-label="Ventas atribuidas" className="num">{row.attributed_sales}</td><td data-label="Ingresos atribuidos" className="num">{money(row.attributed_revenue_minor,currency)}</td><td data-label="ROAS" className="num">{times(row.roas)}</td>
  <td><details className="disclosure quiet"><summary>Métricas</summary><p>Impresiones: {row.impressions??'Sin dato'} · Clics (todos): {row.clicks??'Sin dato'} · CTR: {row.ctr==null?'—':row.ctr.toFixed(2)+'%'} · CPC: {money(row.cpc_minor,currency)} · CPM: {money(row.cpm_minor,currency)}</p></details></td>
 </tr>)}</tbody></Table></TableWrap>}</Card>;
}
