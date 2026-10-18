import {useCallback,useEffect,useState} from 'react';
import type {ProfileFence} from '../lib/profile-request.js';
import {variantRequest,errorText} from '../lib/variants.js';
import {profileToday} from '../lib/results.js';
import {Alert,Badge,Button,Card,CardHead,EmptyState,Kpi,NativeSelect,PageHeader,Segmented,Skeleton,Table,TableWrap} from './ui';
import {Megaphone,RefreshCw} from 'lucide-react';

/** V7 F7 Campañas (RF-11, RF-09.k): what each campaign spent and the sales it
 * brought, crossed with approved payments. Read only: there is no button that
 * creates, pauses or funds anything; «Actualizar datos de Meta» only asks for a
 * new GET read with the profile's own token. */
interface Row {name:string;kind?:string;campaign_id:string|null;ad_id?:string|null;spend_minor:number|null;net_spend_observed_minor?:number|null;revenue_minor:number;attributed_revenue_minor:number;sales:number;attributed_sales:number;conversations:string|null;impressions:string|null;clicks:string|null;roas:number|null;cpa_minor:number|null}
interface Sync {credential:string;last_sync:{status:string;requested_at:string;updated_at:string;issues:string[]}|null}
interface View {connected:boolean;note?:string;sync?:Sync;accounts:{id:string;name:string;currency:string;timezone:string;status:string;last_success_at:string|null}[];
 report:{summary:Row;groups:{campaigns:Row[];ads:Row[];products:(Row&{source?:string})[]};quality:{status:string;unattributed:{sales:number;revenue_minor:number}}}|null}
type Preset='7'|'30'|'month';
const shift=(day:string,d:number)=>new Date(Date.parse(day)+d*86400000).toISOString().slice(0,10);
/** Spend: the complete figure, or what Meta reported for the covered days. */
function spend(row:Row,currency:string){if(row.spend_minor!==null)return money(row.spend_minor,currency);return row.net_spend_observed_minor!=null?`${money(row.net_spend_observed_minor,currency)} *`:'Sin datos de gasto';}
function money(minor:number|null,currency:string){if(minor===null)return'—';try{const d=new Intl.NumberFormat('es-MX',{style:'currency',currency}).resolvedOptions().maximumFractionDigits??2;return new Intl.NumberFormat('es-MX',{style:'currency',currency,maximumFractionDigits:d}).format(minor/10**d);}catch{return String(minor);}}
const syncLabel:Record<string,string>={PENDING:'pendiente',RUNNING:'leyendo',SYNCED:'completa',PARTIAL:'parcial',UNAVAILABLE:'no disponible',CANCELLED:'cancelada'};
function syncText(sync:Sync|undefined){const last=sync?.last_sync;if(!last)return'Aún no hay lecturas de Meta.';return`Última lectura de Meta: ${syncLabel[last.status]??last.status.toLowerCase()} (${new Date(last.updated_at).toLocaleString('es-MX')})${last.issues.length?` · avisos: ${last.issues.join(', ')}`:''}.`;}
const times=(v:number|null)=>v===null?'—':`${v.toFixed(2)}×`;
export function Campaigns({selection,timezone}:{selection:ProfileFence;timezone:string}){
 const today=profileToday(timezone),[preset,setPreset]=useState<Preset>('30'),[currency,setCurrency]=useState('MXN'),[view,setView]=useState<View|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=useCallback(async(p:Preset,cur:string,signal?:AbortSignal)=>{setBusy(true);setError('');
  const from=p==='7'?shift(today,-6):p==='month'?today.slice(0,8)+'01':shift(today,-29);
  try{const v=await variantRequest<View>(selection,'GET',`/v2/campaigns?from=${from}&to=${today}&currency=${cur}&granularity=day`,undefined,undefined,signal);setView(v);
   if(v.accounts.length&&!v.accounts.some(a=>a.currency===cur)){const first=v.accounts[0]!.currency;setCurrency(first);}}
  catch(e){if(!signal?.aborted)setError(errorText(e,'No se pudieron consultar las campañas.'));}finally{if(!signal?.aborted)setBusy(false);}},[selection,today]);
 useEffect(()=>{const c=new AbortController();void load(preset,currency,c.signal);return()=>c.abort();},[load,preset,currency]);
 const [syncNote,setSyncNote]=useState('');
 const refresh=async()=>{setSyncNote('');try{const r=await variantRequest<{status:string}>(selection,'POST','/v2/campaigns/sync',{},crypto.randomUUID());
  setSyncNote(r.status==='QUEUED'?'Pedimos una lectura nueva a Meta. Los datos se actualizan en unos minutos.':'Ya hay una lectura en curso.');void load(preset,currency);}
  catch(e){setSyncNote(errorText(e,'No se pudo pedir la lectura. Sólo el dueño del perfil puede hacerlo.'));}};
 const r=view?.report,s=r?.summary,currencies=[...new Set(view?.accounts.map(a=>a.currency)??[])];
 return <>
  <PageHeader title="Campañas" description="Sólo lectura: lo que gastaron tus anuncios y lo que vendieron, cruzado con los pagos aprobados. Nada de esta página cambia tus campañas ni tu presupuesto en Meta." actions={view?.connected?<Button variant="secondary" onClick={()=>void refresh()}><RefreshCw aria-hidden="true"/>Actualizar datos de Meta</Button>:undefined}/>
  <div className="toolbar">
   <Segmented label="Periodo" value={preset} onChange={setPreset} options={[{value:'7',label:'7 días'},{value:'30',label:'30 días'},{value:'month',label:'Este mes'}]}/>
   {currencies.length>1&&<label className="toolbar-sort"><span className="muted text-sm">Moneda</span><NativeSelect aria-label="Moneda" value={currency} onChange={e=>setCurrency(e.target.value)}>{currencies.map(c=><option key={c}>{c}</option>)}</NativeSelect></label>}
  </div>
  {error&&<Alert tone="error">{error}</Alert>}{!view&&!error&&<div className="kpi-grid" aria-hidden="true"><Skeleton block/><Skeleton block/><Skeleton block/></div>}
  {view&&!view.connected&&<EmptyState icon={<Megaphone aria-hidden="true"/>} title="Conecta Meta" description={view.note} action={<a href="/account/integrations" className="btn" data-variant="default">Ir a Integraciones</a>}/>}
  {view?.connected&&<Alert tone="info" role="status">{syncText(view.sync)}{!view.report&&view.note?` ${view.note}`:''}{syncNote?` ${syncNote}`:''}</Alert>}
  {s&&r&&<div className="stack" aria-busy={busy} style={{gap:'var(--space-5)',opacity:busy?0.6:1}}>
   <section aria-label="Resumen" className="kpi-grid">
    <Kpi label="Gasto" value={spend(s,currency)} hint={s.spend_minor===null?'* Faltan días de Meta en el periodo; es lo reportado hasta ahora.':undefined}/>
    <Kpi label="Ventas por anuncios" value={String(s.attributed_sales)} hint={`de ${s.sales} ventas en total`}/>
    <Kpi label="Ingresos por anuncios" value={money(s.attributed_revenue_minor,currency)}/>
    <Kpi label="ROAS" value={times(s.roas)} missing={s.roas===null} hint="Ingresos atribuidos por cada peso invertido."/>
    <Kpi label="Costo por venta" value={s.cpa_minor===null?'Sin ventas atribuidas':money(Math.round(s.cpa_minor),currency)} missing={s.cpa_minor===null}/>
    <Kpi label="Conversaciones de Meta" value={s.conversations??'Sin dato'} missing={s.conversations===null}/>
   </section>
   <Card aria-labelledby="campaigns-list"><CardHead id="campaigns-list" title="Por campaña"/>
    {r.groups.campaigns.length===0?<p className="muted">No hubo gasto ni ventas atribuidas en el periodo.</p>:<TableWrap label="Por campaña"><Table><thead><tr><th scope="col">Campaña</th><th scope="col" className="num">Gasto</th><th scope="col" className="num">Conversaciones</th><th scope="col" className="num">Ventas</th><th scope="col" className="num">Ingresos</th><th scope="col" className="num">ROAS</th></tr></thead>
     <tbody>{r.groups.campaigns.map(c=><tr key={(c.campaign_id??c.name)+c.name}><th scope="row">{c.name}</th><td data-label="Gasto" className="num">{spend(c,currency)}</td><td data-label="Conversaciones" className="num">{c.conversations??'—'}</td><td data-label="Ventas" className="num">{c.sales}</td><td data-label="Ingresos" className="num">{money(c.revenue_minor,currency)}</td><td data-label="ROAS" className="num">{times(c.roas)}</td></tr>)}</tbody></Table></TableWrap>}
    <details className="disclosure quiet"><summary>Por anuncio ({r.groups.ads.length})</summary><div className="disclosure-body"><TableWrap label="Por anuncio"><Table><thead><tr><th scope="col">Anuncio</th><th scope="col" className="num">Gasto</th><th scope="col" className="num">Ventas</th><th scope="col" className="num">Ingresos</th><th scope="col" className="num">ROAS</th></tr></thead>
     <tbody>{r.groups.ads.map(a=><tr key={(a.ad_id??a.name)+a.name}><th scope="row">{a.name}</th><td data-label="Gasto" className="num">{spend(a,currency)}</td><td data-label="Ventas" className="num">{a.sales}</td><td data-label="Ingresos" className="num">{money(a.revenue_minor,currency)}</td><td data-label="ROAS" className="num">{times(a.roas)}</td></tr>)}</tbody></Table></TableWrap></div></details>
    <details className="disclosure quiet"><summary>Por producto</summary><div className="disclosure-body"><TableWrap label="Por producto"><Table><thead><tr><th scope="col">Producto</th><th scope="col" className="num">Gasto</th><th scope="col" className="num">Ventas</th><th scope="col" className="num">Ingresos</th><th scope="col" className="num">ROAS</th></tr></thead>
     <tbody>{r.groups.products.map(p=><tr key={p.name+(p.source??'')}><th scope="row">{p.name}</th><td data-label="Gasto" className="num">{spend(p,currency)}</td><td data-label="Ventas" className="num">{p.sales}</td><td data-label="Ingresos" className="num">{money(p.revenue_minor,currency)}</td><td data-label="ROAS" className="num">{times(p.roas)}</td></tr>)}</tbody></Table></TableWrap></div></details>
   </Card>
   <p className="muted text-sm">Ventas e ingresos cuentan pagos aprobados en la hoja de pagos; una venta se atribuye a un anuncio sólo con evidencia del anuncio. {r.quality.unattributed.sales>0?`${r.quality.unattributed.sales} venta${r.quality.unattributed.sales===1?'':'s'} sin anuncio (${money(r.quality.unattributed.revenue_minor,currency)}). `:''}{r.quality.status==='PARTIAL'?<Badge tone="warn">Gasto parcial</Badge>:null}{r.quality.status==='PARTIAL'?' El gasto de algunos días falta o no cuadra con Meta; las cifras con * son lo reportado. ':''}
    Cuentas: {view!.accounts.map(a=>`${a.name} (${a.currency}${a.last_success_at?`, leída ${new Date(a.last_success_at).toLocaleString('es-MX')}`:''})`).join(' · ')}.</p>
  </div>}
 </>;
}
