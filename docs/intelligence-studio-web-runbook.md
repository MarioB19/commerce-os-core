# Inteligencia y Estudio en web · Experimental

## Preparación

En **Configuración → Inteligencia y Estudio**, revisa proveedores, cuota, biblioteca y equipos. Una API key guardada no acredita una llamada real: el receipt aparece separado. Los secretos se guardan cifrados; el formulario no los vuelve a mostrar. Remotion requiere registrar el modo y evidencia de licencia aplicable, o una evaluación interna delimitada. La biblioteca requiere R2 privado y verificador remoto configurado; el VPS no renderiza ni transcodifica.

Cada integrante recibe scopes creativos. Los permisos comerciales no los conceden automáticamente. Los scopes de Inteligencia cubren evidencia del workspace; los proyectos permitidos limitan Estudio. Un token humano MCP queda limitado además por membresía activa y grants actuales. Crear un token no concede autoaprobación editorial ni acceso a claves de proveedor. Usa configuración privada del cliente, y revócalo desde API y tokens cuando deje de necesitarse.

Conectar equipo: abre el enlace de emparejamiento mostrado por Commerce Worker. La página recupera únicamente ese ID efímero. Comprueba nombre/plataforma, escribe el código del equipo y selecciona proyectos explícitos. Un heartbeat viejo se muestra sin conexión; nuevos renders esperan y los archivos ya subidos siguen disponibles.

## Inteligencia

1. Guarda una búsqueda BR/MX con sus filtros. No consume proveedor. Los defaults son 2 páginas y hasta100 anuncios.
2. **Actualizar con proveedor** solicita un run durable sujeto a presupuesto. 202 significa aceptado; consulta su historial para completado, error o UNKNOWN. Una respuesta incierta conserva reserva y no se reenvía a ciegas.
3. Consulta ofertas almacenadas, fuentes, fecha, original y score desglosado. Cobertura PARTIAL/STALE/UNAVAILABLE; señales de anuncios no demuestran ventas. El idioma por mercado es una inferencia cuando la fuente no lo declara.
4. Analiza texto seleccionado con IA. Se valida formato y referencias, y se declara muestra/modalidad realmente analizada. Respuestas inválidas, rechazadas o incompletas no se convierten en hechos. El resultado cacheado no genera una llamada nueva.
5. Corrige títulos o separa/mueve observaciones entre ofertas con motivo; el historial conserva el origen. Guarda una oportunidad y llévala al Estudio para un brief/producto propio. No se copian medios competidores ni se publican ofertas.
6. Si necesitas seguimiento diario, configura un tope y actívalo expresamente. Empieza apagado, mantiene máximo un pendiente y no recupera intervalos perdidos en ráfaga. El presupuesto central también aplica.

La importación manual acepta un array de anuncios o respuesta con `ads`, URL HTTPS de origen y fecha observada. Es evidencia declarada por quien importa, no validación automática de sus afirmaciones.

## Primer creativo

1. Crea un proyecto con producto del catálogo y oferta. También puedes partir de una oportunidad sin convertirla en contenido aprobado.
2. Crea una receta individual o importa un playbook canónico6×3 completo. Importar no produce18 variantes: después selecciona sólo la receta que quieres renderizar.
3. Comparte fuentes, imágenes/videos, audio y alignment JSON propios o licenciados en **Biblioteca**. Registra evidencia de derechos. El navegador calcula SHA incremental, sube partes directamente a R2 y el servidor verifica antes de READY.
4. Completa contenido, escenas, copy, fuentes y claims. El audio aportado requiere TimedWord por palabra con `text`, `startFrame`, `endFrame` inclusivo y `chunkId`, a30fps. Puedes importar/editar tiempos; no se estiman automáticamente ni se usa SRT por frases como sustituto. Declara comprobación contra el audio y selecciona el documento de alignment compartido.
5. Guarda la receta: cada versión es inmutable, con SHA. Puedes guardar un borrador incompleto. Si otro integrante cambió la misma versión, la API devuelve409 y tus cambios permanecen para comparar; no sobrescribe silenciosamente.
6. Registra conformidad de los inputs y **Valida y cotiza**. Revisa faltantes, derivados reutilizables, coste y equipos. Una cotización bloqueada no se puede enviar a producir. La conformidad de inputs no equivale a revisión audiovisual final.
7. **Producir sólo este creativo** autoriza esa versión dentro del tope. Sigue el trabajo, pasos e intentos; ausencia de equipo no significa fallo ni trabajo terminado.
8. En **Revisión**, abre los archivos reales y registra tu decisión editorial por SHA. Aprobación de producción requiere la última revisión editorial aprobada y QA técnico PASS. Un cambio posterior invalida lo correspondiente. Aprobar un archivo no activa anuncios, campañas ni mensajes.

## Voz con ElevenLabs

En **Voz y captions**, guarda la transcripción y abre **Voz ElevenLabs experimental**. Selecciona una voz autorizada y modelo, y cotiza sin generar. La cotización dura15min y queda ligada a versión, texto y SHA. Revisa coste estimado y fija el tope antes de **Generar esta voz**; la configuración requiere un recibo del piloto real verificado.

El historial de voz se recupera desde la API al recargar. UNKNOWN conserva la misma operación hasta confirmar recibo; **Recuperar esta operación** no repite un POST pagado incierto. PAID_PENDING_STORAGE significa recibo confirmado y archivos todavía pendientes. El coste confirmado sólo aparece cuando existe en el recibo, separado de la estimación. DERIVED incorpora audio y TimedWord a una versión nueva; requiere conformidad y revisión nuevas. Si otro integrante editó la receta durante la llamada, CONFLICT conserva los archivos en Biblioteca sin sobrescribir su versión.

## Transferencias y recuperación

Al recargar el navegador, Biblioteca recupera las sesiones propias pendientes. **Reconciliar subida pendiente** consulta su estado durable y recupera inicio/finalización conocidos sin crear otro multipart incierto. Para continuar partes, vuelve a seleccionar el archivo exacto: SHA y tamaño deben coincidir. Puedes cancelar y liberar una sesión que no esté finalizada; READY se conserva. Si falla limpieza de staging, la reserva sigue visible hasta confirmarse la limpieza.

Las URLs temporales sólo se solicitan después de autorizar workspace/proyecto/archivo. Preview de audio/video renueva al fallar por expiración y conserva posición de reproducción, con reintentos acotados; también puedes renovar manualmente. Un enlace de revisión por ID recupera el artefacto aunque sea histórico y quede fuera del listado inicial. Los links autenticados son durables; las URLs R2 no lo son.

## Evidencia de desarrollo

La suite `tests/unit/intelligence.test.ts` cubre normalización, límites, agrupación, ausencia de métricas, esquema Responses/refusal y selección acotada. `tests/integration/creative-intelligence.test.ts` usa PostgreSQL aislado para cache compartido, refresh concurrente, scope/entorno, versiones, historial y permisos. `tests/integration/creative-studio-ui.test.ts` comprueba borradores, edición concurrente, submit deduplicado, SHA/inputs/assets, aislamiento de subidas y última revisión editorial. Sus materiales/QA son fixtures de contrato identificadas: no acreditan biblioteca remota, instalación de equipos ni render audiovisual.

`tests/e2e/intelligence-studio.spec.ts` usa HTTP/API reales contra la base de E2E; no instala respuestas mock de UI ni consume proveedores. La matriz final del release registra sus resultados y distingue pruebas locales, publicación, pilotos reales y revisión humana pendiente.
