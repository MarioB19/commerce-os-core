# Continuidad de sesiones WhatsApp QR

Implementación del plan del 15-sep-2026. [Decisión técnica](adr-qr-continuity-2026-09-15.md). La evidencia de publicación se registra en [PROGRESS](PROGRESS.md) y [qr-continuity](evidence/qr-continuity/).

## Controles web

En **Ventas → WhatsApp → Números**, abre un número:

1. **Conexión:** estado y vigencia de la señal, última conexión con identidad y permisos de envío. «Revisar salud» sólo consulta. «Conectar» conserva la autorización de onboarding existente. La respuesta de un comando se consulta hasta conocer su resultado.
2. **Teléfono principal:** asigna alias interno, responsable y disponibilidad. «Registrar uso» declara cuándo una persona abrió WhatsApp en el principal, con motivo y actor. Rutina semanal; avisos preventivos a los días 10, 12, 13 y 14. Una fecha desconocida permanece desconocida.
3. **Recuperación:** configura por separado recuperación automática, estado deseado y pausa. Una cuenta existente empieza STOPPED, pausada y sin recuperación automática. Para habilitarla se requiere principal identificado/disponible, responsable y declaración de uso. Las pausas operativas, conciliaciones pendientes y política del espacio siguen gobernando.
4. **Configuración comercial:** conserva conexiones con el catálogo y sus permisos. Vincular, confirmar uso o recuperar conexión no habilita envíos.

Detener, reiniciar y desvincular están agrupados con confirmación. QR efímero, teclado, foco de retorno, formularios etiquetados, contraste y ancho móvil se verifican mediante E2E. El historial de alertas distingue envío al receptor de acuse humano.

## API y MCP

API HTTPS existente; cabecera `Authorization: Bearer <token>` o sesión web. Lectura: `channels:read` para servicios / `sales:read` para usuarios. Escritura: `channels:manage`. Toda mutación usa `Idempotency-Key` única y `environment`; las de continuidad exigen `expected_version` igual a la `revision` leída. Un conflicto requiere releer y revisar, no sustituir el número de versión a ciegas.

| Acción | API | MCP |
|---|---|---|
| Estado, principal, ownership, historial, alertas y pendientes | GET `/v1/channel-accounts/{id}/session` | `channel_session_get` |
| Responsable, inventario, deseo y recuperación | PATCH `/v1/channel-accounts/{id}/session` | `channel_session_configure` |
| Declaración de uso del principal | POST `/v1/channel-accounts/{id}/primary-usage` | `channel_primary_usage` |
| Preparar recuperación / incidente / conciliación / acuse | POST `/v1/channel-accounts/{id}/session/recovery` | `channel_session_recovery` |
| Conectar, detener, reiniciar, congelar, ownership o salud | POST `/v1/channel-accounts/{id}/commands` | `channel_command` |
| Resultado durable del comando | GET `/v1/commands/{id}` | `command_get` |

Ejemplo de cuerpo para una declaración real del operador (sustituir fecha y revisión):

```json
{"environment":"REAL","expected_version":3,"used_at":"2026-09-15T08:00:00-06:00","source":"operator_confirmation","reason":"Abrí WhatsApp en el principal Equipo-01"}
```

El servicio registra `service_operator_report`; nunca atribuye una señal WAHA al teléfono principal. Los contratos completos se publican en `/v1/openapi.json`. QR se entrega por la ruta autenticada y efímera existente; no se incluye en historial ni en artefactos MCP.

## Estados y recuperación

`WORKING` con identidad esperada acredita `CONNECTED`; la señal vence. `FAILED` genérico queda `UNKNOWN`, sin atribuirlo a baneo. QR, passkey, conflicto de identidad y autenticación revocada confirmada son causas distintas; no se inventa una revocación cuando WAHA no la expone.

Sólo STOPPED observado después de conexión verificada permite recuperación transitoria. Cinco intentos persistidos, separados por 5/15/45/120/300 segundos con variación del 10 %. No se reinicia el presupuesto con otra caída: exige 30 minutos de conexión estable con observaciones vigentes. Agotarlo abre un incidente. Se procesan como comandos existentes, con exclusión por cuenta, lease/generación y prueba de aislamiento del dueño anterior. Expirar un lease no prueba aislamiento.

Una llamada remota incierta detiene la recuperación. Tras revisar salud reciente, un responsable registra `reconcile_command` con `confirmed_applied`, `confirmed_not_applied` o `keep_unknown` y evidencia. No se reenvían comandos ni mensajes por un timeout. Una restauración de la base siempre desactiva recuperación y expira salud.

## Respaldo específico de WAHA

COMOSB02 conserva base/activos de Commerce; **COMOSW01** conserva archivos de sesión GOWS y configuración cifrados mediante AES-256-GCM. Incluye versión/imagen, generación de credenciales, hashes y permisos/uid/gid. Clave existente fuera del volumen, carpeta privada 0700 y archivo 0600. Los servicios de negocio no reciben Docker socket.

`commerce-waha-backup.timer` revisa diariamente a las 05:00 UTC con hasta cinco minutos de variación. `scripts/waha-backup-schedule.py` sólo copia gateways **ya detenidos**, con volumen exclusivo. Un gateway activo produce `AWAITING_AUTHORIZED_COLD_WINDOW`; nunca se detiene para satisfacer el respaldo. Copiar autenticación no demuestra que WhatsApp acepte restaurarla. Fallos/antigüedad aparecen en las alertas de la cuenta. No hay RPO cero ni borrado automático de copias.

La herramienta administrativa `scripts/waha-session-backup.mjs` permite `verify` y `restore`. Ejecutarla desde la imagen de mantenimiento fijada del release, con `--network none`, clave por archivo privado y salida en un directorio **nuevo**. Verifica cifrado, rutas, hashes y permisos antes de restaurar; rechaza enlaces y destinos existentes. No montar ni iniciar la copia hasta demostrar aislamiento del original y autorizar la prueba física. Después comprobar identidad; un respaldo viejo puede requerir QR nuevo.

## Almacenamiento dañado / revinculación

1. Abrir incidente y pausar. Conciliar comandos y efectos inciertos.
2. Solicitar `prepare_relink` o `request_storage_replacement`; se conserva cuenta, historial e identidad esperada.
3. Con ventana autorizada, un administrador aísla el gateway anterior. Si sigue vinculado, el responsable revoca el dispositivo anterior desde el principal cuando proceda. El software entregado no ejecuta esta prueba en una cuenta productiva.
4. Revisión local del plan administrativo: `sudo python3 scripts/waha-storage-recovery.py <account_uuid> <container_id>`. Exige cuenta pausada, gateway ya detenido y correspondencia exacta.
5. Después de revisar, `--execute PREPARE_OFFLINE_REPLACEMENT` conserva cuarentena cifrada y volumen anterior al menos 30 días, crea volumen nuevo y contenedor **detenido**, verifica aislamiento e incrementa generación con historial. No elimina el anterior. El override privado conserva el nuevo montaje en futuros despliegues. Un diario inconcluso bloquea otra ejecución hasta conciliación administrativa.
6. Con autorización, obtener QR efímero, escanear desde el principal y comprobar la misma identidad. Una identidad diferente se bloquea y requiere una cuenta comercial nueva. Una lectura posterior al último cambio de sesión, con WORKING y la identidad esperada, cambia la etapa a «Identidad verificada · revisar reanudación». Reanudar requiere los permisos y controles habituales.

## Verificación independiente y pendientes físicos

`node scripts/probe-session-host.mjs https://commerce-os.inovaris.online` funciona fuera del VPS: distingue disponibilidad, error y host inalcanzable en una lectura con límite de 10 segundos. No acredita autenticación ni entrega notificaciones. Su programación en un monitor independiente y receptor autorizado queda pendiente de operación; el monitor del mismo VPS no detecta su propia caída total.

Pruebas sintéticas: 20 cuentas con cuatro lecturas concurrentes, propiedad ausente, pausas, versiones, dedupe, identidad, relojes virtuales, archivo alterado, restauración aislada y respuesta perdida. No equivalen a 20 teléfonos.

Pendientes separados: responsables/principales reales; receptor de avisos y escalamiento; custodio y copia fuera del host; evidencia de cifrado de disco; ventana de respaldo consistente y restauración de autenticación con cuenta autorizada; piloto 2→5→10→20 y 21 días de observación. La topología instalada conserva sus gateways existentes; la carga sintética no provisiona infraestructura adicional.

## Recepción al reutilizar un gateway — 15 septiembre 2026

Conectar una sesión ya existente no basta: su callback debe corresponder a la cuenta activa. El adaptador WAHA comprueba destino, eventos `message`, `message.ack`, `session.status` y autenticación del webhook. Una discrepancia aparece como señal `infrastructure` de tipo `webhook`, sin URLs ni claves.

Un comando explícito `connect` o `restart` concilia el callback canónico del mismo workspace mediante `PUT /api/sessions/{session}`, conservando otras opciones y callbacks externos. Rechaza callbacks de otro workspace en el mismo ingress. WAHA reinicia una sesión activa al actualizarla; por eso no se añade otro restart ni logout después del PUT. Se verifica la configuración con GET. Una escritura o lectura posterior incierta conserva el bloqueo del comando, sin reintento automático. `stop` y `logout` no cambian configuración.

`GET /v1/channel-accounts/{id}/health?environment=REAL` añade `reception`: configuración observada del webhook y su vigencia, totales de envelopes recibidos/pendientes/fallidos/procesados, número y fecha de mensajes entrantes persistidos y `sending_enabled`. Los totales no contienen contenido privado. `WORKING` sólo acredita sesión; un evento de sesión tampoco acredita recepción de mensajes. La bandeja muestra mensajes materializados aunque no exista producto y los envíos estén apagados.

`POST /v1/channel-accounts/{id}/commands` acepta `expected_version` de la cuenta para rechazar solicitudes obsoletas antes de crear el comando. Sigue requiriendo Idempotency-Key y permiso channels:manage mediante identidad humana/owner autorizada; no amplía scopes de servicio.

Contrato de proveedor consultado: https://waha.devlike.pro/docs/how-to/sessions/#update-session .


### Recuperar entrada perdida durante una configuración incorrecta

`POST /v1/channel-accounts/:id/sync-inbox` requiere un usuario con `channels:manage` (owner u operador),
`environment=REAL`, `Idempotency-Key`, `expected_version` recién leído, `since`,
`until`, `limit` (1–100), `reason` y `confirmation: IMPORT_RECENT_INBOUND`.
La ventana debe estar dentro de las últimas 24 horas y comenzar después de crear
la cuenta. Sólo funciona con WAHA GOWS/NOWEB conectado e identidad verificada.
Devuelve un comando durable (202); consultar su resultado, sin repetir uno incierto.

El worker verifica identidad antes y después de una lectura oficial de historial.
No solicita QR, no marca mensajes como leídos y no descarga archivos. La captura
viaja cifrada por eventos al consumidor de entrada con los permisos existentes.
Los mensajes importados conservan `source=provider_history`, se deduplican por ID
del proveedor y no inician flujos, IA, pagos ni respuestas. Los archivos históricos
se muestran como no recuperados. `reception.state=RECOVERED` prueba recuperación;
una entrada nueva por webhook prueba recepción en vivo.

### Respuesta manual desde Conversaciones

`POST /v1/conversations/:id/commands` con `type: send_message` admite
`expected_version` de una lectura inmediatamente anterior. Si no se proporciona
`authorization_id`, selecciona el permiso vigente de la asignación de producto de
esa conversación. Nunca busca permisos de otro producto; valida contacto, revisión,
identidad, caducidad y revocación. El despacho sigue comprobando política, alcance
completo, límites y estado del canal. Una respuesta 202 acredita un comando durable,
no entrega del mensaje. Seguir comando, outbox y confirmación del proveedor.
