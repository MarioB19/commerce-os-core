# ADR V7 — Extracción documental con admisión019

Decisión previa,12-oct-2026. El pedido que declara snapshot023 nunca pasa a un
proveedor histórico por ausencia de configuración nueva. Su extracción debe
usar el cliente RF14 con reserva, INTENT confirmado antes de red y conciliación
de uso019. Una key verificada y un grant explícito para la variante y tarea
receipt.document son requisitos; no se seleccionan credenciales de variables
de entorno, del vendedor ni del texto del comprobante.

La orquestación vive dentro de WorkerScope sin transacción SQL exterior. Cada
fase PREPARE, comprobación final y RECONCILE abre y confirma su propia transacción
autorizada. PREPARE fija recibo, pedido, conversación, variante, asset/hash y un
UUID estable de intento; la red ocurre sólo después de salir de la fase. Un
asset cambia de bytes o desaparece: se cierra el intento local sin transmitir.
El archivo privado se recibe por un broker de medios acotado y se valida contra
el hash capturado; sólo vive en RAM durante la llamada.

El modelo y su precio se leen del grant/catálogo protegido. El proveedor se llama
una vez por UUID mediante PostgresAiPorts. No se usa fallback tras fallo, ni se
libera presupuesto por timeout/respuesta desconocida. Campos ausentes de la
extracción se conservan como desconocidos. El prompt pide evidencia documental
cerrada y no incluye cuentas esperadas ni permiso de aprobación;023 decide.

Una respuesta correcta se cifra antes de conservarse para la fase de política.
Si una pausa llega después de la red, se conserva la respuesta pendiente y no se
pide otra. Lost ACK del ledger o del almacenamiento no autoriza reenviar; una
fila RUNNING que quedó sin resultado exige conciliación humana. Sólo una
respuesta cuyo intento019 y vínculo original siguen exactos puede continuar
hacia applyReceiptAnalysis; esa función conserva los gates financieros/entrega.

La validación local debe cubrir INTENT antes del POST por TCP, costes y tokens
medidos, pérdida de ACK, key/grant/perfil cambiado, media corrupta, ausencia de
configuración, pausa reversible y reanudación sin segundo POST. Los transportes
sintéticos no acreditan OCR con un proveedor real ni montaje productivo.

La factoría del host recibe únicamente el documento autenticado dentro de
PREPARE y devuelve un adaptador de grant fijo; su ID se conserva con el claim.
La comprobación comercial confirma primero su COMMIT; después019 revalida
perfil, grant, revisión de key, modelo y vigencia al confirmar INTENT como última
fase antes del POST. No se repite INTENT y no hay I/O entre ese COMMIT y la red.
Los dos pools no forman una transacción atómica: la lectura comercial pertenece
a la fase anterior y una pausa posterior sigue la frontera normal de autoridad. Un error posterior a PREPARE conserva el intento y
expone `RECEIPT_AI_RECONCILE_REQUIRED`; si el caché ya quedó confirmado, se
conserva AWAITING_POLICY. Un caché ausente o cambiado no crea otra llamada.
El punto de entrada histórico detecta tanto el pin del pedido como su snapshot
023 y se detiene antes de adquirir archivos o proveedor. Montar el runtime nuevo
requiere además un broker de medios y una factoría autenticados por el host;
este incremento no inventa esa configuración ni activa un proveedor real.
