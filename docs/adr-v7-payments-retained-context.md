# V7 — Dimensiones de pagos después del borrado de conversación

Decisión previa, 12-oct-2026. El registro, sus opciones y ambos exportes usan la
misma consulta. Para una conversación viva prevalecen las fuentes vivas y el
snapshot F4; la existencia de una captura financiera no cambia esa lectura.
Sólo `privacy_erased=true` selecciona las dimensiones no personales del contexto
inmutable024: familia, variante, mercado, número como ID, campaña y anuncio.
Cada vínculo repite perfil, entorno y conversación. Si falta el contexto, las
dimensiones permanecen desconocidas; no se reconstruyen desde payloads retenidos.

Tras el stub se omiten máscaras de contacto/número y acceso al comprobante,
aunque el fixture conserve filas viejas. El nombre de producto puede resolverse
desde el catálogo empresarial por el ID de familia retenido. Los importes y
correcciones FALSE/TEST continúan en el ledger financiero y la vista canónica
`result_payment_facts`; la reserva IA nunca se convierte en ingreso.

La zona del filtro sigue siendo la zona actual del perfil, como declara el
contrato del registro. El calendario de cohortes F7 conserva su propia zona
capturada; este cambio no altera ese contrato ni reemplaza024/025/026. La lectura
liga el GUC de entorno mediante el helper canónico dentro de una transacción ya
autorizada, sin cambiar un entorno establecido ni conceder identidad.

Pruebas previstas: PostgreSQL con roles restringidos, captura024 real y stub
explícito, prioridad de fuente viva, filtros/opciones/exportes con dimensiones
retenidas, correcciones financieras y rechazo de contexto cruzado. El stub de
fixture acredita la independencia de lectura; no representa borrado productivo,
montaje ni ejecución del protocolo completo de privacidad.

Validación local final: 66 focales,26 PostgreSQL/TCP, tipos y lint PASS.
La revisión independiente cubrió el diff completo y ejecutó66 focales. El primer
ensayo24/26 queda conservado; las dos correcciones fueron datos de fixture bajo
constraints canónicas. Inventario ajeno5 contenedores/65 volúmenes exacto.
