# V7 — Custodia financiera tras la minimización (032)

Decisión previa,12-oct-2026. Root reserva030 para fencing y031 para autoridad/purga.
032 conserva024/025/029 y la assertion comercial histórica sin modificaciones.
No monta un job ni concede permiso para borrar.

La captura por perfil REAL/repeatable-read toma primero el mutex de proyección y
luego el de conversación.025 debe autenticar el cierre. El comando APPLIED de ese
mismo cierre debe contener la prueba canónica commercial_resolution: TODOS los
pedidos actuales, sus versiones y contribuciones/fulfillments exactos. Un cierre
histórico sin esa prueba debe volver al procedimiento humano canónico; no se
interpreta FINISHED, body.status ni un JSON del llamador como resolución.

Cada referencia financiera/entrega se relee por029, se conserva su vencimiento
original y se liga a hashes de fuente, términos y autoridad. Se inmovilizan los
registros, versiones y ledger y se rechazan cambios o efectos inciertos. La
captura incluye todos los comprobantes, también los que no generan ingreso,
y valida relaciones e historia1..versión. La versión SQL de la allowlist mínima
se prueba contra el minimizador puro; sus hashes son jsonb::text, explícitamente
distintos del canonical JSON de TypeScript. Ningún hash llega como autoridad del
solicitante. Las fuentes originales quedan sólo en hash; no texto, actor, motivo,
proveedor, documento, extracción sensible ni cifrados.

Una confirmación separada verifica la instalación de TODAS las imágenes mínimas
y el stub del recorrido contra la captura, sin ejecutar el borrado.031 deberá
hacer purga+confirmación en su transacción autorizada y bajo el lease/epoch030.
La confirmación no acredita inventario, backup, filesystem ni permiso de Owner.
El plazo usa el mínimo de las pruebas nativas029 y cinco años del cierre para
pedidos sin prueba comercial; la captura/replay/corrección nunca lo renueva.

Después, la clasificación usa un comando nativo PENDING con alcance, actor,
expected_version, enum y razón válidos, en la misma transacción que el CAS y un
recibo inmutable propio. Sólo FALSE/GENUINE de comprobante o TEST/COMMERCIAL de
pedido: no puede aprobar, cambiar importe, evidencia, ledger ni enviar. Una
fuente originalmente de prueba nunca se promueve a COMMERCIAL. RestaurarGENUINE
usa el reconocimiento nativo retenido y el ledger exacto, sin recuperar un asset
borrado. Un comprobante sin contribución sigue sin producir ingreso.024 recalcula
los resultados por la clasificación actual; no se reescriben cantidades históricas.

El lector verifica el ledger, las imágenes base y cada versión añadida mediante
recibos de corrección. Drift, fecha vencida, hueco de historia o nuevo pedido
rechazan. Una clasificación financiera distinta del estado resuelto queda como
CORRECTED_REQUIRES_RECONCILIATION; no autoriza otro cierre, entrega ni eliminación
adicional. Volver exactamente a la clasificación resuelta permite acreditar ese
mismo hecho histórico mientras siga vigente, sin crear prueba nueva.

OwnerNOLOGIN/NOBYPASSRLS dedicado, sin membresía runtime, con derechos por columna
para el único cambio. Puertos de captura/confirmación sólo resultados; corrección
sólo automation desde comando; lectura de estado resultados/automation. Todos
los artefactos privados mantienen RLS perfil+REAL y no aceptan writes ordinarios.
Los consumidores comerciales vivos continúan por su ruta histórica.

La cobertura incluye fulfillment y todas sus versiones: sólo IDs técnicos,
release_on, estado y fechas de entrega/lectura. El UUID de asset puede quedar como
referencia; sus bytes, URLs y grant/access_ciphertext nunca permanecen en el mínimo.
Una corrección no usa contenido ni estado del asset como prueba. El guard legado
que impide nuevas referencias a assets RETAINED conserva su fuente exacta pinada,
con una sola excepción: el owner032 cerrado, durante un UPDATE de order/receipt
que conserva todos los campos salvo clase/recibo de decisión, y cuyo hash nuevo
ya está en el recibo de corrección032 de la misma transacción. Cualquier otro rol
o nueva referencia conserva el rechazo histórico. El guard_record mantiene sólo
la identidad técnica UUID/kind; por eso031 conserva tombstones de asset necesarios.

El puerto de corrección usa search_path pg_catalog,public,pg_temp para ejecutar los
triggers históricos con referencias sin schema; la migración rechaza CREATE en
public para los roles runtime/owner032. No modifica esos permisos ni desactiva
triggers. La fixture PostgreSQL instala mínimos y tombstones como simulación
administrativa explícita, para comprobar032; no acredita que031 ya borre datos.
Todos los puertos032 carecen de EXECUTE runtime. La fixture concede sólo los cuatro
puertos a sus roles restringidos como ensamblado sintético;031 hará su adopción
separada bajo el cercado030 y autoridad de job, nunca desde booleanos externos.

La captura inicial debe ocurrir antes de perder el comando canónico de cierre a
90 días;025 solo no contiene el veredicto de todos los pedidos.031 debe imponer
esta dependencia a la purga de logs. Capturas existentes pueden releerse sin ese
comando y conservan el mismo receipt/hash/plazo. Un histórico sin cobertura no se
convierte retrospectivamente en resuelto. El owner032 recibe únicamente EXECUTE
del predicado de lectura retention_context_valid requerido por el trigger legado,
ninguna creación/ejecución de planes ni membresía de mantenimiento.

La extensión fulfillment publica la política pura v7-financial-minimization-2;
las proyecciones order/receipt conservan sus campos y pruebas previas.
