# V1 Inteligencia y Estudio · registro reanudable

Inicio 2026-09-08. Rama `codex/intelligence-studio-team-v1` desde origin/main `0f6a3e6`. Autorización íntegra registrada por SHA en [H0](evidence/creative-v1/h0.json).

- H0: leído plan, índice, visión/arquitectura, PROGRESS y publicación; worktree separado; corriente AC; KINGSTON756GiB; sesión caffeinate temporal activa. GitHub autenticado, repositorio privado; Windows CI disponible como mecanismo, dispositivo personal aún no comprobado.
- Motor/contratos, worker/Tauri/MCP e Inteligencia/UI avanzan en subagentes. Integrador central coordina DB/broker/R2/API. Builds/renders seriales.
- 0029 tablas nuevas; 0030 Inteligencia del subagente; hashes0001–0028 preservados. Broker durable con UNKNOWN y presupuesto; uploads multipart reservados y verificador remoto por SHA. En implementación, pruebas pendientes.
- Dependencias: ElevenLabs configurado en fichero privado legado; cuenta/cuota por comprobar. Cloudflare sesión legítima disponible. SearchAPI/OpenAI no halladas en .config de Commerce ni secretos ads-factory; revisar dashboard/cuentas antes de declarar faltante. No certificados Apple de firma.
- Siguiente: cerrar API/storage/jobs/settings, compilar e integración PostgreSQL; configurar cuentas, primer paquete+render y R2 temprano.

Ningún estado de esta nota acredita despliegue ni piloto. [Contrato](creative-api-contract.md) · [ADR](adr-creative-team-v1.md).


## Corte de integración 15:15 UTC

- Primer snapshot privado `f772c4bb99e303d09a66bc3a6a895b372eee9a7f`; CI general34243005869 y desktop34243005954 en curso. NO main merge ni despliegue todavía.
- PostgreSQL: broker8/8, storage8/8, Inteligencia8/8 y Studio7/7; unitarias motor20, worker/MCP17 e Inteligencia11. Build/typecheck/lint global PASS antes de cambios siguientes. E2E UI3/3 PASS, captura móvil390px revisada.
- Dos MP4 nuevos Mac (MiCicloListo y Oraciones), con previews/captions/copy/manifests; segundo usa recursos empaquetados DMG. QA técnicoPASS; evaluaciónRemotion solamente; revisión humana finalPENDING. Evidencia específica en creative-engine-evidence.json.
- DMG nativo interno construido188315487bytes e instalado; app abrió, doctor con Node24.20 propio y política de presión de memoria. Directorio personal funciona; configuración de carpeta externa encontró timeout y se corrige asíncronamente. Artefacto final se regenerará del commit correspondiente. Sin firma/notarización OS disponible; no se desactivaron protecciones.
- SearchAPI: sesión real con100créditos iniciales y sin suscripción. Key guardada privadamente0600. OpenAI: cuentaAPI accesible, saldoUSD7.73, autoreload preexistente USD5→10 con límite10mes; no modificado, no nueva recarga. R2: cuentaaccesible, aún sin activar; checkoutrequiere pago y wallets GooglePay/PayPal no completaron acceso. Pendiente comprobar alternativa legítima; no compra confirmada.
- Runtime de servidor separado: dependenciasproduction215, ninguna Remotion/Chromium/FFmpeg/Playwright/Tauri; conserva tsx para migraciones/maintenance. Docker final porCI pendiente.
- En curso: ElevenLabs quote→broker→R2→snapshotderivado, casos dispositivo/fencing/QA, lazyloadingUI, cuentasR2/OpenAI, backupcreativo y matriz completa.

## Corte de verificación de servicios

- Segundo snapshot `5b94c40b294c07591aac53130e2f4c6b1a7bcb9c`: CI general34247043907, nativo con piloto34247060466. DMG de ese SHA instalado y verificado (firma propia de2215recursos); Windows pasó NSIS/doctor y ejecuta renders. Aún no se ha integrado a main.
- R2 Standard activo, bucket privado y CORS limitado al dominio de Commerce OS. Verificador remoto1.0.1 desplegado, secreto privado y ObjectsRead/Write restringido al bucket. WorkersPaidUSD5 mensual confirmado, sin otras compras nuevas al corte.
- Prueba Node→R2 real: tamaño firmado rechaza exceso403; multipart cerrado→SHAstream→copia final verificada; URL antigua404; HEAD/Range206/416/SHA/abort/expiry+renovación PASS. Sólo3.3MB de preview propio y limpieza de los dos objetos de prueba confirmada. [Evidencia](evidence/creative-v1/r2-live-pilot-node.json).
- Navegador detectó CSP productiva `connect-src 'self'`. Corrección acotada a hostsR2 para imágenes/media/conexiones incluida en helperCI, con45pruebasPython PASS; mantiene scripts/self, respaldo y preservación de otros sitios. No se acredita browserR2 hasta el despliegue y repetición.
- Login privado histórico productivo devuelve401; no se cambió contraseña de Brandon ni de otro usuario. Se prepara acceso técnico explícito de piloto mediante administración legítima, sin revisión humana ni envíos.
- OpenAI usa tierdefault y coste según usage con descuento de inputcache (0.075USD/M frente0.75input y4.50output); monto es cálculo tarifario, no factura. Broker9pruebasPASS; reserva conservadora intacta.


## Candidato de publicación 16:38 UTC

- Dos renders nuevos Windows desde NSIS/Node privado y dos Mac: QA12, duraciones42.2/30.5s, captions/copy/receta/assets/fonts y alineación43ms coinciden. MP4 se verifican porSHA individual; no se exige igualdad binaria entreSO. [Comparación](evidence/creative-v1/cross-platform-native-34247060466.md). La cola API/R2 de Windows aún requiere piloto operativo.
- Dos cuentas técnicas viewer y dos productos/ofertas DRAFT de Preescolar/Oraciones creados mediante administración autorizada, sin tocar contraseñas ni ofertas publicadas. Caducidad09-sep16:07UTC. BaselineHTTPS40/40, p95 161.515ms.
- Candidato incluye arranque verificable de ElevenLabs con presupuesto, receipt/configversion atómicos, CSP mínimaR2, políticaMac WARNING≥2GiB y cancelación que conserva bloqueo hasta cierre real del proceso; salidaCLI sin stdin colgado.
- Validación final proporcional: tsc/lint globalPASS,48PythonPASS, broker11PGPASS, voz12PGPASS, devices13PGPASS, engine/procesos22PASS, worker/operational22PASS. El último CI general pasó salvo fixture comercial demasiado amplio; corregido y recorrido completo de accesibilidad/screenfamilies PASS19.7s. CI de main repetirá toda la batería antes de publicar.
- LicenciaRemotion Automators mensual preparada aUSD100; checkout aún sin compra confirmada. Nuevos cargos confirmados: WorkersUSD5/mes, R2baseUSD0+consumo.


## Corrección previa al despliegue 16:50 UTC

- PR1 integrado en mainfb4d1adb; CI34252420629 empaquetó correctamente Linux/amd64, pero se canceló antes de instalar al descubrir permisos faltantes en las6tablas de Inteligencia. No se publicó esa versión.
- Migración aditiva0032 concede permisos mínimos a commerce_api/commerce_automation; conserva0001–0031. Dos pruebas con roles reales, rutas API y scheduler aislados PASS; automation no puede leer identidad/voz/oportunidades ni borrar observaciones.
- Estudio comprueba vencimiento de licencia/evaluación nuevamente en submit (8PGPASS); inputs aprobados se conservan. HelperWindows permite encolar para el dispositivo efímero aprobado aún sin heartbeat, sin simular conexión y sin relajar Mac.14unitPASS.
- Remotioncheckout está bloqueado exclusivamente por CVC no disponible; no compra confirmada. La evaluación interna seguirá limitada a los pilotos propios y expira el09-sep.

- Cambio de instrucción de Brandon: evitar contrataciónRemotion. Checkout cerrado, sin compra ni cobro. Se verifica opciónFree (mismafuncionalidad y automatizacióncomercial para entidad elegible); falta sólo headcount solicitado, no CVC. Despliegue/pruebas independientes continúan.

- Brandon confirmó2personas en el equipo. Remotion4.0.503 califica FREE_ELIGIBLE paraautomatizacióncomercial; contrato de pago eliminado del trabajo. Configuración Free preparada para API publicada, sin expiry artificial ni gasto.


## Corrección de concurrencia de la prueba comercial

- Candidato2a9bfb1: paqueteCI válido; unitarias29archivosPASS e integración322PASS/1SKIP. Una aserción de campañas asumía que la primera promesa del arreglo llegaría antes al servidor; CI observó COALESCED en ella y MISS en la otra. Se comprueba ahora exactamente un MISS y un HIT/COALESCED entre las dos respuestas, conservando igualdad de revisión e invalidaciones. No se cambia el comportamiento de la API ni se elimina el gate.
- El despliegue permanece pendiente hasta que el nuevo SHA complete CI. Disco VPS ampliado30→40GiB sin reinicios, borrados ni OOM; coste estimado adicionalUSD0.40mes. RemotionFree confirmado para2personas, costeUSD0.


## Incidente de instalación y recuperación compatible

- CI34257593617 de78c5ebce completó verify/package, pero install falló a17:54UTC. El import del scheduler desde el módulo de rutas de Inteligencia cargaba BetterAuth en automation, cuyo entorno correctamente carece del secreto de sesiones. No se repartió ese secreto al worker.
- Se recuperaron las cinco aplicaciones con el rollback compatible del releasefdca; PostgreSQL/WAHA y migraciones0029–0032 quedaron intactos. Configuración release.env previa restaurada0600, conservando copia privada del estado fallido. A18:03UTC: servicios saludables, sin reinicios nuevos ni OOM, dosGETcomerciales200 y operaciónREAL congelada.
- El siguiente candidato separa dominio/cola de las rutasHTTP e incorpora arranqueproduction sin BETTER_AUTH_SECRET. Pilotos/grants siguen detenidos hasta un despliegue SUCCEEDED.

## Publicación recuperada y corrección del informe CI

- El servidor instaló `765e7709e582546a7234611c919013a78942e20d` mediante CI34261500883 y terminó SUCCEEDED a18:35:01UTC:32migraciones, seis servicios saludables y CSP/HTTPS comprobados. El cliente consultó el informe antes de existir y observó el servicio systemd ya terminado después; declaró FAILURE sin volver a leer. El estado de GitHub se conserva como fallido, aunque el runtime fue verificado mediante el canal administrativo autenticado. [Informe recuperado](evidence/creative-v1/deployment-34261500883-server-recovered.json).
- El cliente ahora vuelve a leer el informe cuando systemd termina; un error de transporte no acredita que el proceso remoto falló. Se conserva el límite de espera, la identidad SHA/run y la exigencia SUCCEEDED. Cinco pruebas reproducen la carrera y los fallos; batería Python53PASS, revisión independiente sin bloqueantes. La corrección seguirá el CI/CD habitual para cerrar la evidencia de publicación.
- Grants técnicos aplicados con caducidad original: administrador ocho scopes sin review, lector dos scopes y proyectos vacíos, ambos versión1. Dos propietarios y credenciales humanas intactos. R2 y ElevenLabs configurados con secretos cifrados, todavía sin receipt de voz. Remotion FREE_ELIGIBLE activo, sin vencimiento artificial y sin coste. Importación real de medios propios autorizada; las llamadas de Inteligencia/voz siguen acotadas y separadas.

- Circuito R2 aislado con Chromium y WebKit reales PASS sobre el dominio publicado: UploadPart, HEAD, Range206, descarga SHA, seek540p, cancelación y acceso renovado se ejecutaron en el navegador con CSP/TLS normales. JavaScript no pudo leer las respuestas de error416/403; se registra su negación como tal y una petición Node independiente al mismo recurso confirma el código HTTP. No se afirma que esos códigos fueron legibles desde JavaScript. Dos objetos propios por ejecución limpiados; fallo inicial y evidencia por navegador conservados. La autorización API se acredita aparte con la importación.
- Importación API real completada:35archivos READY y dos recetasv1 de Preescolar/Oraciones, con conformidad delegada y revisión humana pendiente. El título del importador se corrigió para recetas canónicas sin metadata legacy opcional;19unitPASS y se reutilizaron los uploads ya confirmados sin repetir bytes. El primer medio pasó por Chromium y quedó vinculado a escenas de la receta.

- El namespace de equipos `/creative-device/v1/*` faltaba en Caddy y devolvía el sitio web. Corrección acotada del helper publicado5e4747f3 aplicada con respaldo, validación, recarga y conservación de otros sitios; GET sin token401JSON comprobado. Mac emparejado y transferido al propietario real, pausado. Lector con dos proyectos y token MCP del propietario con cinco scopes, sin claves de proveedores en equipos.
- ElevenLabs completó dos operaciones reales y dos borradores derivados v3 con tiempos ajustados a audio y clips reales; originalesv1 e historialv2 intactos. Audio/alignment/SHA y validación de recetas PASS. Sin nuevas conformidades, revisión humana ni jobs de esas propuestas.
- Se corrige `artifacts_list`: la API ahora combina `job_id` y `project_id` dentro de workspace, entorno y permisos vigentes. Seis pruebas PostgreSQL cubren dos trabajos del mismo proyecto, combinaciones incompatibles, scopes, otro workspace y UUID inválidos; tipos/lint PASS. El sampler externo al runtime firmado añade CPU/RSS del árbol del Worker y disponibilidad/presión de memoria durante producción, con diez pruebas. No se confunden muestras con auditoría global de OOM.


## Pilotos operativos comprobados y revisión final — 20:00 UTC

- CI34269006389 instaló `abb1788819782c671a6aafecbd6394cd9a8a6344`: SUCCESS/SUCCEEDED,32migraciones, HTTPS/CSP/ruta de dispositivos y seis servicios sanos.227unitarias+1SKIP nativo,330integraciones+1QR opcional SKIP,79E2E y62Python PASS, recuperación y auditoría correctas. Los pilotos siguientes corrieron en la versión compatible5e anterior, salvo lecturas finales enabb.
- Cuatro búsquedas BR/MX/146observaciones con coberturaPARTIAL, veinte análisis de texto completos y dos voces reales con receipts; no más TTS. Dos masters operativos nuevos Mac/Windows, QA12, diez outputs SHAexacto; Windows produjo con Mac pausado y luego hubo concurrencia. Cada benchmark before/during/after tuvo40HTTP200 y pasó por ruta: p95161.515/90.623/88.738ms. VPS sinrender/OOM/restartobservados; recursos nativos incluyen límites explícitos del picoCPUWindows.
- Mac cerró ventana durante render manteniendo GUI/daemon/heartbeat y completó; autostart se activó/comprobó/desactivó conservando false. Dos usuarios y Chromium/WebKit abrieron/descargaron ambos masters con workersdetenidos, SHAexacto, controles teclado/mobile y sin aprobación editorial. Cache de Inteligencia compartido sin consumo y LINK propioDRAFT con catálogo intacto; lector limitado a proyectospermitidos.
- Ocho toolsMCP ejercidas: primerrefreshrealSDK y sieteenCodex0.153.4. El submit repetido devolvió el job existente sin nuevoattempt/reserva. La prueba real detectó que las respuestas grandes de Inteligencia quedaban sin IDs por el fallback24k; se corrige la proyección compacta útil, sin cambiar las ocho tools ni permisos, y se empaquetará/verificará de nuevo.
- RevisiónSTU03 encontró otro fallo de integración: el cache del motor funcionaba dentrodeunworkRoot, pero el worker creaba uno porattempt y no reutilizaba entrejobs. Se implementa un cache de copias descartables por dispositivo, con huella completa, SHA, confinamiento, cuota y verificación del motor. Habrá una prueba acotada de dos versiones de un clon Oraciones, alterando sólo formato del copy en la segunda: un raster nuevo y otro reutilizado, cero proveedores. Originales/masters anteriores permanecen intactos y revisión humanaPENDING.
- Respaldo de cuatro proyectos y objetosR2 a nuevo SSDinterno, con restore aKINGSTON, en verificación. Se preservará como corte previo y se exportará el cambio de cache-pilot después. Distribución privada definitiva espera las dos correcciones; no se anuncian terminadas por pruebas históricas.


## Candidato de cierre Worker 0.1.1 — 20:23 UTC

Se integró `362afed1b89abb92b3cf4c3b98df80195c82555e` en main: cache de raster entre attempts del mismo dispositivo, revalidación de plan/SHA/QA y cuota compartida sin borrar outputs originales; MCP conserva IDs, procedencia y resumen dentro de24KB UTF-8. Versiones nativas coherentes0.1.1, motor1.0.0/API1 conservados. Validación local:41pruebas focales PASS, TypeScript y lint PASS; las pruebas adicionales de Worker sumaron56PASS en su revisión. Se revisaron59archivos, sus enlaces y JSON, sin coincidencias con ocho secretos privados conocidos.

CI general34274395762 y nativo34274395676 comenzaron automáticamente desde ese SHA. Todavía no acreditan nueva instalación ni STU03 operativo. Tras obtener artefactos firmados se reemplaza el instalador entre jobs, se comprueban dos lecturas MCP en cliente real y se ejecutan como máximo dos jobs del clon Oraciones: seed nuevo y cambio sólo de formato en copy. Cero nuevas llamadas de proveedores. La copia de biblioteca anterior sigue íntegra; habrá una copia final nueva después de esos resultados.


## Paquetes y cliente final comprobados — 20:40 UTC

CI nativo34274395676 SUCCESS en Mac/Windows para362afed1. NSIS instalado/doctor Windows y41tests focales incluidos en ambos runners; no se dispararon nuevos renders de evaluación Windows. Mac0.1.1 instalado desde DMG entre jobs,2215recursos Ed25519/SHA verificados y apertura normal/GUI/doctor PASS. Codesign estricto falla en el DMG intacto y en la app anterior: firma ad-hoc del enlazador sin sello de recursos, no certificado de distribución. Se conserva la limitación; no se quitó cuarentena ni cambiaron políticas.

MCP362afed1 firmado/instalado en Codex0.153.4 devolvió15ofertas con IDs y la oferta seleccionada con5observaciones/1análisis,10.207/10.208bytes, cero nuevos consumos. La CLI0.1.1 también comprobó actualización/rollback de dos releases completas firmadas en dataRoot aislado, con2215hashes de cada copia y sin red/render; ese puntero sólo cambia motor/recursos, la app/Node/Worker se actualizan por instalador.

STU03 seed llegó aREVIEW conQA12; el helper privado detectó fence bigint JSONstring"1" frente a su comparación numérica estricta. Se corrigió exclusivamente su parser (number/string decimal canónico seguro;12testsPASS), reanudando el mismo journal/job sin otro submit. Cinco outputs verificados y presupuesto intacto; la fase copy autorizada continúa en el mismo clonv2.


## Cierre técnico — 20:55 UTC

V1 accesible completada. Código instalado362afed1, CI34274395762 SUCCESS/deployment SUCCEEDED20:44:26 y lectura independiente del VPS20:47:36; RemotionFREE_ELIGIBLEv1 habilitado sinexpiry y R2 preservados. Se comprobaron244unitarias,330integraciones,79E2E y62Python; dos omisiones previstas documentadas. El CI nativo34274395676 pasó ambos instaladores y los tests de cache; Mac0.1.1 y MCP362 instalados/comprobados.

STU03 cerró dos attempts reales:279.290s→22.720s, QA12/10outputs SHA, rasters y captions idénticos, nuevos copy/manifest, cero proveedor y revisión humana PENDING. Mac quedóSTOPPED/PAUSED y sus procesos finalizados. Backup nuevo posterior al deploy:4proyectos,59objetos/65entradas,471,626,058bytes,4jobs/20artifacts, verificados en SSD interno y restauración nueva KINGSTON; backup anterior preservado y sin replay.

Release privada `creative-worker-v0.1.1-362afed1` publicada20:52:35UTC con14assets/442,251,274bytes y digests/manifiesto firmado verificados; incluye instaladores y MCP para ambos SO. Windows efímero revocado/secrets eliminados; propietario y Mac conservados. La matriz contiene los28IDs y la revisión independiente no confirmó otros bloqueos funcionales. Quedan la revisión audiovisual humana, la instalación en el Windows personal no accesible y certificados OS de distribución/notarización; apertura normal Mac comprobada sin cambiar protecciones.

La documentación de cierre no cambia la aplicación362afed1 ya instalada; conservar su SHA como runtime aunque el commit documental posterior sea distinto. [Ficha de regreso](creative-v1-delivery.md) · [Matriz](creative-v1-acceptance.md) · [Release verificada](evidence/creative-v1/private-release-published-362afed1.json).
