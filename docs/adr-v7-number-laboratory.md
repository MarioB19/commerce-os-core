# RF19 — laboratorio de número con motor compartido y frontera propia

Decisión prospectiva, 2026-10-12. Rama aislada desde el consolidado `54d7124`.
No montaje, aprovisionamiento, clave real ni llamada de proveedor en este incremento.

## Contrato de producto

«Probar este número» captura todas las variantes y versiones asignadas al número
bajo la autoridad F2 del perfil. Funciona sin conexión QR. La selección de origen,
el chat, comprobantes sintéticos, materiales, baja y reloj virtual +2/+8/+24 h usan
la misma configuración capturada. Reiniciar crea otro `test_run_id`; no modifica
el anterior. Cada respuesta conserva variante, flujo, vendedor y razón. El informe
automático incluye todas las variantes, escenarios y tiers previstos y distingue
pendiente, parcial, fallo y final correcto. Un HTTP correcto no acredita el recorrido.

Antes de iniciar, UI/API/MCP consumen la misma estimación y reserva de costo de IA.
Sólo la clave empresarial vigente VERIFIED del perfil puede generar esa respuesta.
El permiso `credential.verify` de019 no sirve como permiso de laboratorio.

## Fronteras de ejecución

El almacenamiento del laboratorio tiene rol propio, sin tablas comerciales REAL.
La opción de composición es una base lógica dedicada en el PostgreSQL existente,
con el esquema canónico y el mismo código de workflows/receipt/entrega; no se
replica una máquina de estados simplificada. Un repositorio de control separado
lleva sesión, snapshot, operaciones y reporte. El rol/proceso lab sólo se conecta
al almacenamiento lab validado al arranque, y el transporte no dispone de secretos
WAHA ni de puertos de envío real. La instalación no puede habilitarse por un campo
`environment`/`execution_kind` recibido del cliente.

La captura REAL y la escritura lab son puertos distintos: configuración comercial
mínima, referencias de versiones/materiales y sus hashes. Se excluyen contactos,
pedidos, pagos, sesiones, teléfonos, credenciales y autorizaciones operativas.
Los UUID de configuración original se conservan como referencias de procedencia;
los registros sintéticos del motor son identidades nuevas y nunca son autoridad.
No se crean variantes ni conversaciones comerciales SIMULATION para satisfacer
las FK del presupuesto de IA.

El transporte simulado acredita únicamente eventos de prueba; no usa outbox del
worker comercial ni consume cuotas/calentamiento del número. Reloj virtual, pagos,
comprobantes y timers viven en la misma frontera lab. Los adjuntos sintéticos usan
un prefijo independiente. Las lecturas de material se limitan a referencias fijadas
al snapshot. La red del proceso sólo admite el puente de IA y el lector de assets;
la composición nativa debe demostrar esa allowlist antes de habilitarlo.

## IA y persistencia incierta

El puente de019 separa `credential_environment=REAL`,
`execution_environment=SIMULATION`, `operation_class=TEST` y `test_run_id`.
La referencia a variante viene del snapshot auténtico y la clave queda en su
custodia original. Presupuesto/reserva/INTENT/uso pertenecen al ledger empresarial;
no se copia el secreto a una clave SIMULATION ni se reinicia saldo.

Toda operación de laboratorio tiene UUID, versión esperada e identidad de payload.
Los reintentos exactos consultan resultado; el mismo UUID con otro contenido es
conflicto. Una incertidumbre de COMMIT/red conserva el intento y exige consulta;
no emite otra llamada IA. El resultado de IA y su uso se guardan antes de avanzar
el cursor y no se descartan por una pausa. Historial privado por perfil durante30d;
la retención conserva costo/procedencia y redacta contenido sin alterar métricas REAL.

## Secuencia de cierre y pruebas

Primero se fijan contratos estrictos de snapshot/operación/costo y el control
persistente aislado. Luego se conecta el repositorio del motor y puente019,
se prueban PostgreSQL/TCP con rol restringido y se montan API/MCP/UI equivalentes.
Las pruebas deben demostrar que el rol lab no puede leer/escribir REAL ni usar
puertos WAHA, que una cuenta desconectada funciona, que cambios de configuración
requieren reinicio, y que UNKNOWN no repite proveedores. El caso automático de tres
variantes recorre el mismo código que REAL con proveedor sintético de plataforma;
la calidad de un modelo real sólo se acredita cuando el negocio ejecuta su prueba.

El legado `number-flow-tests` usa tablas compartidas con flags SIMULATION y un
vendedor determinista. Se conserva mientras se ensaya esta frontera nueva; no se
presenta como cumplimiento del aislamiento ni de IA real exigidos por RF19.

## Puente persistente a019

El componente `021_number_lab_ai_bridge.sql` se aplica después de019 y del control021.
Fija release, cotización y máximo por variante antes de admitir una operación.
El rol de control crea un vínculo inmutable con run, operación INTENT, snapshot,
variante/release, grant y hash del request. Comparte el advisory lock REAL de019.
El rol IA no puede fabricar ese vínculo: el trigger adicional lo exige al reservar
y lo relee al pasar a INTENT. El proveedor recibe el Scope lógico SIMULATION;
sólo el puerto interno traduce al dominio REAL de la clave y presupuesto.

`is_test` mantiene su significado exclusivo de verificación de credenciales.
`result_ai_cost_facts` clasifica como TEST también el binding de laboratorio desde
RESERVED, aunque no haya settlement ni costo conocido. No cambia montos, estados,
metadatos históricos ni el saldo de019. Un ACK de COMMIT perdido antes de reserva
no libera acceso al proveedor; una reserva o INTENT consumido conserva la semántica
canónica sin repetición. El control no recibe SELECT de credenciales ni outbox.

El control anterior acreditó12 PostgreSQL locales en attempt2; el puente y la
captura REAL se verifican aparte y no heredan ese resultado. La prueba HTTP usa
un servidor loopback explícitamente sintético con el adaptador de proveedor real.
No acredita el motor comercial del laboratorio, su montaje ni la red de producción.

El recibo cifrado del settlement incluye el resultado y el `run_state` adoptado.
Un replay debe coincidir con ambos, aunque otras operaciones hayan avanzado el
estado actual del run; jamás confirma un cambio de estado que no fue aplicado.

## Verificación de control, captura y puente

29 pruebas unitarias, 12 PostgreSQL de control y 12 PostgreSQL/HTTP de puente y
captura nativa pasan. TypeScript completo y ESLint focal pasan. El peer independiente
leyó las fuentes y ejecutó las pruebas puras, incluido el recibo run_state. La
captura nativa parte de releases F4 publicados mediante sus puertos reales, funciona
con cuenta desconectada y rechaza releases ambiguos, asignaciones retiradas y otro
perfil; no escribe registros comerciales. El proveedor del ensayo es loopback
sintético, con adaptador y dos INTENT reales.

El intento combinado inicial conservó dos fallos de fixture: comparación contra un
sobre en lugar de su release y reutilización de un rol global al crear una segunda
base. El rechazo de rol se mantuvo; las suites finales usan clústeres propios
seriales. Se conservaron dumps y logs del fallo. Los originales finales fijan fuentes
antes/después y preservan exactamente los 5 contenedores y 65 volúmenes ajenos.

Este incremento no monta API/MCP/UI, no implementa aún el motor comercial aislado
ni acredita una llamada al proveedor empresarial real. Evidencia saneada en
`evidence/v7-number-lab-control-ai-local.json`.

## Adaptador del motor canónico

El siguiente incremento usa dependencias localizadas de los runners; no abre el
kernel general WorkerScope a callbacks arbitrarios. El factory del motor verifica
base, marker de instalación, rol dedicado sin membresías y run/snapshot actuales.
Emite un objeto opaco de una sola ejecución. Cada fase obtiene una transacción
propia, fija un workspace sintético del run y SIMULATION, verifica el binding antes
y después, y confirma COMMIT antes de devolver datos. Una referencia prestada no
funciona fuera de la fase y una fase sin await invalida la ejecución.

El runner comercial conserva por defecto sus dependencias actuales. Sólo un lease
emitido por el factory validado permite seleccionar los puertos lab; no acepta un
booleano, entorno ni proveedor alternativo procedente del cliente. Preparación y
reconciliación usan SQL corto; IO usa el puente019 fuera de cualquier transacción.
La configuración original se remapea a UUIDs sintéticos deterministas por run y
conserva sus referencias originales como procedencia. Las funciones canónicas de
workflow, recepción y comprobantes reciben el executor del motor, nunca el pool
comercial REAL. La instalación del schema/rol y la barrera de red siguen siendo
prerrequisitos nativos independientes del ensayo local.

El componente de base del motor se instala únicamente en una base lógica nueva
`commerce_lab_engine_*`, después de las 68 migraciones y las transiciones 001,
010 y 012 originales. No crea columnas sustitutas de continuidad. Los tres roles
nuevos no pueden iniciar sesión, heredar permisos ni administrar PostgreSQL; el
login nativo usa SET ROLE explícito. El marcador sólo lo sella la instalación
administrativa. El rol de ejecución no puede cambiar configuración, marcador ni
bindings, y no tiene acceso a sesiones, claves, perfiles o autorizaciones continuas.

Los lectores comerciales hacen JOIN a autorización antigua y preparación incluso
en SIMULATION. Sus tablas reciben únicamente una proyección RLS siempre vacía
para el rol del laboratorio, nunca permisos de mutación. Las tablas operativas
permitidas exigen workspace del run y CHECK SIMULATION; secuencias y privilegios
son explícitos. Las funciones privilegiadas históricas dejan de ser ejecutables
por PUBLIC en esa base nueva. No se modifican permisos de otra base ni del entorno
REAL. La retención canónica mantiene su comprobación de rol propia.

El ensayo del límite del motor verifica registros/versiones y el proponente de
outbox canónicos bajo rol restringido; no se confunde con el recorrido completo
workflow/IA/comprobantes, cuya adaptación y montaje aún están pendientes.

El primer ensayo del motor rechazó la creación de la cuenta porque el trigger
canónico también materializa `channel_sessions`. Se conserva el fallo completo.
El seed recibe sólo las columnas de INSERT/UPDATE usadas por ese trigger, con
RLS del run y CHECK de simulator, STOPPED, pausa, sin identidad/credenciales ni
recuperación. El rol que ejecuta el motor no recibe acceso a esa metadata. No se
omite el trigger ni se crea una sesión del canal REAL.

## Verificación del límite SQL del motor

27 unitarias y 13 PostgreSQL reales pasan bajo rol restringido; typecheck y lint
focal pasan. El componente rechaza filas previas en toda su superficie operativa
y de identidad, incluso commands y domain_events cuando records está vacío.
El fixture autentica identidad, membresías y dependencias de sus roles antes de
retirar exclusivamente su segunda base y cinco roles propios, sólo tras todos
los casos PASS. Ante fallo conserva base y roles para el dump del harness.

El intento 3 conservó 13 casos funcionales PASS pero falló el hook de limpieza
por su firma Vitest; no se cuenta como suite aprobada. El intento 4 verificó el
hook real. El intento 5 añadió y verificó el OID fijado al crear ambas bases antes
de retirarlas, con inventario ajeno exacto de 5 contenedores y 65 volúmenes. Este resultado acredita el límite SQL y el proponente canónico de
outbox, no el recorrido de workflow/IA, su montaje ni egress productivo.
