# ADR V7 — Política de comprobantes reproducible

Decisión previa, 2026-10-12. Continúa F5 después del registro de pagos. Root reserva transición023 para esta persistencia; 017/022 y el candidato público permanecen bajo sus propietarios.

## Autoridad y versiones

Una política completa del perfil se combina con un override opcional de la variante. Cada campo anidado se reemplaza como unidad; no existen valores implícitos heredados dentro de un override parcial anidado. La resolución fija perfil, entorno, variante, revisiones y hash de la política efectiva. La persistencia023 usará CAS y operaciones idempotentes dentro de la autoridad F2. El pedido nuevo capturará esa política efectiva; cambiar las reglas no reevalúa ni renueva decisiones históricas silenciosamente.

El motor puro recibe evidencia y contexto de repositorios autenticados, no un cuerpo HTTP que pueda declarar sus propias coincidencias, duplicados o clasificación. IA extrae campos; no decide aprobación. La evidencia de entrada es cerrada y acotada. El resultado contiene comprobaciones y razones estables, sin cuentas completas, nombres bancarios sensibles ni texto libre del modelo. Aprobación documental nunca significa verificación bancaria ni permiso de entrega por sí misma.

## Evaluación determinista

Monto exacto, mínimo o tolerancia en unidades menores se evalúan con BigInt a partir de enteros seguros. Moneda ausente siempre requiere revisión; moneda distinta nunca se aprueba. La coincidencia de destino puede exigir cuenta completa o un sufijo de longitud explícita, sin aceptar menos dígitos. Beneficiario/referencia/concepto sólo admiten coincidencia normalizada exacta o contenido literal explícitamente configurado; no se ejecutan expresiones regulares del usuario ni coincidencias difusas.

Las fechas se comparan por día civil en la zona de la variante, incluidos cambios DST. Una fecha sin zona permanece fecha civil; un timestamp con offset se transforma a esa zona. Campos faltantes, contradictorios, ambiguos y confianza inferior al umbral siempre producen Por revisar. Fallos concluyentes pueden producir Rechazado sólo según la política explícita; duplicados permanecen Por revisar y no crean otro ingreso. La clasificación confiable Prueba/Falso prevalece y se conserva fuera de ingresos.

El default conserva aprobación humana. Una política que permite aprobación automática sólo propone Aprobado cuando todas las comprobaciones exigidas pasan. La relectura de permisos, la reserva de revisión, la deduplicación concurrente, las contribuciones y el gate final de entrega pertenecen a persistencia/workers; el motor no realiza I/O ni emite acciones.

## Compatibilidad y cierre

El evaluador histórico se conserva para comprobantes sin snapshot de política023. La migración no transforma su aprobación en un resultado nuevo ni sustituye importes. La integración debe fijar política y versiones al crear el pedido, persistir la evaluación con sus fuentes y conservar CAS/cola de una revisión en el flujo existente. UI/API/MCP deberán presentar la misma regla efectiva y razones.

Este primer bloque del incremento es contrato/motor/pruebas puras. No acredita persistencia023, montaje, extracción con un proveedor real ni revisión bancaria. Esos gates permanecen abiertos hasta ensayos PostgreSQL/HTTP/browser y revisión independiente.

## Persistencia023 preparada

Las cuatro tablas separan cabecera vigente, versiones inmutables, recibos de operación y snapshot del pedido. RLS exige perfil y entorno a la vez; sólo API configura y el worker de automatización puede leer/capturar. Configuración y captura comparten un lock transaccional de perfil/entorno. Las FK compuestas y triggers verifican tipos de versión, hash canónico, herencia real y vínculo pedido→journey→variante. El snapshot exige la versión inicial y el xmin de la transacción actual: ni un pedido histórico que conserva versión1 recibe reglas actuales como si fueran históricas. El replay de una captura devuelve su snapshot antiguo, sin renovar las reglas.

Los cambios de política usan expectedRevision y UUID de operación/actor. Un recibo y la nueva versión se confirman juntos; contenido distinto con el mismo UUID falla. El override vacío vuelve explícitamente a herencia y conserva toda la historia. API preparada usa receipt-rules:read/write y finalauthority de F2; no ejecuta proveedores dentro de la transacción. No hay publicación automática ni evaluación/ingreso/entrega por guardar una política.

## Consumidores preparados y recuperación de escritura

El cliente compartido usa cinco rutas fijas con autoridad cookie de perfil/versión o PAT ligado a un origen seguro. Valida cuerpo cerrado, objetivo, revisión, hash y política efectiva; limita a256KiB y15s sin fallback ni reintento automático. MCP usa ese mismo cliente y conserva redacción.

La vista guarda UUID y cuerpo de configuración en sessionStorage antes del único PUT; no guarda comprobantes, datos bancarios ni credenciales. Perfil/actor/entorno/variante forman la clave persistente, y cualquier cambio de versión/rol remonta el componente. Respuestas tardías no cambian otra vista. Una recarga con pendiente sólo ofrece consultar su recibo. Un404 con código nativo exacto de operación ausente permite reenviar explícitamente el mismo UUID y cuerpo, sujeto otra vez a autoridad/CAS del servidor; errores ambiguos no habilitan esa opción. Ningún envío se repite automáticamente ni se sustituye por un UUID nuevo. El rol viewer puede consultar pero no reenviar.

Validación local:37 pruebas del motor,22 del cliente y7 MCP;15 PostgreSQL/TCP con roles restringidos;12 Chromium con HTTP sintético, incluidos herencia por campo, override vacío, UUID durable antesPUT, recarga, ausencia, pérdida de ACK, cambio de perfil y accesibilidad. Después de PostgreSQL se extrajo el mismo esquema efectivo compartido y se aplicó al parser del snapshot como validación cerrada; ese delta pasa pruebas puras y revisión independiente, sin atribuirlo a la corrida previa.

Este commit deja preparada configuración023 con API/cliente/MCP/vista, sin montaje productivo. El worker aún debe capturar en creación del pedido y persistir la evaluación determinista a partir de extracción y colección autenticadas antes de reutilizar entrega/reconocimiento. Es un gate independiente, no acreditado por el editor ni por sus transportes sintéticos.
