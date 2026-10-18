import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {Bell,ChartNoAxesCombined,ChevronDown,ChevronRight,CircleHelp,Ellipsis,House,KeyRound,Layers3,LogOut,Megaphone,MessageSquare,Package,Plug,Repeat,Search,Settings,ShieldCheck,Smartphone,UserRoundCog,Users} from 'lucide-react';
import {helpSections} from '../../../../packages/contracts/src/help.js';
import {profileRoleLabels,type ProfileBrowserBootstrap} from '../../../../packages/contracts/src/profiles.js';
import {profileRequest,type ProfileFence} from '../lib/profile-request.js';
import {variantRequest,type ProductSummary} from '../lib/variants.js';
import {cachedSales,loadHome,loadHomeForShell,loadSales,moneyMinor,type Home,type Sales} from '../lib/home-data.js';
import {Button,Dialog,DialogContent,Progress} from './ui';
import {profileSections} from './profile-sections.js';

/** V7 shell (canvas «Rediseño Commerce OS V7»): sidebar of 248 px with the six
 * destinations, the profile switch and the month goal; top bar of 64 px with
 * breadcrumbs, search, notices and the account menu; five bottom tabs on
 * mobile. Routes, labels and `href`s are the RF-17.a set and do not change. */
export type Crumb={label:string;href?:string};
interface ShellContextValue {setCrumbs:(crumbs:Crumb[])=>void;refreshCounters:()=>void}
const ShellContext=createContext<ShellContextValue>({setCrumbs:()=>undefined,refreshCounters:()=>undefined});
/** Pages set their own breadcrumb tail (e.g. product › variant). */
export function useBreadcrumbs(crumbs:Crumb[]){const {setCrumbs}=useContext(ShellContext);const key=JSON.stringify(crumbs);useEffect(()=>{setCrumbs(JSON.parse(key));return()=>setCrumbs([]);},[key,setCrumbs]);}
export const useShell=()=>useContext(ShellContext);

const icons={'/home':House,'/products':Package,'/sales/inbox':MessageSquare,'/numbers':Smartphone,'/campaigns':Megaphone,'/results':ChartNoAxesCombined} as const;
const initials=(name:string)=>name.split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]!.toUpperCase()).join('')||'?';
const baseCrumb=(path:string):Crumb[]=>{const s=profileSections.find(x=>x.active(path));if(!s||s.href==='/home')return [];const extra:Record<string,string>={'/sales/orders':'Pedidos','/sales/receipts':'Comprobantes','/sales/payments':'Pagos','/sales/payments/rules':'Reglas de comprobantes','/results/goals':'Metas'};return [{label:s.label,href:s.href},...(extra[path]?[{label:extra[path]!}]:[])];};
const accountCrumb:Record<string,string>={'/settings/profile':'Perfil del negocio','/settings/employees':'Empleados e invitaciones','/account/integrations':'Integraciones','/account/tokens':'Accesos MCP','/account/security':'Seguridad','/help':'Ayuda'};

export interface AppShellProps {
 path:string;
 data:ProfileBrowserBootstrap;
 fence:ProfileFence;
 platformAdmin:boolean;
 onSwitchProfile:()=>void;
 onLogout:()=>void;
 leaving:boolean;
 logoutError:string;
 children:ReactNode;
}
export function AppShell({path,data,fence,platformAdmin,onSwitchProfile,onLogout,leaving,logoutError,children}:AppShellProps){
 const profile=data.profile.profiles.find(p=>p.id===fence.workspaceId&&p.selected)!;
 const [crumbs,setCrumbsState]=useState<Crumb[]>([]);
 const setCrumbs=useCallback((c:Crumb[])=>setCrumbsState(c),[]);
 const [home,setHome]=useState<Home|null>(null),[sales,setSales]=useState<Sales|null>(null),[tick,setTick]=useState(0);
 const refreshCounters=useCallback(()=>setTick(t=>t+1),[]);
 useEffect(()=>{const c=new AbortController();
  (path==='/home'||path==='/'||tick>0?loadHome(fence,c.signal):loadHomeForShell(fence,c.signal)).then(v=>{if(!c.signal.aborted)setHome(v);}).catch(()=>undefined);
  // Fresh results only where the page itself reads them; elsewhere the last read of this tab.
  if(path==='/home'||path==='/'||path.startsWith('/results'))loadSales(fence,profile.timezone,c.signal).then(v=>{if(!c.signal.aborted)setSales(v);}).catch(()=>undefined);
  else setSales(cachedSales(fence)?.sales??null);
  return()=>c.abort();},[fence.workspaceId,fence.version,profile.timezone,path,tick]);
 const allCrumbs=useMemo<Crumb[]>(()=>{const tail=crumbs.length?crumbs:accountCrumb[path]?[{label:accountCrumb[path]!}]:baseCrumb(path);return [{label:'Inicio',href:'/home'},...tail];},[crumbs,path]);
 const counts:Record<string,number|undefined>={'/sales/inbox':home?.pending.receiptsToReview||undefined,'/numbers':home?.pending.alerts||undefined};
 const value=useMemo(()=>({setCrumbs,refreshCounters}),[setCrumbs,refreshCounters]);
 const [moreOpen,setMoreOpen]=useState(false);
 const owner=profile.role==='owner',notViewer=profile.role!=='viewer';
 const accountLinks=[
  {href:'/account/security',label:'Seguridad',icon:ShieldCheck,show:true},
  {href:'/settings/profile',label:'Perfil del negocio',icon:UserRoundCog,show:true},
  {href:'/account/integrations',label:'Integraciones',icon:Plug,show:notViewer},
  {href:'/settings/employees',label:'Empleados e invitaciones',icon:Users,show:owner},
  {href:'/account/tokens',label:'Accesos MCP',icon:KeyRound,show:owner},
  {href:'/help',label:'Ayuda',icon:CircleHelp,show:true},
 ].filter(l=>l.show);
 return <ShellContext.Provider value={value}>
  <div className="app">
   <a href="#profile-main" className="skip-link">Saltar al contenido</a>
   <aside className="app-sidebar">
    <a href="/home" className="app-brand"><span className="app-brand-mark"><Layers3 size={16} aria-hidden="true"/></span>Commerce OS</a>
    <button type="button" className="profile-switch" onClick={onSwitchProfile} aria-label="Cambiar perfil" aria-describedby="profile-switch-current">
     <span className="avatar" aria-hidden="true">{initials(profile.businessName)}</span>
     <span className="profile-switch-text" id="profile-switch-current"><strong>{profile.businessName}</strong><span>{profileRoleLabels[profile.role]}{profile.state==='SUSPENDED'?' · Suspendido':''}</span></span>
     <Repeat size={16} aria-hidden="true" style={{color:'var(--text-2)'}}/>
    </button>
    <nav aria-label="Navegación del perfil" className="app-nav">
     {profileSections.map(section=>{const Icon=icons[section.href];const count=counts[section.href];return <div className="nav-item" key={section.href}><a href={section.href} aria-current={section.active(path)?'page':undefined} aria-describedby={count?`nav-count-${section.href.replace(/\W/g,'')}`:undefined}>
      <Icon aria-hidden="true"/>{section.label}
     </a>{count?<span id={`nav-count-${section.href.replace(/\W/g,'')}`} className={'nav-count'+(section.href==='/numbers'&&home?.pending.criticalAlerts?' attention':'')} aria-label={`${count} pendiente${count===1?'':'s'}`}>{count}</span>:null}</div>;})}
    </nav>
    <MonthGoal sales={sales}/>
    <div className="sidebar-footer">
     <nav aria-label="Configuración y ayuda" className="app-nav">
      {notViewer&&<a href="/account/integrations" aria-current={path==='/account/integrations'?'page':undefined}><Settings aria-hidden="true"/>Configuración</a>}
      <a href="/help" aria-current={path==='/help'?'page':undefined}><CircleHelp aria-hidden="true"/>Ayuda</a>
     </nav>
    </div>
   </aside>
   <div className="app-body">
    <header className="app-topbar">
     <a href="/home" className="app-brand"><span className="app-brand-mark"><Layers3 size={16} aria-hidden="true"/></span><span className="sr-only">Commerce OS</span></a>
     <nav aria-label="Ruta" className="breadcrumbs"><ol>{allCrumbs.map((c,i)=><li key={i} aria-current={i===allCrumbs.length-1?'page':undefined}>{i>0&&<ChevronRight aria-hidden="true"/>}{c.href&&i<allCrumbs.length-1?<a href={c.href}>{c.label}</a>:<span>{c.label}</span>}</li>)}</ol></nav>
     <div className="topbar-actions">
      <SearchBox fence={fence}/>
      <Notices fence={fence} count={home?.pending.alerts??0} critical={(home?.pending.criticalAlerts??0)>0} tick={tick}/>
      <AccountMenu user={data.user} profile={profile} platformAdmin={platformAdmin} links={accountLinks} onLogout={onLogout} leaving={leaving}/>
     </div>
    </header>
    <main id="profile-main" className="app-main" tabIndex={-1}>
     {profile.state==='SUSPENDED'&&<p role="status" className="alert" data-tone="warn">Este perfil está suspendido. Las operaciones comerciales están detenidas.</p>}
     {logoutError&&<p role="alert" className="alert" data-tone="error">{logoutError}</p>}
     {children}
    </main>
   </div>
   <nav aria-label="Navegación del perfil" className="app-tabs">
    {profileSections.slice(0,4).map(section=>{const Icon=icons[section.href];return <a key={section.href} href={section.href} aria-current={section.active(path)?'page':undefined}><Icon aria-hidden="true"/>{section.label}</a>;})}
    <button type="button" aria-expanded={moreOpen} aria-haspopup="dialog" onClick={()=>setMoreOpen(true)}><Ellipsis aria-hidden="true"/>Más</button>
   </nav>
   <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
    <DialogContent title="Más" description="Resultados, campañas, configuración y tu cuenta.">
     <div className="more-sheet">
      {profileSections.slice(4).map(section=>{const Icon=icons[section.href];return <a key={section.href} href={section.href} aria-current={section.active(path)?'page':undefined}><Icon aria-hidden="true"/>{section.label}</a>;})}
      <h3>Mi cuenta</h3>
      {accountLinks.map(l=>{const Icon=l.icon;return <a key={l.href} href={l.href} aria-current={path===l.href?'page':undefined}><Icon aria-hidden="true"/>{l.label}</a>;})}
      {platformAdmin&&<a href="/platform"><Layers3 aria-hidden="true"/>Plataforma</a>}
      <h3>Perfil</h3>
      <Button variant="secondary" onClick={()=>{setMoreOpen(false);onSwitchProfile();}}><Repeat aria-hidden="true"/>Cambiar perfil</Button>
      <Button variant="ghost" disabled={leaving} onClick={onLogout}><LogOut aria-hidden="true"/>Cerrar sesión</Button>
     </div>
    </DialogContent>
   </Dialog>
  </div>
 </ShellContext.Provider>;
}

function MonthGoal({sales}:{sales:Sales|null}){
 if(!sales)return null;
 const g=sales.goal;
 if(!g)return <div className="sidebar-goal"><span className="muted">Meta del mes</span><a href="/results">Define una meta en Resultados</a></div>;
 const revenue=g.label==='Meta de ingresos',fmt=(v:string)=>revenue?moneyMinor(v,sales.currency):v,pct=g.ratio===null?null:Math.round(g.ratio*100);
 return <div className="sidebar-goal">
  <span className="muted">{g.label} · hasta {g.to}</span>
  <strong>{g.actual===null?'Sin datos':fmt(g.actual)} <span className="muted" style={{fontWeight:400}}>de {fmt(g.target)}</span></strong>
  <Progress value={pct??0} label={g.label} tone={g.met?'success':undefined} valueText={g.met?'Meta cumplida':pct===null?'Sin datos suficientes':`${pct} % del objetivo`}/>
  <span className="muted">{g.met?'Meta cumplida':pct===null?'Sin datos suficientes':`${pct} % del objetivo`}</span>
 </div>;
}

/** Search across destinations, help topics and the profile's products. */
interface Hit {label:string;href:string;kind:string}
function SearchBox({fence}:{fence:ProfileFence}){
 const id='shell-search',[query,setQuery]=useState(''),[open,setOpen]=useState(false),[active,setActive]=useState(0),[products,setProducts]=useState<ProductSummary[]|null>(null),host=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null);
 useEffect(()=>{if(!open||products)return;const c=new AbortController();variantRequest<ProductSummary[]>(fence,'GET','/v2/products',undefined,undefined,c.signal).then(v=>{if(!c.signal.aborted)setProducts(v);}).catch(()=>{if(!c.signal.aborted)setProducts([]);});return()=>c.abort();},[open,products,fence]);
 useEffect(()=>{if(!open)return;const close=(e:MouseEvent)=>{if(!host.current?.contains(e.target as Node))setOpen(false);};document.addEventListener('mousedown',close);return()=>document.removeEventListener('mousedown',close);},[open]);
 const hits=useMemo<Hit[]>(()=>{const q=query.trim().toLowerCase();if(!q)return [];const norm=(s:string)=>s.toLowerCase();const out:Hit[]=[];
  for(const s of profileSections)if(norm(s.label).includes(q))out.push({label:s.label,href:s.href,kind:'Sección'});
  for(const [href,label] of Object.entries(accountCrumb))if(norm(label).includes(q))out.push({label,href,kind:'Cuenta'});
  for(const h of helpSections)if(norm(h.title).includes(q)||norm(h.summary).includes(q))out.push({label:h.title,href:`/help#${h.id}`,kind:'Ayuda'});
  for(const p of products??[]){if(norm(p.name).includes(q))out.push({label:p.name,href:`/products/${p.id}`,kind:'Producto'});for(const v of p.variants)if(norm(v.name).includes(q)||norm(p.name+' '+v.name).includes(q))out.push({label:`${p.name} · ${v.name}`,href:`/products/${p.id}/variants/${v.id}/sale`,kind:'Variante'});}
  return out.slice(0,12);},[query,products]);
 useEffect(()=>setActive(0),[hits.length]);
 const go=(hit:Hit)=>{setOpen(false);window.location.assign(hit.href);};
 return <div className={'topbar-search'+(open?' open':'')} ref={host}>
  <Search aria-hidden="true"/>
  <button type="button" className="icon-button search-toggle" aria-label="Abrir búsqueda" aria-expanded={open} onClick={()=>{setOpen(o=>!o);setTimeout(()=>input.current?.focus(),0);}}><Search aria-hidden="true"/></button>
  <input ref={input} id={id} className="input" type="search" placeholder="Buscar" aria-label="Buscar" role="combobox" aria-expanded={open&&hits.length>0} aria-controls={id+'-list'} aria-autocomplete="list" aria-activedescendant={open&&hits[active]?`${id}-opt-${active}`:undefined} value={query} autoComplete="off"
   onFocus={()=>setOpen(true)} onChange={e=>{setQuery(e.target.value);setOpen(true);}}
   onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();setActive(a=>Math.min(hits.length-1,a+1));}else if(e.key==='ArrowUp'){e.preventDefault();setActive(a=>Math.max(0,a-1));}else if(e.key==='Enter'&&hits[active]){e.preventDefault();go(hits[active]!);}else if(e.key==='Escape'){setOpen(false);}}}/>
  {open&&query.trim()&&<ul id={id+'-list'} role="listbox" aria-label="Resultados de la búsqueda" className="search-results">
   {hits.length===0&&<li><span className="empty-line muted">{products===null?'Buscando…':'Sin resultados'}</span></li>}
   {hits.map((h,i)=><li key={h.href+h.label}><a id={`${id}-opt-${i}`} role="option" aria-selected={i===active} href={h.href} onMouseEnter={()=>setActive(i)} onClick={e=>{e.preventDefault();go(h);}}>{h.label}<small>{h.kind}</small></a></li>)}
  </ul>}
 </div>;
}

interface AlertRow {id:string;kind:string;label:string;href:string;severity:'WARNING'|'CRITICAL';number:{id:string;alias:string}|null;createdAt:string|null;acknowledgedAt:string|null}
function Notices({fence,count,critical,tick}:{fence:ProfileFence;count:number;critical:boolean;tick:number}){
 const [open,setOpen]=useState(false),[alerts,setAlerts]=useState<AlertRow[]|null>(null),[error,setError]=useState(''),host=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(!open)return;const c=new AbortController();setError('');profileRequest<{alerts:AlertRow[]}>(fence,'GET','/v2/alerts',undefined,c.signal).then(v=>{if(!c.signal.aborted)setAlerts(v.alerts.filter(a=>!a.acknowledgedAt));}).catch(()=>{if(!c.signal.aborted)setError('No se pudieron consultar los avisos.');});return()=>c.abort();},[open,fence,tick]);
 useEffect(()=>{if(!open)return;const close=(e:MouseEvent)=>{if(!host.current?.contains(e.target as Node))setOpen(false);};const esc=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};document.addEventListener('mousedown',close);document.addEventListener('keydown',esc);return()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',esc);};},[open]);
 return <div className="popover-host" ref={host}>
  <button type="button" className="icon-button" aria-label={count?`Avisos: ${count} pendiente${count===1?'':'s'}`:'Avisos'} aria-expanded={open} aria-controls="shell-notices" onClick={()=>setOpen(o=>!o)}>
   <Bell aria-hidden="true"/>{count>0&&<span className={'dot count'} aria-hidden="true" style={critical?undefined:{background:'var(--warn)'}}>{count>9?'9+':count}</span>}
  </button>
  {open&&<div className="popover" id="shell-notices">
   <div className="popover-head"><Bell aria-hidden="true" size={18}/><div><strong>Avisos</strong><span>{count?`${count} sin atender`:'Nada pendiente'}</span></div></div>
   {error&&<p className="popover-empty" role="alert">{error}</p>}
   {!error&&alerts===null&&<p className="popover-empty" role="status">Consultando…</p>}
   {alerts&&alerts.length===0&&<p className="popover-empty">No hay avisos abiertos.</p>}
   {alerts&&alerts.length>0&&<ul>{alerts.slice(0,8).map(a=><li key={a.id}><a href={a.href}>{a.severity==='CRITICAL'?<Bell aria-hidden="true" style={{color:'var(--error)'}}/>:<Bell aria-hidden="true"/>}<span>{a.number?<strong>{a.number.alias}: </strong>:null}{a.label}</span></a></li>)}</ul>}
   {alerts&&alerts.length>0&&<nav aria-label="Ver avisos"><a href="/numbers">Ver todos en Números<ChevronRight aria-hidden="true"/></a></nav>}
  </div>}
 </div>;
}

function AccountMenu({user,profile,platformAdmin,links,onLogout,leaving}:{user:ProfileBrowserBootstrap['user'];profile:ProfileBrowserBootstrap['profile']['profiles'][number];platformAdmin:boolean;links:{href:string;label:string;icon:typeof Settings}[];onLogout:()=>void;leaving:boolean}){
 const [open,setOpen]=useState(false),host=useRef<HTMLDivElement>(null),name=user.name||user.email;
 useEffect(()=>{if(!open)return;const close=(e:MouseEvent)=>{if(!host.current?.contains(e.target as Node))setOpen(false);};const esc=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};document.addEventListener('mousedown',close);document.addEventListener('keydown',esc);return()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',esc);};},[open]);
 return <div className="popover-host" ref={host}>
  <button type="button" className="account-trigger" aria-expanded={open} aria-controls="shell-account" onClick={()=>setOpen(o=>!o)}>
   <span className="avatar sm" aria-hidden="true">{initials(name)}</span>
   <span className="label">Mi cuenta<span className="label-name"> · {name}</span></span>
   <ChevronDown aria-hidden="true"/>
  </button>
  {open&&<div className="popover" id="shell-account">
   <div className="popover-head"><span className="avatar sm" aria-hidden="true">{initials(name)}</span><div><strong>{name}</strong><span>{user.email} · {profile.businessName} · {profileRoleLabels[profile.role]}</span></div></div>
   <nav aria-label="Mi cuenta">
    {links.map(l=>{const Icon=l.icon;return <a key={l.href} href={l.href}><Icon aria-hidden="true"/>{l.label}</a>;})}
    {platformAdmin&&<a href="/platform"><Layers3 aria-hidden="true"/>Plataforma</a>}
    <button type="button" className="menu-item" disabled={leaving} onClick={onLogout}><LogOut aria-hidden="true"/>Cerrar sesión</button>
   </nav>
  </div>}
 </div>;
}
