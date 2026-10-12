# ADR V7 — Registro de pagos, revisión y remarketing por variante

Decisión previa, 2026-10-12. Rama aislada desde ba78c05; candidato público y producción conservados. Implementación local por incrementos, sin proveedores, envíos, cambios bancarios ni anuncios reales.

## Alcance y mapa de compuertas

F5 conserva RF08–11/18 completos. El código previo ya contiene contribuciones por comprobante, deduplicación de evidencia/folio, correcciones TEST/FALSE, exclusión de compradores y ciclos de remarketing. Eso no acredita su montaje multiperfil ni operación real. La matriz actual mantiene:

| Bloque | Base reutilizable | Cierre necesario |
| --- | --- | --- |
| Registro RF09.h–k | payment_contributions y proyección F7 | filas/estados/variante, filtros, totales por moneda, CSV/XLSX seguro, UI/API/MCP y conciliación nativa |
| Reglas RF09.a–f | assessReceipt y políticas históricas | herencia perfil/override variante versionados, monto/moneda/destino/fecha/referencia/confianza, revisión reproducible |
| Decisiones RF09.g/l | commands + revisión CAS y clasificación | cinco etiquetas V7, operación consultable, cola de una acción y controles concurrentes |
| Cobro RF08 | snapshot F4 y cobro histórico | preservar referencias/versiones, uno o ambos métodos, migración explícita sin inferir el método usado |
| Remarketing RF10 | ciclos/intentos/cancelación comprador/baja | configuración por variante y horario, consumidores, revisión final antes de emitir y métricas con procedencia |
| Campañas RF11 | Meta lectura y atribución | contexto F2 y conciliación con ingresos; ninguna escritura publicitaria |

No se elimina una función de Inbox/pedidos ni se degrada una compuerta para completar un bloque. Los tests locales no equivalen a instalación ni a envío orgánico.

## Primer incremento: un registro consistente

El lector usa exclusivamente `ProfileExecutor` dentro de `withProfileRequest`; perfil y entorno nunca proceden de la búsqueda. Una sentencia SQL materializa filas, filtros, paginación y totales en la misma instantánea. El entorno por defecto es REAL; SIMULATION permanece disponible sólo a contratos autorizados de prueba. No añade un selector operativo.

Cada fila corresponde a un comprobante, con contribución reconocida cuando exista. Aprobado/Por revisar/Rechazado/Prueba/Falso son una proyección de hechos actuales, no una decisión nueva. FALSE tiene precedencia sobre TEST; TEST se detecta en comprobante, conversación o pedido sin exigir propagación entre ellos. Duplicados permanecen Por revisar salvo decisión explícita y no generan ingreso. `result_payment_facts` de 017 es la única fuente del ingreso de este lector: un estado aprobado sin contribución elegible no inventa dinero. Se excluye además el comprobante TEST explícito, omisión detectada en la vista histórica; 022 adoptará la misma exclusión sin reescribir 017. Se conserva la revisión del comprobante y la identidad de contribución para reconciliar con F7.

Padre/variante/mercado provienen del snapshot inmutable de la conversación. La ausencia de snapshot conserva padre histórico conocido y deja variante/mercado sin dato. La atribución usa la identidad exacta del anuncio y una única coincidencia en metadata del mismo perfil/entorno; ambigüedad produce sin dato. Número/contacto sólo salen enmascarados. El comprobante sale como ID y ruta interna autenticada; nunca storage key, signed URL ni bytes privados. El método usado permanece desconocido cuando sólo se conoce que la variante ofrece varios métodos.

La conservación de dimensiones financieras después de purgar una conversación depende de los snapshots no personales y las vistas compatibles de 022. Este incremento no acredita D18 ni cambia la retención; la combinación debe comprobar también correcciones FALSE/TEST posteriores a la purga antes del montaje.

La suma usa enteros en unidades menores y cadenas decimales para evitar pérdida de precisión en agregados. No convierte monedas. Búsqueda limitada a los campos proyectados públicos/enmascarados; no busca texto del chat ni secretos. Las exportaciones tienen límite explícito de filas y bytes: si se excede, fallan y piden acotar filtros; nunca entregan un archivo parcial como completo.

## CSV y XLSX

Ambos formatos consumen el mismo resultado materializado y muestran los mismos importes y totales por moneda. CSV escapa comillas y neutraliza comienzos de fórmula, incluidos espacios/controles anteriores. XLSX usa celdas `inlineStr`, sin fórmulas, macros, vínculos externos ni autoenlaces; importes y totales se conservan como texto decimal exacto. Se genera un paquete OOXML mínimo y acotado, sin nueva dependencia de ejecución. La [estructura SpreadsheetML](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document) y [semántica de inlineStr](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.cell) se verificaron en documentación primaria Microsoft. Pruebas independientes leerán ZIP/XML y los valores; un nombre de extensión no acredita formato válido.

## Verificación local del primer incremento

El incremento pasó 65 pruebas de contratos/exportación/HTTP/cliente/MCP, 20 PostgreSQL y HTTP reales locales con roles restringidos y Better Auth, y 9 Chromium con accesibilidad. La lectura independiente ZIP/CRC/XML y CSV comprueba valores exactos, fórmulas, Unicode inválido y formatos completos. Typecheck raíz/web y lint focal pasaron. El cliente conserva el orden de opciones producido por PostgreSQL; valida unicidad y cursor sin imponer un orden UTF-16 distinto a su collation, cubierto con regresiones Unicode. Las pruebas nativas aplican 017 y 019 reales, distinguen dos perfiles y entornos, monedas, variantes, TEST/FALSE, duplicados, atribución, autoridad caducada y opciones paginadas. Un caso adicional fija TEST únicamente en receipt, conserva order REAL y su contribución, y exige ingreso cero.

Los intentos originales se conservan: el primero tuvo 13/17 aprobados y permitió corregir dos datos de fixture y el cast UUID/text de la auditoría; después pasaron 17, 19 y finalmente 20 casos según el alcance añadido. El último ensayo conservó exactamente 5 contenedores ajenos (identidad, arranque y reinicios) y 65 volúmenes; sólo retiró su contenedor propio. La evidencia pública sanitizada referencia hashes de los originales privados, sin sesiones ni datos de clientes.

El componente no está montado en producción ni constituye el cierre de F5. Permanecen las reglas heredables, detalle/decisión de comprobantes, cobro y remarketing de la matriz inicial. La combinación con 022 para dimensiones tras purga y con el aislamiento global de 020 debe verificarse antes del montaje. No se copian fuentes mutables ni se amplían permisos generales.
