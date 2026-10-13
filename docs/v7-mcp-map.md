# Mapa MCP V7: 121 herramientas anteriores → registro V7

Generado en F8 (RF-15.b, RNF-05.a/b). Fuente anterior: `apps/commerce-mcp/src/server.ts` y `numbers.ts` (servidor de token de servicio, 121 herramientas), retirados en F8. Destino: el registro compuesto de `packages/contracts/src/mcp-registry.ts`, servido por `apps/commerce-mcp/src/index.ts` sólo con token personal de perfil (`cos_pat_`) o de plataforma (`cos_plt_`). Cualquier otro token se rechaza con `MCP_PROFILE_TOKEN_REQUIRED` antes de registrar herramientas.

## Conteo

| Medida | Antes | Después |
|---|---|---|
| Herramientas vivas con token de servicio | 121 | 0 |
| Herramientas de perfil (`cos_pat_`) | 30 | 32 |
| Herramientas de plataforma (`cos_plt_`) | 2 | 2 |
| Total vivo | 153 | 34 |
| Presupuesto del registro | 40 | 40 |

Reducción frente a las 121 anteriores: 71.9 %. Las 6 herramientas del registro sin acciones servidas (`privacy_manage`, `account_security_manage`, `admin_services_read`, `admin_recovery_manage`, `admin_releases_read`, `admin_audit_read`) no se anuncian hasta tener API; sus acciones siguen declaradas como pendientes en el registro.

Tratamiento de las 121: 62 sustituidas por una acción V7, 3 pasan a acción humana en la aplicación (mismo resultado en UI, API y MCP), 47 retiradas sin sustituto comercial y 9 con la acción V7 aún pendiente.

## Herramientas V7 servidas

| Herramienta | Público | Acciones |
|---|---|---|
| `profile_context` | perfil | actual, listar, cambiar |
| `profile_settings_manage` | perfil | leer, editar, onboarding, actualizar_onboarding |
| `employees_manage` | perfil | listar, invitaciones, invitar, cancelar_invitacion, cambiar_rol, desactivar, consultar_operacion |
| `api_tokens_manage` | perfil | listar, crear, revocar, consultar_operacion |
| `integrations_manage` | perfil | listar, guardar, rotar, validar, preferencias, activar, desactivar, eliminar |
| `products_manage` | perfil | listar, leer, crear, editar, archivar, restaurar, dependencias |
| `materials_manage` | perfil | listar, leer, iniciar_subida, parte, completar, cancelar, eliminar |
| `variants_manage` | perfil | listar, leer, adoptar, crear, editar, revisar, duplicar, publicar, version, historial, archivar, restaurar, consultar_operacion |
| `offers_manage` | perfil | leer, guardar, validar, publicar, historial |
| `sales_flows_manage` | perfil | leer, guardar, validar, publicar, historial |
| `sellers_manage` | perfil | leer, guardar, validar, publicar, historial |
| `remarketing_manage` | perfil | leer, guardar, validar, publicar, historial, resultados, ciclos, previsualizar_reprogramacion, reprogramar |
| `collections_manage` | perfil | leer, guardar, validar, historial |
| `receipt_rules_manage` | perfil | guardar_perfil, guardar_variante, leer_perfil, leer_variante, consultar_operacion |
| `conversations_manage` | perfil | listar, leer, responder, registrar_acuerdo, cerrar, registrar_baja, tomar_control, liberar_control, pausar, reanudar |
| `orders_manage` | perfil | listar, leer |
| `receipts_manage` | perfil | listar, leer, archivo, revisar |
| `number_test_manage` | perfil | diagnosticar, estimar, crear, leer, ultima, mensaje, seleccionar, avanzar_reloj, continuar, reiniciar, adjuntar, revisar_comprobante, exportar, estimar_suite, ejecutar_suite, informe |
| `campaigns_read` | perfil | cuentas, resultados, campanas, anuncios, sincronizar_lectura |
| `payments_manage` | perfil | opciones, listar, exportar |
| `results_read` | perfil | opciones, resumen |
| `goals_manage` | perfil | listar, leer, avance, crear, editar, consultar_operacion |
| `help_read` | perfil | guia, descargar |
| `home_get` | perfil | resumen |
| `usage_read` | perfil | conversaciones, numeros, almacenamiento, costo_ia, cuotas |
| `audit_read` | perfil | listar, exportar |
| `operations_get` | perfil | leer_resultado |
| `number_assignments_manage` | perfil | autorizaciones, autorizacion, consultar_operacion, autorizar, pausar, reanudar, revocar, asignar, retirar, impacto, historial, vista_inversa |
| `numbers_manage` | perfil | listar, leer, crear, impacto_eliminar, eliminar |
| `number_connection_manage` | perfil | estado, conectar, vincular, desconectar, pausar, reanudar |
| `alerts_manage` | perfil | listar, leer, acusar |
| `warmup_manage` | perfil | progreso, evidencia, pausar, reanudar |
| `admin_profiles_manage` | plataforma | listar, crear, invitar_dueno, suspender, reactivar, limites |
| `admin_capacity_manage` | plataforma | leer |

## Equivalencia, una fila por herramienta anterior

| Herramienta anterior | Título | Destino V7 | Tratamiento | Nota |
|---|---|---|---|---|
| `archive_production_list` | Consultar archivo histórico | — | Retirado | Archivo de estudio creativo retirado. |
| `assets_upload_create` | Registrar subida de activo terminado | materials_manage · iniciar_subida | Sustituido | Almacenamiento privado de la plataforma en lugar de R2. |
| `assets_upload_operation` | Continuar subida | materials_manage · parte / completar / cancelar | Sustituido |  |
| `assignment_authorize` | Autorizar alcance comercial concreto | number_assignments_manage · autorizar | Sustituido | Asignar crea un permiso permanente; ya no hay autorización temporal. |
| `assignment_transition` | Consultar o retirar una relación | number_assignments_manage · retirar / historial | Sustituido |  |
| `assignments_apply` | Aplicar mapeo elegido | number_assignments_manage · asignar | Acción humana en la aplicación | Vender una variante en un número es decisión de la persona en la aplicación (D-01). |
| `assignments_list` | Consultar asignaciones independientes | number_assignments_manage · vista_inversa / autorizaciones | Sustituido |  |
| `assistant_context` | Consultar contexto del producto | — | Retirado | Asistente interno fuera de V7; los agentes externos usan las herramientas de dominio. |
| `assistant_proposal_state` | Resolver propuesta o excepción | — | Retirado | Asistente interno retirado. |
| `assistant_propose` | Preparar propuesta contextual | — | Retirado | Asistente interno retirado. |
| `catalog_create` | Crear recurso comercial | products_manage · crear; variants_manage · crear / duplicar | Sustituido | Crear un producto crea también su primera variante. |
| `catalog_get` | Consultar recurso completo | products_manage · leer; variants_manage · leer | Sustituido | Contrato por dominio. |
| `catalog_list` | Consultar catálogo y operación | products_manage · listar; variants_manage · listar | Sustituido | Contrato por dominio en lugar del recurso genérico. |
| `catalog_transition` | Validar, publicar internamente o recuperar | products_manage · archivar / restaurar; variants_manage · publicar / archivar / restaurar | Sustituido | Publicar aplica sólo a conversaciones nuevas. |
| `catalog_update` | Editar borrador con revisión | products_manage · editar; variants_manage · editar; offers/sales_flows/sellers/collections/remarketing_manage · guardar | Sustituido | Cada sección de la variante tiene su acción. |
| `channel_command` | Solicitar control de sesión | number_connection_manage · desconectar / pausar / reanudar | Sustituido | Conectar o vincular es acción humana con el QR. |
| `channel_health` | Salud explicable por capacidad | numbers_manage · leer; alerts_manage · listar | Sustituido |  |
| `channel_inventory` | Números y productos actuales | numbers_manage · listar | Sustituido |  |
| `channel_primary_usage` | Registrar uso humano del principal | — | Retirado | La identidad se observa automáticamente al vincular. |
| `channel_session_configure` | Configurar continuidad y principal | number_connection_manage | Retirado | La sesión técnica la administra el supervisor de gateways; el operador sólo conecta, pausa o desconecta. |
| `channel_session_get` | Consultar continuidad de sesión | numbers_manage · leer | Sustituido | Estado legible del número con su siguiente paso. |
| `channel_session_recovery` | Gestionar recuperación de cuenta | — | Retirado | La recuperación la hace el supervisor de gateways; el aviso indica qué hacer. |
| `command_effects` | Consultar efectos | operations_get | Pendiente | `leer_resultado` disponible; la acción `efectos` sigue declarada como pendiente. |
| `command_get` | Consultar resultado durable de comando | operations_get · leer_resultado | Sustituido | Lectura durable de la operación V7. |
| `conversation_select_product` | Elegir producto explícitamente | conversations_manage | Pendiente | `elegir_variante` declarada pendiente; la conversación con varias variantes se resuelve por evidencia o con la persona. |
| `costs_summary` | Costos registrados | usage_read · costo_ia; results_read · resumen | Sustituido |  |
| `effective_seller` | Vendedor efectivo del recorrido | sellers_manage · leer | Sustituido |  |
| `evaluation_get` | Leer evaluación | number_test_manage · leer | Sustituido |  |
| `evaluation_turn` | Avanzar ensayo aislado | number_test_manage · mensaje | Sustituido |  |
| `home_operations_summary` | Resumen operativo de Inicio | home_get · resumen | Sustituido |  |
| `integration_diagnostic_get` | Consultar diagnóstico | integrations_manage · listar | Sustituido | El resultado de la última validación viene con la integración. |
| `integration_profiles` | Configuración y pruebas por perfil | integrations_manage · listar | Sustituido | Sólo IA y Meta por perfil. |
| `integration_save` | Guardar perfil cifrado | integrations_manage · guardar | Acción humana en la aplicación | Las claves sólo se escriben en la aplicación. |
| `integration_verify` | Verificar conexión del perfil | integrations_manage · validar | Sustituido |  |
| `intelligence_analyze` | Analizar evidencia por lotes | — | Retirado | Inteligencia retirada. |
| `intelligence_batch_get` | Leer lote completo | — | Retirado | Inteligencia retirada. |
| `intelligence_compare` | Comparar expedientes | — | Retirado | Inteligencia retirada. |
| `intelligence_corpus_evaluate` | Evaluar el mismo corpus con dos prompts | — | Retirado | Evaluación de corpus de Inteligencia retirada. |
| `intelligence_corpus_fixture` | Leer corpus y oráculo de evaluación | — | Retirado | Evaluación de corpus de Inteligencia retirada. |
| `intelligence_corpus_get` | Leer evaluación comparativa | — | Retirado | Evaluación de corpus de Inteligencia retirada. |
| `intelligence_corpus_reconcile` | Conciliar evaluación sin inferir de nuevo | — | Retirado | Evaluación de corpus de Inteligencia retirada. |
| `intelligence_get_offer` | Leer expediente y fuentes | — | Retirado | Inteligencia retirada. |
| `intelligence_job_get` | Leer ejecución de Inteligencia | — | Retirado | Inteligencia retirada. |
| `intelligence_reconcile` | Conciliar análisis incierto | — | Retirado | Inteligencia retirada. |
| `intelligence_refresh` | Actualizar búsqueda explícitamente | — | Retirado | Inteligencia retirada. |
| `intelligence_search` | Buscar ofertas almacenadas | — | Retirado | Inteligencia retirada (RF-03). Datos exportados cifrados antes del DROP. |
| `intelligence_search_create` | Guardar búsqueda | — | Retirado | Inteligencia retirada. |
| `launch_guide` | Consultar proceso de lanzamiento | help_read · guia | Sustituido | Guía V7 «Empieza a vender en 6 pasos». |
| `launch_tests` | Consultar o preparar ensayo comprador único | number_test_manage · crear / ultima | Sustituido | Ya no hay prueba obligatoria para vender (RF-06.e). |
| `number_capacity_administration_command` | Claim o readback de capacidad | admin_capacity_manage | Pendiente | Previsualizar, aplicar, drenar y conciliar siguen declaradas pendientes; el supervisor de gateways actúa por política. |
| `number_capacity_administration_list` | Operaciones del administrador acotado | admin_capacity_manage · leer | Sustituido | Sólo identidad de plataforma. |
| `number_capacity_adopt_legacy` | Adoptar plazas legadas conciliadas | — | Retirado | Adopción única de la migración anterior; no es operación V7. |
| `number_capacity_command` | Preparar y ampliar capacidad | admin_capacity_manage | Pendiente | Igual que number_capacity_administration_command. |
| `number_capacity_discrepancies` | Conciliar capacidad | admin_capacity_manage | Pendiente | `conciliar` pendiente. |
| `number_capacity_get` | Capacidad e inventario de workers | admin_capacity_manage · leer | Sustituido |  |
| `number_capacity_inventory` | Registrar inventario observado | admin_capacity_manage · leer | Sustituido |  |
| `number_capacity_measurement` | Registrar medición del host | admin_capacity_manage · leer | Sustituido |  |
| `number_create` | Preparar nuevo número | numbers_manage · crear | Sustituido | Agregar no conecta ni envía. |
| `number_edit` | Editar número | numbers_manage | Pendiente | `editar` declarada pendiente. |
| `number_episodes_list` | Historial de preparación | warmup_manage · evidencia | Sustituido |  |
| `number_flow_test_action` | Actuar en prueba de flujo | number_test_manage · mensaje / seleccionar / avanzar_reloj / continuar | Sustituido |  |
| `number_flow_test_get` | Leer prueba de flujo | number_test_manage · leer | Sustituido |  |
| `number_flow_test_latest` | Recuperar última prueba del número | number_test_manage · ultima | Sustituido |  |
| `number_flow_test_reset` | Reiniciar prueba de flujo | number_test_manage · reiniciar | Sustituido |  |
| `number_flow_test_start` | Probar flujo de un número | number_test_manage · estimar / crear | Sustituido |  |
| `number_get` | Detalle de número | numbers_manage · leer | Sustituido |  |
| `number_groups_list` | Consultar grupos propios existentes | — | Retirado | Grupos propios administrados por la plataforma, sin configuración del perfil. |
| `number_groups_refresh` | Actualizar observación de grupos | — | Retirado | Igual que number_groups_list. |
| `number_identity_confirm` | Confirmar propiedad del número detectado | — | Retirado | La propiedad se declara al dar de alta el número. |
| `number_identity_observe` | Releer identidad conectada | — | Retirado | Identidad observada automáticamente al vincular. |
| `number_library_approve` | Aprobar contenido concreto | — | Retirado | Igual que number_library_list. |
| `number_library_create` | Crear conversación de prueba | — | Retirado | Igual que number_library_list. |
| `number_library_edit` | Editar conversación de prueba | — | Retirado | Igual que number_library_list. |
| `number_library_list` | Biblioteca editable | — | Retirado | Biblioteca de contenido propio administrada por la plataforma. |
| `number_library_seed` | Preparar biblioteca inicial | — | Retirado | Igual que number_library_list. |
| `number_link_access` | Acceso humano a vinculación QR | number_connection_manage · vincular | Acción humana en la aplicación | El QR sólo se muestra a la persona en la aplicación. |
| `number_operation_command` | Reanudar consulta durable | — | Retirado | Recuperación interna automática o de plataforma. |
| `number_operation_get` | Consultar operación durable | numbers_manage · leer | Sustituido | El estado del alta se lee en el número. |
| `number_policy_get` | Política automática de quince días | warmup_manage · progreso | Sustituido | La política es automática y aparece en el progreso. |
| `number_preparation_command` | Gestionar preparación y migración | warmup_manage · pausar / reanudar | Sustituido |  |
| `number_preparation_get` | Progreso automático | warmup_manage · progreso | Sustituido |  |
| `number_program_command` | Revisar, autorizar y gestionar instancia | — | Retirado | Sin programas manuales. |
| `number_program_create` | Guardar borrador de calentamiento | — | Retirado | Sin programas manuales. |
| `number_program_edit` | Editar borrador | — | Retirado | Sin programas manuales. |
| `number_program_evidence` | Evidencia de instancia | warmup_manage · evidencia | Sustituido |  |
| `number_program_get` | Leer instancia y planes | — | Retirado | Sin programas manuales. |
| `number_program_preview` | Preflight y cobertura | — | Retirado | Sin programas manuales. |
| `number_programs_list` | Consultar calentamientos | — | Retirado | Sin programas manuales: el calentamiento es automático. |
| `number_retire` | Retirar número conservando historial | numbers_manage · impacto_eliminar / eliminar | Sustituido | Conserva la historia. |
| `number_setup_command` | Avanzar preparación segura | number_connection_manage | Sustituido | Conectar con QR es acción humana; pausar y desconectar desde el MCP. |
| `number_setup_get` | Leer preparación reanudable | numbers_manage · leer | Sustituido |  |
| `number_simulation_clock` | Controlar reloj de laboratorio | number_test_manage · avanzar_reloj | Sustituido | El reloj virtual vive en la prueba del número. |
| `number_simulation_get` | Leer laboratorio de números | — | Retirado | La simulación del calentamiento no existe en V7. |
| `number_simulation_group` | Configurar grupo del adaptador sin red | — | Retirado | Simulación de grupos retirada. |
| `numbers_batch` | Lote de hasta veinte números | numbers_manage · crear | Sustituido | Alta uno a uno; la instalación admite hasta 20 números. |
| `numbers_list` | Mis números | numbers_manage · listar | Sustituido |  |
| `offer_version_create` | Crear versión editable de oferta | offers_manage · guardar; variants_manage · publicar | Sustituido | La revisión vive en la variante; publicar conserva la versión de las conversaciones abiertas. |
| `product_configuration` | Preparación del producto | variants_manage · leer | Sustituido | La variante trae su documento completo y lo que falta. |
| `proposal_message` | Preparar mensaje para revisión | conversations_manage · responder | Sustituido | Respuesta humana o del agente con el token del perfil; no hay propuestas intermedias. |
| `provider_diagnostic_get` | Leer diagnóstico específico | — | Retirado | Diagnósticos de proveedor retirados. |
| `provider_diagnostic_profiles` | Capacidades de SearchAPI y R2 | — | Retirado | Diagnósticos de SearchAPI/R2 retirados (RF-13.b). |
| `provider_diagnostic_reconcile` | Conciliar objeto temporal propio | — | Retirado | Diagnósticos de proveedor retirados. |
| `provider_diagnostic_verify` | Verificar proveedor específico | — | Retirado | Diagnósticos de proveedor retirados. |
| `remarketing_cycles_list` | Consultar ciclos de seguimiento | remarketing_manage · ciclos | Sustituido | Ciclos por variante (`GET /v2/variants/{id}/remarketing/cycles`), los mismos que muestra la web. |
| `remarketing_reprogram_apply` | Aplicar reprogramación revisada | remarketing_manage · reprogramar | Sustituido | Mueve sólo los recordatorios futuros no iniciados al horario publicado; exige la vista previa (5 min). Pausar/reanudar un ciclo es pausar/reanudar su conversación (`conversations_manage`). |
| `remarketing_reprogram_preview` | Previsualizar reprogramación | remarketing_manage · previsualizar_reprogramacion | Sustituido | Misma vista previa que la web. |
| `resource_dependencies` | Dependencias antes de eliminar | products_manage · dependencias | Sustituido |  |
| `results_summary` | Resultados del producto | results_read · resumen | Sustituido |  |
| `sales_flow_get` | Leer flujo de venta de una oferta | sales_flows_manage · leer | Sustituido |  |
| `sales_flow_save_draft` | Guardar borrador de flujo de venta | sales_flows_manage · guardar | Sustituido |  |
| `sales_flow_validate` | Validar borrador de flujo de venta | sales_flows_manage · validar | Sustituido |  |
| `seller_effective` | Vendedor del flujo | sellers_manage · leer | Sustituido |  |
| `simulation_run` | Ensayar flujo sin red | number_test_manage · crear / mensaje / continuar | Sustituido | Laboratorio aislado; nada sale a WhatsApp. |
| `simulation_snapshot` | Copiar configuración al laboratorio | number_test_manage · leer | Sustituido |  |
| `warmup_activate` | Activar alcance concreto revisado | — | Retirado | El calentamiento empieza solo al vincular el número. |
| `warmup_overview` | Consultar preparación de números | warmup_manage · progreso | Sustituido |  |
| `warmup_pause` | Pausar o reanudar warm-up | warmup_manage · pausar | Sustituido |  |
| `warmup_preflight` | Preparar activación de warm-up | — | Retirado | El calentamiento es política automática de la plataforma. |
| `warmup_simulate` | Ejecutar conversación virtual | — | Retirado | La simulación del calentamiento no existe en V7; la prueba del número es number_test_manage. |
| `warmup_simulation_get` | Consultar simulación completa | — | Retirado | Igual que warmup_simulate. |
| `workflow_evaluate` | Evaluar vendedor aislado | number_test_manage · crear | Sustituido |  |

## Verificación

- `apps/commerce-mcp/src/profile-server.test.ts`: el registro tiene 40 entradas (34 de perfil y 6 de plataforma), sin acciones duplicadas entre servidas y pendientes; el servidor sólo anuncia herramientas del registro y ninguna acepta perfil, token, origen, ruta o SQL.
- `tests/integration/v7-mcp-stdio.test.ts`: cliente MCP SDK real por STDIO y HTTPS local verificado con un token personal; la lista coincide con el registro, ninguna herramienta retirada aparece y un token de servicio se rechaza antes de registrar herramientas.


## Ajuste F8-D (13-oct)

`products_manage.listar/leer` leen `/v2/products` (antes `/v2/catalog`, retirado con las rutas genéricas V5); `versiones` y `productos` se fusionaron en `listar`. El historial de versiones de una variante sigue en `variants_manage · historial / version`. `apps/commerce-mcp/src/numbers.ts` se retiró en F8-D junto con sus rutas.
