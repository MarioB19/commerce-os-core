# Decisiones de auditoría — 2026-09-06

Alcance solicitado: simplificación accesible, QR experimental, Meta oficial de lectura y catálogo API-first. Se conserva React/Vite, Fastify, PostgreSQL, servicios y contratos v1. No se autorizan mensajes, anuncios, campañas, conversiones ni gasto.

## Navegación y formularios (antes de implementar)

Reproducción Chromium contra build local: sidebar fixed sin overflow y flex hijos con mínimo intrínseco. En 1280×720 Ventas, contenido mide 1050 px y botón logout queda en y995–1024, fuera de ventana. Inicio también supera altura (800 px). Capturas y medidas `evidence/ui-audit/before.*`.

Decisión: cabecera/usuario compactos y estables, navegación como única zona de scroll del lateral con min-height:0; ancho controlado común para contenido y sidebar. Contraer conserva enlaces con nombres accesibles y contexto activo; móvil usa drawer modal con foco, Escape y retorno al disparador. Tamaño de texto, wrapping y foco visibles; zoom refluye al drawer.

Inicio prioriza métricas verificables, pendientes y accesos; capacidades futuras en ficha compacta desplegable. Formularios compartidos: errores por campo y resumen enlazado, opciones avanzadas bajo demanda, valores conservados al cerrar/error, bloqueo de doble envío y clave idempotente reutilizada en reintentos del mismo payload. UI consume API v1 existente.

Meta y API-first registran decisiones específicas en documentos separados antes de sus implementaciones. Toda verificación diferencia fixtures, PostgreSQL/local, servicios reales y producción. No desplegar durante esta auditoría sin paquete/revisión final.

## Revisión de comprobantes y análisis concurrente (antes de implementar)

E2E de pago, datos sintéticos: API aceptó `receipt_review` para versión 1 a las 04:39:28.750 UTC. El análisis sin proveedor cambió únicamente su estado a `HUMAN_REQUIRED`, versión 2, a las .846. El worker rechazó la revisión aceptada con `VERSION_CONFLICT` a las .855. La carrera ocurre después del HTTP 202; esperar más polling en el navegador no la resuelve.

Decisión: aceptación de revisión, inicio/final del análisis, recuperación de análisis interrumpido y aplicación de la decisión comparten el bloqueo transaccional por conversación que ya protege pedidos y workflows. Bajo ese bloqueo se relee el comprobante antes de validar su versión. Una revisión humana pendiente reserva el comprobante: análisis/recovery no cambian su evidencia o versión; tampoco sobrescriben una revisión ya aplicada. Sólo se acepta una revisión pendiente por comprobante (la repetición idempotente devuelve su aceptación original). La aplicación conserva `expected_version`, actor, motivo y trazabilidad, y finaliza el análisis como `HUMAN_REVIEWED`.

Un cambio anterior a la aceptación continúa produciendo 409 para que el operador vuelva a revisar la evidencia. No se reintenta una aprobación sobre evidencia nueva, no se autoaprueba, no se concilia ni se habilitan envíos. Se verifica con PostgreSQL aislado y API inject: carrera reproducida, análisis adelantado, revisión duplicada, resultado tardío y recuperación sin invalidar la decisión humana.

Verificación: prueba roja reprodujo `FAILED / VERSION_CONFLICT`; tras el cambio pasan los seis casos nuevos y doce regresiones de automation/roles (18/18), typecheck, lint y diff check. Datos, documentos y proveedor de prueba sintéticos; sin HTTP a la API local ni operaciones externas. Evidencia: `evidence/receipt-review-concurrency.json`. La UI mantiene la evidencia seleccionada; no sustituye silenciosamente la versión aprobada por el operador.

Compatibilidad con comprobantes existentes, antes de corregir: fixture de un comprobante antiguo con `review` y `analysis_status=PENDING`, seguido de otro nuevo, demuestra que el antiguo ocupa indefinidamente un lote de tamaño uno. Decisión: excluir revisiones ya registradas en la consulta de candidatos antes de `LIMIT`, admitiendo `review` ausente o JSON null. Se conserva la comprobación transaccional para cambios posteriores a la selección. No se modifica el comprobante legado ni se vuelve a analizar su evidencia.

Verificación de compatibilidad: el nuevo caso falló con el recibo nuevo aún `PENDING` antes del filtro. Tras corregir, pasan 7/7 casos de revisión/concurrencia, typecheck completo, lint de archivos afectados y diff check. El comprobante legado conserva su versión; los nuevos avanzan con lote de tamaño uno.
