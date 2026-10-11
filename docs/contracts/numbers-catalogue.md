# Catálogo registrado de Números y calentamientos

Generado por `scripts/export-numbers-contracts.ts` desde el catálogo registrado y `/v1/openapi.json`. No contiene tokens, QR ni datos de cuentas. El JSON OpenAPI conserva los esquemas comunes; el catálogo MCP contiene los inputSchema completos.

| Acción | Endpoint | Herramienta registrada | Scope de servicio | Efecto |
|---|---|---|---|---|
| Historial de preparación | GET /v1/numbers/{id}/episodes | `number_episodes_list` | channels:read | Lectura |
| Operaciones del administrador acotado | GET /v1/number-capacity/administration | `number_capacity_administration_list` | channels:capacity:agent | Lectura |
| Claim o readback de capacidad | POST /v1/number-capacity/administration/{id} | `number_capacity_administration_command` | channels:capacity:agent | Intención versionada; revisar descripción del contrato |
| Registrar medición del host | POST /v1/number-capacity/measurements | `number_capacity_measurement` | channels:capacity:agent | Intención versionada; revisar descripción del contrato |
| Registrar inventario observado | POST /v1/number-capacity/inventory | `number_capacity_inventory` | channels:capacity:agent | Intención versionada; revisar descripción del contrato |
| Mis números | GET /v1/numbers | `numbers_list` | channels:read | Lectura |
| Detalle de número | GET /v1/numbers/{id} | `number_get` | channels:read | Lectura |
| Preparar nuevo número | POST /v1/numbers | `number_create` | channels:manage | Intención versionada; revisar descripción del contrato |
| Editar número | PATCH /v1/numbers/{id} | `number_edit` | channels:manage | Intención versionada; revisar descripción del contrato |
| Retirar número conservando historial | DELETE /v1/channel-accounts/{id} | `number_retire` | channels:manage | Intención versionada; revisar descripción del contrato |
| Lote de hasta veinte números | POST /v1/numbers/batch | `numbers_batch` | channels:manage | Intención versionada; revisar descripción del contrato |
| Reanudar consulta durable | POST /v1/number-operations/{id}/commands | `number_operation_command` | channels:manage | Intención versionada; revisar descripción del contrato |
| Consultar operación durable | GET /v1/number-operations/{id} | `number_operation_get` | channels:read | Lectura |
| Releer identidad conectada | POST /v1/numbers/{id}/observe-identity | `number_identity_observe` | channels:manage | Intención versionada; revisar descripción del contrato |
| Confirmar propiedad del número detectado | POST /v1/numbers/{id}/confirm-identity | `number_identity_confirm` | channels:manage | Intención versionada; revisar descripción del contrato |
| Acceso humano a vinculación QR | POST /v1/numbers/{id}/link-access | `number_link_access` | channels:manage | Intención versionada; revisar descripción del contrato |
| Progreso automático | GET /v1/numbers/{id}/preparation | `number_preparation_get` | channels:read | Lectura |
| Gestionar preparación y migración | POST /v1/numbers/{id}/preparation | `number_preparation_command` | channels:manage | Intención versionada; revisar descripción del contrato |
| Política automática de quince días | GET /v1/number-policy | `number_policy_get` | warmup:read | Lectura |
| Consultar grupos propios existentes | GET /v1/number-groups | `number_groups_list` | warmup:read | Lectura |
| Actualizar observación de grupos | POST /v1/number-groups/refresh | `number_groups_refresh` | warmup:manage | Intención versionada; revisar descripción del contrato |
| Consultar calentamientos | GET /v1/number-programs | `number_programs_list` | warmup:read | Lectura |
| Leer instancia y planes | GET /v1/number-programs/{id} | `number_program_get` | warmup:read | Lectura |
| Guardar borrador de calentamiento | POST /v1/number-programs | `number_program_create` | warmup:manage | Intención versionada; revisar descripción del contrato |
| Editar borrador | PATCH /v1/number-programs/{id} | `number_program_edit` | warmup:manage | Intención versionada; revisar descripción del contrato |
| Preflight y cobertura | GET /v1/number-programs/{id}/preview | `number_program_preview` | warmup:read | Lectura |
| Revisar, autorizar y gestionar instancia | POST /v1/number-programs/{id}/commands | `number_program_command` | review: warmup:manage; authorize: warmup:activate; activate: warmup:activate; pause: warmup:manage; resume: warmup:activate; cancel: warmup:manage; archive: warmup:manage; restore: warmup:manage; revoke: warmup:manage | Intención versionada; revisar descripción del contrato |
| Evidencia de instancia | GET /v1/number-programs/{id}/evidence | `number_program_evidence` | warmup:read | Lectura |
| Biblioteca editable | GET /v1/number-library | `number_library_list` | warmup:read | Lectura |
| Preparar biblioteca inicial | POST /v1/number-library/seed | `number_library_seed` | warmup:manage | Intención versionada; revisar descripción del contrato |
| Crear conversación de prueba | POST /v1/number-library | `number_library_create` | warmup:manage | Intención versionada; revisar descripción del contrato |
| Editar conversación de prueba | PATCH /v1/number-library/{id} | `number_library_edit` | warmup:manage | Intención versionada; revisar descripción del contrato |
| Aprobar contenido concreto | POST /v1/number-library/{id}/approve | `number_library_approve` | warmup:activate | Intención versionada; revisar descripción del contrato |
| Capacidad e inventario de workers | GET /v1/number-capacity | `number_capacity_get` | channels:read | Lectura |
| Preparar y ampliar capacidad | POST /v1/number-capacity | `number_capacity_command` | preview: channels:read; prepare: channels:capacity; expand: channels:capacity; drain: channels:capacity | Intención versionada; revisar descripción del contrato |
| Leer laboratorio de números | GET /v1/number-simulation | `number_simulation_get` | warmup:simulate | Lectura |
| Controlar reloj de laboratorio | POST /v1/number-simulation | `number_simulation_clock` | warmup:simulate | Intención versionada; revisar descripción del contrato |
| Configurar grupo del adaptador sin red | POST /v1/number-simulation/groups | `number_simulation_group` | warmup:simulate | Intención versionada; revisar descripción del contrato |
| Probar flujo de un número | POST /v1/channel-accounts/{id}/flow-tests | `number_flow_test_start` | simulations:run, channels:read, assignments:read, workflows:read, products:read | Intención versionada; revisar descripción del contrato |
| Recuperar última prueba del número | GET /v1/channel-accounts/{id}/flow-tests/latest | `number_flow_test_latest` | simulations:run, channels:read, assignments:read, workflows:read, products:read | Lectura |
| Leer prueba de flujo | GET /v1/number-flow-tests/{id} | `number_flow_test_get` | simulations:run, channels:read, assignments:read, workflows:read, products:read | Lectura |
| Actuar en prueba de flujo | POST /v1/number-flow-tests/{id}/actions | `number_flow_test_action` | simulations:run, channels:read, assignments:read, workflows:read, products:read | Intención versionada; revisar descripción del contrato |
| Reiniciar prueba de flujo | POST /v1/number-flow-tests/{id}/reset | `number_flow_test_reset` | simulations:run, channels:read, assignments:read, workflows:read, products:read | Intención versionada; revisar descripción del contrato |

## Capacidades existentes reutilizadas

[Esquemas registrados completos](numbers-reused-mcp-tools.json). Los endpoints de acciones variables conservan el contrato de la herramienta; la matriz de entrega enumera permisos, efectos y pruebas.

| Capacidad | Herramienta | Ruta de ejemplo |
|---|---|---|
| Consultar continuidad de sesión | `channel_session_get` | GET /v1/channel-accounts/{id}/session |
| Configurar continuidad y principal | `channel_session_configure` | PATCH /v1/channel-accounts/{id}/session |
| Registrar uso humano del principal | `channel_primary_usage` | POST /v1/channel-accounts/{id}/primary-usage |
| Gestionar recuperación de cuenta | `channel_session_recovery` | POST /v1/channel-accounts/{id}/session/recovery |
| Solicitar control de sesión | `channel_command` | POST /v1/channel-accounts/{id}/commands |
| Consultar resultado durable de comando | `command_get` | GET /v1/commands/{id} |
| Números y productos actuales | `channel_inventory` | GET /v1/channel-inventory |
| Salud explicable por capacidad | `channel_health` | GET /v1/channel-accounts/{id}/health |
| Consultar asignaciones independientes | `assignments_list` | GET /v1/assignments |
| Aplicar mapeo elegido | `assignments_apply` | POST /v1/assignments/batch |
| Consultar o retirar una relación | `assignment_transition` | GET /v1/assignments/{id}/preflight |
| Autorizar alcance comercial concreto | `assignment_authorize` | POST /v1/assignments/{id}/authorize |
| Preparación del producto | `product_configuration` | GET /v1/products/{id}/configuration |
| Guardar perfil cifrado | `integration_save` | PUT /v1/settings/integrations/waha%3A%7Bgateway%7D |
| Configuración y pruebas por perfil | `integration_profiles` | GET /v1/integration-profiles |

Validación de registro y transporte: `tests/integration/numbers-mcp-stdio.test.ts`. HTTP/roles/recuperación: `numbers-groups.test.ts`, `number-capacity-administration.test.ts`, `numbers-policy-migration.test.ts`, `numbers-worker-restart.test.ts`. La [matriz de evidencia](../numbers-delivery.md) distingue cobertura de contrato y recorridos ejecutados.

[OpenAPI](numbers-openapi.json) · [Esquemas MCP](numbers-mcp-tools.json) · [Guía de operación](../numbers-operations.md).
