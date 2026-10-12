# V7 — Entrada del navegador con perfil nativo

## Decisión previa

El navegador no puede obtener su contexto comercial de `/v1/me`: ese consumidor
histórico resuelve la primera membresía. La entrada revisada usa un único GET de
identidad `/v2/me`, que une la identidad BetterAuth nativa con el listado 020 de esa
misma sesión. No devuelve sesión, token, permisos legados ni empresa inventada.
Una selección nula muestra el selector; una selección guardada sólo se acepta si
el listado nativo confirma un único perfil y versión. Cambiar requiere CAS 020.

El árbol de páginas se desmonta al cambiar de perfil. La pantalla pide descartar
los borradores no guardados antes de iniciar el cambio; los UUID inciertos que
cada consumidor conserva bajo su perfil se mantienen para reconciliar. Tras CAS
se vuelve a leer el bootstrap y sólo se abre la selección confirmada. Ninguna
respuesta antigua puede montar otro perfil. No se hace replay automático de POST.

Se montan páginas ya revisadas: catálogo de lectura, configuración del perfil,
empleados e invitaciones, tokens personales, pagos, reglas de comprobantes y
resultados/metas. Usan sus clientes V2 cerrados, cada uno con perfil y versión. No
se construye un Principal legado desde el navegador ni se reutiliza `api()` para
convertir un selector global en autoridad. La identidad se mantiene fuera del
entorno comercial. El proxy local incluye `/v2` con el mismo destino existente.

## Incremento y gates de cierre

Este incremento integra la entrada y las superficies anteriores, no declara la
navegación final ni la paridad funcional V7. La disposición de las 384 operaciones
V1 observadas se trata por familias según el inventario aprobado; no se monta
Inteligencia/SearchAPI/R2/creativo ni se conserva un simulador como sustituto de RF19.
Los destinos aún no conectados y los enlaces de compatibilidad requieren su
mapeo nativo; no se adivina producto, variante o perfil. Las rutas históricas que
se mantengan fuera de este incremento siguen abiertas en el inventario de corte,
y ninguna navegación de la entrada revisada las ofrece como superficies seguras.

Pendientes: Inicio operativo, inbox/pedidos/revisión, padres/variantes con catálogo
de opciones nativo, números/QR/RF19, campañas de lectura, integraciones IA/Meta,
plataforma, montaje de workers, compatibilidad y retirada F8 tras evidencia. El límite
final es 180 operaciones de negocio y 40 herramientas por las mismas reglas de
conteo del plan, no el número de rutas observado hoy. FULL completo y corte nativo
siguen prohibidos hasta completar esas fronteras y los otros gates del plan.

## Verificación requerida

HTTP: identidad nativa sin bearer, selector ajeno rechazado, ninguna sesión/token
en salida; perfil suspendido/revocado y selección nula se conservan. Navegador real
local con respuestas sintéticas: entrada sin primera empresa, CAS único,
relectura, borrado de estado/solicitudes antiguas, permisos visuales, formularios
existentes, foco/teclado, salida y fallo cerrado. No atribuye BetterAuth real ni
PostgreSQL a una prueba de navegador sintética. La verificación PG de los puertos 020
y de los handlers montados se conserva separada.

## Evidencia del incremento

24 pruebas HTTP/estado/loader y 8 comprobaciones Chromium locales con API
sintética pasan. Typecheck raíz/web y ESLint pasan. La revisión independiente
leyó la composición completa y ejecutó las 24 pruebas host; Chromium se conserva
como evidencia del autor. El ensayo se incorpora como contrato de navegador 15
sin sustituir ni filtrar la suite Playwright montada. La cuenta no muestra un
modo de operación. No se ejecutaron PostgreSQL, proveedores ni despliegues para
este incremento; los puertos nativos mantienen su evidencia anterior separada.
