# Commerce Worker y MCP · Experimental

Commerce Worker aporta un render simultáneo desde un equipo autorizado. La web/API conserva permisos, cotizaciones, leases y archivos compartidos. Cerrar el chat o la ventana no termina el worker; apagar el equipo o cerrar la sesión sí interrumpe la ejecución local.

## Soporte e instalación

Targets V1: macOS 14 o posterior en Apple Silicon y Windows 10 22H2 (19045) o posterior x64. La matriz de evidencia distingue binario construido, ejecución en CI, instalación y render en un equipo de persona. Windows ARM, Mac Intel y Linux no se anuncian compatibles.

La entrega privada incluye Tauri 2, Node 24.20.0, motor 1.0.0, Remotion 4.0.503, Chrome Headless Shell fijado por Remotion, FFmpeg/FFprobe y la fuente Bricolage Grotesque 5.3.0. El usuario no instala Git, Node global, Rust, Docker, WSL, Bash ni Homebrew. macOS recibe `.app`/`.dmg`; Windows NSIS por usuario e instalador oficial WebView2 si falta. Usar sólo los artefactos privados y sus checksums del SHA publicado.

La [entrega privada 0.1.1, fuente 362afed1](https://github.com/MarioB19/commerce-os/releases/tag/creative-worker-v0.1.1-362afed1) reúne 14 archivos: instaladores Mac/Windows, ZIP MCP de ambas plataformas, manifiestos, firmas, checksums y guía. Requiere acceso autorizado al repositorio privado; no se ha invitado ni enviado archivos a otra persona. El token de cada usuario se configura por separado y no está incluido. [Recibo de publicación privada y digests](evidence/creative-v1/private-release-published-362afed1.json).

1. Instalar el paquete correspondiente. Las builds sin certificado se identifican como **internas sin firma de distribución**. No desactivar Gatekeeper/SmartScreen ni eliminar cuarentena para eludir una advertencia. La instalación local asistida y la distribución certificada son estados distintos.
2. Abrir Commerce Worker y conservar el servidor HTTPS publicado.
3. Elegir carpeta de datos o dejar vacía para la carpeta personal. En Mac: `~/Library/Application Support/Commerce Worker`; Windows: `%LOCALAPPDATA%\CommerceWorker`. Un disco externo debe estar montado e identificarse correctamente; su ausencia pausa, sin crear otra carpeta silenciosamente.
4. Solicitar código. El dueño abre **Preparación → Equipos**, comprueba el código y aprueba los proyectos permitidos. El código y su permiso de consulta caducan; el token de dispositivo queda sólo en almacenamiento privado del usuario, separado de materiales.
5. Comprobar aprobación y pulsar Iniciar. El diagnóstico indica bloqueos concretos. Autostart es opcional.

El Mac piloto usa la app en `~/Applications/Commerce Worker.app` y la carpeta de datos personal del SSD interno. KINGSTON conserva código, evidencia y restauraciones administrativas; no es una dependencia configurada del worker instalado. No se realizó una prueba física de desmontaje del volumen durante este trabajo.

## Recursos y controles

Un render por proceso/equipo, Remotion concurrency 1 y FFmpeg threads 2. Admisión por corriente por defecto, mínimo 10 GiB libres o reserva configurada mayor, memoria comprobada y horario opcional. La caché de inputs y copias reutilizables de raster comparte un máximo configurable de 30 GiB. La purga elimina sólo esas copias descartables cuando no están protegidas, nunca fuentes ni masters originales de los jobs. Los hashes activos se conservan hasta completar su intento; la caché puede superar temporalmente el límite si todo el contenido está protegido por un trabajo activo.

Pausar evita nuevos claims. Detener espera el trabajo activo. La opción de bandeja **Salir al terminar el trabajo** espera a que termine el proceso y libera el inhibidor de suspensión. Cerrar la ventana sólo la oculta. La app supervisa el proceso Node y limita a tres reinicios ante fallos; no repite operaciones de proveedor. Un proceso muerto recupera el journal y reconcilia con el servidor antes de promover. Al detenerse, el CLI cierra su lector STDIO aunque el padre Tauri mantenga el pipe abierto; una prueba del CLI empaquetado confirma salida normal y estado STOPPED sin render ni red.

`doctor`, `start`, `pause`, `resume`, `status`, `resources`, `pair`, `pair-poll`, `backup`, `update` y `rollback` son comandos locales tipados del runtime. El frontend no dispone de shell, filesystem general, puertos públicos o túneles. Los subprocessos son binarios propios con argumentos del motor; ninguna receta contiene código ejecutable.

## Offline, cuotas y recuperación

Los assets se descargan por ID/SHA con URLs breves, límites de bytes y comprobación de hash. No se usan nombres remotos como paths. Journal, workdirs y caché permanecen en la carpeta de datos; credenciales quedan en carpeta privada. Un disco reemplazado o symlink pausa la admisión.

Heartbeat inicial 15 s, lease 90 s y fencing del servidor. Un render cuyos inputs ya están locales puede terminar offline; conserva outputs y espera reconexión. El siguiente ciclo reconcilia el attempt antes de subir/promover. Un attempt antiguo queda STALE; un nuevo worker puede repetir el cómputo puro desde inputs durables. No se promete retomar el frame exacto ni se repite TTS por cambiar equipo.

Subida multipart de 8 MiB, secuencial y limitada a 500 MiB por archivo. El servidor inicia/completa; el worker sólo tiene acceso a las partes asignadas. Hash y tipo final se verifican en servidor; ETag no sustituye SHA256. Un archivo sólo se comparte como READY después del cierre y verificación. Revocar un dispositivo bloquea nuevos accesos; una URL ya emitida conserva su TTL.

Ante `INSUFFICIENT_DISK`, liberar archivos propios ajenos al producto o elegir una carpeta con capacidad; el producto no elimina fuentes/masters para resolverlo. Ante `DATA_VOLUME_UNAVAILABLE` o `DATA_VOLUME_CHANGED`, montar la unidad original y comprobar el diagnóstico. Ante `RECOVERY_PENDING`, restablecer red y comprobar el job web. El broker conserva UNKNOWN tras una llamada de pago incierta; el worker no tiene credenciales ni comando para repetirla.

## Actualización y rollback

API compatible primero. El runtime acepta una carpeta de release con `release.json` y firma Ed25519 `release.sig`; verifica versión, plataforma, intervalo API, paths y SHA de todos los archivos. El public key de confianza se incluye en el paquete original. La activación sólo se permite sin job pendiente y con worker detenido desde la app; se copia a una versión nueva en datos y se cambia el puntero atómicamente. Ese puntero selecciona el motor y sus recursos. Se conserva la versión anterior, journal y archivos. Rollback vuelve sólo a una versión de motor/recursos cuya firma y compatibilidad siguen siendo válidas.

La firma de recursos no sustituye firma/notarización de macOS o Authenticode. Sin llave de release no se habilita actualización verificada: la build queda identificada `INTERNAL_UNSIGNED`. Node, Tauri y la lógica JS del Worker se actualizan mediante instalador nuevo, entre jobs; el rollback del puntero no reemplaza esos componentes de la app. No se reemplaza un ejecutable durante un render. Nunca se descarga una URL o ejecuta un comando suministrado por una receta.

La verificación automatizada de activación y rollback usa releases sintéticas identificadas, firmadas con una clave de prueba: bloquea un worker activo o journal pendiente, comprueba integridad, activa dos versiones y vuelve a la anterior. Además se probó el comando real de la app 0.1.1 en un dataRoot aislado: activó la release completa firmada `fb4d1adb`/0.1.0, después `362afed1`/0.1.1 y volvió a motor/recursos 0.1.0. Se verificaron los 2.215 archivos de cada copia y la conservación de configuración/token personales, sin red, pairing ni render. [Recibo de actualización y rollback real](evidence/creative-v1/worker-real-signed-update-rollback.json).

## Backup y desinstalación

Con el worker detenido, `backup` exporta journal y puntero de versión a una carpeta nueva. No incluye tokens, masters ni bucket: la copia independiente de metadata y objetos R2 pertenece al runbook de biblioteca, y debe verificarse por hashes. Para recuperación, conservar la copia original, restaurar en carpeta nueva y emparejar nuevamente; reconciliar con servidor antes de reanudar. Nunca importar un token de otro equipo ni reproducir operaciones externas desde un backup.

Desinstalar la app conserva por defecto carpeta de datos y biblioteca remota. Desactivar autostart y revocar el equipo en web antes de retirarlo. Sólo el dueño decide eliminar por separado materiales locales; no se ejecuta borrado de datos al desinstalar.

## MCP sin motor local

El paquete fino contiene `node`/`node.exe` y `mcp.mjs`, sin Chrome/FFmpeg. El proceso habla MCP STDIO usando el SDK oficial; stdout contiene únicamente el protocolo. Requiere un **token humano** revocable por workspace/scopes, distinto del token de dispositivo y sin keys de proveedores. Guardarlo en un archivo privado 0600 en macOS o carpeta privada del usuario en Windows.

Ocho herramientas: `intelligence_search` (cache), `intelligence_refresh`, `intelligence_get_offer`, `studio_create_brief`, `studio_quote_render`, `studio_submit_render`, `jobs_get`, `artifacts_list`. Mutaciones conservan `expected_version`, `idempotency_key`, cotización y tope; 202/job_id indica aceptación. Crear un brief requiere `product_id` UUID y título de 1 a 160 caracteres; `offer_id`, si se aporta, también debe ser UUID, igual que en la API. No hay herramientas para aprobar contenido/gasto/producción, ni para publicar anuncios. Salidas acotadas omiten URLs firmadas, tokens, base64 y paths privados.

Ejemplo Codex (`NODE_PRIVADO`, `MCP_JS` y `TOKEN_FILE` son rutas absolutas del paquete y archivo privado):

```toml
[mcp_servers.commerce_os]
command = "NODE_PRIVADO"
args = ["MCP_JS"]
[mcp_servers.commerce_os.env]
COMMERCE_API_ORIGIN = "https://commerce-os.inovaris.online"
COMMERCE_MCP_TOKEN_FILE = "TOKEN_FILE"
```

Para actualizar sólo MCP, `scripts/package-creative-mcp.mjs` empaqueta el commit limpio actual en una carpeta nueva con Node 24 previamente verificado, SDK incluido y licencias. Exige rutas absolutas `--output`, `--base-package`, `--private-key-file` y `--public-key-file`; no modifica la app ni el motor instalados. Produce `mcp-release.json` y firma Ed25519 `mcp-release.sig`, con commit y SHA por archivo. Se verifica con la clave de confianza previa antes de instalar. El manifiesto MCP tiene un nombre distinto del manifiesto de actualización del worker para evitar activarlo como runtime de render.

Codex acepta `codex mcp add commerce_os --env COMMERCE_API_ORIGIN=https://commerce-os.inovaris.online --env COMMERCE_MCP_TOKEN_FILE=TOKEN_FILE -- NODE_PRIVADO MCP_JS`. La configuración contiene la ruta, nunca el token. El cliente real comprobado fue la CLI 0.153.4 incluida con la app; una CLI global 0.147.0 no reconoció el modelo configurado y falló antes de llamar herramientas. [Documentación oficial de Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Ejemplo Claude Code de configuración STDIO equivalente:

```json
{"mcpServers":{"commerce_os":{"command":"NODE_PRIVADO","args":["MCP_JS"],"env":{"COMMERCE_API_ORIGIN":"https://commerce-os.inovaris.online","COMMERCE_MCP_TOKEN_FILE":"TOKEN_FILE"}}}}
```

Para Windows, usar rutas JSON escapadas (`C:\\Users\\…`) o slash normal. Configurar no acredita una llamada real: la matriz final registra por separado protocolo SDK, cliente real conectado y operaciones contra API publicada.

## Build, procedencia y licencias

`scripts/package-creative-desktop.mjs` descarga Node oficial con SHA fijado, instala dependencias nativas por SO, crea composición revisada y manifiesto por archivo. `.github/workflows/creative-desktop.yml` sólo ejecuta en el repositorio privado y conserva artefactos privados 30 días. Cargo.lock fija Rust/Tauri; pnpm-lock fija herramientas JS. El build Windows corre en `windows-2022`, no en cross-compilación Mac.

FFmpeg full para QA usa binarios `eugeneware/ffmpeg-static b6.1.1` con SHA oficial de cada asset, LICENSE/README de la misma release. El compositor Remotion incluye su propio FFmpeg n7.1, pero su selección de filtros no incluye todos los necesarios para QA; no se usa para sustituir blackdetect/volumedetect. Los ejecutables corren separados de la fábrica. Conservar avisos y código fuente correspondiente de los componentes GPL en la distribución privada; esto no autoriza publicar código propio. [Fuentes y builds de FFmpeg](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1) · [Licencias FFmpeg](https://ffmpeg.org/legal.html).

El usuario confirmó un equipo de dos personas y se registró `FREE_ELIGIBLE` para Remotion 4.0.503, incluido el uso comercial automatizado conforme a la licencia aplicable. No se compró una licencia Remotion. El tamaño del equipo, no el número de equipos informáticos, determina ese alcance. [Licencia Remotion](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md). Tauri permite runtime Node y JS como recursos privados separados. [Sidecar Node oficial](https://v2.tauri.app/learn/sidecar-nodejs/).

Histórico: el CI privado [34247060466](https://github.com/MarioB19/commerce-os/actions/runs/34247060466), SHA 5b94c40, completó ambos instaladores nativos y dos renders Windows mediante el motor instalado directamente. Ese primer ensayo no acreditaba claim de API ni transferencia R2.

El instalador posterior de [34252420679](https://github.com/MarioB19/commerce-os/actions/runs/34252420679), fuente `fb4d1adb6571f1e873a2c36d719844de47f10b63`, sí se usó para el piloto operativo Mac y Windows: pairing real, inputs R2, claim/heartbeat, renders simultáneos, cinco outputs verificados por SHA por job y QA 12/12. Ambos quedaron `REVIEW`, con revisiones humanas pendientes. La continuidad tras cerrar sólo la ventana del Mac y el arranque desde la app están comprobados. Windows corresponde a un runner nativo de CI; no se afirma instalación en el equipo personal de un compañero. [Evidencia operativa](commerce-worker-operational-pilot.md).

Autostart se comprobó desde la GUI instalada: desactivado → activado con LaunchAgent nativo → desactivado. Se conservó el estado inicial y el daemon detenido; no se cerró ni inició una sesión de macOS. [Recibo del control opcional](evidence/creative-v1/worker-mac-autostart-roundtrip.json).

El MCP `b12fbd07` se configuró con un token del dueño de cinco scopes y se ejercitaron siete herramientas mediante Codex real; el refresh restante se ejecutó por STDIO dentro del presupuesto INT, sin repetición. Quote/submit devolvieron el job existente y no provocaron otro render. La salida INT extensa de esa versión perdió IDs al truncarse. El paquete corregido `362afed1` ya se firmó, instaló y comprobó desde Codex real: 15 ofertas con IDs/versiones y una oferta con cinco observaciones, hashes/run y análisis conservados; ambas respuestas rondaron 10 KiB y no consumieron proveedores. [Prueba de lecturas útiles](evidence/creative-v1/mcp-codex-useful-362afed1.json).

También se detectó que la caché de raster del worker anterior estaba aislada por intento. La versión 0.1.1, fuente `362afed1`, pasó ambos builds nativos, las pruebas de caché entre dos attempts y la instalación/doctor Windows en [34274395676](https://github.com/MarioB19/commerce-os/actions/runs/34274395676). El Mac se actualizó entre jobs con configuración y token intactos, abrió normalmente y mostró GUI/doctor 0.1.1. El MCP Windows se incluye como paquete portátil firmado procedente de ese CI; su JS coincide por SHA con el probado en el Mac, pero no se afirma cliente MCP Windows real.

La comprobación estricta `codesign --verify --deep --strict` falla ya en el DMG original: `code has no resources but signature indicates they must be present`. La firma es `adhoc,linker-signed`, con Info.plist no vinculado y sin recursos sellados. La app anterior presenta el mismo fallo. La apertura normal y el diagnóstico de 0.1.1 sí pasaron, igual que los hashes y firma Ed25519 de todos los recursos; no se quitó cuarentena ni se cambiaron políticas. Este límite del bundle interno no se presenta como una firma OS válida. [Instalación Mac y fallo literal](evidence/creative-v1/worker-mac-ci-362afed1.json) · [Windows instalado en CI](evidence/creative-v1/worker-windows-ci-362afed1.json).

La prueba operativa 0.1.1 entre dos jobs terminó PASS: seed 279,290 s y copy 22,720 s, con master/preview/subtítulos idénticos por SHA, nuevos copy/manifest y cero consumo de proveedores. La app quedó detenida y pausada. El backup final de los cuatro proyectos y su restore independiente verificaron 59 objetos y todos los hashes. El borrador privado `fb4d1adb` + `b12fbd07` se conserva como evidencia histórica. [Reutilización operativa](evidence/creative-v1/published-render-reuse-362afed1.json) · [Backup final](evidence/creative-v1/library-final-backup-restore-362afed1.json).

La copia verificable de biblioteca seleccionada y restauración local se documentan en [commerce-worker-library-backup.md](commerce-worker-library-backup.md).

En macOS el doctor distingue memoria inmediatamente libre de memoria recuperable: consulta `memory_pressure -Q` y la presión nativa `kern.memorystatus_vm_pressure_level`, con timeout de 5 segundos. Admite NORMAL con al menos 512 MiB recuperables y WARNING con al menos 2 GiB; mantiene WARNING visible. CRITICAL, valores desconocidos y lecturas no disponibles bloquean nuevos trabajos. Durante el cómputo consulta presión cada 5 segundos sin solapar consultas; una lectura CRITICAL aborta el render mediante su AbortSignal, registra MEMORY_PRESSURE_CRITICAL en el journal y solicita RETRY con el fence del intento. Sólo reintenta cómputo local; no invoca proveedores ni crea artefactos del intento cancelado. El intento siguiente obtiene otro fence y vuelve a pasar admisión. El fallback conserva el dato bruto y se declara conservador. Windows usa memoria física disponible del sistema.

La presión nativa describe el estado actual y utiliza histéresis: puede permanecer WARNING mientras el porcentaje recuperable ronda el 30%; no implica que la lectura esté obsoleta. La política WARNING de 2 GiB es una decisión de admisión de Commerce Worker. Fuentes primarias: [XNU: notificaciones de memoria](https://github.com/apple-oss-distributions/xnu/blob/main/doc/vm/memorystatus_notify.md), [implementación del sysctl de presión](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/kern/kern_memorystatus_notify.c).

Verificación de esta política: 28 pruebas unitarias Worker/MCP/backup y 13 casos en PostgreSQL aislado aprobados, incluyendo límites exactos, aborto de un subprocess real identificado como fixture, journal de retry y rechazo del fence anterior. TypeScript y ESLint aprobados. La política ya se instaló con `fb4d1adb` y se observó durante el piloto Mac: presión WARNING/NORMAL, mínimo 2,24 GiB recuperables durante cómputo y ninguna muestra CRITICAL. [Recursos observados y límites de medición](evidence/creative-v1/worker-operational-resource-summary.json).
