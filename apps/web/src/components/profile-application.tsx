import {ProfileSales} from './profile-sales.js';
import {ProductVariants} from './product-variants.js';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {profileRoleLabels,type ProfileBrowserBootstrap} from '../../../../packages/contracts/src/profiles.js';
import {createProfileApplication,type ProfileApplicationState} from '../lib/profile-application.js';
import {ApiError,api,setProfileFence} from '../lib/api.js';
import {AccountSecurityView} from '../pages/account-security.js';
import {ProfileSelector} from './profile-selector.js';
import {ProfileCatalog} from './profile-catalog.js';
import {ProfileEmployees} from './profile-employees.js';
import {ProfileInvitations} from './profile-invitations.js';
import {ProfileTokens} from './profile-tokens.js';
import {ProfileSettings} from './profile-settings.js';
import {PaymentsRegister} from './payments-register.js';
import {ReceiptPolicies} from './receipt-policies.js';
import {Results} from './results.js';
import {Button} from './ui/button.js';
import {loadPlatformAccess} from '../lib/platform-profiles.js';
import {ProfileIntegrations} from './profile-integrations.js';
import {ProfileOnboarding} from './profile-onboarding.js';

/** Closed set: unreviewed V1 pages are never offered by this profile entrypoint. */
export const profileApplicationPaths=['/','/home','/login','/products','/sales/inbox','/sales/orders','/sales/receipts','/sales/payments','/sales/payments/rules','/results','/results/goals','/settings/profile','/settings/employees','/account/integrations','/numbers','/account/tokens','/account/security'] as const;
const productVariantPath=/^\/products\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/variants$/i;
/** RF-17.a: at most six destinations, identical on desktop and mobile;
 * configuration lives in the account menu. */
export const profileSections=[
 {label:'Inicio',href:'/home',active:(path:string)=>['/','/home','/login'].includes(path)},
 {label:'Productos',href:'/products',active:(path:string)=>path==='/products'||productVariantPath.test(path)},
 {label:'Ventas',href:'/sales/inbox',active:(path:string)=>path.startsWith('/sales/')},
 {label:'Números',href:'/numbers',active:(path:string)=>path==='/numbers'},
 // Until F7 moves it, Campañas opens the reviewed read-only campaign dashboard.
 {label:'Campañas',href:'/campaigns',active:(path:string)=>path==='/campaigns'},
 {label:'Resultados',href:'/results',active:(path:string)=>path.startsWith('/results')},
] as const;
export const isProfileApplicationPath=(path:string)=>profileApplicationPaths.some(value=>value===path)||productVariantPath.test(path);
export function ProfileApplication({path,login}:{path:string;login:(retry:()=>void)=>ReactNode}){
 const view=useRef<ReturnType<typeof createProfileApplication>|null>(null),[state,setState]=useState<ProfileApplicationState>({status:'LOADING'}),[confirmSwitch,setConfirmSwitch]=useState(false),[logoutError,setLogoutError]=useState(''),[leaving,setLeaving]=useState(false);
 const heading=useRef<HTMLHeadingElement>(null);
 const [platformAdmin,setPlatformAdmin]=useState(false);
 useEffect(()=>{const controller=new AbortController();loadPlatformAccess(controller.signal).then(admin=>{if(!controller.signal.aborted)setPlatformAdmin(admin);}).catch(()=>undefined);return()=>controller.abort();},[]);
 useEffect(()=>{const next=createProfileApplication();view.current=next;const off=next.subscribe(()=>setState(next.snapshot()));void next.refresh();return()=>{off();next.dispose();if(view.current===next)view.current=null;};},[]);
 useEffect(()=>{if(state.status==='READY'||state.status==='SELECTING')document.getElementById('profile-main')?.focus();heading.current?.focus();},[state.status,path]);
 const reload=()=>{void view.current?.refresh();};
 async function logout(){if(leaving)return;setLeaving(true);setLogoutError('');try{await api('/api/auth/sign-out',{method:'POST',body:'{}'});view.current?.dispose();window.location.assign('/login');}catch{setLogoutError('No se pudo confirmar el cierre de sesión. Vuelve a intentarlo.');setLeaving(false);}}
 if(state.status==='LOADING')return <main className="boot" aria-busy="true"><p role="status">Confirmando tu acceso…</p></main>;
 if(state.status==='ERROR')return state.error instanceof ApiError&&state.error.status===401?<>{login(reload)}</>:<main className="boot"><p role="alert">{state.error.message}</p><Button onClick={reload}>Volver a consultar</Button></main>;
 if(state.status==='SELECTING'&&path==='/account/security')return <main className="main-content"><a href="/home">Volver a tus perfiles</a><AccountSecurityView user={state.data.user}/></main>;
 if(state.status==='SELECTING')return <main className="main-content"><h1 ref={heading} tabIndex={-1}>Tus perfiles</h1>{state.message&&<p role="status">{state.message}</p>}<a href="/account/security">Seguridad de tu cuenta</a><ProfileSelector initial={state.data.profile} onConfirmed={selection=>{void view.current?.confirm(selection);}}/><Button variant="ghost" disabled={leaving} onClick={()=>{void logout();}}>Cerrar sesión</Button>{logoutError&&<p role="alert">{logoutError}</p>}</main>;
 const data=state.data,profile=data.profile.profiles.find(p=>p.id===data.profile.selection.workspaceId&&p.selected)!;
 const fence={workspaceId:profile.id,version:data.profile.selection.version},key=JSON.stringify([data.user.id,fence,profile.role,profile.state,profile.membershipVersion]);
 // Historical screens rendered inside this profile send the same CAS fence.
 setProfileFence(fence);
 return <div className="profile-application">
  <a href="#profile-main" className="skip-link">Saltar al contenido</a>
  <header className="topbar"><a href="/home" className="brand">Commerce <strong>OS</strong></a><div><strong>{profile.businessName}</strong> · {profileRoleLabels[profile.role]} <Button variant="secondary" onClick={()=>setConfirmSwitch(true)}>Cambiar perfil</Button>{platformAdmin&&<a href="/platform">Plataforma</a>}</div><details><summary>Mi cuenta · {data.user.name||data.user.email}</summary><nav aria-label="Mi cuenta"><a href="/account/security">Seguridad</a><a href="/settings/profile">Perfil del negocio</a>{profile.role!=='viewer'&&<a href="/account/integrations">Integraciones</a>}{profile.role==='owner'&&<><a href="/settings/employees">Empleados e invitaciones</a><a href="/account/tokens">Accesos MCP</a></>}<Button variant="ghost" disabled={leaving} onClick={()=>{void logout();}}>Cerrar sesión</Button></nav></details></header>
  <nav aria-label="Navegación del perfil" className="profile-application-nav">{profileSections.map(section=><a key={section.href} href={section.href} aria-current={section.active(path)?'page':undefined}>{section.label}</a>)}</nav>
  <main id="profile-main" className="main-content" tabIndex={-1} key={key}>
   {profile.state==='SUSPENDED'&&<p role="status">Este perfil está suspendido. Las operaciones comerciales están detenidas.</p>}
   {logoutError&&<p role="alert">{logoutError}</p>}
   <ProfilePage path={path} data={data}/>
  </main>
  <Dialog.Root open={confirmSwitch} onOpenChange={setConfirmSwitch}><Dialog.Portal><Dialog.Overlay className="profile-switch-overlay"/><Dialog.Content className="profile-switch-dialog"><Dialog.Title>Cambiar de perfil</Dialog.Title><Dialog.Description>Se descartarán los cambios que no hayas guardado en esta pantalla. Las solicitudes pendientes conservarán su seguimiento en el perfil de origen.</Dialog.Description><div className="flex gap-2"><Dialog.Close asChild><Button variant="secondary">Seguir en este perfil</Button></Dialog.Close><Button onClick={()=>{setConfirmSwitch(false);void view.current?.choose();}}>Descartar borradores y elegir perfil</Button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
 </div>;
}
function ProfilePage({path,data}:{path:string;data:ProfileBrowserBootstrap}){
 const profile=data.profile.profiles.find(p=>p.id===data.profile.selection.workspaceId&&p.selected)!,selection={workspaceId:profile.id,version:data.profile.selection.version};
 if(path==='/account/security')return <AccountSecurityView user={data.user}/>;
 const productId=productVariantPath.exec(path)?.[1]?.toLowerCase();
 if(productId)return <ProductVariants productId={productId} selection={selection} actorId={data.user.id} role={profile.role} profileState={profile.state}/>;
 if(path==='/products')return <><h1>Productos</h1><ProfileCatalog selection={selection} environment="REAL" variantLinks/></>;
 if(path==='/settings/profile')return <ProfileSettings selection={selection} role={profile.role}/>;
 if(path==='/account/integrations')return <ProfileIntegrations selection={selection} role={profile.role} state={profile.state}/>;
 if(path==='/numbers')return <section><h1>Números</h1><p>Aquí verás tus números de WhatsApp, su conexión y su calentamiento.</p></section>;
 if(path==='/settings/employees')return profile.role==='owner'?<><ProfileEmployees selection={selection} role={profile.role} state={profile.state} currentUserId={data.user.id}/><ProfileInvitations selection={selection} role={profile.role} state={profile.state}/></>:<p role="alert">No tienes permiso para gestionar empleados.</p>;
 if(path==='/account/tokens')return profile.role==='owner'?<ProfileTokens selection={selection} role={profile.role} state={profile.state}/>:<p role="alert">No tienes permiso para gestionar accesos MCP.</p>;
 if(path==='/results'||path==='/results/goals')return <Results selection={selection} timezone={profile.timezone} role={profile.role} profileState={profile.state}/>;
 if(['/sales/inbox','/sales/orders','/sales/receipts'].includes(path))return <ProfileSales key={path} resource={path==='/sales/inbox'?'conversations':path==='/sales/orders'?'orders':'receipts'} selection={selection} actorId={data.user.id} role={profile.role} profileState={profile.state} timezone={profile.timezone}/>;
 if(path==='/sales/payments/rules')return <ReceiptPolicies selection={selection} actorId={data.user.id} environment="REAL" role={profile.role} profileState={profile.state} variant={null}/>;
 if(path==='/sales/payments')return <><h1>Pagos</h1><a href="/sales/payments/rules">Reglas de comprobantes</a><PaymentsRegister selection={selection} environment="REAL" timezone={profile.timezone} role={profile.role}/></>;
 return <section><h1>Inicio · {profile.businessName}</h1><ProfileOnboarding selection={selection} role={profile.role} state={profile.state}/><p>Trabajas en {profile.businessName} con el rol {profileRoleLabels[profile.role]}.</p><div className="grid gap-4"><a href="/products">Consultar productos</a><a href="/sales/inbox">Atender conversaciones</a><a href="/sales/payments">Consultar pagos</a><a href="/results">Consultar resultados y metas</a></div></section>;
}
