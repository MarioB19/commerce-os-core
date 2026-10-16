# V7 F6 — «Probar número»: laboratorio aislado montado en web, API y MCP

13-oct-2026. Agente: Claude. Monta sobre la arquitectura del laboratorio de
número que ya existía por partes (control `commerce_number_lab`, motor
dedicado `commerce_lab_engine_*`, materialización, custodia de materiales,
transporte simulado y vendedor con la IA del negocio; ver
`adr-v7-number-laboratory*.md`). Cubre RF-19.a/b/e/f/k/l/m/n y parte de
RF-19.c/g/i/j/o. No instala nada en producción.

## Qué hace

- La persona abre un número y pulsa **Probar número**.
- Primero ve el **costo máximo de IA**, calculado en el servidor:
  - lo paga la clave de su perfil y cuenta en su presupuesto mensual;
  - es un tope, no un gasto prometido;
  - al iniciar acepta ese máximo; si una estimación nueva lo supera, el inicio
    se rechaza (`LAB_ESTIMATE_INCREASED`).
- La prueba fija la configuración vigente al iniciar: variantes, oferta, flujo,
  vendedor, cobro, materiales y remarketing. Editar la variante después no cambia
  la prueba abierta; **Reiniciar** captura lo actual.
- Conversa como cliente. Cada acción se aplica una vez, en segundo plano, por
  el trabajador del laboratorio.
- **Continuar** separa dos mensajes visibles seguidos del negocio. Antes de una
  espera (acuerdo, comprobante, respuesta) el flujo sigue solo, para que el
  cliente conteste a la pregunta que acaba de ver, igual que en producción.
- **Adelantar 2, 8 o 24 h** mueve sólo el reloj de la prueba: los seguimientos
  de la variante salen dentro de su horario y se detienen si el cliente
  responde.
- Si el número vende varias variantes y el mensaje no dice cuál, la prueba lo
  pregunta (como si el cliente viniera de un anuncio) y conserva esa variante en
  toda la conversación.
- Los datos de pago aparecen como marcador de prueba: la prueba nunca muestra ni
  usa la cuenta real.
- La última prueba de cada número aparece en Números («sin probar», «sin
  problemas», «con problemas»). Es informativa: nunca impide vender.

Ninguna prueba envía mensajes por WhatsApp, crea ventas, pagos, métricas o
temporizadores reales, ni consume la cuota del número. Funciona con el número
desconectado.

## API (`tests:read` / `tests:run`)

| Ruta | Uso |
|---|---|
| `POST /v2/number-tests/estimate` | `{account_id, mode:'CHAT'}` → máximo en microUSD, llamadas y modelo por variante |
| `POST /v2/number-tests` + `Idempotency-Key` | `{account_id, mode, accepted_maximum_microusd}` → 201 con la prueba; repetir la operación devuelve la misma |
| `GET /v2/number-tests/latest?account_id=` | Última prueba del número (o del perfil) |
| `GET /v2/number-tests/:id` | Prueba, variantes capturadas, acciones con resultado, conversación, programados y siguiente paso |
| `POST /v2/number-tests/:id/actions` + `Idempotency-Key` | `{expected_version, action}`: `message`, `select_variant`, `advance` (2/8/24), `continue` → 202 |

- Una acción a la vez por prueba: otra en curso → 409 `LAB_OPERATION_PENDING`.
- Los permisos de IA del laboratorio (`laboratory.chat` por variante) los emite
  la persona Dueña al publicar o confirmar la IA de la variante, o al iniciar
  una prueba desde la aplicación. Una clave personal sin ese permiso recibe
  `LAB_AI_GRANT_REQUIRED`.
- El comprador automático y los comprobantes dentro de la prueba siguen sin
  conductor: el inicio automático devuelve `LAB_AUTOMATIC_UNAVAILABLE` y adjuntar
  devuelve `LAB_ATTACHMENT_DRIVER_REQUIRED`. No se simulan como hechos.

## MCP `number_test_manage`

Acciones: `estimar`, `crear` (exige el máximo aceptado), `leer`, `ultima`,
`mensaje`, `seleccionar`, `avanzar_reloj`, `continuar` y `reiniciar`.
Pendientes declaradas en el registro: `adjuntar`, `ejecutar_suite` e `informe`.

## Trabajador

- `processNumberLabOperations` corre en el trabajador de automatización como
  un ciclo propio (`number_lab`) y sólo si existen sus credenciales:
  - control (`commerce_number_lab`), motor y semilla (base dedicada), lectura
    de materiales (`commerce_api`) y, para el vendedor, el login `commerce_ai`;
  - sin ellas el ciclo no hace nada y nunca bloquea la venta.
- La cola cruza perfiles sólo con `commerce_number_lab.queued_operations`
  (0108): una función definidora que usa el descubrimiento acotado de perfiles
  (018) y devuelve identificadores, nunca contenido.
- Una operación que quedó a medias más de dos minutos se concilia desde el
  recibo del motor; sin recibo queda incierta y nunca se ejecuta dos veces.
- Las claves del laboratorio se derivan de la clave privada del servidor (HKDF):
  control, archivos y transporte.
- La conversación viaja cifrada en el resultado de cada operación (como mucho
  200 mensajes y 10 programados), con el estado del flujo para el siguiente
  paso.
- Después de las confirmaciones simuladas se ejecuta lo que desbloquean
  (seguimientos confirmados, siguiente unidad del flujo), como harían los
  siguientes ciclos de producción.
- `variant_receipts` (F5) también queda montado como ciclo propio del
  trabajador.

## Instalación (Fase C)

`scripts/v7-number-lab-install.ts --write-env <ruta absoluta>`:

- crea la base del motor con las fuentes canónicas (migraciones 0001–0068,
  transiciones 001/010/012 y los cuatro componentes 021);
- crea los logins y escribe sus URL en un archivo `0600`. Sólo imprime la
  identidad;
- es idempotente: una segunda ejecución verifica y no reconstruye ni emite
  logins.

El trabajador necesita además `LAB_PRIVATE_STORAGE_DIR`, un directorio privado
`0700` distinto del almacén privado. El almacén de origen también debe ser
`0700`.

## Cambio compartido con producción

Continuidad de la ruta comercial: sin evidencia nueva, la única conversación
abierta del chat continúa.

- Antes, en un número con varios productos, una respuesta genérica («Sí,
  acepto») tras entrar por anuncio volvía a pedir elegir producto.
- Con dos conversaciones abiertas y una respuesta genérica de pago, se sigue
  pidiendo elegir (sin cambios).

## Verificación local (sin FULL)

- `v7-number-lab`, sobre un motor creado con el instalador de producción:
  - estimación, máximo aceptado, idempotencia del inicio y una acción a la vez;
  - flujo de venta con Continuar, recordatorio a las 2 h virtuales, acuerdo y
    cobro con marcador;
  - pregunta libre al vendedor con la clave del negocio, registrada como
    intento de laboratorio;
  - «Última prueba», y huella REAL idéntica antes y después;
  - número con dos variantes: selección y continuidad.
- Suites del laboratorio (motor, conductor, IA, materialización y control),
  rutas V5 y MCL, prueba de flujo anterior, venta y remarketing V7, y el
  arranque del trabajador con permisos de producción (14 ciclos).
- MCP: `estimar` → `crear` → acciones con la operación como llave.
- Chromium local, en escritorio y 390 px:
  - número con seis variantes: elegir, conversar, adelantar el reloj y llegar
    al cobro, sin desbordamiento.

## Pendiente

- RF-19.d: comprobantes en la prueba (conductor de adjuntos y lectura con
  `laboratory.vision`).
- RF-19.p: comprador automático por producto y su informe (RF-19.h).
- RF-19.c: vista previa de los materiales en el chat. Hoy se muestra su nombre.
- RF-19.o: retención de 30 días y exportación de transcripciones (F7).
- RF-19.q: retiro de las experiencias anteriores (F8).
