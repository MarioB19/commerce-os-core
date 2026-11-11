# ADR V7.4 — Números y calentamiento sin fricción

Fecha: 11-nov-2026 · Estado: aceptado (decisión de producto de Brandon, 11-nov) · Autor: Claude

Sustituye, sólo para el comportamiento nuevo, dos reglas anteriores: «todos los
integrantes del grupo son números del perfil» (`adr-v7-2-group-library-warmup.md`)
y «conectar por QR inscribe siempre al calentamiento» (`adr-v7-auto-qr-warmup.md`).
Asignación comercial, identidad, pausa humana, consentimiento, aislamiento entre
perfiles, biblioteca sin IA, curvas, topes y horarios no cambian.

## Problema comprobado (10/11-nov, V7.3.0 `2f5c8be3`)

| Defecto | Causa |
|---|---|
| El alta se quedaba en «Preparando tu número…» y el QR no aparecía | Una lectura de salud anterior a la integración del gateway escribía `status=UNKNOWN`; el contrato de aprovisionamiento inicial exige `NEW` y la operación `PROVISION` no podía terminar. La vista decía «unos segundos» sin límite. |
| «Actualizar grupos» fallaba | WAHA 2026.8.2 / GOWS responde `JID`/`Name`, participantes `id` (LID) + `pn`, y `adminsOnly`; el adaptador esperaba `id`/`subject`, `phoneNumber` y `adminOnly` (`GROUP_LIST_RESPONSE_UNSUPPORTED`). |
| «Conecta por QR todas las líneas del grupo» con las líneas ya conectadas | La consulta exigía a cada línea pedida autoridad QR e inscripción de calentamiento ya emitidas; una línea recién conectada (o en espera de verificación) hacía fallar toda la consulta con un mensaje de QR. |
| Un grupo con dos personas ajenas al perfil era rechazado | Regla de producto de V7.2. |
| «Calentando, día 1 de 15» sin actividad | La tarjeta mostraba el día de calendario del episodio, no evidencia. |
| Números migrados atascados en «Eliminación en curso» | El `logout` no se intenta sin prueba de aislamiento del dueño técnico anterior (`VERIFIED_ISOLATION_PROOF_REQUIRED`); no había camino para terminar. |

## Decisiones

### A. Alta y QR

1. **El avance de preparación y la salud observada son cosas distintas.** Una
   observación «proveedor ilegible» (`availability=not_authorized`) sobre un
   número que nunca se inició ni vinculó no cambia su `status` (`NEW`) ni abre
   un incidente. Una lectura real del proveedor sigue escribiendo su estado.
2. **Recuperación automática y acotada del estado que dejó V7.3.** El alta de
   la integración inicial acepta `NEW` o, además, `UNKNOWN` sólo si el número
   nunca tuvo identidad, vínculo, ciclo de vida, dueño de sesión, comandos ni
   conexión; en ese caso vuelve a `NEW` dentro de la misma operación revisada y
   queda el evento `number.initial_provision_registration_recovered`. No se
   acepta cualquier `UNKNOWN` y nunca se afirma `CONNECTED`.
3. **Estados de preparación veraces** (derivados de la operación `PROVISION`):

   | Estado | Cuándo | Lo que ve el operador |
   |---|---|---|
   | `PREPARING` | operación viva, ≤ 5 min desde su alta o su último reintento | «suele tardar entre uno y cinco minutos» |
   | `PREPARATION_DELAYED` | operación viva, > 5 min | «tarda más de lo normal; seguimos intentándolo; tu número está guardado» |
   | `PREPARATION_FAILED` | operación `FAILED`/`CANCELLED` | «reintentar la preparación» |

   El supervisor reintenta solo las operaciones vivas. El reintento manual
   (`retry_preparation`) vuelve a encolar **la misma operación** de un número
   nunca vinculado; no crea cuenta, plaza, gateway ni comando nuevos.
4. La ventana del QR hace una petición a la vez, descarta respuestas tardías,
   muestra cuando el QR no se puede obtener (antes se silenciaba), no reinicia
   una sesión sana y no repite el alta en un doble clic (clave de idempotencia
   por formulario).

### B. Lectura de grupos

1. El adaptador admite el formato GOWS y conserva los anteriores. Un mismo dato
   declarado dos veces con valores distintos, un permiso de escritura ausente o
   no booleano, un grupo distinto del pedido o identidades duplicadas se
   rechazan. **LID ↔ teléfono sólo por el mapeo explícito del proveedor (`pn` /
   `phoneNumber`)**, nunca por dígitos iguales.
2. **Consultar depende de las líneas administradas elegidas para consultar**,
   no de que cada integrante tenga sesión aquí. Estados por línea:
   `READY`, `VERIFICATION_PENDING`, `HEALTH_PENDING`, `NOT_CONNECTED`, `PAUSED`,
   `IDENTITY_CONFLICT`, `UNSUPPORTED`. Basta una línea `READY`; las demás quedan
   registradas con su causa. Sin ninguna, el error distingue espera verificable
   (`GROUP_LINES_VERIFICATION_PENDING`) de falta de conexión.
3. La operación es durable y única por perfil (un segundo clic se une a la que
   corre), guarda resultado por línea y la pantalla la retoma tras recargar.
   Causas distinguibles: sin grupos, proveedor inaccesible, sesión iniciando,
   respuesta incompatible, línea propia no resuelta. Una línea o un grupo
   ilegible no descarta lo que leyeron las demás. Consultar no envía nada.

### C. Grupos con participantes externos

Tres conjuntos separados en modelo, permisos y vista:

| Conjunto | Qué es | Qué puede |
|---|---|---|
| **Participantes** (`program.account_ids`) | líneas del perfil, en el grupo, cuyo dueño pidió calentamiento | emisores elegidos envían; todas dan evidencia de recepción; se reservan |
| **Líneas propias «ya preparadas»** | líneas del perfil en el grupo con `DECLARED_READY` | sólo reciben; sin reserva, estado ni cuota |
| **Externos** | integrantes sin cuenta en el perfil | sólo reciben; sin cuenta, QR, plaza, autoridad, estado, días ni métricas |

- Una línea es propia sólo por identidad explícita: su registro de
  calentamiento o la identidad observada por su propia sesión QR confirmada. Un
  número de otro perfil es externo; nunca se consulta otro perfil.
- De un externo se guarda sólo el hash de su identidad de proveedor (opaca si
  no hay teléfono verificable).
- **Consentimiento.** Estar en el grupo no prueba consentimiento. Iniciar o
  reanudar con externos exige `audienceConfirmed: true`; queda en
  `scope.audience` (quién, cuándo, versión de membresía) y en el evento
  `warmup.audience_consent_confirmed`. No hay aprobaciones diarias.
- **Cambio de audiencia.** Cualquier cambio de integrantes o permisos sube la
  versión de membresía: programa en pausa, revisión invalidada, pendientes no
  iniciados cancelados; lo ya aceptado no se deshace. Reanudar exige revisar y
  confirmar de nuevo.
- **Evidencia de entrega.** Un envío queda `DELIVERED` cuando lo observaron
  todas las líneas participantes receptoras (recepción autenticada en su
  sesión). No se espera webhook de externos, un ACK global no acredita y un ACK
  de un externo no crea recibo. El avance describe ese alcance.
- Los mensajes del grupo (también de externos) no crean leads, respuestas,
  remarketing ni ventas; no hay mensajes privados a externos.
- Requisitos de emisión (QR vigente, identidad, salud, permiso de escritura,
  pausa, cuotas) se aplican a los participantes; los sondeos de grupo sólo usan
  líneas participantes. El modo autorizado anterior (no QR) conserva su regla
  estricta.

### D. Elección de calentamiento por número

- Se guarda en el propio número (`warmup_mode`: `REQUIRED` | `DECLARED_READY`,
  más origen, fecha y autor), **en el mismo INSERT que lo crea**.
- **Compatibilidad:** un cliente anterior que omite el campo registra
  `REQUIRED` con origen `compatibility_default`. Ninguna omisión ni reintento
  cambia una elección guardada; cambiarla es una acción explícita
  (`POST /v1/numbers/{id}/warmup`, MCP `numbers_manage.cambiar_calentamiento`)
  con versión esperada y auditoría (`number.warmup_mode_changed`).
- **`DECLARED_READY` es una declaración del dueño, no una graduación.** No se
  fabrican `GRADUATED`, días, recibos ni salud. Efectos: sin inscripción, sin
  reserva, sin envíos ni mantenimiento de calentamiento; el gate comercial de
  calentamiento no lo retiene. Conexión, identidad, salud, pausa y asignación
  humana siguen siendo condiciones aparte; no crea asignaciones ni abre envíos.
- La declaración queda ligada a la identidad confirmada. Con otra identidad no
  vale (`WARMUP_DECLARATION_IDENTITY_CHANGED`) hasta que el dueño elija otra vez.
- **Garantía en la base (migración 0120):** triggers que rechazan inscribir
  (`warmup_states`), reservar (`warmup_account_reservations`) o encolar un
  efecto de calentamiento (`outbox`) para un número declarado listo, por
  cualquier vía (worker, reconexión, adopción legacy, reinicio, release).
- **Cambio de modo.** A «ya preparado»: se conserva todo el historial; se
  cancelan sólo envíos no iniciados, los inciertos siguen conciliándose, su
  programa queda en pausa para revisión y se libera su reserva. A «necesita
  calentamiento»: no arranca nada; vuelve a «elige un grupo». La pausa humana
  no se toca.
- **Estados históricos:** los números existentes no tienen valor y conservan su
  comportamiento (`REQUIRED`). La migración no clasifica nada en masa ni
  enciende programas; programas, pausas, episodios y créditos no cambian.

### E. Estados y eliminación

- La tarjeta separa: conexión; elección; calentamiento (`NOT_REQUESTED`,
  `WAITING_CONNECTION`, `REGISTERING`, `GROUP_REQUIRED`, `PROGRAM_PENDING`,
  `ACTIVE`, `RECEIVING`, `PROGRAM_PAUSED`, `COMPLETED`, `ATTENTION`,
  `CHOICE_REQUIRED`); días efectivos sobre 14. «Calentando» sólo con programa
  activo y la línea emitiendo. No se muestra el día nominal.
- **Baja de números migrados.** Las protecciones `VERIFIED_ISOLATION_PROOF_REQUIRED`
  y `PROFILE_QUOTA_UNSAFE_RETIREMENT` no cambian y la propiedad antigua no se
  transfiere. Cuando el cierre no puede intentarse, la vista lo dice y pide la
  acción: quitar el dispositivo en WhatsApp y confirmarlo. La confirmación
  (`POST /v1/numbers/{id}/removal/unlink-confirmation`) sólo la hace una
  persona con sesión, y sólo se acepta con: lectura fresca y vacía del gateway
  actual de ese número hecha por el administrador acotado, sesión detenida y
  aislada, sin comandos pendientes ni resultados inciertos. Se registra
  `channel.unlink_reconciled` con `remote_logout_executed:false`: una
  desvinculación acreditada por el dueño, no un logout que no ocurrió. Un
  gateway vacío por sí solo no basta.

### Publicación

- Migración aditiva `0120`; el instalador admite la cola exacta 119→120.
- El inventario del instalador cubre un gateway por plaza (20): el supervisor
  ya creó `waha-07`.
- El control del portal conservado se mantiene: su nombre público ya no llega
  a este host (DNS en otro proveedor), así que se verifica su versión en origen,
  dentro del contenedor conservado, sólo cuando se comprueba que el nombre
  resuelve fuera de la VM. No se asume versión ni se migra contenido.

## Consecuencias y límites

- No hay promesa de evitar restricciones de WhatsApp; el calentamiento sigue
  siendo actividad legítima entre líneas propias con audiencia consentida.
- La elección «ya preparado» traslada al dueño la responsabilidad de esa
  afirmación; queda auditada.
- Sin piloto físico esta decisión no acredita un intercambio real; el release
  distingue instalado, QR físico, grupo consultado, primer intercambio y
  calentamiento completado.
