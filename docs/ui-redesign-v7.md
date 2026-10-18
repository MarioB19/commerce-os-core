# Rediseño de la interfaz web V7 (Etapa R)

Estado: 🟡 en curso · Rama `claude/v7-ui-redesign` (desde `claude/v7-b02-renewal`) · Agente: Claude · Inicio 18-oct-2026.

Dirección visual aprobada por Brandon el 17-oct (canvas «Rediseño Commerce OS V7» y su anexo en `🚀 Prompt de lanzamiento punta a punta V7 — 2026-10-18`). El rediseño **no cambia** API, rutas, redirecciones, permisos ni comportamiento de negocio; sólo toca `apps/web/**`, `tests/e2e/**`, `tests/support/**` y `docs/`.

## R0 — Inventario (18-oct)

### Lo que hay en realidad

El estado de partida del prompt describía `apps/web` como «47 .tsx, styles.css de ~4,000 líneas más 6 CSS por módulo, TanStack Router/Query, xyflow». El inventario real de `claude/v7-b02-renewal` (`2fe5f4e`) es:

| Qué | Real |
|---|---|
| Entradas | `src/main.tsx` (34 líneas): enrutador propio por `window.location.pathname`; sin TanStack ni xyflow. |
| Componentes | 28 en `src/components/` + `src/pages/account-security.tsx` (≈2,650 líneas de TSX denso). |
| Primitivas | sólo `components/ui/button.tsx` (cva + Radix Slot; `data-variant` = `default`/`secondary`/`ghost`/`destructive`). |
| Estilos | un único `src/styles.css` de 4,344 líneas. No existen CSS por módulo: todo el CSS legado (V5 sidebar, creative, intelligence, warmup, inbox, dark theme `data-theme`) vive ahí y **ninguna página V7 lo referencia**; lo vivo son ~400 líneas al final (`.profile-application`, `.results-*`, `.variant-*`, `.number-*`, `.receipt-*`, `.platform-*`, `.login-*`, `.security-*`). |
| Dependencias web | react 19.2, react-dom, @radix-ui/react-dialog 1.1.23, @radix-ui/react-slot 1.3.3, cva, clsx, tailwind-merge, lucide-react 1.41; Vite 8 + Tailwind 4 (`@theme inline`). |
| Utilidades Tailwind en TSX | sólo en `profile-sales.tsx` y en el diálogo de cambio de perfil (`flex gap-2`, `grid gap-6 lg:grid-cols-2`, `rounded border p-3`…). |
| Fuente | Inter por nombre, sin archivo servido. |
| E2E | 3 specs de Playwright (`tests/e2e`), 10 pruebas, viewport 1440×1050 y 390×844, axe WCAG 2 A/AA + 2.1; `pnpm test:e2e` levanta `serve:build` (API + web `vite preview`) contra PostgreSQL local. |
| Unitarias web | `apps/web/src/lib/*.test.ts` (vitest, sin jsdom). |

### Mapa de rutas vigente (no se cambia)

`main.tsx` → `isProfileApplicationPath` (`profile-application.tsx`):

| Destino | Rutas | Componente |
|---|---|---|
| Inicio | `/`, `/home`, `/login` (con sesión) | `ProfilePage` (Inicio inline) + `ProfileOnboarding` + `ProfileHome` |
| Productos | `/products`, `/products/:id`, `/products/:id/variants`, `/products/:id/variants/:vid/(sale\|offer\|collection\|remarketing\|numbers)` | `ProductsHome`, `ProductDetail`, `VariantEditor` |
| Ventas | `/sales/inbox`, `/sales/orders`, `/sales/receipts`, `/sales/payments`, `/sales/payments/rules` | `ProfileSales`, `ReceiptQueue`, `PaymentsRegister`, `ReceiptPolicies` |
| Números | `/numbers`, `/numbers/:id/test` | `ProfileNumbers`, `NumberTest` |
| Campañas | `/campaigns` | `Campaigns` |
| Resultados | `/results`, `/results/goals` | `Results` |
| Menú de cuenta | `/settings/profile`, `/settings/employees`, `/account/integrations`, `/account/tokens`, `/account/security`, `/help` | `ProfileSettings`, `ProfileEmployees`+`ProfileInvitations`, `ProfileIntegrations`, `ProfileTokens`, `AccountSecurityView`, `Help` |
| Identidad | `/login` (sin sesión), `/forgot-password`, `/reset-password`, `/accept-invitation` | `Login`, `ForgotPasswordPage`, `ResetPasswordPage`, `InvitationAccess` |
| Plataforma | `/platform` | `PlatformDashboard` + `PlatformMail` |
| Legado | `legacy-routes.ts`: redirecciones y «Esta función se retiró» | `Retired`, `NotFound` |

Las seis secciones (`profileSections`) y el menú de cuenta se conservan tal cual (etiquetas y `href`).

### Nombres accesibles que usan los E2E (se conservan)

- `navigation[name="Navegación del perfil"]` con exactamente 6 `link` (`Inicio /home`, `Productos /products`, `Ventas /sales/inbox`, `Números /numbers`, `Campañas /campaigns`, `Resultados /results`).
- Disparador del menú de cuenta: un elemento cuyo texto empieza por «Mi cuenta» (`getByText(/^Mi cuenta/)`), visible también a 390 px; al abrirse, `navigation[name="Mi cuenta"]` con links `Seguridad`, `Perfil del negocio`, `Integraciones`, `Empleados e invitaciones`, `Accesos MCP`, `Ayuda`.
- `link "Saltar al contenido"` como primer foco del documento; `#profile-main` recibe el foco al activarlo y al cambiar de ruta.
- `h1` por página: `/^Inicio/`, `Productos`, `Conversaciones`, `Pedidos`, `Comprobantes`, `Pagos`, `Números`, `Campañas`, `Resultados`, `Ayuda`, `Integraciones`, `Seguridad`; `/settings/profile`, `/settings/employees`, `/account/tokens` muestran un `main h2`.
- Objetivos ≥ 44 px: `main button, main summary, main a[data-variant], main input (no checkbox/radio/hidden), main select, main textarea, nav a, header button`.
- Como máximo **un** `main [data-variant="default"]` visible en el viewport al llegar a cada página (1440 y 390 px). El botón primario conserva `data-variant="default"`.
- Sin scroll horizontal a 390 px; axe sin violaciones (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`) en cada página principal, `/login`, `/forgot-password`, `/reset-password`, `/account/security`, `/platform`.
- Variante: `navigation[name="Secciones de la variante"]` con 5 links (`Venta`, `Oferta y materiales`, `Cobro`, `Remarketing`, `Números`); botones `Guardar venta`, `Guardar oferta`, `Guardar cobro`, `/Publicar/`, `Agregar enlace` (exacto), `Agregar material`; `form[name="Agregar material"]` con `radio "Enlace"`, labels `Nombre`, `Enlace (https://)`; `getByLabel(/Precio/)`, `Agregar material entregable` (select), `Etiqueta para el cliente`; `status` con «Cambios guardados» y «Publicado. Asigna un número para empezar a vender.»; texto «Listo para asignar»; en `/products` un `link` con el nombre del producto; el material agregado aparece dentro de un `list`.
- Login: labels `Correo electrónico`, `Contraseña` (exacto), botón `Entrar a Commerce OS`, heading `Bienvenido de nuevo`, link `Olvidé mi contraseña`. Selector de perfil: heading `Tus perfiles`, label `Perfil` (exacto), botón `Cambiar a este perfil`.
- Seguridad: botón `Cambiar contraseña`, labels `Contraseña actual`, `Nueva contraseña`, `Confirmar nueva contraseña`, botones `Mostrar/Ocultar nueva contraseña` (`aria-pressed`), `status` «Contraseña actualizada»; recuperación: headings `Recupera tu acceso`, `Elige una nueva contraseña`, `Contraseña restablecida`, botón `Enviar enlace de recuperación`, `Restablecer contraseña`, links `Iniciar sesión`, `Solicitar otro enlace`.
- Plataforma (correo): heading `Correo transaccional`, botón `Configurar Resend`, labels `Correo remitente`, `Host SMTP`, `Puerto`, `Seguridad de conexión`, `Usuario SMTP`, `Envío de recuperación`, `API key de Resend`, botón `Guardar configuración`, `status` «Configuración guardada».
- Ayuda: link `Operar con IA (Claude o Codex)`, botón `Descargar guía`.

Si algún nombre cambia, el spec cambia en el mismo commit y se anota aquí.

### Componentes a crear (`components/ui/`)

`button` (primario = `default`, secundario, terciario = `ghost`, destructivo; `loading`; `asChild`), `input`, `textarea`, `select` (Radix Select, versión fijada; `NativeSelect` para listas largas), `checkbox`, `field` (etiqueta permanente + ayuda + error con `aria-describedby`), `card`, `badge` (icono + texto + tono), `table` (encabezados, orden, scroll horizontal en caja), `segmented` (`aria-pressed`), `tabs` (Radix Tabs), `dialog` (Radix Dialog con retorno de foco), `toast` (Radix Toast), `skeleton`, `empty-state`, `page-header`, `progress`, `alert` (estado con icono + texto), `kpi` (cifra tabular). Shell: `app-shell` (barra lateral 248 px, barra superior 64 px, pestañas inferiores móviles).

### CSS que desaparece

Todo el CSS legado de `styles.css` (líneas 1–~3,950: V5 sidebar/topbar glass, `data-theme="dark"`, creative, intelligence, warmup, inbox, numbers drawer, resilience `ux-*`, modales legados). `styles.css` se reescribe con los tokens V7 y sólo las reglas que usan las pantallas V7. No existen los archivos `v5-cards.css`, `warmup.css`, `meta.css`, `campaign-performance.css`, `creative.css` ni `mcl-launch.css` en este repo (pertenecen al repo `commerce-os` anterior); su equivalente aquí es el bloque legado de `styles.css`.

### Decisiones tomadas en R0 (lectura razonable; corregibles)

1. **Tema claro único.** El canvas es claro; el tema oscuro `data-theme` legado no se conserva (no lo usa ninguna pantalla V7). `prefers-reduced-motion` y `prefers-reduced-transparency` sí.
2. **Fuente local.** Instrument Sans variable (OFL 1.1) vendida desde el paquete `@fontsource-variable/instrument-sans@5.2.6` a `apps/web/public/fonts/` con su licencia; no se añade dependencia ni se carga desde Google.
3. **Pruebas de primitivas sin jsdom.** `react-dom/server` (`renderToStaticMarkup`) + aserciones de atributos accesibles, en vitest; la accesibilidad real la acredita axe en E2E. No se añade `jsdom`/`@testing-library` (fuera de `@radix-ui/*`).
4. **`data-variant`** se conserva en el botón para la regla «una acción primaria por página».
5. **`section` como vista previa del primer mensaje** en Variante se compone con el documento ya cargado (sin llamadas nuevas a la API).

## Avance

- 18-oct — R0 inventario escrito. Siguiente: R1 (tokens, fuente, primitivas).
