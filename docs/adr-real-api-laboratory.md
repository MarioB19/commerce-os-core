# ADR — REAL predeterminado, laboratorio y credenciales acotadas

Fecha: 2026-09-08. Estado: aceptado para implementación local por el encargo de cierre.

Las consultas de negocio sin entorno usan REAL. Toda mutación de negocio exige `environment` explícito y rechaza contradicciones entre query y cuerpo; el cambio de default nunca convierte una petición heredada ambigua en envío. `/v1/me` comunica el entorno efectivo, REAL por defecto. Los endpoints de ensayo sólo aceptan SIMULATION. Abrir una consulta no cambia políticas, números ni autorizaciones.

El laboratorio crea una copia de las versiones comerciales elegidas dentro de SIMULATION, con IDs de ensayo, fuente/revisión/hash y cuenta simulator independiente. Copia únicamente campos comerciales conocidos; archivos conservan copia privada independiente del objeto inmutable tras comprobar bytes, tamaño y hash; accesos/enlaces sustituyen destinos por referencias de ensayo. No copia cifrados operativos, códigos, rutas públicas, gateways, bancos operativos ni credenciales. La referencia privada de almacenamiento nunca se devuelve al cliente. Un snapshot no acredita descarga, reproducción o acceso real. Las versiones REAL quedan intactas. No se añaden contactos ni comandos hasta iniciar explícitamente la simulación.

Las credenciales conservan workspace propio y añaden `allowed_environments` y `resource_ids` opcionales. La lista de recursos es exacta para lecturas/referencias; la lectura de conversación por token no expande contactos, mensajes, ofertas ni efectos fuera de las rutas con su permiso propio; los snapshots de vendedor comprueban también categoría y vendedor efectivos; comandos y efectos se autorizan por su recurso/conversación/cuenta asociada. Crear recursos raíz requiere una credencial sin restricción de IDs; un propietario crea credenciales y revoca. Se añaden capacidades separadas `assets:read`, `assets:write`, `sales:read`, `sales:propose`, `channels:read`, `commands:read`, `warmup:read`, `warmup:manage`. Ninguna concede aprobación financiera, autorización REAL, activación de números, gestión de secretos o envío directo. Proponer deja un comando en borrador que requiere aceptación humana; no entra en la cola ejecutable.

La revalidación de credenciales dentro de la transacción toma un lock compartido del token: revocación concurrente espera la transacción vigente y ninguna nueva mutación empieza tras revocar. Una revisión obsoleta y replay con otro cuerpo fallan. El cliente HTTP incorpora entorno explícito, clave estable y seguimiento de comando/efecto/ACK con timeout y resultado incierto visible; nunca escribe PostgreSQL.

Se conserva la API existente. Las rutas nuevas se documentan en OpenAPI con scopes, entorno, revisiones y errores. Los permisos de warm-up se definen para el módulo coordinado por separado; no constituyen habilitación operativa.

## Vista de preparación y evidencia

`GET /v1/readiness` consulta versiones, conexión/identidad, salud vigente, warm-up, política, outbox y metadatos de IA/SMTP/heartbeats. Cada check indica fuente y fecha. CONFIGURED no es evidencia del proveedor. Una credencial `channels:read` recibe sólo cuentas permitidas y ningún dato de SMTP, backups, configuración global o attestaciones; nunca se interpreta ese resumen parcial como preparación completa.

Owner puede registrar evidencia externa por `POST /v1/operational-evidence`, siempre HUMAN_ATTESTATION y append-only. El cliente no puede elegir SERVER_JOB, modificar evidencia ni registrar secretos. La vigencia expirada aparece STALE; ausencias son UNAVAILABLE. Pilotos comerciales y evaluaciones deben cubrir los IDs de las cuentas y versiones actuales; una attestación sobre otras versiones no acredita readiness actual. Los heartbeats se leen de service_heartbeat escrito por persistHeartbeat y se usa la instancia más reciente con su vencimiento declarado. No se envía correo ni se ejecuta un backup/evaluación para construir esta vista.

## APIs de recuperación warm-up

Las mutaciones nuevas comparten lock del pool con el worker y versión esperada. Agregar miembros o seleccionar perfil revoca el scope y deshabilita nueva planificación hasta la autorización owner; no altera planes históricos ni días. Reconciliar es un comando durable de estado, sin despacho. Backfill es lectura/dry-run con evidencia real de sesión; no inventa antigüedad ni graduación. Cloud no participa como peer WAHA.

El permiso REAL referencia evidencia vigente de capacidades por cuentas y tipos de contenido. Su vencimiento no puede superar esa evidencia. Esta autorización no incluye llamadas de pago por mensaje/modelo; `max_cost_minor=0` no mide costo de infraestructura. La política congelada sigue bloqueando toda habilitación.

Owner puede solicitar revisar un perfil UNKNOWN con versión de warmup_states y razón. La API sólo registra profile_review_requested_at y aumenta la revisión; conserva UNKNOWN, permisos, flags y evidencia. El worker obtiene el perfil por GET; esa revisión nunca reintenta PUT inciertos.
