# Cliente HTTP de Commerce OS

Implementación: `scripts/commerce-client.mjs`. Contrato vivo: `GET /v1/openapi.json`. No usa SQL ni credenciales del navegador. La credencial llega desde `COMMERCE_SERVICE_TOKEN` en el almacén privado; nunca como argumento, archivo del repositorio o salida. `COMMERCE_API_URL` debe usar HTTPS excepto localhost. Node 24 del proyecto es suficiente.

El cliente envía **REAL explícitamente** en query y cuerpo. `--lab` crea un cliente SIMULATION limitado a esa invocación. El servidor rechaza omisión en mutaciones y contradicciones; las consultas sin entorno usan REAL. No cambia flags operativos. El cambio de default no permite que un cliente antiguo mande mensajes.

## Permisos y límites

Owner emite por `POST /v1/service-tokens` con `environment`, nombre, scopes, `expires_at`, `allowed_environments` y `resource_ids`. Las nuevas credenciales admiten sólo REAL por defecto; para el laboratorio se concede SIMULATION explícitamente. El snapshot de un flujo REAL necesita ambos entornos y `workflows:read` + `simulations:run`. Vigencia máxima: 90 días. La credencial no puede emitir/revocar otras ni convertirse en owner.

| Uso | Scope mínimo | Restricción adicional |
|---|---|---|
| Producto / oferta | `products:read/write`, `offers:read/write` | Publicación separada `products:publish`, `offers:publish` |
| Flujo / vendedor | `workflows:read/draft` | Publicación separada `workflows:publish` |
| Crear material | `assets:write` | Inmutable tras completar; hash/tamaño comprobados |
| Leer bytes privados | `assets:read` | ID autorizado y entorno correcto; catálogo no concede este permiso |
| Conversación / pedido / comprobante / entrega | `sales:read` | Workspace y allowlist de recursos |
| Proponer respuesta | `sales:propose` | `expected_version`, DRAFT inerte, revisión del operador |
| Consultar comandos / efectos / ACK | `commands:read` | Alcance del recurso, conversación o cuenta asociada |
| Números y salud | `channels:read` | No concede conexión, QR, activación ni autorización REAL |
| Preparar/controlar warm-up | `warmup:read/manage` | Activar permiso del pool y rearmar breaker siguen siendo owner |

`resource_ids` limita consultas, referencias y mutaciones a IDs exactos; las colecciones filtran. `null` permite el workspace según scopes. Crear raíces nuevas exige este último tipo de credencial: concederla sólo durante la preparación y revocarla al acabar. Conversación autorizada incluye su contexto interno. Nunca permite consultar otro workspace. Tokens vencidos/revocados devuelven 401; scope/entorno no autorizado 403; recurso fuera de alcance 404. Una revocación concurrente bloquea el inicio de nuevas mutaciones. Un trabajo ya autorizado y aceptado por el servidor conserva su trazabilidad.

## Ejemplos ejecutables

Preparar los JSON en una carpeta privada de trabajo. Los IDs, precio y contenido siguientes son fixtures; sustituirlos por las versiones aprobadas cuando se prepare un producto REAL. Estos comandos crean datos internos; publicar aquí significa publicar una versión del catálogo, no una campaña ni un envío.

```bash
node scripts/commerce-client.mjs --help
node scripts/commerce-client.mjs request GET /v1/products
node scripts/commerce-client.mjs request POST /v1/products --body product.json --key producto-preparacion-001
node scripts/commerce-client.mjs request POST /v1/products/PRODUCT_ID/offers --body offer.json --key oferta-preparacion-001
node scripts/commerce-client.mjs upload material.pdf --mime application/pdf --key material-pdf-001
node scripts/commerce-client.mjs upload presentacion.mp3 --mime audio/mpeg --key material-audio-001
node scripts/commerce-client.mjs request POST /v1/assets --body link.json --key material-link-001
node scripts/commerce-client.mjs request POST /v1/agents --body seller.json --key vendedor-001
node scripts/commerce-client.mjs request POST /v1/workflows --body workflow.json --key flujo-001
node scripts/commerce-client.mjs request POST /v1/workflows/FLOW_ID/validate --body empty.json --key validar-flujo-001
node scripts/commerce-client.mjs request POST /v1/workflows/FLOW_ID/publish --body revision.json --key publicar-flujo-001
node scripts/commerce-client.mjs request GET /v1/workflows/PUBLISHED_FLOW_ID/seller
node scripts/commerce-client.mjs request GET /v1/channel-accounts/ACCOUNT_ID
node scripts/commerce-client.mjs request GET /v1/health-signals
node scripts/commerce-client.mjs request GET /v1/conversations/CONVERSATION_ID
node scripts/commerce-client.mjs request GET /v1/fulfillments/FULFILLMENT_ID
node scripts/commerce-client.mjs request PATCH /v1/warmup/pools/POOL_ID --body pause.json --key pausar-pool-001
```

Cuerpos mínimos (cada objeto va en el archivo indicado). Referencias de flujo/vendedor deben pertenecer al mismo producto/oferta y entorno. El `PUBLISHED_FLOW_ID` es el nuevo ID devuelto al publicar. Añadirlo mediante revisión esperada de producto/oferta cuando corresponda; nunca sobrescribir versiones históricas.

| Archivo | JSON |
|---|---|
| product.json | `{"name":"Producto de ejemplo","description":"Descripción aprobada"}` |
| offer.json | `{"name":"Oferta","currency":"MXN","base_amount_minor":9700,"fulfillment":[]}` |
| link.json | `{"name":"Enlace aprobado","kind":"link","url":"https://example.invalid/material"}` |
| seller.json | `{"name":"Vendedor","product_id":"PRODUCT_ID","provider":"deterministic","model":"deterministic-v1","instructions":"Usa sólo la información aprobada."}` |
| workflow.json | `{"name":"Flujo","product_id":"PRODUCT_ID","offer_version_id":"OFFER_ID","agent_version_id":"AGENT_ID","entry_node_id":"inicio","nodes":[{"id":"inicio","type":"entry","config":{},"next":"fin"},{"id":"fin","type":"end","config":{}}]}` |
| empty.json | `{}` |
| revision.json | `{"expected_version":1}` |
| pause.json | `{"expected_version":1,"action":"pause","reason":"Pausa operativa solicitada"}` |

`upload` fija tamaño y SHA-256, crea intención, sube contenido y completa el material con tres claves derivadas de la misma clave lógica. La misma clave y bytes reanudan un resultado guardado; otro contenido devuelve conflicto. Un timeout se muestra como `TRANSPORT_UNCERTAIN`: inspeccionar el recurso antes de repetir con la misma clave. Ningún reintento automático reenvía.

## Laboratorio y seguimiento

```bash
node scripts/commerce-client.mjs request POST /v1/simulation-snapshots --lab --body snapshot.json --key ensayo-version-001
node scripts/commerce-client.mjs request POST /v1/simulations --lab --body simulation.json --key inicio-ensayo-001
node scripts/commerce-client.mjs follow COMMAND_ID --lab --until DELIVERED
```

`snapshot.json`: `{"workflow_version_id":"REAL_FLOW_ID","expected_version":1}`. Respuesta: IDs nuevos de flujo/oferta/producto/cuenta SIMULATION, `workflow_revision`, fuentes y materiales. `simulation.json` recibe sus `account_id`, `offer_version_id` y `workflow_version_id`. Los archivos conservan una copia privada independiente con MIME, tamaño y hash verificados. Accesos y enlaces son placeholders visibles: no incluyen códigos reales y no acreditan abrir el portal. No se copian conexiones, bancos operativos ni proveedor de IA externo.

`follow` consulta `202 → PENDING → APPLIED/FAILED → efecto → ACK`. `SENT` sólo acredita aceptación/envío del proveedor; `DELIVERED` exige acuse y `READ` lectura disponible. `UNKNOWN`, `FAILED`, `BLOCKED` y `CANCELLED` requieren atención y nunca se reenvían solos. Timeout sale con código 2 y conserva el estado observado. `APPLIED_WITHOUT_DIRECT_EFFECT` informa que el comando no tiene efecto directo registrado; no acredita una entrega indirecta. Ningún ACK prueba acceso al portal.

Para proponer una respuesta usar `POST /v1/conversations/:id/proposals` con revisión esperada, texto/material y motivo. Devuelve DRAFT y no crea comando ejecutable ni outbox. El operador revisa con `GET /v1/conversations/:id/proposals` y utiliza el comando normal de Inbox con su permiso. Las respuestas humanas normales pueden heredar el permiso operativo vigente del número; no exigen copiar un ID de autorización cada vez. Los controles finales de servidor siguen validando vigencia, configuración, ownership, salud, consentimiento, cuotas y parada.

## Evidencia y alcance

`tests/integration/real-api-contract.test.ts` arranca HTTP real en localhost y ejecuta este CLI con token acotado, verifica workspace/scopes/entorno/recursos, revisiones, idempotencia concurrente, revocación/expiración, snapshot exacto y seguimiento de ACK. Usa PostgreSQL aislado y archivos sintéticos; no WAHA, proveedor externo ni recepción productiva. Las APIs de preparación no sustituyen los gates productivos de publicación, habilitación y piloto.

## Preparación operativa y attestaciones

`node scripts/commerce-client.mjs request GET /v1/readiness` devuelve checks con `source`, `observed_at`, `status` y `href`. `channels:read` ve únicamente números permitidos; el resumen completo exige sesión owner/operator y las pruebas de proveedor/backup/SMTP se mantienen separadas de configuración presente. CONFIGURED no se presenta como recepción comprobada.

La sesión owner registra evidencia humana usando `POST /v1/operational-evidence` con clave idempotente, entorno, `kind`, `status`, `evidence_ref`, `details:{summary,resource_ids?}`, `observed_at` y `expires_at`. Referencias opacas; sin URLs con credenciales, correos, teléfonos ni tokens. El servidor fija `source:HUMAN_ATTESTATION`; nunca afirma que esa declaración sea una comprobación automática. La evidencia es inmutable y el estado del check pasa a STALE al caducar. El piloto comercial debe cubrir cuentas, ofertas y flujos actuales mediante resource_ids; la evaluación de IA debe cubrir los vendedores vigentes. Un piloto de otras versiones no vuelve verde el sistema. Los jobs del servidor usan su fuente separada.

## Operación y recuperación de warm-up

| Ruta | Contrato |
|---|---|
| POST `/warmup/pools/:id/members` | `expected_version`, `account_ids`, `ownership_confirmed:true`, `reason`; sólo propios, mismo workspace/entorno. Agregar revoca scope anterior y exige reautorización acotada. |
| PATCH `/warmup/pools/:id/profile` | `expected_version`, `profile_id`, `reason`; perfil inmutable nuevo para planes futuros, planes anteriores intactos. No cambia standard/inbound-light una vez enrolado. |
| PATCH `/warmup/accounts/:id` | `expected_version`, `action:pause/resume`, `reason`; conserva días/estado graduado. No permite salir de cuarentena. |
| POST `/warmup/accounts/:id/profile-review` | Owner: `expected_version` de warmup_states y `reason`. Solicita GET de revisión; responde 200 con UNKNOWN, nueva versión y `external_mutations:false`. No reintenta PUT ni habilita envíos. |
| POST `/warmup/pools/:id/reconcile` | `expected_version`, `reason`; 202 y comando `warmup_reconcile`. Revisa dependencias, no envía ni reactiva breakers. |
| GET `/warmup/backfill` | Dry-run puro. Sólo usa eventos WORKING del proveedor; ningún día ni antigüedad se infiere desde created_at. Desconocidos esperan evidencia. |

REAL sólo acepta cuentas WAHA propias; Cloud es no aplicable a este pool. La autorización owner exige `provider_evidence_id` vigente de tipo `provider_capability`, referencias a todas las cuentas y `details.capabilities` suficientes para texto/audio/imagen/documento/perfil usado. El permiso nunca puede durar más que esa evidencia. `max_cost_minor` sólo acepta 0 porque este módulo no autoriza modelos ni transportes pagados por llamada/mensaje; no representa costo medido de VPS/licencia. El límite de mensajes y caducidad siguen siendo obligatorios. Configuración REAL congelada impide activar incluso con evidencia completa.

Los controles de pausa y perfil toman el mismo lock del pool que el worker. Los requests con revisión obsoleta fallan 409. Los tokens de administración no pueden autorizar REAL ni rearmar un breaker. Listas y backfill respetan sus IDs, sin exponer el pool de otro recurso.

Las consultas de conversación con token devuelven sólo el registro autorizado. Para mensajes, contacto, oferta o efectos, usar sus rutas y scopes explícitos; no se amplía una lista de IDs por relaciones del catálogo. Los listados de versiones respetan la misma lista exacta.

El check humano `private_storage_disk` utiliza la última medición `MOUNTED_PRIVATE_STORAGE_STATFS` del volumen privado: bytes disponibles/totales, observación y vigencia. Menos de 1 GiB o 5% marca BLOCKED; expiración STALE y medición ausente UNAVAILABLE. No acredita espacio del destino de backup; los tokens no reciben esa métrica.


## Backfill de operación histórica

`POST /v1/warmup/accounts/:id/backfill` exige sesión owner, entorno explícito e Idempotency-Key. El cuerpo incluye `expected_version` del estado, `expected_account_version` de la cuenta y `reason`; `dry_run` es true por defecto. Responde `eligible`, causas concretas, `evidence_hash` y resumen de actividad/historial. Aplicar usa otra clave lógica, `dry_run:false` y el hash revisado. Repetir esa aplicación con la misma clave devuelve el resultado original; revisión o pruebas cambiadas producen 409.

Sólo evidencia anterior al alta del miembro puede acreditar la curva aplicable: días comerciales con ACK verificado, intento aceptado, envelope procesado y muestra madura >=98%; identidad inmutable coherente y siete días de salud sin huecos >=1h antes del alta, además de los siete días inmediatamente anteriores a aplicar. Salud actual debe seguir vigente; un regreso reciente tras desconexión no reutiliza estabilidad antigua. Los desconocidos, simples SENT, historias incompletas por retención, reemplazos y curvas iniciadas se rechazan sin reclasificar. No se aceptan attestaciones como sustituto.

El éxito escribe GRADUATED/BACKFILL con `warmup_started_at:null`, preserva `effective_days` y fija `enrolled_at` a la primera actividad verificada para conservar el guard de identidad con pool apagado. No modifica cuenta, flags, pausas, autorización, permisos ni outbox. Esto es código preparado; aplicar a producción necesita el gate operativo acordado. Ver [ADR del backfill](adr-warmup-backfill.md).

El check de preparación warm-up exige que la identidad conectada siga siendo la registrada para esa graduación. Una representación equivalente de JID conserva la coincidencia; un número distinto bloquea el check. `provider_verified:false` del overview permanece como indicador separado: configuración y graduación local no certifican el proveedor.
