# SOURCE detenido por cuota antes de adquirir el archivo

Decisión prospectiva del 11 de octubre de 2026, adoptada por el operador principal.
La respuesta nativa del intento `6debc2e3-5e4a-472f-acc2-e68c6fe465a0` informó
`INVENTORY_HTTP_429` en `SOURCE_POST_INTENT_FENCE`. En la implementación sellada,
ese punto está dentro del fence posterior al CAS y precede a `prepare_archive`.
No se trata como adquisición exitosa, no autoriza repetir el POST original y no
borra su intención. La cuota nativa leída por el operador es 60 solicitudes por
minuto por proyecto y por usuario para `all_else_requests` y `get_requests`.

Se mantienen los dos inventarios completos, sus 44 regiones observadas y todas
sus páginas. Un limitador compartido en cada fábrica separa los inicios de las
consultas de inventario por al menos 1.05 segundos. No reutiliza una observación
previa, no aumenta cuotas ni transforma un error en ausencia de Builds. Cada
observación conserva su inicio original y el límite de 90 segundos; cada gate
sigue venciendo 120 segundos después de comenzar. El operador serializa otras
lecturas de Cloud Build y exige 60 segundos desde la última antes de invocar.
El coste del tiempo de espera permanece dentro de la reserva de 450 segundos.

La recuperación sólo procede con originales nativos autenticados del mismo
servicio, imagen, tarea, solicitud, ledger y diario: respuesta terminal exacta
429/fase, control pausado por CAS, IAM del invocador sin cambio, ausencia nativa
del objeto de fuente, inventario completo, ledger todavía RESERVED sin intención
de Build, y diario que contiene únicamente `source-acquire` sin resultado.
Deben pasar los 450 segundos de la solicitud más 30 segundos de margen. Si
cualquier dato queda incierto, se conserva el bloqueo. La recuperación del
medidor conserva todas las filas, meses, techos y uso: cambia sólo el estado de
esa solicitud y su hash de recibo; no modifica el ledger ni libera sus 95 minutos.

Una nueva tarea protegida de continuación referencia un recibo inmutable de esa
recuperación. La fábrica revalida la reserva y consume una intención adicional
`source-resume:<attempt>` antes de adquirir el mismo commit y árbol con el
productor canónico. La intención original se conserva. Sólo una continuación
puede adquirir; cualquier pérdida de respuesta exige reconciliar originales y
nunca vuelve a ejecutar la adquisición. El resultado auténtico se registra en
la acción original y el upload conserva su propio CAS de intención/generación0.
El recibo de continuación no proviene de HTTP ni de la fuente candidata.

El arreglo pertenece al tooling confiable, con commit, imagen, pruebas, scan y
adopción propios. El candidato público permanece en
`0471afc7774885dd96ab64503472d692d17d6647`; no se afirma que ese árbol contiene el
arreglo ni se cambia el SHA atribuido al FULL, paquete o instalación. No se
reconstruyen verifier/package ni se reutiliza un PASS de otro SHA. El transporte
Root y la conciliación nativa conservan sus gates independientes.


### Composición final de lectores

El intervalo fijo es 1,25 s: como máximo 48 emisiones de lectura por minuto en
cada proceso. Factory comparte el mismo reloj entre inventarios nuevos,
ConnectedSourceReader, GoogleBuildAPI, GoogleFullReader y GooglePackageReader.
PublisherWorker comparte otro reloj entre sus cuatro lectores. `accessReadToken`
también ocupa una posición. Logging, Storage y metadata no usan cuota Cloud Build.
Create/approve conservan envío inmediato después del fence: no se introduce una
espera que invalide su autorización; sus efectos acotados caben en el margen de
12 consultas por minuto. La serialización de actores y pausa de 60 s del operador
sigue siendo necesaria: este mecanismo no promete una cuota global del proveedor.

La autorización RESUME contiene originales de metro y ledger codificados en
base64, la prueba histórica y el recibo de recuperación, más descriptor nativo del
metro posterior. Su productor rederiva la transición en `recovered_at` original.
El runtime comprueba los bytes/generación actuales de ledger y journal, todas las
filas recuperadas del metro y una nueva reserva de 450 s. Después de consumir
`source-resume:<attempt>` relee ausencia nativa del TGZ; sólo 404 permite adquirir.
Una nueva incertidumbre consume esta única continuación y conserva ambos intents.
El productor de tarea mantiene el plan, evento, aprobación y SHA0471 originales.
Estas correcciones pertenecen al tooling confiable posterior; no se atribuyen al
árbol público0471 ni autorizan cambiarlo o publicar otro evento.
