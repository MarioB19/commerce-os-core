# ADR — Interfaz, contexto REAL y laboratorio aislado

Fecha: 2026-09-08. Estado: aceptado para implementación local del cierre operativo.

La aplicación comercial siempre utiliza REAL, sin selector ni preferencia persistida. Se descarta la antigua clave `commerce-environment:<workspace>:<user>`; una URL normal no puede cambiar el contexto. El contexto ausente produce un error explícito. Esto no activa permisos, números ni envío.

Configuración → Pruebas requiere una activación explícita por visita. Dentro del laboratorio se monta un provider SIMULATION con un QueryClient propio y se conservan allí simulador, evaluaciones, detalles y monitor de comandos. Al salir se cancelan consultas, se desmontan borradores y monitor y se destruye su caché. Las claves incluyen workspace y entorno, y los fetch de consulta aceptan AbortSignal. Los eventos del monitor llevan workspace y entorno para impedir mezcla de comandos. Las rutas antiguas llevan al laboratorio inactivo. La selección de un flujo REAL únicamente crea un snapshot SIMULATION por API; no se reutilizan referencias operativas en ejecuciones de ensayo.

Se conservan React, Tailwind, Radix y React Flow. Un sistema de color azul, superficies blancas, bordes fríos, elevación discreta y foco consistente sustituye la paleta verde. Inbox, números y catálogo reciben jerarquía y estados consistentes; el sistema se aplica a las pantallas existentes, incluidas identidad, configuración y módulos planificados. La navegación conserva ventas como módulo y WhatsApp como canal.

Validación: escenarios UI interceptados y sanitizados antes/después, tamaños 1440/1024/768/360/320, teclado/foco, axe, contraste medido y pruebas de contexto limpio/legado/URL/recarga/laboratorio. Ninguna captura ni axe sustituye zoom nativo 200/400 por ciento o revisión humana de lector de pantalla. Las pruebas no usan proveedor ni cambian flags comerciales.

El compositor de Inbox utiliza la autorización vigente del número resuelta por el servidor. La API exige un grant activo no vencido del mismo workspace/entorno, y el worker vuelve a validar configuración, alcance, destinatario, consentimiento y envío habilitado. Se elimina la introducción manual del ID por mensaje conforme al contrato del plan; no se habilita ningún permiso.

Los escenarios E2E antiguos usan un transporte explícito `simulation-fixture-transport.ts`: la petición del navegador declara REAL y el adaptador exclusivo del test la dirige a fixtures SIMULATION de la base aislada. Esa regresión valida interfaz y persistencia sintética, no operación real. La suite `closure-ui.spec.ts` no instala el adaptador: verifica el contrato de entorno original con red interceptada. La evaluación guiada con integración usa un origen REAL de fixture y crea el snapshot por API en Pruebas.

La comprobación responsive detectó un desbordamiento real en el catálogo a 768px: etiquetas `sr-only` posicionadas absolutamente se anclaban fuera de la tabla desplazable. Se anclan al contenedor local. La auditoría del mapa publicado detectó etiquetas ARIA en puntos genéricos; ahora se describen como imágenes de conexión y se conserva la alternativa de edición por teclado en Pasos.

## Dashboard de campañas y carga de consultas — 2026-09-08

Se recupera la jerarquía comprobada en Vibe Marketing/dashboard-wa: balance del periodo, indicadores, tendencia, comparación y ventas verificadas, conservando el sistema azul de Commerce OS. Una etiqueta extraída de una campaña puede organizar el gasto, pero no acredita un producto del catálogo ni el producto vendido. Toda asociación comercial exige su registro explícito y versionado.

El dashboard consulta snapshots persistidos sin polling automático ni refetch al recuperar foco. Los filtros agrupan cambios rápidos; las búsquedas en una tabla ya cargada son locales. Actualizar solicita una sincronización y renueva únicamente las lecturas relacionadas. Los datos previamente cargados siguen visibles ante un fallo de actualización y muestran el error, la fecha del corte y el estado de caché. Los errores 429 no se reintentan automáticamente. Las consultas comunes conservan 30 segundos de frescura y las mutaciones invalidan el workspace y entorno correspondientes. El monitor de comandos conserva su intervalo mientras existe trabajo pendiente.

La sincronización de Insights puede devolver 202. La pantalla sigue exclusivamente ese `job_id` cada 3 segundos mientras está en cola o ejecutándose; respeta `next_attempt_at`, detiene las lecturas ante error y limita el seguimiento automático a 5 minutos, con continuación manual. Al llegar a SYNCED, PARTIAL o UNAVAILABLE renueva el reporte una vez. Salir cancela la consulta y una respuesta tardía no actualiza otra pantalla. El monitor general de comandos también detiene su polling ante 429 y ofrece un reintento explícito.
