# Despacho de correo GCP · V7

Decisión del 11-oct-2026, antes de implementar. Desarrolla ADR-V7-13 sin
cambiar Better Auth ni contratar SMTP. La activación permanece sujeta a
publicación canónica, disponibilidad nativa de App Engine/Mail API y prueba
real a un buzón controlado. Aceptación del API nunca acredita recepción.

La outbox transaccional revalida propietario/perfil/versión y reserva antes de
cada llamada externa: cuota de destinatarios, coste de la invocación y tiempo
de cola/arranque/cola ociosa. App Engine F1 cobra USD0.05/h y sigue devengando
hasta quince minutos después de la última petición. La reserva USD2 es bruta,
con IVA: no equivale a cuarenta horas netas ni a un techo de facturación.
No se restan cuotas gratis. Cada intento reserva conservadoramente sesenta
segundos de ejecución más novecientos de cola ociosa; no hay reembolso ni
reintento automático. La instrumentación nativa debe demostrar que el máximo
presupuestado cubre inicio/finalización antes de habilitar. Operaciones GCS,
red, logs y construcción también se admiten; el modelo de instancia no las
oculta. La cola espera con un diagnóstico si falta presupuesto.

No hay polling al endpoint: los estados se consultan directamente en el journal
durable. El ingreso del servicio es INTERNAL_ONLY, con una sola instancia y
versión, min0/max1. El dispatcher de la VM usa un token Google de identidad,
audiencia, email y subject fijados en configuración protegida. Esto evita que
peticiones públicas no autenticadas mantengan una instancia facturable.
El ingreso interno no sustituye la autenticación de la identidad exacta.

El cliente público no controla remitente, destinatario, HTML o URL. Sólo la
outbox autorizada crea un envelope cifrado/autenticado con una clave interna
versionada de Secret Manager. El endpoint recibe un intento y ciphertext; el
contenido se descifra en RAM, valida un esquema cerrado y usa templates,
remitente appspotmail y origen/rutas fijados por configuración del servicio.
El identificador del perfil conserva el texto histórico y su límite del contrato
compartido; no se exige UUID ni se normaliza. Intento, invitación y job sí son UUID.
El token del enlace vive en el fragmento; su TTL empieza con el intento durable.
La autorización del despacho vence a los dos minutos como máximo, separada del
TTL del enlace de invitación de veinticuatro horas. No se registran destinatarios,
claves, ciphertexts, cuerpos ni enlaces en journals o errores.

Antes de Mail API, CAS confirmado más relectura preservan un único intento y
una clave de deduplicación por perfil/evento/entidad/versión/destinatario HMAC.
La pérdida de una respuesta CAS no concede envío. Si el proceso muere durante
Mail API, el INTENT conservado significa UNKNOWN y no se repite. La escritura
de ACCEPTED requiere relectura; una respuesta incierta sigue UNKNOWN. No se
recrea un journal desaparecido ni se borra historial para liberar cuota.

Las cuotas locales usan ventanas móviles inclusivas de 24h y60s: como máximo
100 destinatarios y8/minuto. Es conservador respecto al reset diario de Google
en medianoche Pacific y evita errores DST. El API puede rechazar por su propia
cuota; las reservas consumidas no se devuelven. Lotes o reuso del coste de una
instancia requerirán evidencia nativa de su duración; no se presumen ahora.

Fuentes oficiales comprobadas11-oct: [Mail Python3](https://docs.cloud.google.com/appengine/docs/standard/python3/services/mail),
[remitentes](https://docs.cloud.google.com/appengine/docs/standard/services/mail),
[cuotas y reset](https://docs.cloud.google.com/appengine/docs/standard/quotas),
[precio y cola ociosa](https://cloud.google.com/appengine/pricing),
[ingreso interno](https://docs.cloud.google.com/appengine/docs/standard/ingress-settings).

## Transporte nativo preparado · 11-oct-2026

La firma del ID token se verifica con RS256 y las claves públicas del endpoint
fijo de Google antes de aceptar sus claims; un `kid` desconocido falla cerrado.
El lector de clave admite sólo una versión numérica exacta de Secret Manager,
comprueba CRC32C y32 bytes, y conserva el material únicamente en RAM. El journal
GCS usa objeto fijo y generación positiva: GET de metadata, media de esa
generación y metadata actual deben concordar. Cada CAS hace un único POST con
`ifGenerationMatch`, compara los bytes nativos de vuelta y vuelve a comprobar
la generación actual. No existe alta automática de un objeto desaparecido.

Todas las respuestas tienen cota de bytes y tiempo absoluto, TLS validado y
redirecciones prohibidas; los errores externos no se incorporan a mensajes ni
logs. La admisión previa al efecto se vuelve a ejecutar después de resolver las
credenciales y antes del POST. Los transportes son componentes internos: no
constituyen aún la factory de identidad de workload, el fence económico nativo
ni un servicio desplegable. Sus pruebas usan RSA real sintética y transporte
falso, sin claves ni llamadas de producción.

El despliegue deberá crear primero el servicio `default`; el ingreso es una
propiedad de servicio distinta del descriptor de versión. Se prepara un
firewall con denegación predeterminada antes de desplegar y sólo se abrirá el
origen administrativo exacto tras comprobar INTERNAL_ONLY. No se configuran
warmups, cron ni notificaciones de correo entrante. Construcción, activaciones
iniciales, lecturas de prueba y almacenamiento se contabilizan aparte de la
reserva por intento. Ni `min_instances: 0` ni `max_instances: 1` son un techo de
facturación. El estado nativo de11-oct registra App Engine ausente y API apagada;
no se presenta como una dependencia humana.

Referencias: [ID tokens](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token),
[SM y checksum](https://docs.cloud.google.com/secret-manager/docs/access-secret-version),
[GCS GET por generación](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get),
[servicio default](https://docs.cloud.google.com/appengine/docs/standard/python3/configuring-your-app-with-app-yaml),
[firewall](https://docs.cloud.google.com/appengine/docs/standard/understanding-firewalls).

## Cierre de ventanas antes de integrar la factory · 12-oct-2026

La reserva precede al envío y su permiso puede durar 120 segundos. Contar sólo
`intent_at` permitiría que un lote demorado se enviase cerca del lote siguiente,
aunque sus reservas estuvieran separadas por 60 segundos. Se decide conservar cada
reserva durante toda su ventana posible de envío: cuenta mientras
`authorized_until >= now - 60s`. Todos los estados cuentan, inclusive los
fallidos o inciertos; la igualdad en la frontera también cuenta. Los intentos
viejos permanecen en el journal.

La afirmación anterior de que 24 horas móviles son conservadoras frente a todo
día Pacific queda corregida: el 1-nov-2026 tiene 25 horas, de 07Z a 08Z del día siguiente.
Decisión Root del 12-oct: el máximo diario usa el calendario `America/Los_Angeles`
definido por Google. Cada intento consume una plaza en cada día local tocado por
su intervalo posible de envío `[intent_at, authorized_until)`; si cruza medianoche
consume ambos. El intento nuevo reserva desde el reloj actual hasta su fin de
autorización. No se reinicia ni reembolsa el journal y tampoco se impone una
ventana de 25 horas que reduciría la capacidad del día siguiente. La outbox DB
aplica la misma regla antes del HTTP. Esto fija máximos, no una promesa de
despachar ocho correos cada minuto ni de entrega instantánea.

La contabilidad mensual de la outbox nueva será conservadora respecto tanto
al mes UTC interno como a Billing Pacific: reserva en la unión de las etiquetas
de ambos calendarios tocadas por `[dispatched_at, authorized_until+960s]`.
No anticipa reset a las 00Z del 1-noviembre ni acredita una migración de los metros
CI/runtime ya instalados. La reserva de 15467 microUSD por mes y el techo interno
USD 2 permanecen intactos. La factory de correo sólo verificará el permiso
cifrado y sus controles nativos: no inventará una lectura DB del otro servicio.

Validación local del incremento: 55 pruebas Python del núcleo y los transportes
preparados pasan, incluida firma RSA y AES-GCM sintéticas, lote demorado,
estados sin reembolso, frontera inclusiva de minuto, días Pacific de 23/25 horas,
cruce de medianoche y fin exclusivo exacto. Revisión independiente de F1
mantenimiento: 55 PASS. No hay petición nativa, despliegue, envío real ni prueba
de recepción. La factory y su configuración protegida siguen pendientes.
