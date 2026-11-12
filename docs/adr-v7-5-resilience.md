# ADR V7.5 — Recuperación, propiedad, avisos e IA vendedora

Fecha: 11-nov-2026 · Estado: aceptada para V7.5 (Claude) · Base: V7.4.0 `b2fa4df3`.

Encargo: «Prompt V7.5 — Release resiliente y Claude vendedor» del vault. Hallazgos
H01–H14 y riesgos R01–R03. H11 son los avisos; **H14 es Anthropic** (las notas
previas lo llamaban H11). Este ADR fija las transiciones antes de implementarlas.
No crea otro motor, otra API administrativa ni una ruta SQL de recuperación.

## 1. Causas distintas, salidas distintas

| Causa | Cómo se observa | Bloquea | Salida permitida |
|---|---|---|---|
| Lectura desconocida (timeout, transporte, formato, 5xx) | `health_status=UNKNOWN` con `reason` sanitizada | Envíos de esa línea (el despacho exige salud fresca) | La siguiente lectura sana. **No** es muestra de fallo del breaker; escala a fallo sólo si persiste ≥ 15 min sin ninguna lectura sana (`UNKNOWN_PERSISTENT`) |
| Evidencia vencida | `health_checked_at` > 90 s | Igual que arriba | Lectura nueva |
| Desconexión confirmada | sesión `STOPPED/FAILED/SCAN_QR_CODE` leída del proveedor | Propiedad congelada con causa `HEALTH_DISCONNECTED`; muestra de fallo | Supervisor acotado (si `recovery_enabled`) o reconexión humana |
| Restricción / identidad en conflicto | `health_status=BLOCKED` | Propiedad congelada `HEALTH_BLOCKED` | Sólo revisión humana; nunca se recupera como transitorio |
| Pausa humana | programa `PAUSED`, control manual, gracia QR pausada | Todo | Sólo el comando humano correspondiente (`resume`) |
| Protección del grupo (breaker) | `warmup_pools.breaker_open` | Planificación y despacho del programa | Comando canónico `recover` (sección 2) |
| Hold de release | `operational_settings.release_hold` | Todo REAL | El instalador al terminar |
| Efecto incierto | outbox `SENDING/UNKNOWN/SENT` sin ACK | Recuperación y reanudación | Conciliar primero; nunca repetir |

Un 401/403 del proveedor es `AUTHENTICATION`, no `TIMEOUT`; una restricción no
se reintenta como fallo transitorio. Reintentos: los lazos existentes ya acotan
lecturas (una por línea cada 25 s, cuatro en paralelo, lease de sondeo de 60 s);
V7.5 no añade bucles.

## 2. Recuperar la protección de un programa (H02)

Acción nueva `recover` en `POST /v2/warmup/programs/:id/commands`, mismo
servicio para web, API y MCP (`warmup_manage.recuperar_proteccion`), con lectura
previa `POST /v2/warmup/programs/:id/recovery-preview`.

- Entrada: `operationId`, `expectedVersion` del programa, `recoveryHash` de la
  vista previa y `reason` (texto corto). Mismo `replay` idempotente de los otros
  comandos: repetir devuelve la misma operación; reutilizar el ID con otro
  payload → `OPERATION_ID_CONFLICT`.
- La vista previa revisa por línea emisora: sesión `WORKING` y salud `OK`
  frescas (≤ 90 s), identidad verificada, QR vigente, **propiedad operativa
  vigente** (lease vivo, no congelada), sin bloqueo confirmado, sin efectos
  inciertos del programa y grupo con lectura vigente. Devuelve las fallas
  revisadas (ventana de 24 h) y un hash de todo lo revisado.
- La ejecución repite la revisión dentro de la misma transacción (lock del
  perfil + programa) y exige el mismo hash; si algo cambió → `WARMUP_RECOVERY_CHANGED`.
- Efecto: `breaker_open=false`, `breaker_reviewed_until=now()` (corte de
  observaciones revisadas), versión del pool y del programa +1, evento
  `warmup.protection_recovered` con actor, motivo, fallas revisadas y evidencia.
  Las observaciones históricas no se borran. Una falla **posterior** al corte
  vuelve a abrir la protección.
- No cambia el estado del programa: un programa `PAUSED` sigue pausado y se
  reanuda con `resume` (su consentimiento vigente). Una pausa concurrente gana.
  No enciende `recovery_enabled` ni crea asignaciones.

El runbook deja de mencionar `reset_breaker`.

## 3. Estado efectivo (H03)

`GET /v2/warmup` y `/programs/:id` agregan `effective`: `{state, reasons[],
observedAt, nextAction}`. `state` ∈ `RUNNING`, `WAITING_WINDOW`,
`WAITING_ACK`, `PROTECTED`, `PAUSED_BY_HUMAN`, `NEEDS_CONNECTION`,
`NEEDS_OWNERSHIP`, `GROUP_READ_STALE`, `COMPLETED`, `DRAFT`, `ARCHIVED`. Un
programa `ACTIVE` con la protección abierta se muestra `PROTECTED`, nunca
«Activo». «Próximo envío» sólo aparece con trabajo `READY` elegible; si no, es
condicionado y lo dice. Web y MCP consumen la misma lectura.

## 4. Propiedad de la sesión (H12, H13)

- La columna `session_ownership.freeze_reason` registra por qué está congelada.
  Un disparador la fija en cada `frozen=true`: sólo `recordHealth` declara
  `HEALTH_DISCONNECTED`/`HEALTH_BLOCKED` (ajuste local de transacción); cualquier
  otra congelación (manual, transferencia, hold, fallo de comando, instalador)
  queda `UNSPECIFIED` y no es recuperable automáticamente. Una congelación
  posterior no recuperable nunca se rebaja a recuperable.
- El supervisor admite una propiedad congelada sólo si la causa es
  `HEALTH_DISCONNECTED` y el único incidente abierto es el de salud por esa
  desconexión (H12). Sigue exigiendo `recovery_enabled`, mantenimiento del
  primario, política, ausencia de pausas manuales, de efectos y comandos
  inciertos, restricción en verde y su límite de 5 intentos con backoff.
- Mismo proceso y generación con lease vencido (H13 local): tras una lectura
  completa y sana, `reconcileHealthyLease` puede renovar el lease si **este
  proceso** adquirió esa generación (registro en memoria del proceso). Un
  heartbeat tardío solo no basta.
- Propietario anterior (caso WA 5): operación canónica `POST
  /v1/numbers/:id/ownership` (`number_connection_manage.conciliar_propiedad`)
  que encola un `check_health` idempotente. El worker vigente transfiere la
  generación **sólo** con un comprobante de aislamiento válido sin consumir del
  propietario y generación exactos (lo consume una vez); si no existe responde
  `VERIFIED_ISOLATION_PROOF_REQUIRED`. Después, la lectura sana resuelve el
  incidente o reanuda por la autorización permanente vigente. Nunca se fuerza
  `frozen=false` por SQL.
- `GET /v1/numbers/overview` y `/link` exponen `operability` (propiedad
  vigente, congelada con causa, vencida, de otro proceso) y el número deja de
  decir sólo «Conectado» cuando no puede operar.

## 5. Calentamiento (H01, H06, H07, H08, H09)

- H01: una lectura `UNKNOWN` se registra como observación `UNKNOWN` (nuevo
  valor del CHECK), no `FAILED`. Persistencia ≥ 15 min sin lectura sana →
  `FAILED` con referencia `persistent-unknown:`.
- H06: al abrir la protección el evaluador actualiza el objeto del pool y el
  planificador de grupo vuelve a leer la fila del pool dentro de la misma
  transacción: cero reservas nuevas. El despacho conserva su segunda guarda.
- H07: `observeGroup` recibe el instante de **recepción** (inicio + duración
  monotónica) en vez del `now` previo a la consulta. Se conserva el rechazo de
  observaciones futuras (> 1 s) y la frescura de 5 s del despacho.
- H08: cierre del día anterior. Si la línea no tiene lectura sana, o quedan
  efectos de ese día sin estado terminal, el plan queda pendiente (no `MISSED`)
  hasta 24 h después del fin del día local; entonces se decide con la evidencia
  que exista. Un ACK tardío del mismo día cuenta; el crédito es único por
  número/día (`warmup_day_credits` y el estado del plan). Nunca se crea crédito
  por tiempo transcurrido ni mensajes compensatorios.
- H09: el editor envía `configure` siempre que el formulario difiera de la
  configuración **persistida**, usa la última versión devuelta y regenera la
  vista previa; los conflictos se muestran sin perder el formulario.

## 6. Avisos (H10, H11)

Tres estados independientes en `operational_alerts`:

- **Incidente**: abierto si `resolved_at IS NULL AND superseded_by IS NULL`.
- **Notificación**: `status` (PENDING/SENDING/ACCEPTED/RECEIVED/UNKNOWN/FAILED;
  `RESOLVED` es un valor histórico).
- **Acuse humano**: `acknowledged_at`.

Pendiente de leer = incidente abierto y sin acuse; contador y listado usan el
mismo predicado (`pendingAlertPredicate`). Episodio: una fila abierta por perfil,
entorno, tipo y recurso (`account_id` o ninguno), con `first_observed_at`,
`last_observed_at` y `observations`. Repetir la observación actualiza la fila
sin tocar el acuse ni crear correo. La recuperación verificada resuelve
(`resolved_at`, `evidence.resolution`); la recurrencia posterior abre otra fila.
Subir de WARNING a CRITICAL actualiza la gravedad y quita el acuse (aviso nuevo).

Migración 0121, reconciliación idempotente y documentada:
1. `status='RESOLVED'` sin `resolved_at` → `resolved_at=updated_at` con
   `evidence.resolution='LEGACY_STATUS_RESOLVED'` (el escritor histórico ya lo
   había declarado resuelto).
2. Duplicados abiertos globales de un mismo tipo: se conserva el más antiguo
   como episodio (primera/última observación y conteo) y los demás quedan
   `superseded_by` ese episodio. No se marcan resueltos ni pierden acuse.
3. Índice único parcial para un episodio abierto global por tipo.

Monitores: respaldo con la fuente instalada (`platform_backup_runs`, mismos
límites de `/healthz/platform`: 36 h y completo 8 días, y ningún fallo
posterior al último éxito) o evidencia verificada vigente; horarios
`warmup_schedule_runs` sólo para pools `LEGACY` activos con integrantes. Los
pools QR vacíos, pausados o archivados no generan avisos de horario.

API/MCP: paginación por cursor estable, lectura directa por ID, «marcar todos
como vistos» con corte capturado al iniciar (los avisos posteriores al corte
siguen pendientes), auditado e idempotente.

## 7. Errores del proveedor (H05)

`recordHealth` clasifica el fallo de lectura: `TIMEOUT`, `TRANSPORT`,
`AUTHENTICATION`, `PROVIDER_ERROR` (5xx), `INVALID_RESPONSE`, `ISOLATION`,
`UNCLASSIFIED`, con fase y duración. `availability` deja de decir
`not_authorized` salvo 401/403. Nada de credenciales ni contenido en el
diagnóstico.

## 8. MCP (H04)

`initialize` declara `version=<semver>+<sha12>` y el servidor publica la
herramienta de lectura `platform_build` (perfil) con SHA, versión y
capacidades V7.5. El cliente antiguo sigue funcionando; las capacidades nuevas
se detectan por nombre de acción.

## 9. Anthropic (H14)

Se integra `239c1ad`: razonamiento mínimo por modelo revisado y descarte de
`thinking`/`redacted_thinking`. Se conservan los rechazos de `tool_use`, sin
texto, truncado, modelo distinto y JSON inválido; HTTP 400 no se reintenta;
timeout posterior al envío queda `UNCERTAIN` con su reserva. Anthropic no
transcribe: el alterno `gpt-4o-mini-transcribe` se usa sólo para audio. La llave
la guarda el Dueño en la web.

## 10. Capacidad y publicador (R01–R03)

- R01: aviso temprano de disco (`PRIVATE_STORAGE_DISK_WARNING` < 20 % libre o
  < 25 GiB, con histéresis de 2 puntos) además del crítico existente. Sin borrar
  datos.
- R02: imagen confiable del publicador derivada del `main` vigente; lector del
  portal preservado en origen.
- R03: limpieza de la llave efímera de OS Login atribuida por bytes exactos con
  reintento acotado de lectura/eliminación; si no puede confirmarse queda
  `CLEANUP_UNCONFIRMED`, nunca éxito.

## Migración

`0121_v75_resilience.sql`, aditiva. El instalador admite exactamente la cola
120→121 sobre la base V7.
