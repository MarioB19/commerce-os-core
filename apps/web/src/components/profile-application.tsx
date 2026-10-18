import {ProfileSales} from './profile-sales.js';
import {ProductsHome,ProductDetail} from './products-v7.js';
import {VariantEditor,variantSectionTabs,type VariantTab} from './variant-editor.js';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Layers3,LogOut,ShieldCheck} from 'lucide-react';
import {type ProfileBrowserBootstrap} from '../../../../packages/contracts/src/profiles.js';
import {createProfileApplication,type ProfileApplicationState} from '../lib/profile-application.js';
import {ApiError,api,setProfileFence} from '../lib/api.js';
import {ProfileNumbers} from './profile-numbers.js';
import {AccountSecurityView} from '../pages/account-security.js';
import {ProfileSelector} from './profile-selector.js';
import {ProfileEmployees} from './profile-employees.js';
import {ProfileInvitations} from './profile-invitations.js';
import {ProfileTokens} from './profile-tokens.js';
import {ProfileSettings} from './profile-settings.js';
import {PaymentsRegister} from './payments-register.js';
import {ReceiptPolicies} from './receipt-policies.js';
import {Results} from './results.js';
import {Button,Dialog,DialogActions,DialogClose,DialogContent,ToastProvider} from './ui';
import {loadPlatformAccess} from '../lib/platform-profiles.js';
import {ProfileIntegrations} from './profile-integrations.js';
import {Home} from './home.js';
import {ReceiptQueue} from './receipt-queue.js';
import {NumberTest} from './number-test.js';
import {Campaigns} from './campaigns.js';
import {Help} from './help.js';
import {AppShell} from './app-shell.js';
import {numberTestPath,productPath,variantEditorPath} from './profile-sections.js';
export {profileApplicationPaths,profileSections,isProfileApplicationPath} from './profile-sections.js';

/** V7 (RF-17): one application. Profile work lives inside the shell (six
 * sections plus the account menu); identity pages and the platform page are
 * separate. Routes are the closed set of `profile-sections.ts`. */
export function ProfileApplication({path,login}:{path:string;login:(retry:()=>void)=>ReactNode}){
 const view=useRef<ReturnType<typeof createProfileApplication>|null>(null),[state,setState]=useState<ProfileApplicationState>({status:'LOADING'}),[confirmSwitch,setConfirmSwitch]=useState(false),[logoutError,setLogoutError]=useState(''),[leaving,setLeaving]=useState(false);
 const heading=useRef<HTMLHeadingElement>(null);
 const [platformAdmin,setPlatformAdmin]=useState(false);
 useEffect(()=>{const controller=new AbortController();loadPlatformAccess(controller.signal).then(admin=>{if(!controller.signal.aborted)setPlatformAdmin(admin);}).catch(()=>undefined);return()=>controller.abort();},[]);
 useEffect(()=>{const next=createProfileApplication();view.current=next;const off=next.subscribe(()=>setState(next.snapshot()));void next.refresh();return()=>{off();next.dispose();if(view.current===next)view.current=null;};},[]);
 useEffect(()=>{if(state.status==='READY'||state.status==='SELECTING')document.getElementById('profile-main')?.focus();heading.current?.focus();},[state.status,path]);
 const reload=()=>{void view.current?.refresh();};
 async function logout(){if(leaving)return;setLeaving(true);setLogoutError('');try{await api('/api/auth/sign-out',{method:'POST',body:'{}'});view.current?.dispose();window.location.assign('/login');}catch{setLogoutError('No se pudo confirmar el cierre de sesión. Vuelve a intentarlo.');setLeaving(false);}}
 if(state.status==='LOADING')return <main className="boot" aria-busy="true"><p role="status" className="muted">Confirmando tu acceso…</p></main>;
 if(state.status==='ERROR')return state.error instanceof ApiError&&state.error.status===401?<>{login(reload)}</>:<main className="boot"><p role="alert">{state.error.message}</p><Button onClick={reload}>Volver a consultar</Button></main>;
 if(state.status==='SELECTING'&&path==='/account/security')return <main className="identity-page main-content"><a href="/home" className="back-link">Volver a tus perfiles</a><section className="card"><AccountSecurityView user={state.data.user}/></section></main>;
 if(state.status==='SELECTING')return <main className="identity-page main-content">
  <a href="/home" className="app-brand"><span className="app-brand-mark"><Layers3 size={16} aria-hidden="true"/></span>Commerce OS</a>
  <section className="card" aria-labelledby="profiles-title">
   <h1 ref={heading} tabIndex={-1} id="profiles-title">Tus perfiles</h1>
   {state.message&&<p role="status" className="alert" data-tone="info">{state.message}</p>}
   <ProfileSelector initial={state.data.profile} onConfirmed={selection=>{void view.current?.confirm(selection);}}/>
   <div className="cluster"><a href="/account/security" className="btn" data-variant="ghost"><ShieldCheck aria-hidden="true"/>Seguridad de tu cuenta</a><Button variant="ghost" disabled={leaving} onClick={()=>{void logout();}}><LogOut aria-hidden="true"/>Cerrar sesión</Button></div>
   {logoutError&&<p role="alert" className="alert" data-tone="error">{logoutError}</p>}
  </section>
 </main>;
 const data=state.data,profile=data.profile.profiles.find(p=>p.id===data.profile.selection.workspaceId&&p.selected)!;
 const fence={workspaceId:profile.id,version:data.profile.selection.version},key=JSON.stringify([data.user.id,fence,profile.role,profile.state,profile.membershipVersion]);
 // Historical screens rendered inside this profile send the same CAS fence.
 setProfileFence(fence);
 return <ToastProvider>
  <AppShell path={path} data={data} fence={fence} platformAdmin={platformAdmin} onSwitchProfile={()=>setConfirmSwitch(true)} onLogout={()=>{void logout();}} leaving={leaving} logoutError={logoutError}>
   <div key={key} className="stack" style={{gap:'var(--space-5)'}}><ProfilePage path={path} data={data}/></div>
  </AppShell>
  <Dialog open={confirmSwitch} onOpenChange={setConfirmSwitch}>
   <DialogContent title="Cambiar de perfil" description="Se descartarán los cambios que no hayas guardado en esta pantalla. Las solicitudes pendientes conservarán su seguimiento en el perfil de origen.">
    <DialogActions><DialogClose asChild><Button variant="secondary">Seguir en este perfil</Button></DialogClose><Button onClick={()=>{setConfirmSwitch(false);void view.current?.choose();}}>Descartar borradores y elegir perfil</Button></DialogActions>
   </DialogContent>
  </Dialog>
 </ToastProvider>;
}
function ProfilePage({path,data}:{path:string;data:ProfileBrowserBootstrap}){
 const profile=data.profile.profiles.find(p=>p.id===data.profile.selection.workspaceId&&p.selected)!,selection={workspaceId:profile.id,version:data.profile.selection.version};
 if(path==='/account/security')return <AccountSecurityView user={data.user}/>;
 const editor=variantEditorPath.exec(path);
 if(editor)return <VariantEditor key={editor[2]} productId={editor[1]!.toLowerCase()} variantId={editor[2]!.toLowerCase()} section={(variantSectionTabs.some(([k])=>k===editor[3])?editor[3]:'sale') as VariantTab} selection={selection} role={profile.role} state={profile.state}/>;
 const productId=productPath.exec(path)?.[1]?.toLowerCase();
 if(productId)return <ProductDetail productId={productId} selection={selection} role={profile.role} state={profile.state}/>;
 if(path==='/products')return <ProductsHome selection={selection} role={profile.role} state={profile.state}/>;
 if(path==='/settings/profile')return <ProfileSettings selection={selection} role={profile.role}/>;
 if(path==='/account/integrations')return <ProfileIntegrations selection={selection} role={profile.role} state={profile.state}/>;
 if(path==='/numbers')return <ProfileNumbers selection={selection} role={profile.role} state={profile.state}/>;
 const testedNumber=numberTestPath.exec(path)?.[1]?.toLowerCase();
 if(testedNumber)return <NumberTest key={testedNumber} accountId={testedNumber} selection={selection} role={profile.role} state={profile.state} timezone={profile.timezone}/>;
 if(path==='/settings/employees')return profile.role==='owner'?<><ProfileEmployees selection={selection} role={profile.role} state={profile.state} currentUserId={data.user.id}/><ProfileInvitations selection={selection} role={profile.role} state={profile.state}/></>:<p role="alert" className="alert" data-tone="warn">No tienes permiso para gestionar empleados.</p>;
 if(path==='/account/tokens')return profile.role==='owner'?<ProfileTokens selection={selection} role={profile.role} state={profile.state}/>:<p role="alert" className="alert" data-tone="warn">No tienes permiso para gestionar accesos MCP.</p>;
 if(path==='/results'||path==='/results/goals')return <Results selection={selection} timezone={profile.timezone} role={profile.role} profileState={profile.state}/>;
 if(path==='/campaigns')return <Campaigns selection={selection} timezone={profile.timezone}/>;
 if(path==='/help')return <Help/>;
 if(path==='/sales/receipts')return <ReceiptQueue selection={selection} role={profile.role} state={profile.state} timezone={profile.timezone}/>;
 if(['/sales/inbox','/sales/orders'].includes(path))return <ProfileSales key={path} resource={path==='/sales/inbox'?'conversations':'orders'} selection={selection} actorId={data.user.id} role={profile.role} profileState={profile.state} timezone={profile.timezone}/>;
 if(path==='/sales/payments/rules')return <ReceiptPolicies selection={selection} actorId={data.user.id} environment="REAL" role={profile.role} profileState={profile.state} variant={null}/>;
 if(path==='/sales/payments')return <PaymentsRegister selection={selection} environment="REAL" timezone={profile.timezone} role={profile.role}/>;
 return <Home selection={selection} role={profile.role} state={profile.state} businessName={profile.businessName} userName={data.user.name||data.user.email} timezone={profile.timezone}/>;
}
