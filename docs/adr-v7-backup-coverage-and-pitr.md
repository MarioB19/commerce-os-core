# Cobertura B02 y recuperación continua · V7

Decisión del 11 de octubre de 2026. Este incremento se desarrolla separado del
candidato F0. No modifica la instalación actual ni acredita PITR productivo.

La ventana financiera B02 existente termina el 4 de noviembre a las 00:00 UTC.
Su cuota global de 37 inicios en treinta días incluye todos los fallos e intentos
inciertos que llegaron al journal. Después del respaldo F1 quedan 20 inicios,
reservados para el 12–31 de octubre. Los tres slots del 1–3 de noviembre no caben;
no se renueva la ventana, se reinicia el historial ni se abre cupo manual.

Se prepara una admisión suplementaria exclusiva de esos tres slots diarios,
conservando MAX37 como política base. Cada suplemento requiere el binding
SCHEDULED actual, historial original completo preservado, slot canónico, ausencia
de otro intento del mismo slot y reserva económica de noviembre autenticada.
Fallos y resultados inciertos consumen el slot; solamente lecturas concilian una
respuesta perdida. La aprobación no permite repetir un backup ni alterar uno
previo. Sin esa admisión, el ejecutor mantiene el rechazo existente.

El pronóstico recorre todos los slots en orden y aplica el mismo límite inclusivo
del ejecutor: un inicio exactamente treinta días anterior todavía cuenta. Separa
meses UTC, costes brutos con impuestos, máximos de ejecución y bytes. La factura
previa, otros recursos y reservas se reciben del sobre económico revisado; no se
presumen gratis, no se restan créditos y no se presenta este modelo como un límite
duro de facturación del proveedor. Tres ejecuciones de 1,920 segundos a 2 vCPU y
8 GiB, con las tarifas oficiales actuales de jobs y 16% IVA, reservan
USD 0.347443200 sólo de cómputo; almacenamiento, operaciones, logs y transferencia
se contabilizan aparte. La producción requiere la admisión nativa posterior.

Para PITR se conserva PostgreSQL17, siete días de historial y archive_timeout=60s.
B02 es un respaldo lógico; no sustituye una base física más una cadena completa
de WAL. Se elige pgBackRest con repositorio cifrado, compresión y GCS en una
región distinta, sin una réplica permanente. La cola nunca se descarta por cuota:
la opción archive-push-queue-max debe quedar deshabilitada, los errores conservan
WAL y se alertan edad/capacidad. La base física, incrementales y todos los WAL
necesarios deben caber con retención completa y contar su transferencia.

Antes de instalar: fixture PostgreSQL real con recuperación a un punto anterior
a un cambio destructivo, comprobación de dinero/IDs, rechazo de cadena rota y
custodia de claves; posteriormente medir WAL comprimido representativo en el
host mediante observación autorizada y recalcular almacenamiento/egreso. La
muestra histórica de 7.92 GiB/día sin compresión no demuestra que siete días
quepan en la reserva. El ensayo local no acredita RPO/RTO ni veinte teléfonos.
El cambio de archive_mode requiere un arranque controlado propio, con respaldo,
cuatro locks, plan canónico y aprobación económica vigente: jamás repetir el
resize/restore F1 ni usar el ensayo como permiso para producción.

La verificación del arranque durable después del release F0 lee instalación,
policy y journal por boot, salud, CIDs y pausas actuales. No fuerza otro reinicio
ni enciende sesiones para obtener evidencia. Toda mutación nube/VM sigue
serializada por el operador principal.

La lectura Root del 11-oct a las 20:03:31 UTC autenticó los 17 journals:
16 SUCCEEDED y uno FAILED_RECONCILED, que conserva su consumo. El pronóstico
con sus hashes originales confirma 20 slots de octubre y exactamente tres
descubiertos. El cálculo marginal, incluyendo una descarga de recuperación por
objeto, es USD 0.855582073 bruto. Es una estimación condicionada: falta el sobre
completo de noviembre y demostrar los límites de operaciones/logs del adaptador.
No se presenta un mes con coste cero ni se financia con el margen de octubre.
[Evidencia sin contenidos privados](evidence/v7-f1-recovery-20261011/b02-coverage.json).

El suplemento puro exige los originales de fuente, plan, binding y economía,
además de conservar el historial y cada claim, incluso incierto. Devuelve sólo
elegibilidad. Su integración debe ejecutar el mismo gate bajo los cuatro locks
en `gcp_authorize` y `execute`, con un claim O_EXCL previo. El plan canónico debe
sellar la nueva clausura de fuentes y revalidar el par Root/B02; no basta copiar
el módulo ni sustituir MAX37 por MAX40. Este incremento no modifica ninguno de
los ocho archivos del restore histórico ni el ejecutor instalado.

El laboratorio aislado PostgreSQL17.11/pgBackRest2.59.3 pasó full, incremental,
restauración a un punto nombrado previo al borrado, rechazo de clave incorrecta
y rechazo de WAL requerido ausente. Recuperó exactamente los IDs sintéticos
1 y 2, con 30,000 centavos; el incremental posterior conservó el borrado.
El repositorio medido después de poner ese WAL en cuarentena ocupó 4,774,640
bytes. Esa cifra es del fixture, no una muestra de capacidad productiva.
El repositorio del laboratorio es POSIX, no prueba GCS ni recuperación regional.
Un primer intento falló por permisos antes de iniciar PostgreSQL; se conservó
el resultado y se retiraron sólo su contenedor y volumen vacío propios. El
intento final usa tmpfs para impedir volúmenes anónimos. Cinco contenedores y
31 volúmenes preexistentes permanecieron idénticos. Se conservan los resultados
anteriores y el [recibo sin datos privados](evidence/v7-f1-recovery-20261011/synthetic-pitr.json).

Validación del incremento: 36 pruebas unitarias Python; revisión independiente
del pronóstico/política, suplemento y fixture. Para repetir sólo el laboratorio,
seguir [su procedimiento aislado](../tests/recovery/README.md). FULL, integración
del suplemento, observación de WAL real, repositorio regional y aprobación
económica/instalación permanecen gates de las siguientes etapas.

### Corrección de la reserva del suplemento · 11-oct, revisión posterior

La estimación marginal anterior de USD 0.855582073 queda como antecedente
incompleto y no es admisible: cortaba almacenamiento el 11 de noviembre,
pero el bucket canónico exige lifecycle de 30 días más siete días de soft delete.
Los objetos del 1–3 de noviembre pueden conservarse hasta el 8–10 de diciembre.
Lifecycle es asíncrono; esa fecha nominal no demuestra eliminación ni constituye
un techo de facturación. Se conserva intacto el recibo histórico del cálculo.

El nuevo modelo reserva los bytes máximos de los tres objetos durante noviembre
y diciembre completos, sin descontar el tiempo anterior al upload. Reserva una
descarga de recuperación y sus operaciones/transferencia en cada mes en que
pueda ocurrir; son reservas conservadoras, no dos restauraciones autorizadas.
Cómputo y escrituras del respaldo pertenecen sólo a noviembre. El resultado
exige sobres completos de ambos meses, con todos los servicios existentes y
reservas; no toma el saldo de octubre ni asigna cero a un mes desconocido.
El gate puro debe comprobar ambos techos de USD100. Ningún resultado concede
ejecución, cambia MAX37 ni extiende el binding más allá del 4 de noviembre.

La reserva de diciembre termina el 1 de enero. Antes de liberar almacenamiento
se exige evidencia nativa de ausencia tanto de objetos vivos como soft-deleted;
si permanecen, la siguiente envolvente debe conservar su coste. El modelo no
supone que lifecycle imponga ese límite temporal. Esta revisión mantiene cerrada
la integración productiva hasta demostrar los límites de operaciones/logs y la
contabilidad completa de noviembre y diciembre.

La [corrección del cálculo](evidence/v7-f1-recovery-20261011/b02-storage-horizon-correction.json)
preserva el hash del antecedente y deja desconocidos los totales completos de
ambos meses. El cálculo aislado se prueba con totales sintéticos; ninguno se
presenta como saldo productivo.

Fuentes de la corrección: [Object Lifecycle Management](https://docs.cloud.google.com/storage/docs/lifecycle)
y [soft delete](https://docs.cloud.google.com/storage/docs/soft-delete), consultadas
el 11 de octubre de 2026.

Fuentes: [PostgreSQL17 recuperación](https://www.postgresql.org/docs/17/continuous-archiving.html),
[pgBackRest configuración](https://pgbackrest.org/configuration.html),
[Cloud Run precios](https://cloud.google.com/run/pricing),
[GCS precios](https://cloud.google.com/storage/pricing),
[Cloud Logging precios](https://cloud.google.com/products/observability/pricing).

## Envolventes completas futuras · decisión 11-oct antes del código

Noviembre y diciembre se modelan desde la base estable de ADR-V7-14, con horas
reales del calendario y CI420; el devengado parcial de octubre no es su base.
Se preservan IVA16%, lag24h, veinte números, 30/50GiB de red, GCS primario/DR/WAL,
snapshot20GiB, ingress2, Pub/Sub1, operaciones2, Registry10GiB, correo2 antesIVA,
logs5GiB, monitor1 y restore1. Los USD2 brutos de activaciones de correo siguen
siendo su admisión interna; el resto de la reserva anterior no se reutiliza.

B02 diario usa 1920s por día a2CPU/8GiB y un Scheduler separado. Noviembre separa
27 diarios ordinarios de los tres slots suplementarios; diciembre conserva31.
Nunca se cobran los tres suplementos dos veces como cómputo diario. Se conserva
una contingencia B02 deUSD0.50 antesIVA. Las bolsas de operaciones contienen la
capacidad OPERATING vigente:20kCPU-s/40kGiB-s/2krequests más12kCPU-s/24kGiB-s de
startup/rechazos/cleanup,10kClaseA/100kClaseB,8.171875GiB de control y dos ciclos
de fuentes/paquetes, un Scheduler y el secreto publicador. Su desglose se
recalcula y debe caber en2; no consume las reservas de ingress o monitor.
La bolsa separada OAuth, source0.05 y SHADOW0.03 se mantienen prudentemente.

Para recuperación durante un mes con cambios se conservan también95min de
rollback Compute y un snapshot frío100GiB durante24h+7d de papelera. Son reservas
futuras, no se vuelve a cobrar el snapshot F1 ya eliminado ni se autoriza otro.

El inventario B02 reportado nativamente el11-oct12:43 en ADR14 era
15,967,372,648bytes. Se conserva íntegro, más21 exports máximos posteriores de
octubre y todos los diarios futuros. Cada export reserva1GiB+64KiB. Se carga el
máximo resultante durante todo el mes, sin inferir una desaparición por edad,
lifecycle o soft-delete. Los20GiB B02 del rubro original se amplían sólo por la
diferencia; sus otros40GiB se conservan. Los suplementos añaden sus propios tres
objetos y red/operaciones de recuperación en ambos meses, según el modelo previo.
Esta sobrecota evita suponer borrados y no equivale a crecimiento observado.

Si una envolvente excede100, el modelo lo informa y bloquea ambas admisiones.
La solución candidata es autenticar el inventario normal y soft-deleted antes
de la nueva admisión y la ausencia de objetos que ya no requieren retención,
conservando lifecycle30d+soft-delete7d y siete días PITR. El horizonte financiero
conservador de ocho semanas no autoriza borrar ni acortar retención. Tampoco se
recortan funciones, FULL o CI para forzar PASS. WAL comprimido, DR, bytes de
operaciones y límites de proveedor siguen requiriendo medición representativa;
una cifra bajo100 no los acredita. Este modelo no escribe cuotas, GCS o Cloud.

Referencias de tarifa revalidadas11-oct: [GCS](https://cloud.google.com/storage/pricing),
[Run](https://cloud.google.com/run/pricing), [Build](https://cloud.google.com/build/pricing),
[Scheduler](https://cloud.google.com/scheduler/pricing). Las tarifas USD son la
base de comparación; la admisión futura debe revalidar SKU y conversión de la
cuenta MXN, sin deducir free tiers ni créditos.

Resultado local conservador: **noviembre99.852384076USD**, con margen0.147615924;
**diciembre102.976077556USD**, excede2.976077556. El conjunto queda bloqueado.
El cálculo conserva también la diferencia de almacenamiento de los tres objetos
suplementarios en744h frente a la referencia0.02USD/GiB-mes del marginal previo.
Los originales del marginal se preservan. La suma se construye desde partidas
publicadas redondeadas hacia arriba; doce pruebas locales cubren conservación,
meses, cuotas, no doble cómputo y rechazo del gate previo para diciembre.
Recibo derivado: [envolventes futuras](evidence/v7-f1-recovery-20261011/future-monthly-envelopes-proposed.json).


### Corrección de frontera Pacific · decisión posterior antes del código

Cloud Billing informa días de uso en Pacific y observa DST. Se validará el
calendario con `America/Los_Angeles`, convirtiendo ambos extremos a UTC antes de
restarlos: octubre termina 1-nov07:00Z y noviembre dura721h. La nota económica
original ya fijaba514.165h desde10-oct20:50:06Z hasta ese cierre; la cadena que
parte de94.946182966 conserva esas horas. No se suman otra vez siete horas de
Compute/PD/IP. Los restantes rubros mensuales permanecen íntegros.

Los lectores históricos de byte-hours B02 terminaban00Z y su cómputo futuro
omitía el slot1-nov06:45Z, que empieza en octubre Pacific. Antes de una nueva
admisión se propone reservar un intento completo1920s,25ClaseA,100ClaseB y64KiB
logs, sin liberar la contingencia B02 ni descontar ninguna otra reserva. La
proyección GCS conserva el inventario reportado, todas sus fechas ya agregadas,
los20diarios restantes y un F1 manual desde00Z del11-oct como sobrecota. Añade
las7h hasta el cierre correcto y24h incluso a cada export futuro y al suplemento.
Esto es una cota de preparación; no atribuye una creación anterior a su hora real.
La base20GiB×744h sólo puede absorberlo si la suma verificable es menor14880.
Red30/50GiB,logs5GiB,operaciones2 y los demás rubros siguen completos; una posible
restauración adicional sigue necesitando su admisión y su control de bytes, no
se inventa una descarga causada por el cambio de calendario.

La propuesta futura anterior se conserva como histórica y no es admisible:
noviembre se calculó con720h y atribuyó los tres inicios sólo a noviembre UTC.
El suplemento necesita sobres de octubre, noviembre y diciembre, con posible
solapamiento conservador de cómputo en el intento que cruza la frontera. Nada
permite ejecutarlo sólo por corregir esta aritmética, ampliarMAX37 o tocar cuotas.
Las tarifas y los recibos nativos deben revalidarse en cada admisión efectiva.
Fuente oficial: [periodos del informe Cloud Billing](https://docs.cloud.google.com/billing/docs/how-to/reports).


La revisión independiente de octubre ejecutó8pruebas y cotejó los siete
originales: el delta completo conservador es0.116041200390625USD conIVA, con
propuesta99.92126366725297311677679811982547090383461664234. Los byte-hours B02
son14584.1120381236601163024902343750, menores que14880, incluyendo24h a todos
los exports futuros. El [recibo de frontera](evidence/v7-f1-recovery-20261011/october-pacific-boundary-proposed.json)
no adopta esa envolvente ni sustituye el reanclaje de facturación de Root.

La [propuesta Pacific](evidence/v7-f1-recovery-20261011/future-monthly-envelopes-pacific-v2.proposed.json)
usa721h ennoviembre y744endiciembre. El diario1-dic06:45UTC pertenece todavía
anoviembre: son28ordinarios y2suplementarios que comienzan allí. Además se retiene
conservadoramente el intento completo del1-nov que puede cruzar desdeoctubre;
no se deduce del cómputo reservado en ninguno de los dos meses.
Los totales son **noviembre100.085861513USD** y **diciembre102.999723706USD**.
Ambos meses quedan fuera de admisión. El algoritmo conserva todos los bytes,
por lo que un inventario futuro/ausencia verificada puede cambiar la estimación,
pero no se anticipa ese cambio ni se reduce retención para declararPASS.

El consumidor preparado sube a schema3 y exige `America/Los_Angeles` y sobres de
los tres meses, ligados por el hash de propuesta/custodia que ya exige. Rechaza
schema1/2 y presupuesto de octubre ausente o excedido. El calculador anterior
permanece como estimación histórica de componentes Nov/Dec, explícitamente
incompatible con una admisión: ya no afirma que octubre no tenga cargo. No se
importa en el runtime instalado ni en el candidatoFULL0471; la integración
canónica sigue pendiente, además de financiación completa y todos los gates.


### Conciliación propuesta de octubre tras la lectura de las22:06UTC

Antes de modificar el modelo se decide comprobar dos escenarios, sin adoptar
ninguno. El reanclaje usa336.01MXN frente a329.75MXN, IVA1.16 y sólo retira el
futuro de Compute/PD/IP entre20:32:32.1963 y22:05:00UTC. Este último instante es
un ancla conservadora anterior a la captura completa, no una lectura fabricada.

La revisión11 conservó explícitamente el diferencial entre e2-standard-4 y
standard-2 después del resize nativoDONE15:24:05.679UTC. La revisión8 había
extendido ese diferencial hasta18:00UTC. Se puede conciliar una sola vez ese
intervalo ya cerrado, con resize/start y lectura actual del mismo ID de VM,
sin descontar tiempo detenido ni cambiar el margen de retraso24h. No es una
reducción del presupuesto deCI, del rollback95min ni de los gates del release.

El escenarioA mantiene incluso el snapshot100GiB×(24h+7d) íntegro. El escenarioB
mantiene100GiB y7d completos pero acota su fase activa a2h, redondeadas hacia
arriba desde creación hasta la confirmación nativaGET404 posterior a DELETE
DONE. No se usa el tamaño comprimidoREADY52.86GiB como cota futura: la API
permite que aumente por redistribución de una cadena, yUP_TO_DATE está deprecado.
Tampoco se usa el descuentoPreview de la papelera ni se anticipa eliminación.
Ambos siguen siendo propuestas locales, con adopción y frescura a cargo del
operador canónico antes de un efecto.

Fuentes primarias: [precio de snapshots](https://cloud.google.com/compute/disks-image-pricing),
[campos del snapshot](https://docs.cloud.google.com/compute/docs/reference/rest/v1/snapshots)
y [retención de recursos eliminados](https://docs.cloud.google.com/compute/docs/disks/retain-deleted-resources).


### Condiciones técnicas para financiar los meses futuros

La base futura íntegra sigue excediendoUSD100. Se prepara un escenario distinto,
condicionado a que no exista una intervención nueva deCompute ese mes: sin resize,
creación/restauración de disco ni nuevo snapshot de mantenimiento. El release
canónico sobre la mismaVM conserva backup fresco, restore histórico compatible,
rollback de la aplicación, cuatro locks, FULL y el resto de gates. Los95min de
Compute adicional y el snapshot frío100GiB×24h+7d son reservas del procedimiento
Compute nuevo; no se descuentan del escenario íntegro ni se usan para autorizarlo.
Todo plan que incluya ese procedimiento debe volver al sobre íntegro y financiarlo.

Se calcula el umbral máximo de byte-hours B02 que permitiría financiar el mes
sin esa intervención, conservando los40GiB de primario/DR, snapshot20GiB, WAL7d,
CI420, todos los intentos diarios/suplementarios, red, correo, lag y operaciones.
El umbral no acredita bytes actuales ni garantiza que lifecycle borre a tiempo.
Para utilizarlo se requiere inventario completo normal ysoft-deleted, generaciones,
bytes y timestamps, ausencia autenticada antes de liberar históricos y una
proyección que mantenga30d más7d de soft delete sin vacíos. Se conserva el coste
separado de los tres objetos suplementarios; no se descuenta dos veces.

No se implementa un selector de producción ni una autorización basada en el
booleano«sin mantenimiento». El resultado es únicamente una condición revisable
para un plan canónico de acciones cerrado. La prueba LOAD20 y la capacidad real
WAL/DR siguen pendientes y pueden invalidar este escenario; si requieren más
infraestructura, se recalcula antes de cualquier efecto. No se declara que las
fases F0–F9 o todo diciembre ya sean financiables.
