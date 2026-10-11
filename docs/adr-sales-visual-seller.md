# ADR · Ventas, editor y vendedor — 07-sep-2026 UTC

Decisión previa a implementación H0–H5. Rama `codex/sales-visual-seller`, worktree independiente en `~/.local/share/commerce-os-worktrees/sales-visual-seller`, base `0a53310` (`origin/main`, incluye `6e62fc4` y receipt_sales_v1). Se conserva sin tocar el árbol principal con documentación sin commit. `codex/channel-lifecycle-controls` / `ed88f92` es un incremento independiente, no integrado aquí. No hay push, despliegue, QR ni acciones comerciales autorizadas en esta tarea.

## Contratos

- Un único grafo declarativo; React Flow representa `next` y `branches`, con metadatos opcionales `editor` v1 (posiciones/etiquetas). Posición y orden del arreglo no cambian ejecución. Mapa y Pasos comparten estado y comandos reversibles. JSON avanzado es progresivo.
- PATCH de borrador valida estructura, tipos, límites y referencias presentes, permite conexiones/campos pendientes; validación completa antes de publicar o evaluar/ejecutar. Revisión esperada protege actualizaciones. Publicaciones siguen siendo IDs inmutables, con linaje. Autoguardado a API, sin contenido en localStorage; protección de navegación y conflictos explícitos.
- Catálogo compartido: categoría opcional, fuentes estructuradas de producto/categoría versionadas mediante `record_versions`. Agentes forman familia con revisiones inmutables; editar no reasigna conversaciones. Migración 0020 aditiva para integridad de referencias nuevas.
- Resolver asignación en una función compartida: vínculo → oferta → número → producto → workflow (sólo fallback nuevo). Una referencia de nodo IA no sustituye al agente efectivo. Conversación conserva origen y snapshot acotado/saneado de oferta, producto, categoría y agente al comenzar. Historial de hasta 12 mensajes / 6000 caracteres, sin payloads privados, medios ni datos bancarios. Fuentes citadas se validan contra contexto; citas válidas no prueban por sí solas exactitud semántica.
- El flujo tiene prioridad por mensaje; consume respuestas esperadas y genera sus efectos una vez. Vendedor atiende preguntas durante esperas permitidas, o el nodo IA; no opera tras takeover/pausa/baja/revisión humana ni declara compromiso o pago por inferencia. Descartar resultados obsoletos por secuencia/control/configuración. Preservar ingreso por comprobante, Prueba/Falso y entrega idempotente.
- Evaluación aislada en registros propios, sin conversaciones comerciales/outbox/timers comerciales. Toma snapshot inmutable de borrador validado y subflujos publicados, contexto compartido con runtime y reloj virtual. Endpoint de turnos usa revisión esperada/idempotencia. Doble determinista explícito por defecto. Evaluación externa queda deshabilitada sin permiso/configuración/presupuesto; `SIMULATION_EXTERNAL_AI_DENIED` permanece intacto. No medir calidad real de proveedor con fixtures.

## Verificación y límites

Batería del repositorio, regresiones de comprobantes, nuevos casos de grafo/contexto/API/E2E y recuperación. QA visual responsive, teclado, alternativa al arrastre y axe; distinguir pruebas automatizadas de revisión de lector de pantalla/zoom nativo. Base y puertos privados propios; nunca detener servidores ajenos. Preescolar: sólo condiciones documentadas en `preschool-launch.md` y receta local; segundo producto explícitamente ficticio. Estado final y pendientes en `sales-visual-seller.md`.


## Precisiones verificadas durante implementación

Conversaciones heredadas recuperan producto/categoría con `record_versions.created_at <= conversation.created_at`, sin incorporar hechos posteriores. Handoff/error guarda `ai_review_resume_state`; aprobar devuelve a la espera pendiente y conserva temporizadores. Un nodo IA pendiente vuelve a esperar una entrada del cliente. El descarte tardío también compara etapa y estado del flujo. La evaluación usa `evaluationFlow` para copiar únicamente parámetros permitidos; el original completo sigue en catálogo.

React Flow fijado en 12.11.6 con sus peers existentes React 19; las versiones transitivas quedan en pnpm-lock. Zoom nativo se verifica mediante una extensión efímera aislada de Chromium y getZoom, sin cambiar el perfil del usuario. La escucha con lector de pantalla requiere una revisión humana explícitamente pendiente. El entregable no modifica el pipeline ni publica nada; defaults de puertos permanecen compatibles con CI.

La evaluación reproduce también la aprobación de comprobante durante una espera de cobro y conserva materiales distintos con referencias sintéticas, sin exponer IDs de archivos. Compromiso/aprobación aplican las reglas de entrega de la oferta una sola vez; volver a pasar por un nodo no duplica esas entregas ficticias. Casos cubiertos en seller-context.test.ts.
