import {useCallback,useEffect,useState} from 'react';
import type {ProfileFence} from '../lib/profile-request.js';
import {variantRequest,errorText} from '../lib/variants.js';
import {profileToday} from '../lib/results.js';

/** V7 F7 Campañas (RF-11, RF-09.k): what each campaign spent and the sales it
 * brought, crossed with approved payments. Read only: there is no button that
 * creates, pauses or funds anything. */
interface Row {name:string;kind?:string;campaign_id:string|null;ad_id?:string|null;spend_minor:number|null;net_spend_observed_minor?:number|null;revenue_minor:number;attributed_revenue_minor:number;sales:number;attributed_sales:number;conversations:string|null;impressions:string|null;clicks:string|null;roas:number|null;cpa_minor:number|null}
interface View {connected:boolean;note?:string;accounts:{id:string;name:string;currency:string;timezone:string;status:string;last_success_at:string|null}[];
 report:{summary:Row;groups:{campaigns:Row[];ads:Row[];products:(Row&{source?:string})[]};quality:{status:string;unattributed:{sales:number;revenue_minor:number}}}|null}
type Preset='7'|'30'|'month';
const shift=(day:string,d:number)=>new Date(Date.parse(day)+d*86400000).toISOString().slice(0,10);
/** Spend: the complete figure, or what Meta reported for the covered days. */
function spend(row:Row,currency:string){if(row.spend_minor!==null)return money(row.spend_minor,currency);return row.net_spend_observed_minor!=null?`${money(row.net_spend_observed_minor,currency)} *`:'Sin datos de gasto';}
function money(minor:number|null,currency:string){if(minor===null)return'—';try{const d=new Intl.NumberFormat('es-MX',{style:'currency',currency}).resolvedOptions().maximumFractionDigits??2;return new Intl.NumberFormat('es-MX',{style:'currency',currency,maximumFractionDigits:d}).format(minor/10**d);}catch{return String(minor);}}
const times=(v:number|null)=>v===null?'—':`${v.toFixed(2)}×`;
export function Campaigns({selection,timezone}:{selection:ProfileFence;timezone:string}){
 const today=profileToday(timezone),[preset,setPreset]=useState<Preset>('30'),[currency,setCurrency]=useState('MXN'),[view,setView]=useState<View|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=useCallback(async(p:Preset,cur:string,signal?:AbortSignal)=>{setBusy(true);setError('');
  const from=p==='7'?shift(today,-6):p==='month'?today.slice(0,8)+'01':shift(today,-29);
  try{const v=await variantRequest<View>(selection,'GET',`/v2/campaigns?from=${from}&to=${today}&currency=${cur}&granularity=day`,undefined,undefined,signal);setView(v);
   if(v.accounts.length&&!v.accounts.some(a=>a.currency===cur)){const first=v.accounts[0]!.currency;setCurrency(first);}}
  catch(e){if(!signal?.aborted)setError(errorText(e,'No se pudieron consultar las campañas.'));}finally{if(!signal?.aborted)setBusy(false);}},[selection,today]);
 useEffect(()=>{const c=new AbortController();void load(preset,currency,c.signal);return()=>c.abort();},[load,preset,currency]);
 const r=view?.report,s=r?.summary,currencies=[...new Set(view?.accounts.map(a=>a.currency)??[])];
 return <section className="results-v7 campaigns-v7" aria-labelledby="campaigns-title">
  <header className="results-head"><h1 id="campaigns-title">Campañas</h1>
   <div className="results-presets" role="group" aria-label="Periodo">{([['7','7 días'],['30','30 días'],['month','Este mes']] as [Preset,string][]).map(([k,l])=><button key={k} type="button" aria-pressed={preset===k} onClick={()=>setPreset(k)}>{l}</button>)}</div>
   {currencies.length>1&&<label className="results-currency">Moneda<select value={currency} onChange={e=>setCurrency(e.target.value)}>{currencies.map(c=><option key={c}>{c}</option>)}</select></label>}
  </header>
  <p className="number-test-isolation" role="note">Sólo lectura: aquí ves lo que gastaron tus anuncios y lo que vendieron. Nada de esta página cambia tus campañas ni tu presupuesto en Meta.</p>
  {error&&<p role="alert">{error}</p>}{!view&&!error&&<p role="status">Consultando campañas…</p>}
  {view&&!view.connected&&<div className="results-funnel"><h2>Conecta Meta</h2><p>{view.note}</p><p><a href="/account/integrations">Ir a Integraciones</a></p></div>}
  {s&&r&&<div className="results-report" aria-busy={busy}>
   <div className="results-cards">
    <div className="results-card"><span className="results-card-label">Gasto</span><strong className="results-card-value">{spend(s,currency)}</strong>{s.spend_minor===null&&<span className="results-card-hint">* Faltan días de Meta en el periodo; es lo reportado hasta ahora.</span>}</div>
    <div className="results-card"><span className="results-card-label">Ventas por anuncios</span><strong className="results-card-value">{s.attributed_sales}</strong><span className="results-card-hint">de {s.sales} ventas en total</span></div>
    <div className="results-card"><span className="results-card-label">Ingresos por anuncios</span><strong className="results-card-value">{money(s.attributed_revenue_minor,currency)}</strong></div>
    <div className="results-card"><span className="results-card-label">ROAS</span><strong className="results-card-value">{times(s.roas)}</strong><span className="results-card-hint">Ingresos atribuidos por cada peso invertido.</span></div>
    <div className="results-card"><span className="results-card-label">Costo por venta</span><strong className="results-card-value">{s.cpa_minor===null?'—':money(Math.round(s.cpa_minor),currency)}</strong></div>
    <div className="results-card"><span className="results-card-label">Conversaciones de Meta</span><strong className="results-card-value">{s.conversations??'—'}</strong></div>
   </div>
   <section className="results-series" aria-labelledby="campaigns-list"><h2 id="campaigns-list">Por campaña</h2>
    {r.groups.campaigns.length===0?<p>No hubo gasto ni ventas atribuidas en el periodo.</p>:<div className="results-table"><table><thead><tr><th>Campaña</th><th>Gasto</th><th>Conversaciones</th><th>Ventas</th><th>Ingresos</th><th>ROAS</th></tr></thead>
     <tbody>{r.groups.campaigns.map(c=><tr key={(c.campaign_id??c.name)+c.name}><th>{c.name}</th><td>{spend(c,currency)}</td><td>{c.conversations??'—'}</td><td>{c.sales}</td><td>{money(c.revenue_minor,currency)}</td><td>{times(c.roas)}</td></tr>)}</tbody></table></div>}
    <details><summary>Por anuncio ({r.groups.ads.length})</summary><div className="results-table"><table><thead><tr><th>Anuncio</th><th>Gasto</th><th>Ventas</th><th>Ingresos</th><th>ROAS</th></tr></thead>
     <tbody>{r.groups.ads.map(a=><tr key={(a.ad_id??a.name)+a.name}><th>{a.name}</th><td>{spend(a,currency)}</td><td>{a.sales}</td><td>{money(a.revenue_minor,currency)}</td><td>{times(a.roas)}</td></tr>)}</tbody></table></div></details>
    <details><summary>Por producto</summary><div className="results-table"><table><thead><tr><th>Producto</th><th>Gasto</th><th>Ventas</th><th>Ingresos</th><th>ROAS</th></tr></thead>
     <tbody>{r.groups.products.map(p=><tr key={p.name+(p.source??'')}><th>{p.name}</th><td>{spend(p,currency)}</td><td>{p.sales}</td><td>{money(p.revenue_minor,currency)}</td><td>{times(p.roas)}</td></tr>)}</tbody></table></div></details>
   </section>
   <p className="variant-hint">Ventas e ingresos cuentan pagos aprobados en la hoja de pagos; una venta se atribuye a un anuncio sólo con evidencia del anuncio. {r.quality.unattributed.sales>0?`${r.quality.unattributed.sales} venta${r.quality.unattributed.sales===1?'':'s'} sin anuncio (${money(r.quality.unattributed.revenue_minor,currency)}). `:''}{r.quality.status==='PARTIAL'?'El gasto de algunos días falta o no cuadra con Meta; las cifras con * son lo reportado. ':''}
    Cuentas: {view!.accounts.map(a=>`${a.name} (${a.currency}${a.last_success_at?`, leída ${new Date(a.last_success_at).toLocaleString('es-MX')}`:''})`).join(' · ')}.</p>
  </div>}
 </section>;
}
