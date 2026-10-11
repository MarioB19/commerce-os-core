# Operación por producto V5

Fecha: 2026-09-13. Implementación y evidencia local; la publicación y los proveedores físicos se verifican por separado. Decisión: [asignaciones y chat compartido](adr-v5-product-routing.md).

## Contrato API y MCP

Todas las rutas usan workspace de la credencial y `environment` explícito. Mutaciones llevan `Idempotency-Key`; las revisiones se vuelven a leer antes de operar.

| Operación | API | MCP |
|---|---|---|
| Preparación integral | `GET /v1/products/:id/configuration` | `product_configuration` |
| Inventario de números | `GET /v1/channel-inventory?product_id=...` | `channel_inventory` |
| Leer relaciones | `GET /v1/assignments?product_id=...` | `assignments_list` |
| Guardar relación | `POST /v1/assignments` | `assignments_apply` (un elemento) |
| Aplicar selección por lote | `POST /v1/assignments/batch` | `assignments_apply` |
| Historial | `GET /v1/assignments/:id/history` | `assignment_transition` (action: history) |
| Retirar/restaurar/montar | `POST /v1/assignments/:id/retire`, `/restore`, `/activate` | `assignment_transition` |
| Preparación del vínculo | `GET /v1/assignments/:id/preflight` | `assignment_transition` (action: preflight) |
| Elegir producto de un chat | `POST /v1/conversations/:id/select-product` | `conversation_select_product` |
| Revisar dependencias | `GET /v1/workflows/:id/dependencies`, `/agents/:id/dependencies` | `resource_dependencies` |
| Evaluación aislada | `POST /v1/workflows/:id/evaluate` | `workflow_evaluate` |
| Resultados/costos | `GET /v1/reports/summary`, `GET /v1/costs` | `results_summary`, `costs_summary` |

Una asignación acepta `account_id`, `product_id`, `offer_version_id`, `workflow_version_id`, vendedor opcional, `entry_rules`, vigencia, motivo y `expected_version`. Una pareja nueva empieza con expected_version 0. Las reglas son `keyword`, `link`, `ad`, `campaign` con valor exacto reconocido; ad/campaign deben existir en el workspace. Cada cambio crea binding inmutable y sube únicamente la revisión de esa pareja. El lote admite 50 relaciones; un fallo devuelve 207 y resultado por pareja, y repetir misma clave+cuerpo devuelve el mismo resultado sin duplicar. Las relaciones omitidas permanecen intactas.

`restore` produce DRAFT y no rutea entradas. `activate` monta explícitamente la configuración restaurada sin autorizar envíos. `authorization_registered` y `authorization_status` describen permiso registrado y su caducidad; `sending_authorized` no se deduce de ese dato. Preflight y despacho vuelven a validar identidad, versiones, controles y proveedor. `/authorize` exige scope independiente `assignments:authorize`, límites y confirmación; no forma parte de preparar catálogo.

Un número/contacto tiene un chat físico; cada producto conserva su recorrido, vendedor, oferta, orden y evidencia. Respuestas a mensajes conocidos conservan el recorrido original. Evidencia contradictoria o pagos/aceptaciones sin contexto entre varios pedidos producen `PRODUCT_SELECTION_REQUIRED`/`ORDER_CONTEXT_REQUIRED`, sin vendedor ni orden nuevos. El turno y SENDING/UNKNOWN se comparten por chat. Baja del contacto cancela intenciones y seguimientos de sus productos; nunca borra el envío incierto ni la entrega histórica.

Retirar un flujo/vendedor exige resolver referencias de configuración, leer `dependency_hash` y, cuando haya recorridos abiertos, `existing_policy: handoff`. La API cancela timers e intenciones sin intento y encola la transferencia al worker; no escribe estados comerciales fuera de su rol de base de datos. Restaurar recursos no reanuda esos trabajos.

UI: `/catalog?product=<id>&tab=numbers`, `tab=flows`, `tab=sellers`, `tab=tests`, `tab=results`. Las pantallas generales de números, flujos y vendedores siguen accesibles.

## Evidencia de integración

| Matriz | Resultado local comprobado | Evidencia |
|---|---|---|
| A/B × número1/número2 | Cuatro relaciones, publicación y readback; replay sin duplicado; lote parcial conserva las otras parejas | `v5-launch-api-mcp.test.ts`, `v5-product-routing.test.ts` |
| Mismo contacto/mismo número | Dos recorridos y dos pedidos con importes/vendedores propios | `v5-product-routing.test.ts` |
| UUID arbitrario, pago genérico, señales contradictorias | Sin producto seleccionado ni ejecución comercial | mismo test |
| Respuesta antigua/mensaje tardío | Atribución histórica conservada, sin respuesta nueva por evento tardío | mismo test |
| UNKNOWN en producto A | Bloquea despacho comercial B en el chat compartido | mismo test |
| Retiro/restauración B | A permanece; B restaura DRAFT; permisos/timers no reviven | mismo test |
| Carrera retiro vs asignación | Sólo una operación incompatible se confirma | mismo test |
| Recibos A/B | Contribución al pedido correcto; evidencia reutilizada entre productos rechazada | mismo test |
| Baja global | Timers/intenciones A/B cancelados; UNKNOWN preservado | mismo test |
| Roles PostgreSQL | API configura, automation materializa, channel consulta; workers no cambian estado del vínculo | mismo test |
| Migración poblada | Historial/snapshots preservados; permisos globales antiguos revocados | `v5-assignment-migration.test.ts` |
| API/MCP completo | SDK MCP real en transporte InMemory y HTTP→app.inject; token dedicado; sin Inteligencia, efectos ni red externa | `v5-launch-api-mcp.test.ts` |
| Simulación/ingreso | Órdenes TEST desde creación, contribuciones visibles de ensayo y cero ingreso comercial | `sales-journey.test.ts` |
| Costos | Monedas/estimaciones/desconocidos separados, dedup de batches y scopes por producto | `v5-costs.test.ts` |

Los fixtures son sintéticos y PostgreSQL aislado. La prueba MCP usa SDK y handlers reales, pero no acredita instalación stdio del usuario, nube, WhatsApp físico ni un lanzamiento comercial REAL.

## Costos y cobertura

`/v1/costs?product_id=...&conversation_id=...` requiere `reports:read`. La conversación debe pertenecer al producto. Credenciales con allowlist deben proporcionar un producto autorizado. El reporte reúne `ai_run`, operaciones persistidas de Inteligencia y diagnósticos; el mismo provider operation referenciado por análisis y batch cuenta una sola vez. Un análisis sólo entra al producto si tiene relación explícita `analysis_scope.product_id`; los diagnósticos son globales.

Los importes confirmado, estimado y reservado pueden describir la misma operación: no se suman entre sí. UNKNOWN conserva reserva. `currency:null`, unidad MINOR, significa que la tarifa histórica no identifica moneda; no se convierte ni agrega a USD. Usage reconocido sigue siendo cálculo por tarifa, no factura conciliada. Ausencia de registros no demuestra costo cero de operaciones no instrumentadas.

## Migración y recuperación

0040 es aditiva: materializa vínculos demostrables, conserva bindings/versiones y fija contexto solamente cuando coincide exactamente. No borra registros históricos. Se revocan autorizaciones legacy `channel_setup`; requieren autorización nueva por relación. No utilizar rollback de código que desconozca chat compartido/assignments después de operar V5. Ante un incidente, mantener política congelada, conservar backup y ledger y corregir con migración hacia delante; nunca reactivar timers o UNKNOWN como parte de restaurar.

Credenciales: [bootstrap privado V5](v5-credential-bootstrap.md). Publicación: [CI/CD](ci-cd.md).
