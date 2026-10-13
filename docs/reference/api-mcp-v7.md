# Referencia API y MCP — Commerce OS V7

> Generada por `scripts/api-reference.ts` desde el código (OpenAPI de la app y registro MCP tipado). No se edita a mano: CI falla si difiere del código.

Contenido: `03c3358565849526` · 189 operaciones HTTP en 166 rutas · 40 herramientas MCP (presupuesto 40).

## Herramientas MCP

| Herramienta | Audiencia | Rutas | Permisos | Acciones | Pendientes |
|---|---|---|---|---|---|
| `profile_context` | perfil | `/v2/profile` | `profiles:read` | actual, listar, cambiar | — |
| `home_get` | perfil | `/v2/home` | `home:read` | resumen | — |
| `employees_manage` | perfil | `/v2/employees` | `employees:read`, `employees:write` | listar, invitaciones, invitar, cancelar_invitacion, cambiar_rol, desactivar, consultar_operacion | reenviar_invitacion |
| `integrations_manage` | perfil | `/v2/integrations` | `integrations:read`, `integrations:write` | listar, guardar, validar, rotar, preferencias, activar, desactivar, eliminar | — |
| `api_tokens_manage` | perfil | `/v2/tokens` | `tokens:read`, `tokens:write` | listar, crear, revocar, consultar_operacion | — |
| `products_manage` | perfil | `/v2/products` | `products:read`, `products:write` | listar, leer, crear, editar, archivar, restaurar, dependencias | — |
| `variants_manage` | perfil | `/v2/variants` | `variants:read`, `variants:write` | listar, leer, adoptar, crear, editar, revisar, duplicar, publicar, version, historial, archivar, restaurar, consultar_operacion | — |
| `offers_manage` | perfil | `/v2/variants/{id}/offer` | `offers:read`, `offers:write` | leer, guardar, validar, publicar, historial | — |
| `materials_manage` | perfil | `/v2/materials` | `materials:read`, `materials:write` | listar, leer, iniciar_subida, parte, completar, cancelar, eliminar | — |
| `sales_flows_manage` | perfil | `/v2/variants/{id}/sales-flow` | `flows:read`, `flows:write` | leer, guardar, validar, publicar, historial | — |
| `sellers_manage` | perfil | `/v2/variants/{id}/seller` | `sellers:read`, `sellers:write` | leer, guardar, validar, publicar, historial | — |
| `collections_manage` | perfil | `/v2/variants/{id}/collection` | `collections:read`, `collections:write` | leer, guardar, validar, historial | — |
| `receipt_rules_manage` | perfil | `/v2/payments/policies` | `receipt-rules:read`, `receipt-rules:write` | leer_perfil, leer_variante, guardar_perfil, guardar_variante, consultar_operacion | — |
| `numbers_manage` | perfil | `/v1/numbers` | `numbers:read`, `numbers:write` | listar, leer, crear, impacto_eliminar, eliminar | editar |
| `number_connection_manage` | perfil | `/v1/numbers/{id}/link` | `numbers:read`, `numbers:connect` | estado, conectar, vincular, desconectar, pausar, reanudar | — |
| `number_assignments_manage` | perfil | `/v2/continuity` | `assignments:read`, `assignments:write` | autorizaciones, autorizacion, autorizar, pausar, reanudar, revocar, consultar_operacion, asignar, retirar, impacto, historial, vista_inversa | — |
| `warmup_manage` | perfil | `/v2/continuity/warmup` | `warmup:read`, `warmup:write` | progreso, pausar, reanudar, evidencia | — |
| `conversations_manage` | perfil | `/v1/conversations` | `conversations:read`, `conversations:write` | listar, leer, responder, registrar_acuerdo, cerrar, registrar_baja, tomar_control, liberar_control, pausar, reanudar | asignar_persona, elegir_variante |
| `orders_manage` | perfil | `/v1/orders` | `orders:read`, `orders:write` | listar, leer | corregir_clasificacion, historial |
| `receipts_manage` | perfil | `/v2/receipts` | `receipts:read`, `receipts:review` | listar, leer, archivo, revisar | — |
| `payments_manage` | perfil | `/v2/payments` | `payments:read`, `payments:write`, `payments:export` | opciones, listar, exportar | leer, registrar, conciliar, corregir |
| `remarketing_manage` | perfil | `/v2/variants/{id}/remarketing` | `remarketing:read`, `remarketing:write` | leer, guardar, validar, publicar, historial, resultados, ciclos, previsualizar_reprogramacion, reprogramar | — |
| `campaigns_read` | perfil | `/v2/campaigns` | `campaigns:read`, `integrations:write` | cuentas, resultados, campanas, anuncios, sincronizar_lectura | portafolios |
| `results_read` | perfil | `/v2/results` | `results:read` | opciones, resumen | embudo, series, comparar, exportar |
| `goals_manage` | perfil | `/v2/goals` | `goals:read`, `goals:write` | listar, leer, avance, crear, editar, consultar_operacion | eliminar |
| `number_test_manage` | perfil | `/v2/number-tests` | `tests:read`, `tests:run` | diagnosticar, estimar, crear, leer, ultima, mensaje, seleccionar, avanzar_reloj, continuar, reiniciar, adjuntar, revisar_comprobante, exportar | ejecutar_suite, informe |
| `operations_get` | perfil | `/v2/operations` | `operations:read` | leer_resultado | efectos |
| `alerts_manage` | perfil | `/v2/alerts` | `alerts:read`, `alerts:write` | listar, leer, acusar | configurar_preferencias |
| `help_read` | perfil | `/v2/help` | `help:read` | guia, descargar | receta, referencia |
| `audit_read` | perfil | `/v2/audit` | `audit:read`, `audit:export` | listar, exportar | — |
| `privacy_manage` | perfil | `/v2/privacy` | `privacy:read`, `privacy:write` | — | retencion, guardar_retencion, exportar_contacto, borrar_contacto, leer_resultado |
| `profile_settings_manage` | perfil | `/v2/profile` | `profile:read`, `profile:write` | leer, editar, onboarding, actualizar_onboarding | pausar_operacion, reanudar_operacion |
| `usage_read` | perfil | `/v2/usage` | `usage:read` | conversaciones, numeros, almacenamiento, costo_ia, cuotas | — |
| `account_security_manage` | perfil | `/v2/me/security` | `account:read`, `account:write` | — | leer, sesiones, revocar_sesion, solicitar_cambio_seguro |
| `admin_profiles_manage` | plataforma | `/v2/platform/profiles` | `platform:profiles` | listar, crear, invitar_dueno, suspender, reactivar, limites | exportar, eliminar |
| `admin_capacity_manage` | plataforma | `/v2/platform/capacity` | `platform:capacity` | leer | previsualizar, aplicar, drenar, conciliar |
| `admin_services_read` | plataforma | `/v2/platform/health` | `platform:health` | — | salud, slo, incidentes, colas, backups |
| `admin_recovery_manage` | plataforma | `/v2/platform/recovery` | `platform:recovery` | — | previsualizar, conciliar, restaurar, leer_resultado |
| `admin_releases_read` | plataforma | `/v2/platform/releases` | `platform:releases` | — | actual, historial, verificaciones |
| `admin_audit_read` | plataforma | `/v2/platform/audit` | `platform:audit` | — | listar, exportar, costos |

## Operaciones HTTP

### `/api/auth`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/api/auth/{*}` | autenticado |
| POST | `/api/auth/{*}` | autenticado |

### `/api/version`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/api/version` | público |

### `/health/live`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/health/live` | autenticado |

### `/health/ready`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/health/ready` | autenticado |

### `/healthz/platform`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/healthz/platform` | autenticado |

### `/livez`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/livez` | autenticado |

### `/readyz`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/readyz` | autenticado |

### `/v1/channel-accounts`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/channel-accounts/{id}/qr` | autenticado |
| GET | `/v1/channel-accounts/{id}/session` | autenticado |
| POST | `/v1/channel-accounts/{id}/session/recovery` | autenticado |
| GET | `/v1/channel-accounts/{id}/source-isolation` | autenticado |
| POST | `/v1/channel-accounts/{id}/source-isolation/confirm` | autenticado |

### `/v1/conversations`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/conversations` | autenticado |
| GET | `/v1/conversations/{id}` | autenticado |
| POST | `/v1/conversations/{id}/commands` | autenticado |
| POST | `/v1/conversations/{id}/controls` | autenticado |

### `/v1/me`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/me` | autenticado |

### `/v1/number-capacity`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/number-capacity` | autenticado |
| POST | `/v1/number-capacity` | autenticado |
| GET | `/v1/number-capacity/administration` | autenticado |
| POST | `/v1/number-capacity/administration/{id}` | autenticado |
| GET | `/v1/number-capacity/discrepancies` | autenticado |
| POST | `/v1/number-capacity/inventory` | autenticado |
| POST | `/v1/number-capacity/measurements` | autenticado |
| GET | `/v1/number-capacity/reconciliation` | autenticado |
| POST | `/v1/number-capacity/reconciliation/adopt-legacy` | autenticado |

### `/v1/numbers`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/numbers/{id}/episodes` | autenticado |
| GET | `/v1/numbers/{id}/link` | autenticado |
| POST | `/v1/numbers/{id}/link` | autenticado |
| POST | `/v1/numbers/{id}/pause` | autenticado |
| GET | `/v1/numbers/{id}/preparation` | autenticado |
| GET | `/v1/numbers/{id}/removal` | autenticado |
| POST | `/v1/numbers/{id}/removal` | autenticado |
| GET | `/v1/numbers/overview` | autenticado |
| POST | `/v1/numbers/quick` | autenticado |

### `/v1/openapi.json`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/openapi.json` | autenticado |

### `/v1/orders`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/orders` | autenticado |
| GET | `/v1/orders/{id}` | autenticado |

### `/v1/outbox`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/outbox/{id}` | autenticado |
| POST | `/v1/outbox/{id}/resolve` | autenticado |

### `/v1/readiness`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/readiness` | autenticado |

### `/v1/remarketing-cycles`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/remarketing-cycles` | autenticado |
| POST | `/v1/remarketing-cycles/{id}/reprogram` | autenticado |
| POST | `/v1/remarketing-cycles/{id}/reprogram/preview` | autenticado |

### `/v1/retention`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/retention/policies` | autenticado |
| POST | `/v1/retention/policies` | autenticado |

### `/v1/sales-operations`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/sales-operations/{key}` | autenticado |

### `/v1/service-tokens`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/service-tokens` | autenticado |
| DELETE | `/v1/service-tokens/{id}` | autenticado |

### `/v1/settings`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v1/settings/integrations` | autenticado |
| PUT | `/v1/settings/integrations/{key}` | autenticado |
| POST | `/v1/settings/integrations/{key}/disable` | autenticado |
| GET | `/v1/settings/launch` | autenticado |
| POST | `/v1/settings/launch/switch` | autenticado |
| GET | `/v1/settings/operations` | autenticado |
| PATCH | `/v1/settings/operations` | autenticado |

### `/v1/system`

| Método | Ruta | Acceso |
|---|---|---|
| POST | `/v1/system/controls` | autenticado |
| GET | `/v1/system/status` | autenticado |

### `/v1/warmup`

| Método | Ruta | Acceso |
|---|---|---|
| POST | `/v1/warmup/accounts/{id}/profile-review` | autenticado |

### `/v2/alerts`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/alerts` | autenticado |
| POST | `/v2/alerts/{id}/acknowledge` | autenticado |

### `/v2/audit`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/audit` | autenticado |
| GET | `/v2/audit/export` | autenticado |

### `/v2/campaigns`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/campaigns` | autenticado |
| POST | `/v2/campaigns/sync` | autenticado |

### `/v2/continuity`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/continuity/commercial` | autenticado |
| POST | `/v2/continuity/commercial` | autenticado |
| GET | `/v2/continuity/commercial/{id}` | autenticado |
| POST | `/v2/continuity/commercial/{id}/commands` | autenticado |
| GET | `/v2/continuity/commercial/operations/{id}` | autenticado |
| GET | `/v2/continuity/warmup` | autenticado |
| GET | `/v2/continuity/warmup/{id}` | autenticado |
| POST | `/v2/continuity/warmup/{id}/commands` | autenticado |
| GET | `/v2/continuity/warmup/operations/{id}` | autenticado |

### `/v2/employees`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/employees` | autenticado |
| PATCH | `/v2/employees/{userId}` | autenticado |

### `/v2/goals`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/goals` | autenticado |
| POST | `/v2/goals` | autenticado |
| GET | `/v2/goals/{id}` | autenticado |
| PUT | `/v2/goals/{id}` | autenticado |
| GET | `/v2/goals/{id}/progress` | autenticado |
| GET | `/v2/goals/operations/{id}` | autenticado |

### `/v2/help`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/help` | autenticado |
| GET | `/v2/help/download` | autenticado |

### `/v2/home`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/home` | autenticado |

### `/v2/integrations`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/integrations` | autenticado |
| PUT | `/v2/integrations/ai/{provider}/key` | autenticado |
| POST | `/v2/integrations/ai/{provider}/state` | autenticado |
| PUT | `/v2/integrations/ai/preferences` | autenticado |
| POST | `/v2/integrations/meta/state` | autenticado |
| PUT | `/v2/integrations/meta/token` | autenticado |

### `/v2/invitation-acceptance`

| Método | Ruta | Acceso |
|---|---|---|
| POST | `/v2/invitation-acceptance` | autenticado |
| POST | `/v2/invitation-acceptance/status` | autenticado |

### `/v2/invitation-registration`

| Método | Ruta | Acceso |
|---|---|---|
| POST | `/v2/invitation-registration` | autenticado |

### `/v2/invitations`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/invitations` | autenticado |
| POST | `/v2/invitations` | autenticado |
| POST | `/v2/invitations/{id}/cancel` | autenticado |
| GET | `/v2/invitations/operations/{operationId}` | autenticado |

### `/v2/market`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/market/releases/{id}` | autenticado |

### `/v2/materials`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/materials` | autenticado |
| POST | `/v2/materials` | autenticado |
| GET | `/v2/materials/{id}` | autenticado |
| POST | `/v2/materials/{id}/archive` | autenticado |
| POST | `/v2/materials/{id}/cancel` | autenticado |
| POST | `/v2/materials/{id}/complete` | autenticado |
| GET | `/v2/materials/{id}/content` | autenticado |
| PUT | `/v2/materials/{id}/parts/{n}` | autenticado |

### `/v2/me`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/me` | autenticado |
| POST | `/v2/me/profile-selection` | autenticado |
| GET | `/v2/me/profiles` | autenticado |

### `/v2/number-tests`

| Método | Ruta | Acceso |
|---|---|---|
| POST | `/v2/number-tests` | autenticado |
| GET | `/v2/number-tests/{id}` | autenticado |
| POST | `/v2/number-tests/{id}/actions` | autenticado |
| GET | `/v2/number-tests/{id}/attachments` | autenticado |
| POST | `/v2/number-tests/{id}/attachments` | autenticado |
| GET | `/v2/number-tests/{id}/attachments/{attachment}` | autenticado |
| GET | `/v2/number-tests/{id}/export` | autenticado |
| GET | `/v2/number-tests/{id}/materials/{material}` | autenticado |
| GET | `/v2/number-tests/diagnose` | autenticado |
| POST | `/v2/number-tests/estimate` | autenticado |
| GET | `/v2/number-tests/latest` | autenticado |

### `/v2/number-variants`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/number-variants` | autenticado |
| GET | `/v2/number-variants/{id}/history` | autenticado |

### `/v2/onboarding`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/onboarding` | autenticado |
| PATCH | `/v2/onboarding` | autenticado |

### `/v2/operations`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/operations/{id}` | autenticado |

### `/v2/payments`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/payments` | autenticado |
| GET | `/v2/payments/export` | autenticado |
| GET | `/v2/payments/options` | autenticado |
| GET | `/v2/payments/policies/operations/{id}` | autenticado |
| GET | `/v2/payments/policies/profile` | autenticado |
| PUT | `/v2/payments/policies/profile` | autenticado |
| GET | `/v2/payments/policies/variants/{id}` | autenticado |
| PUT | `/v2/payments/policies/variants/{id}` | autenticado |

### `/v2/platform`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/platform/access` | autenticado |
| GET | `/v2/platform/capacity` | autenticado |
| POST | `/v2/platform/capacity/agent-tokens` | autenticado |
| GET | `/v2/platform/mail` | autenticado |
| PUT | `/v2/platform/mail` | autenticado |
| POST | `/v2/platform/mail/diagnose` | autenticado |
| GET | `/v2/platform/mail/jobs` | autenticado |
| GET | `/v2/platform/profiles` | autenticado |
| POST | `/v2/platform/profiles` | autenticado |
| PATCH | `/v2/platform/profiles/{id}` | autenticado |
| POST | `/v2/platform/profiles/{id}/owner-invitations` | autenticado |
| GET | `/v2/platform/tokens` | autenticado |
| POST | `/v2/platform/tokens` | autenticado |
| POST | `/v2/platform/tokens/{id}/revoke` | autenticado |

### `/v2/products`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/products` | autenticado |
| POST | `/v2/products` | autenticado |
| PATCH | `/v2/products/{id}` | autenticado |
| POST | `/v2/products/{id}/adopt` | autenticado |
| POST | `/v2/products/{id}/archive` | autenticado |
| GET | `/v2/products/{id}/dependencies` | autenticado |
| POST | `/v2/products/{id}/restore` | autenticado |

### `/v2/profile`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/profile` | autenticado |
| PATCH | `/v2/profile` | autenticado |

### `/v2/receipts`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/receipts` | autenticado |
| GET | `/v2/receipts/{id}` | autenticado |
| POST | `/v2/receipts/{id}/decision` | autenticado |
| GET | `/v2/receipts/{id}/document` | autenticado |

### `/v2/results`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/results` | autenticado |
| GET | `/v2/results/options` | autenticado |

### `/v2/tokens`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/tokens` | autenticado |
| POST | `/v2/tokens/operations` | autenticado |
| GET | `/v2/tokens/operations/{id}` | autenticado |

### `/v2/usage`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/usage` | autenticado |

### `/v2/variant-operations`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/variant-operations/{id}` | autenticado |

### `/v2/variants`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/v2/variants` | autenticado |
| POST | `/v2/variants` | autenticado |
| GET | `/v2/variants/{id}` | autenticado |
| GET | `/v2/variants/{id}/{section}` | autenticado |
| PUT | `/v2/variants/{id}/{section}` | autenticado |
| POST | `/v2/variants/{id}/ai-authorization` | autenticado |
| GET | `/v2/variants/{id}/ai-status` | autenticado |
| POST | `/v2/variants/{id}/archive` | autenticado |
| POST | `/v2/variants/{id}/duplicate` | autenticado |
| GET | `/v2/variants/{id}/history` | autenticado |
| GET | `/v2/variants/{id}/numbers` | autenticado |
| POST | `/v2/variants/{id}/numbers` | autenticado |
| GET | `/v2/variants/{id}/numbers/{account_id}/impact` | autenticado |
| POST | `/v2/variants/{id}/publish` | autenticado |
| GET | `/v2/variants/{id}/remarketing/cycles` | autenticado |
| POST | `/v2/variants/{id}/remarketing/cycles/{cycle}/reprogram` | autenticado |
| POST | `/v2/variants/{id}/remarketing/cycles/{cycle}/reprogram/preview` | autenticado |
| GET | `/v2/variants/{id}/remarketing/results` | autenticado |
| POST | `/v2/variants/{id}/restore` | autenticado |
| POST | `/v2/variants/{id}/review` | autenticado |

