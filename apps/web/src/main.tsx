import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {ProfileApplication,isProfileApplicationPath} from './components/profile-application';
import {PlatformDashboard} from './components/platform-dashboard.js';
import {Login} from './components/login.js';
import {createInvitationAccessPage} from './components/invitation-access.js';
import {ForgotPasswordPage,createResetPasswordPage} from './pages/account-security';
import {legacyTarget,isRetiredPath} from './lib/legacy-routes.js';
import {Layers3} from 'lucide-react';
import './styles.css';

/** V7 (RF-17): one application. Profile work lives in ProfileApplication
 * (six sections plus the account menu); identity pages and the platform page
 * are separate. Addresses of the previous application lead to their V7
 * equivalent; retired functions show that they were retired, with no data. */
function Retired(){
 return <main className="boot"><h1>Esta función se retiró</h1><p className="muted">Commerce OS V7 ya no incluye esta sección. Tus productos, ventas y resultados siguen en su lugar.</p><a href="/home" className="btn" data-variant="secondary">Volver a Inicio</a></main>;
}
function NotFound(){return <main className="boot"><h1>Esta página no existe</h1><a href="/home" className="btn" data-variant="secondary">Volver a Inicio</a></main>;}
const path=window.location.pathname.replace(/(.)\/+$/,'$1');
// The invitation token is taken from the address once, before any render or request.
const InvitationAccessPage=path==='/accept-invitation'?createInvitationAccessPage(()=>window.location.assign('/home')):null;
const ResetPasswordPage=path==='/reset-password'?createResetPasswordPage():null;
function App(){
 if(InvitationAccessPage)return <main className="identity-page"><a href="/login" className="app-brand"><span className="app-brand-mark"><Layers3 size={16} aria-hidden="true"/></span>Commerce OS</a><InvitationAccessPage/></main>;
 if(ResetPasswordPage)return <ResetPasswordPage/>;
 if(path==='/forgot-password')return <ForgotPasswordPage/>;
 if(path==='/platform')return <PlatformDashboard/>;
 if(isProfileApplicationPath(path))return <ProfileApplication path={path} login={retry=><Login onSignedIn={retry}/>}/>;
 const target=legacyTarget(path);
 if(target){window.location.replace(target+window.location.search);return null;}
 if(isRetiredPath(path))return <Retired/>;
 return <NotFound/>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
