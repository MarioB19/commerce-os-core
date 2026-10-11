# Commerce OS common contract v1

Implementation decision 2026-09-05. Scope ADR-002; PostgreSQL truth. API owns catalog/configuration/control/commands; automation owns sales body and events; channel owns effect executions and session observations. No legacy runtime code is adopted.

## Database

`packages/db/src/index.ts` exports `pool`, `db` (Drizzle), `query<T>(text, values?)`, `withTransaction(fn(client))`, `getRecord(client,workspace,kind,id)`, `listRecords(client,workspace,kind,environment?)`, `putRecord(client,{id?,workspaceId,environment,kind,body,version?})`, `appendEvent(client,event)`, `uuid()`. `QueryExecutor` has `query(text, values?)` returning `{rows,rowCount}`.

`records`: id UUID PK, workspace_id TEXT, environment TEXT CHECK SIMULATION|REAL, kind TEXT, version INTEGER, body JSONB, created_at/updated_at timestamptz; unique(workspace_id,kind,id). `record_versions`: same columns immutable PK(record_id,version). Domain record envelopes use `{id,workspace_id,environment,kind,version,body,created_at,updated_at}`. Body uses snake_case.
Kinds: product, offer, asset, workflow, agent, bank_profile, receipt_policy, channel_account, contact, conversation, message, order, receipt, fulfillment, touchpoint, acquisition_campaign, ad_set, ad, binding, message_campaign, import_batch, incident, health_signal, service_heartbeat, conversion, ai_run, simulation.
Immutable configuration references are `offer_version_id` = offer record UUID (new offer version is new record), `workflow_version_id` = published workflow record UUID, `agent_version_id`, `bank_profile_version_id`. Product metadata versions use record_versions. Historical order body pins all references plus `offer_snapshot`. Publishing/rollback creates a new immutable workflow record; draft edited only using expected_version.

`commands`: id UUID PK, workspace_id TEXT, environment TEXT, kind TEXT, resource_id TEXT, actor_id TEXT, payload JSONB, status TEXT DEFAULT PENDING (PENDING|APPLIED|FAILED), result JSONB, idempotency_key TEXT, created_at/updated_at timestamptz; unique(workspace_id,actor_id,idempotency_key). API checks role/resource and records actor before insert. Workers never invent authorization.
`manual_controls`: workspace_id TEXT, scope_type TEXT (workspace|channel_account|conversation|contact|workflow), scope_id TEXT, paused BOOL, takeover BOOL, suppressed BOOL, version INT, reason TEXT, actor_id TEXT, updated_at timestamptz; PK(workspace_id,scope_type,scope_id). API writes urgent controls in same TX as command. Contact suppression checked across all numbers.
`domain_events`: id UUID PK, workspace_id TEXT, environment TEXT, event_type TEXT, schema_version INT=1, aggregate_id TEXT, correlation_id TEXT, causation_id TEXT NULL, actor JSONB, payload JSONB, occurred_at,recorded_at timestamptz.
`inbound_envelopes`: id UUID PK, workspace_id TEXT, environment TEXT, account_id TEXT, provider TEXT, provider_event_id TEXT, payload_ciphertext TEXT, metadata JSONB, occurred_at,received_at timestamptz, processed_at NULL, status TEXT DEFAULT PENDING, error TEXT; unique(workspace_id,account_id,provider,provider_event_id). Original encrypted, ACK after commit. No customer text in metadata/logs.
`outbox`: id UUID PK, workspace_id TEXT, environment TEXT, account_id TEXT, conversation_id TEXT, contact_id TEXT, logical_key TEXT, kind TEXT DEFAULT message, payload JSONB, status TEXT DEFAULT READY (READY|SENDING|SENT|DELIVERED|READ|FAILED|UNKNOWN|CANCELLED|BLOCKED), predecessor_id UUID NULL, config_hash TEXT, approval_hash TEXT NULL, authorization_id UUID NULL, control_version INT, not_before timestamptz, expires_at timestamptz, claim_id TEXT NULL, claimed_at timestamptz NULL, provider_message_id TEXT NULL, result JSONB, attempts INT, created_at/updated_at timestamptz; unique(workspace_id,logical_key). All messaging only through channel. UNKNOWN blocks successors.
`effect_attempts`: id UUID, effect_id UUID, claim_id TEXT, status TEXT, result JSONB, started_at,finished_at timestamptz NULL.
`timers`: id UUID, workspace_id,environment,conversation_id TEXT, kind TEXT, payload JSONB, due_at timestamptz, status TEXT (PENDING|FIRED|CANCELLED), logical_key TEXT unique(workspace_id,logical_key), created_at.
`session_ownership`: account_id TEXT PK, workspace_id TEXT, owner_id TEXT, generation INT, frozen BOOL default true, lease_expires_at timestamptz, isolation_evidence TEXT NULL, updated_at.
`operation_authorizations`: id UUID,workspace_id,environment,actor_id,scope JSONB,config_hash TEXT,expires_at,revoked_at NULL,created_at. Must explicitly authorize versions/account/audience/limits; real is never enabled by seed.
`idempotency`: workspace_id,actor_id,operation,key,request_hash,response JSONB,status_code INT; PK(workspace_id,actor_id,operation,key).
`memberships`: user_id,workspace_id,role (owner|operator|seller|reconciler|analyst|viewer), active BOOL. Better Auth user/account/session/verification own tables.
`service_tokens`: id UUID,workspace_id,actor_id,name,token_hash,scopes JSONB,expires_at,revoked_at,created_at. No privileged runtime default token.

## HTTP

REST `/v1`. All success responses `{data: T}`; lists `{data:T[],meta:{total:number}}`. Errors `{error:{code,message,details?}}`. Auth `/api/auth/sign-in/email` Better Auth standard; `/v1/me` returns `{data:{user:{id,name,email},workspace_id,role,permissions,environment}}`. UI default environment SIMULATION, list filter `?environment=SIMULATION|REAL`; never mix results.

Resource responses flatten record: `{id,version,environment,...body,created_at,updated_at}`. Collection/detail GET: products, offers, assets, workflows, agents, channel-accounts, conversations, contacts, leads(alias contacts), orders, receipts, fulfillments, touchpoints, acquisition-campaigns, ad-sets, ads, bindings, message-campaigns, imports, incidents, health-signals, events, outbox, commands, operation-authorizations, bank-profiles, receipt-policies, service-tokens. Lists support q/status/account_id/product_id/assigned_to/limit/offset. Conversation detail includes messages/events/outbox/order/contact/offer/controls.

POST/PATCH configuration: products, products/:id/offers, assets, workflows, agents, channel-accounts, acquisition-campaigns, ad-sets, ads, bindings, message-campaigns, bank-profiles, receipt-policies. Every POST mutation requires Idempotency-Key. PATCH body includes expected_version. Products create body `{name,slug?,description?,initial_offer?:{currency,base_amount_minor,fulfillment:[{asset_id,release_on}],...}}` and return product + `initial_offer` DRAFT. Public signup is closed.

Commands: POST `/v1/conversations/:id/commands` `{type:'send_message'|'commitment'|'receipt_received'|'set_stage'|'assign'|'consent'|'opt_out',...payload}`; `/controls` `{paused?,takeover?,suppressed?,reason}`. `/v1/receipts/:id/review` `{decision:'APPROVED'|'REJECTED'|'HUMAN_REVIEW',reason,expected_version}`; `/v1/orders/:id/reconcile` `{amount_minor,currency,evidence_asset_id,reason,expected_version}`. Return durable command 202, polling command/detail reflects result. API manual controls immediate; worker sales transitions async.

Workflows: POST `/validate` `{name,nodes:[{id,type,config,next?,branches?}],entry_node_id}`; POST `/apply` same; POST `/:id/publish` `{expected_version}`; `/:id/duplicate` `{name}`; `/:id/rollback` `{version_id}`. Types entry,condition,ai,message,wait,stage,approval,handoff,commitment,fulfillment,bank_instructions,receipt,post_receipt,reconcile,subflow,end; bounded graph validation forbids arbitrary code. Agent body name/provider/model/knowledge/instructions/max_cost_minor/timeout_ms.

POST `/v1/simulations` `{account_id,offer_version_id,workflow_version_id?,contact_name?,script?}`; command `simulation_start`. `/simulations/:id/advance` `{seconds}` command simulation_advance. POST `/channel-accounts/:id/commands` `{type:'connect'|'disconnect'|'restart'|'freeze'|'resume'|'check_health'|'get_qr',...}`. Authenticated ephemeral QR `/channel-accounts/:id/qr` queries internal channel HTTP service only; absent QR returns readiness dependency, never gateway keys.

POST `/imports/preview` `{source,environment,rows:[{external_id?,name,identity?,occurred_at?,messages?,consent?:{purpose,source,observed_at,evidence},origin?}]}` returns normalized valid rows/errors/duplicates. POST `/imports/:id/commit` queues import_contacts. No consent or attribution is invented.

Campaign POST `/:id/preview`, `/:id/schedule` `{scheduled_at,authorization_id,expected_version}`, `/:id/cancel` `{reason}`. Approval snapshot tied config hash; schedule creates authorized command. `/operation-authorizations` owner only. Acquisition records have source/evidence and binding valid_from/valid_to. `/conversions/prepare` uses receipt_sales_v1 and eligibility, export only; no remote publication.

GET `/v1/reports/summary` and `/v1/reports/export?format=csv|json`, `/v1/system/status`; POST `/v1/system/controls`. `/v1/service-tokens` owner only creation returns token once; allowed draft scopes products:read,products:write,offers:write,workflows:draft,simulations:run. DELETE revoke. `/v1/users` owner-only provision via Better Auth internal API then membership.

## Extensión API-first — 2026-09-06

[Decisión](adr-api-first-2026-09-06.md) y [contratos ejecutables](api-automation.md). Catálogo mantiene `/v1`, separación de identidades y snapshots históricos. Productos agregan `asset_ids` y referencias HTTPS. Flujos agregan `product_id`; referencias y versiones deben coincidir en workspace/entorno. Ofertas/flujos versionados incorporan linaje opaco `series_id`; duplicación inicia otro linaje y rollback sólo restaura uno propio. Publicación interna requiere scopes específicos de servicio y no crea comandos ni efectos. Migration0015 agrega guardas de referencias sin reescribir datos históricos.

## Venta por comprobante — 06-sep-2026

[Contrato y transición completos](campaign-receipt-sales.md). Migración 0019 agrega payment_contributions, receipt_sale_facts, snapshots/jobs/cobertura de Insights, campaña→producto versionada e históricos reportados. Aprobación humana/automática registra ingreso positivo con evidencia privada; Prueba/Falso corrigen la proyección sin repetir efectos. `/reconcile` queda deprecado. Los contratos anteriores se conservan como compatibilidad, no como requisito bancario. Las rutas nuevas, filtros, unidades monetarias, permisos y revisión de cortes están documentados en el enlace.


## Ventas visuales y vendedor contextual — 07-sep-2026 UTC

Migración aditiva 0020; [ADR](adr-sales-visual-seller.md), [uso y límites](sales-visual-seller.md). Kinds nuevos `category` y `flow_evaluation`; el segundo es propiedad de API y conserva snapshot inmutable en DB. `category_id` opcional/nulo y `knowledge` estructurado de categoría/producto no duplican el catálogo. Cada fuente lleva id, topic, title, content, source; las revisiones se conservan en record_versions.

Workflow `editor?:{schema_version:1,positions:{[nodeId]:{x,y}},labels:{[nodeId]:string}}`. PATCH espera `expected_version`; borrador estructural incompleto permitido, ejecución/publicación/evaluación requieren validación completa. El editor serializa config declarativa sin inferir orden por coordenadas. Agente añade product_id, offer_version_id y style; PATCH crea ID nuevo con series_id/source_version_id/revision, exige revisión esperada y rechaza sucesores concurrentes.

| Ruta | Contrato | Permiso de servicio / sesión humana |
|---|---|---|
| GET/POST /v1/categories; GET/PATCH /v1/categories/:id | Nombre y fuentes; PATCH expected_version | products:read/write / catalog:read/write |
| GET /v1/categories/:id/versions | Historial de revisión/conocimiento | products:read / catalog:read |
| GET /v1/agents/:id/versions | Familia de IDs de vendedor | products:read / catalog:read |
| PATCH /v1/agents/:id | Nueva revisión inmutable, sin reasignación | workflows:draft / workflows:write |
| GET /v1/workflows/:id/seller | Origen previsto y snapshot; número/vínculo pueden tener prioridad | workflows:read (o draft) / catalog:read |
| POST /v1/workflows/:id/evaluations | expected_version, agent_version_id opcional exclusivo de prueba; devuelve 201 | simulations:run / workflows:write |
| GET /v1/evaluations/:id | Snapshot y estado de prueba | simulations:run / workflows:write |
| POST /v1/evaluations/:id/turns | expected_version, input: reply/text, clock/seconds, receipt/decision/amount_minor opcional o approve | simulations:run / workflows:write |
| POST /v1/evaluations/:id/provider | Siempre 409 PROVIDER_EVALUATION_NOT_ENABLED | workflows:draft / workflows:write |

Todas las mutaciones de estado usan Idempotency-Key, ámbito servidor y revisión esperada cuando corresponde. El endpoint externo deshabilitado no ejecuta mutación. Evaluación admite sólo referencias del mismo workspace/entorno y copia campos saneados; no cambia permisos operativos ni permite IA externa en SIMULATION. La conversación conserva seller_snapshot y agent_assignment_origin; ai_run registra context_snapshot/source_revisions y configuración observada. Historial y variables permitidas se acotan. Fuente de venta y entrega permanecen en receipt_sales_v1, con compatibilidad de registros históricos, sin nuevo requisito de conciliación.

En el producto, `agent_version_id:null` retira la asignación explícita mediante nueva revisión de metadatos y permite el respaldo del workflow; no borra el vendedor ni cambia conversaciones activas. El asistente conserva también conocimiento sin guardar al cambiar de sección y exige resolverlo antes de cambiar producto o guardar otra revisión del agente.
