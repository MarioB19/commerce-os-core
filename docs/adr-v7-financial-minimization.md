# V7 — Minimización financiera de pedidos y comprobantes

Decisión previa,12-oct-2026. Complementa D-18,024,025 y029; Root conserva030.
Este incremento es una transformación pura y cerrada. No borra, no modifica SQL,
no concede autoridad, no empieza ni renueva el plazo financiero de cinco años.

La entrada contiene la imagen actual y TODAS las versiones1..actual del mismo
registro, perfil, entorno REAL y kind order/receipt. Falta, repetición, identidad
incompatible o divergencia de la última imagen bloquea el plan entero. No acepta
un subconjunto como historia completa ni trunca registros. Los límites de memoria
son rechazo, no pérdida silenciosa de versiones.

Se conservan sólo UUID técnicos necesarios para joins, importes minor units y
moneda, clasificación financiera/TEST, duplicado, estado de comprobante, método
de pago, términos numéricos/materiales, fechas estrictas y referencias técnicas
de decisiones financieras.024 ya conserva dimensiones y atribución comerciales;
no se duplican texto, nombres, contacto, teléfono, cuenta de comprador o payloads
configurables. Tampoco sobreviven referencia/concepto/banco del comprobante,
receipt_ai_result, analysis_evidence_ciphertext, prompts, assessment, workflow,
access_ciphertext, URLs, actor, motivos ni texto libre, incluso anidados o en
versiones antiguas. Los identificadores y hashes retenidos son datos técnicos
privados ligados al ledger; no forman parte de agregados públicos anónimos.

Los campos conservados tienen validadores cerrados. Un tipo/enum conocido inválido
bloquea; los campos fuera de la allowlist se eliminan. Los marcadores de prueba
se reducen a is_test=true y clasificación TEST (FALSE tiene prioridad para un
comprobante); no se retienen IDs de sesiones de laboratorio. Los estados financieros
no se recalculan ni acreditan una venta. Los importes ausentes siguen ausentes/null,
y las contribuciones canónicas permanecen en el ledger separado.

La salida incluye cada cuerpo mínimo y hashes de fuente/proyección por versión,
además de un fingerprint del conjunto con identidad. No incluye valores borrados
ni nombres de sus campos: una clave arbitraria también puede contener PII. Los
hashes no son firma ni autorización;030 debe verificar entrada y versiones bajo
sus locks/fences, guardar su manifest autenticado y aplicar todas las imágenes en
la misma transacción con inventario, backup,024 y025. No se debe usar putRecord
ordinario para dejar una nueva versión que conserve el texto antiguo.

029 autentica resolución antes de la purga, sustituyendo sólo logs de90d. Su
verificador actual requiere fuentes actuales y rechaza privacy_erased; no es un
verificador postminimización.030 debe capturar antes el veredicto canónico de
TODOS los pedidos, la cobertura exacta PAYMENT/RECONCILIATION/DELIVERY de029,
closure025, versiones/revisiones del ledger y hashes de este manifest; después
una constancia privada debe ligar esa prueba al estado mínimo instalado. Una
corrección FALSE/TEST, contribución revisada, obligación nueva, reapertura o
fingerprint distinto invalida ese veredicto y requiere conciliación explícita.
Ningún body.status ni un hash suministrado por cliente reemplaza esa captura.

La corrección financiera posterior deberá usar un puerto para registros minimizados:
la restauración GENUINE actual exige asset original y refreshReceiptSale puede
consultar términos de beneficios que ya no se retienen. Este incremento conserva
los datos para recalcular ingreso/estatus con024 y el ledger, pero no afirma que
esas rutas antiguas funcionen tras la purga. No se permiten nuevos envíos ni
reanalizar un documento eliminado. La prueba de composición SQL/lectores/correcciones
y la autoridad postpurga quedan en el protocolo D18, antes de activarlo.

Validación local:41 pruebas unitarias, typecheck raíz y lint PASS; revisión
independiente completa con otras41 pruebas PASS. Casos cubren contenido privado
anidado e histórico, toda la secuencia1..actual, alcance/relación alterados,
TEST/FALSE, importes desconocidos, precisión de fechas, idempotencia, aliases,
getters/ciclos y límite acumulado. No se ejecutó SQL ni PostgreSQL en este incremento.
