import {ProfileApplication,isProfileApplicationPath} from './components/profile-application';
import {PlatformDashboard} from './components/platform-dashboard.js';
import {NumbersPage,WarmupsPage} from './pages/numbers';
import {LaunchHelpPage} from './pages/launch-help';
import {DisplayPreferences} from './components/display-preferences';
import {IntegrationsPage} from './pages/integrations';
import {ProductionArchivePage} from './pages/production-archive';
import { WarmupPage } from "./components/warmup-configuration";
import { TestsPage } from "./pages/tests-lab";
import {AccountSecurityPage,ForgotPasswordPage,createResetPasswordPage} from './pages/account-security';
import {TransactionalMailPage} from './pages/transactional-mail';

import {SellersPage} from './pages/sellers';
import {SalesOverview} from './pages/sales-overview';
import {CampaignDashboard} from "./pages/campaign-performance";
import { StrictMode, Suspense, lazy, useState, useEffect, useRef, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
  Navigate,
  Link,
  useRouterState,
} from "@tanstack/react-router";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  House,
  Layers3,
  LogOut,
  Menu,
  MessageCircle,
  Package,
  Settings2,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  ChartNoAxesCombined,
  LockKeyhole,
} from "lucide-react";
import {
  WorkspaceContext,
  CommandMonitor,
  Badge,
  ErrorState,
  Feedback,
  Loading,
  useWorkspace,
} from "./components/shared";
import { Button } from "./components/ui/button";
import { api, useData, setProfileFence, type Session } from "./lib/api";
import { loadProfiles } from "./lib/profile-identity";
import { HomePage, ResultsPage } from "./pages/home";
const IntelligencePage=lazy(()=>import('./pages/intelligence').then(module=>({default:module.IntelligencePage})));
import { CatalogPage } from "./pages/catalog";
import { InboxPage, LeadsPage, OrdersPage } from "./pages/sales";
import { FlowsPage } from "./pages/flows";
import {
  AcquisitionPage,
  CampaignsPage,
  ChannelsPage,
  SettingsPage,
} from "./pages/operations";
const MetaPage = lazy(() => import("./pages/meta").then((module) => ({ default: module.MetaPage })));
import * as Dialog from "@radix-ui/react-dialog";
import "./styles.css";
const queryClient = new QueryClient();
const nav = [
  { path: "/home", label: "Inicio", icon: House },
  {
    path: "/intelligence",
    label: "Inteligencia",
    icon: Sparkles,
    experimental: true,
  },
  { path: "/catalog", label: "Productos y ofertas", icon: Package },
  { path: "/campaigns", label: "Campañas", icon: TrendingUp },
  { path: "/sales", label: "Ventas", icon: MessageCircle },
  {
    path: "/results",
    label: "Resultados y aprendizaje",
    icon: ChartNoAxesCombined,
  },
  { path: "/settings", label: "Configuración", icon: Settings2 },
];
const salesNav = [
  { path: "/sales", label: "Resumen" },
  { path: "/sales/inbox", label: "Conversaciones" },
  { path: "/sales/orders", label: "Pedidos y comprobantes" },
  { path: "/sales/flows", label: "Flujos y agentes" },
  { path: "/sales/channels/whatsapp", label: "Mis números" },
  { path: "/sales/warmups", label: "Calentamientos" },
];
const ResetPasswordPage=createResetPasswordPage();
function App() {
 const pathname=useRouterState({select:state=>state.location.pathname});
 if(pathname==='/forgot-password')return <ForgotPasswordPage/>;
 if(pathname==='/reset-password')return <ResetPasswordPage/>;
 if(pathname==='/platform')return <PlatformDashboard/>;
 if(isProfileApplicationPath(pathname))return <ProfileApplication path={pathname} login={retry=><Login onSignedIn={retry}/>}/>;
 return <SessionApp/>;
}
function SessionApp() {
  // V7: business requests carry the server-confirmed profile selection. With
  // several profiles and no selection, the profile chooser decides first.
  const profiles = useQuery({ queryKey: ["identity", "profiles"], queryFn: ({ signal }) => loadProfiles(signal), retry: false, staleTime: 30_000, refetchOnWindowFocus: false });
  const selection = profiles.data?.selection;
  const ready = Boolean(profiles.data && (selection?.workspaceId || profiles.data.profiles.length <= 1));
  if (profiles.data) setProfileFence(selection?.workspaceId ? { workspaceId: selection.workspaceId, version: selection.version } : null);
  const session = useData<Session>("/me", ready);
  if (profiles.error && "status" in profiles.error && profiles.error.status === 401) return <Login />;
  if (profiles.data && !ready) return <Navigate to="/" />;
  if (profiles.isPending || (ready && session.isPending))
    return (
      <div className="boot">
        <div className="brand-mark">
          <Layers3 />
        </div>
        <Loading />
      </div>
    );
  if (session.error) {
    if ("status" in session.error && session.error.status === 401)
      return <Login />;
    return (
      <div className="boot">
        <ErrorState
          error={session.error}
          retry={() => {
            void session.refetch();
          }}
        />
      </div>
    );
  }
  if (!session.data) return <Login />;
  if (window.location.pathname === "/login") return <Navigate to="/home" />;
  return <AuthenticatedApp key={`${session.data.workspace_id}:${session.data.user.id}`} session={session.data} />;
}
function AuthenticatedApp({ session }: { session: Session }) {
  useEffect(() => {
    try { sessionStorage.removeItem(`commerce-environment:${session.workspace_id}:${session.user.id}`); } catch { /* Storage is optional; context is always REAL. */ }
  }, [session.workspace_id, session.user.id]);
  return <WorkspaceContext.Provider value={{ session: { ...session, environment: "REAL" }, environment: "REAL" }}><Shell /></WorkspaceContext.Provider>;
}
function Login({onSignedIn}:{onSignedIn?:()=>void}={}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function login(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const submittedPassword = password;
    setPassword("");
    try {
      await api("/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email, password: submittedPassword }),
      });
      setPassword("");
      await queryClient.invalidateQueries();
      onSignedIn?.();
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-story">
        <div className="brand">
          <span className="brand-mark">
            <Layers3 size={23} />
          </span>
          Commerce <strong>OS</strong>
        </div>
        <div className="login-story-body">
          <span className="eyebrow">CONTEXTO. CONTROL. CRECIMIENTO.</span>
          <h1>
            Tu operación
            <br />
            comercial,
            <br />
            <em>conectada.</em>
          </h1>
          <p>
            Un espacio para tus productos, conversaciones y resultados. Con
            claridad en cada paso.
          </p>
          <div className="login-circuit">
            <Package />
            <i />
            <MessageCircle />
            <i />
            <ChartNoAxesCombined />
          </div>
        </div>
        <small>Commerce OS · Espacio privado de trabajo</small>
      </div>
      <div className="login-form-wrap">
        <div className="login-form">
          <Badge tone="success">
            <ShieldCheck size={13} /> ACCESO DEL EQUIPO
          </Badge>
          <h2>Bienvenido de nuevo</h2>
          <p>Ingresa con tu cuenta individual para continuar.</p>
          <form
            onSubmit={(e) => {
              void login(e);
            }}
          >
            <label className="field">
              <span>Correo electrónico</span>
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="tu@equipo.com"
              />
            </label>
            <label className="field">
              <span>Contraseña</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="Tu contraseña"
              />
            </label>
            <Feedback error={error} />
            <Button type="submit" disabled={pending} className="login-submit">
              {pending ? "Ingresando…" : "Entrar a Commerce OS"}
              <ArrowUpRight />
            </Button>
          </form>
          <Link to="/forgot-password" className="recovery-back">Olvidé mi contraseña</Link>
          <div className="login-note">
            <LockKeyhole size={15} />
            <span>
              El registro público está cerrado. Tu administrador gestiona el
              acceso del equipo.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
function revealActiveNavigation() {
  const navigation = document.getElementById("primary-navigation");
  const links = navigation?.querySelectorAll<HTMLElement>('[aria-current="page"]');
  const active = links?.item(links.length - 1);
  if (!navigation || !active) return;
  const container = navigation.getBoundingClientRect(), item = active.getBoundingClientRect();
  if (item.bottom > container.bottom - 8) navigation.scrollTop += item.bottom - container.bottom + 8;
  else if (item.top < container.top + 8) navigation.scrollTop -= container.top - item.top + 8;
}
function Shell() {
  const { session, environment } = useWorkspace();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [mobile, setMobile] = useState(false);
  const [compact, setCompact] = useState(() => localStorage.getItem("commerce-nav-compact") === "true");
  const [small, setSmall] = useState(() => matchMedia("(max-width: 760px)").matches);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const previousPath = useRef(pathname);
  useEffect(() => {
    const media = matchMedia("(max-width: 760px)");
    const update = () => { setSmall(media.matches); setMobile(false); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    localStorage.setItem("commerce-nav-compact", String(compact));
  }, [compact]);
  useEffect(() => {
    if (previousPath.current !== pathname) {
      document.querySelector<HTMLElement>("#main")?.focus();
      window.scrollTo({ top: 0 });
      previousPath.current = pathname;
    }
  }, [pathname]);
  useEffect(() => {
    const navigation = document.getElementById("primary-navigation");
    if (!navigation) return;
    const observer = new ResizeObserver(revealActiveNavigation);
    observer.observe(navigation);
    const frame = requestAnimationFrame(revealActiveNavigation);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [pathname, compact, small, mobile]);
  const current = pathname.startsWith("/account") ? {path:"/account/security",label:"Mi cuenta / Seguridad"} : nav.find((item) => pathname.startsWith(item.path)) ?? nav[0]!;
  const currentSub = salesNav.find((item) => item.path === pathname);
  const can = (permission: string) => session.permissions.includes("*") || session.permissions.includes("read") || session.permissions.includes(permission);
  const visibleNav = nav.filter((item) =>
    item.path === "/results" ? can("reports:read") : item.path === "/sales" ? (can("sales:read") || can("sales:assigned")) :
    item.path === "/campaigns" ? ["owner", "operator", "reconciler", "analyst", "viewer"].includes(session.role) :
    item.path === "/settings" ? ["owner", "operator", "reconciler"].includes(session.role) : true);
  const visibleSalesNav = salesNav.filter((item) =>
    /channels|campaigns/.test(item.path) ? ["owner", "operator"].includes(session.role) :
    item.path.includes("orders") ? ["owner", "operator", "reconciler", "seller"].includes(session.role) : true);
  async function logout() {
    await api("/api/auth/sign-out", { method: "POST", body: "{}" });
    queryClient.clear(); location.reload();
  }
  function navigation() {
    return <>
      <div className="sidebar-heading">
        <Link to="/home" className="brand" aria-label="Commerce OS · Inicio" onClick={() => setMobile(false)}>
          <span className="brand-mark"><Layers3 size={22} /></span><span className="brand-name">Commerce <strong>OS</strong></span>
        </Link>
        {small ? <Dialog.Close className="icon-button" aria-label="Cerrar menú"><X /></Dialog.Close> :
          <button className="icon-button nav-toggle" onClick={() => setCompact(!compact)} aria-label={compact ? "Expandir menú" : "Contraer menú"} aria-expanded={!compact} aria-controls="primary-navigation">
            {compact ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>}
      </div>
      <nav id="primary-navigation" aria-label="Navegación principal">
        {visibleNav.map((item) => <div key={item.path}>
          <Link to={item.path} onClick={() => setMobile(false)} title={item.label} aria-label={item.label}
            aria-current={pathname === item.path || (item.path === "/home" && pathname === "/") ? "page" : undefined}
            className={`nav-item ${current.path === item.path ? "active" : ""}`}>
            <item.icon size={19} /><span className="nav-label">{item.label}</span>
            {item.experimental && <span className="nav-planned">Experimental</span>}
            {item.path === "/sales" && <ChevronDown className="nav-chevron" size={14} />}
          </Link>
          {item.path === "/sales" && pathname.startsWith("/sales") && <div className="subnav">
            {visibleSalesNav.map((sub) => <Link key={sub.path} to={sub.path} activeOptions={{ exact: true }} onClick={() => setMobile(false)}
              title={sub.label} aria-label={sub.label} aria-current={(pathname === sub.path || sub.path==='/sales/flows'&&/^\/sales\/(flows|agents)\//.test(pathname)||sub.path==='/sales/flows'&&pathname==='/sales/agents') ? "page" : undefined} className={(pathname===sub.path||sub.path==='/sales/flows'&&/^\/sales\/(flows|agents)/.test(pathname))?"active":""}>
              <span className="subnav-short" aria-hidden="true">{sub.label.slice(0, 2)}</span><span className="nav-label">{sub.label}</span>
            </Link>)}
          </div>}
        </div>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="environment-note" title={environment === "SIMULATION" ? "Datos simulados" : "Datos reales · Envíos sujetos a autorización"}>
          <ShieldCheck size={18} /><strong>Operación real</strong>
        </div>
        <div className="user-block">
          <Link to="/account/security" className="user-avatar" aria-label="Mi cuenta · Seguridad" title="Mi cuenta · Seguridad" onClick={() => setMobile(false)}>{session.user.name.slice(0, 2).toUpperCase()}</Link>
          <div className="user-name"><strong>{session.user.name}</strong><small>{session.role} · <Link to="/account/security" onClick={() => setMobile(false)}>Mi cuenta</Link></small></div>
          <button onClick={() => { void logout(); }} className="icon-button" title="Cerrar sesión" aria-label="Cerrar sesión"><LogOut size={18} /></button>
        </div>
      </div>
    </>;
  }
  return <div className={`app-shell ${compact && !small ? "nav-compact" : ""}`}>
    <a href="#main" className="skip-link">Saltar al contenido</a>
    {small ? <Dialog.Root open={mobile} onOpenChange={setMobile}>
      <Dialog.Portal><Dialog.Overlay className="sidebar-scrim" />
        <Dialog.Content className="sidebar mobile-open" onOpenAutoFocus={(event) => {
          event.preventDefault();
          const active = document.querySelector<HTMLElement>('#primary-navigation [aria-current="page"]');
          (active ?? document.querySelector<HTMLElement>('.mobile-open button'))?.focus({ preventScroll:true });
          revealActiveNavigation();
        }} onCloseAutoFocus={(event) => { event.preventDefault(); menuTrigger.current?.focus(); }}>
          <Dialog.Title className="sr-only">Navegación de Commerce OS</Dialog.Title>
          <Dialog.Description className="sr-only">Módulos y opciones de tu equipo.</Dialog.Description>
          {navigation()}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root> : <aside className="sidebar desktop-sidebar" aria-label="Menú de Commerce OS">{navigation()}</aside>}
    <div className="app-main">
      <header className="topbar">
        <div className="breadcrumb">
          {small && <button ref={menuTrigger} className="icon-button" onClick={() => setMobile(true)} aria-label="Abrir menú" aria-expanded={mobile} aria-haspopup="dialog"><Menu /></button>}
          <span>Commerce OS</span><ChevronRight size={13} />
          <strong>{current.label}{currentSub && currentSub.path !== "/sales" ? ` / ${currentSub.label}` : ""}</strong>
        </div>
        <div className="topbar-right"><DisplayPreferences/>
          <span className="operation-context" aria-label="Contexto comercial: Operación real"><ShieldCheck size={16} />Operación real</span>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="main-content">
        <Outlet key={environment} />{pathname !== "/settings/tests" && <CommandMonitor key={`command-${environment}`} />}
      </main>
      <footer className="app-footer"><span>Commerce OS · V5</span><Link to="/help/launch">Guía de lanzamiento</Link><Badge tone={pathname === "/settings/tests" ? "info" : "warning"}>{pathname === "/settings/tests" ? "Laboratorio local" : "Datos reales"}</Badge></footer>
    </div>
  </div>;
}
const rootRoute = createRootRoute({ component: App });
const EmptyProfileRoute=()=>null;
const routes = [
  ["/products", EmptyProfileRoute],
  ["/products/$productId/variants", EmptyProfileRoute],
  ["/sales/payments", EmptyProfileRoute],
  ["/sales/payments/rules", EmptyProfileRoute],
  ["/results/goals", EmptyProfileRoute],
  ["/settings/profile", EmptyProfileRoute],
  ["/settings/employees", EmptyProfileRoute],
  ["/account/tokens", EmptyProfileRoute],
  ["/account/integrations", EmptyProfileRoute],
  ["/numbers", EmptyProfileRoute],
  ["/account/security", AccountSecurityPage],
  ["/forgot-password", ForgotPasswordPage],
  ["/reset-password", ResetPasswordPage],
  ["/login", Login],
  ["/settings/integrations/mail", TransactionalMailPage],
  ["/help/launch", LaunchHelpPage],
  ["/home", () => <HomePage />],
  ["/", () => <HomePage />],
  ["/intelligence", ()=><Suspense fallback={<Loading/>}><IntelligencePage/></Suspense>],
  ["/studio", ()=><Navigate to="/archive/materials"/>],
  ["/studio/review/$artifactId", ()=><Navigate to="/archive/materials"/>],
  ["/settings/creative", ()=><Navigate to="/settings/integrations"/>],
  ["/archive/materials", ProductionArchivePage],
  ["/catalog", CatalogPage],
  ["/campaigns", CampaignDashboard],
  ["/campaigns/meta", () => <Navigate to="/settings/integrations/meta" />],
  ["/settings/integrations/meta", () => <Suspense fallback={<Loading />}><MetaPage /></Suspense>],
  ["/settings/integrations", IntegrationsPage],
  ["/settings/integrations/acquisition", AcquisitionPage],
  ["/sales", SalesOverview],
  ["/sales/inbox", InboxPage],
  ["/sales/leads", LeadsPage],
  ["/sales/orders", OrdersPage],
  ["/sales/madrina", ()=><Navigate to="/settings/tests"/>],
  ["/sales/flows", FlowsPage],
  ["/sales/flows/$flowId", FlowsPage],
  ["/sales/agents", SellersPage],
  ["/sales/agents/$agentId", SellersPage],
  ["/sales/campaigns", CampaignsPage],
  ["/sales/channels/whatsapp", NumbersPage],
  ["/sales/warmups", WarmupsPage],
  ["/settings/channels/advanced", ChannelsPage],
  ["/results", ResultsPage],
  ["/settings", SettingsPage],
  ["/settings/tests", TestsPage],
  ["/settings/warmup", ()=><Navigate to="/sales/warmups"/>],
  ["/settings/warmup/legacy", WarmupPage],
  ["/sales/simulator", () => <Navigate to="/settings/tests" />],
  ["/sales/flows/simulator", () => <Navigate to="/settings/tests" />],
  ["/simulator", () => <Navigate to="/settings/tests" />],
] as const;
const routeTree = rootRoute.addChildren(
  routes.map(([path, component]) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component,
      validateSearch: (search: Record<string, unknown>): Record<string,string|undefined> => Object.fromEntries(Object.entries(search).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),
    }),
  ),
);
const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultNotFoundComponent: () => (
    <div className="empty">
      <h1>Esta página no existe</h1>
      <Link to="/home">Volver a Inicio</Link>
    </div>
  ),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
