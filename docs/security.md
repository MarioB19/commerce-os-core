# Modelo de amenazas y límites de seguridad

Esta revisión describe el código de Commerce OS de la entrega inicial de Ventas. La evidencia local está en `docs/evidence/verification-backend.json`; la verificación del despliegue y sus imágenes se registra por separado. No es una auditoría de penetración ni una garantía sobre WhatsApp, OpenAI o el VPS.

## Activos y actores

Se protegen credenciales y sesiones, perfiles bancarios, archivos privados, conversaciones y evidencia de cobro, permisos de contacto, autorizaciones de salida, historial de decisiones y capacidad de restaurar. Los mensajes de clientes, archivos recibidos, respuestas IA, webhooks y datos importados son entradas no confiables. Los operadores tienen roles explícitos; el administrador del VPS, del motor Docker y de las claves permanece dentro de la frontera de confianza.

Una persona con acceso root al host o al socket Docker puede leer memoria, secretos montados y datos, modificar contenedores o sustituir el código. Los permisos del producto y el cifrado de aplicación no protegen contra ese administrador. El mantenimiento utiliza el socket sólo en una tarea administrativa explícita; ningún servicio de aplicación lo monta.

## Acceso de equipo y API

Better Auth proporciona cuentas individuales con contraseña, registro público cerrado, sesiones limitadas y cookies seguras en producción. La API consulta la membresía activa, valida permisos en servidor y exige un origen permitido en mutaciones autenticadas por cookie. La configuración inicial trabaja con una organización por operador; no ofrece un selector de múltiples organizaciones ni roles personalizados. MFA y SSO no están implementados.

| Rol del producto | Alcance implementado |
|---|---|
| owner | Administración, miembros, claves de servicio, configuración, autorizaciones y operación. |
| operator | Catálogo, flujos, ventas, canales, campañas e importaciones; no recibe automáticamente permiso de conciliación o administración de miembros. |
| seller | Catálogo y conversaciones asignadas; los recursos relacionados se verifican por asignación incluso cuando se pide su ID directamente. |
| reconciler | Ventas y revisión/conciliación financiera; no administra credenciales de canal. |
| analyst | Catálogo y reportes/exportaciones permitidos. |
| viewer | Catálogo y lectura de ventas permitida; no revisión de recibos/pedidos reservados. |
| Token de servicio | Scopes permitidos para catálogo/borradores/simulación, expiración y revocación. No puede autorizar salidas ni conciliar. |

La clave de un token de servicio se almacena como hash. Una respuesta privada de creación conservada para idempotencia se cifra. La misma Idempotency-Key con un payload o entorno diferente se rechaza. Rate limits de autenticación y API limitan abuso básico; no sustituyen protección volumétrica del proveedor de infraestructura.

## Fronteras entre servicios y datos

| Componente | Permisos y material necesario |
|---|---|
| Web/Caddy | Sirve la consola y enruta peticiones HTTPS; no recibe claves de gateway ni de cifrado de datos. |
| API | Catálogo, identidad, membresías, controles, comandos, aprobaciones y lectura autorizada; no inserta directamente efectos de mensajería. |
| Ingress | Autentica webhook y persiste el envelope cifrado antes del ACK. No ejecuta flujos ni despacha. |
| Automation | Identidad de negocio, conversaciones, pedidos, recibos, timers y propuestas de efecto. No usa credenciales de envío del gateway. Registra assets recibidos sólo con evidencia sellada del canal. |
| Channel | Única ruta de mensajería, claims e intentos, ownership, salud y descarga de medios. Recibe las claves de los adaptadores que utiliza. |
| Migración/bootstrap | Usuario propietario de PostgreSQL en tareas separadas; no se usa para servir peticiones. |
| Mantenimiento | Backup/restore administrativo y perfil separado para retención; acceso elevado explícito, nunca un endpoint público. |

Los logins runtime heredan un perfil PostgreSQL diferente. Triggers restringen quién escribe cada clase de registro; permisos de tabla/columna separan identidad de acceso, inbox, outbox y decisiones. Las revisiones selladas, envelopes originales, bindings y aristas causales no se editan silenciosamente. Los schemas pg-boss pertenecen a sus respectivos workers.

La separación de workspace/entorno se comprueba en la API, dominio y referencias de base. **No hay Row Level Security por tenant:** los perfiles internos conservan lecturas amplias necesarias para procesamiento. No se presenta esta arquitectura como aislamiento frente a un worker comprometido. La clave simétrica de datos también se comparte entre los servicios que necesitan cifrar o descifrar; no existe todavía una clave independiente por workspace ni un custodio KMS integrado.

Los envelopes originales, perfiles bancarios, archivos privados y resultados sensibles usan AES-256-GCM con IV aleatorio. Los mensajes normalizados y parte de los hechos de negocio se consultan en PostgreSQL sin cifrado de campo; no se afirma que cada dato de cliente esté cifrado por la aplicación. El backup completo sí se cifra con una clave distinta. Los directorios privados y archivos se crean con permisos 0700/0600 fuera del repositorio. El runtime accede a sus assets como UID1000; restore productivo puede asignar explícitamente ese UID/GID al nuevo destino.

## Entradas externas, IA y archivos

WAHA y Cloud validan HMAC sobre los bytes recibidos, filtran la sesión/número configurado y deduplican antes de confirmar recepción. Ingress no está expuesto públicamente para WAHA en la configuración Caddy; Cloud publica únicamente su callback autenticado. Las descargas de media tienen límites y controles de origen/redirección; las URLs y credenciales de proveedor se configuran en el servidor.

Las salidas de IA se validan mediante esquema y reglas locales. El modelo propone o clasifica; no obtiene herramientas ejecutables arbitrarias, secretos de envío ni permiso para confirmar dinero. Los campos deterministas fijan precio, moneda y datos de cobro. Antes de aceptar una respuesta se revalida la conversación, takeover y supresión. Los límites de tokens, timeout y costo dependen de precios/modelo configurados. Los fixtures no acreditan resistencia absoluta a inyección, exactitud de OCR ni calidad del modelo real.

Los assets se sellan por contenido y las lecturas atraviesan autorización de recursos. El sistema no incorpora un antivirus o desarmado de documentos; la autorización de descarga y la validación MIME/tamaño no demuestran que un archivo sea inocuo. La importación conserva origen y grado de verificación, y no crea consentimiento ni inicia automáticamente un flujo a partir de historia importada.

## Acciones externas e incertidumbre

La preparación de sesiones QR dispone ahora de `ALLOW_CHANNEL_ONBOARDING`, separado de habilitar operación real y desactivado por defecto. Consultar o generar un QR no libera el dispatcher. La identidad WAHA sólo se representa mediante verificación y huella; un cambio congela la cuenta. El registro y el worker bloquean la reutilización de gateway/sesión entre cuentas. La puerta determinista de envío exige identidad vigente e aislamiento además de todos sus controles anteriores. Diagnósticos y evidencia: [auditoría QR](qr-audit.md). La verificación alcanzó QR real en un gateway local desechable; no acredita una cuenta productiva vinculada.

REAL requiere flags de proceso, autorización vigente con alcance/versiones y aprobación exacta, además de controles, consentimiento, salud, frecuencia y elegibilidad del canal en el instante del despacho. Cambiar contenido invalida su aprobación. SIMULATION no selecciona un proveedor externo.

Channel registra el claim y el intento antes del HTTP. Timeout ambiguo, intento abandonado o resultado perdido se conservan como UNKNOWN y bloquean sucesores. La secuencia durable y locks breves serializan cada conversación. Una cancelación no deshace un mensaje ya aceptado por WhatsApp. Una cola reconstruible no proporciona entrega remota exactamente una vez.

Un lease vencido no acredita que el dueño anterior haya parado. Transferir ownership exige congelamiento, reconciliación y una prueba firmada de aislamiento real. La aplicación valida la prueba; el operador debe comprobar la infraestructura que afirma esa prueba. Los comandos lifecycle interrumpidos no se repiten automáticamente.

## Despliegue, recuperación y evidencia

Compose limita memoria/CPU/PIDs, rota logs y mantiene PostgreSQL/gateways sin puertos públicos. Los servicios runtime usan usuario sin privilegios, filesystem raíz de sólo lectura, capacidades eliminadas y montajes de datos delimitados. La web incorpora CSP, protección contra framing y HTTPS/HSTS en Caddy. La imagen runtime aún contiene dependencias de construcción junto a las ejecutables; no se declara una imagen mínima o un SBOM auditado.

El instalador verifica el archivo de imágenes, arquitectura y IDs inmutables cargados. Conserva el POC y agrega un sitio Caddy separado, validado antes del reload, con copia para volver atrás. La instalación inicial utiliza una base nueva. En actualizaciones posteriores hay que ejecutar y verificar el backup antes de migrar: `release.sh deploy` no lo ejecuta automáticamente. El rollback de imagen exige compatibilidad de esquema y no deshace acciones externas.

COMOSB02 une snapshot de PostgreSQL y archivos privados inmutables. El restore autentica el paquete antes de crear una base nueva, rechaza rutas/enlaces y divergencias del manifiesto, congela controles/ownership, revoca autorizaciones, elimina sesiones y conserva SENDING como UNKNOWN. No sobrescribe la única base válida. La retención exige política de owner vigente y digest exacto, conserva referencias financieras y genera tombstones; la eliminación de archivos se puede retomar sin fabricar una ejecución nueva.

Las pruebas locales cubren acceso directo, aislamiento, roles PostgreSQL, idempotencia, archivos inmutables, incertidumbre, locks, retención y recuperación. El escaneo de logs busca valores exactos de secretos generados y la configuración aplica redacción de cabeceras/cuerpos; ese escaneo acotado no prueba que nunca pueda registrarse un dato sensible. El monitor externo, copia externa, recuperación de claves, RPO/RTO y sesiones reales tienen evidencias independientes y no se dan por validados al pasar estas pruebas.


## Artefactos de pruebas de navegador

Los reportes Playwright pueden incluir el valor pasado a `fill()` dentro del título de un paso. Limpiar el campo antes del HTTP, desactivar trazas o sanitizar `error-context.md` no elimina por sí solo ese valor del ZIP base64 embebido en `playwright-report/index.html`. La revisión encontró cuatro ocurrencias de una contraseña de prueba local vigente en dos miembros JSON del reporte y las redactó sin alterar el resultado de las pruebas. Su rotación y revocación de sesiones se gestionan por separado; no se expuso una credencial Meta o productiva en ese hallazgo.

Después de cada suite, antes de retener o compartir artefactos, ejecutar `python3 scripts/sanitize-test-artifacts.py`. Lee sólo configuración privada local en memoria, redacta credenciales conocidas y firmas Meta/tokens de servicio en los reportes y elimina valores introducidos de los títulos `Fill`. Esto también protege esos títulos si una contraseña ya fue rotada. Conserva resultados/duraciones, procesa el ZIP embebido y es idempotente; se verificó con datos sintéticos sin copiar credenciales reales a fixtures. El resultado sólo imprime conteos.

`docs/evidence/audit-secret-review.json` distingue hallazgo inicial, saneamiento y escaneo posterior. El escaneo compara valores existentes y firmas, y la revisión OCR/QR cubrió 53 capturas sin resultados positivos. Ni una firma, ni OCR ni la exclusión de `test-results`/`playwright-report` del contexto Docker constituyen una garantía universal de ausencia de PII. Cualquier nueva ejecución que regenere reportes requiere nuevamente saneamiento y revisión. No deben adjuntarse cuerpos HTTP, cookies, tokens o QR como evidencias de prueba.

## Seguridad de cuenta y SMTP — incremento local 07-sep-2026

[Contrato y operación](account-security.md) · [ADR](adr-account-security.md). Better Auth 1.7.2 conserva hashing/sesiones/verificadores; el controlador de todas las rutas nativas habilitadas agrega membresía activa, origen, confirmación, revocación obligatoria y límites persistentes. Cambio/reset/login se serializan por cuenta y las mutaciones de identidad/auditoría se confirman en una transacción. Las cookies sólo salen tras commit y los tokens se retiran del JSON. El preflight de cookie ocurre antes de reservar la conexión de transacción, para evitar agotar el pool mediante lecturas anidadas.

Todos los roles humanos activos tienen acceso a su propia seguridad. Bearer, usuarios desactivados, objetivos manipulados y endpoints alternativos de identidad no autorizan cambios. No se modifica ningún permiso comercial. Las tablas nuevas se conceden sólo al perfil PostgreSQL `commerce_api`; Ingress/Automation/Channel no pueden leerlas ni descifrar correo por una nueva concesión.

SMTP tiene destino/IP permitidos por configuración protegida, TLS/certificado obligatorio en remoto, secretos cifrados con scope/revisión y UI exclusiva de owner. Su cola global independiente no libera campañas ni WhatsApp. Payloads privados se eliminan al finalizar/vencer/invalidarse. Timeout ambiguo tras DATA y claims abandonados no se reenvían automáticamente; SMTP aceptado no implica recibido. Auditoría contiene IDs/resultados/correlación, sin passwords, correos, cookies, tokens ni URLs.

La recuperación usa token en fragmento retirado al cargar, no-store/no-referrer y ninguna analítica/recurso externo. Las contraseñas sólo viven transitoriamente en el formulario, sin caché/idempotencia comercial. Bootstrap no sobreescribe cambios; restore anula enlaces/sesiones y deshabilita correo sin modificar la contraseña guardada. Backups privados cifrados pueden conservar payloads antiguos durante su retención; no se promete borrado físico retroactivo.

La frontera de confianza sigue incluyendo administradores del VPS, PostgreSQL y claves. El spool de un MTA puede contener correo claro con sus permisos propios. No hay garantía de entrega, deduplicación externa, protección volumétrica total o anonimato temporal perfecto. Integración de correo productivo y prueba de recepción siguen pendientes de autorización/configuración.
