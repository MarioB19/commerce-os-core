# Contrato integrado V1 · Inteligencia y Estudio

Contrato 1, Node24, engine1.0.0. Mutaciones humanas usan environment REAL/SIMULATION explícito, Idempotency-Key 8–160 y expected_version (se acepta expectedVersion). Respuestas {data:...}; errores {error:{code,message,details}}. Estado 202 es aceptado.

## Estudio

- GET/POST /v1/studio/projects: {title,product_id,offer_id?,brief:{...},source_opportunity_id?}. GET/PATCH /projects/:id: expected_version, title/brief.
- GET/POST /v1/studio/recipes: {project_id,title,recipe:CreativeRecipe|draft}; guarda incompletos. GET /recipes/:id devuelve metadata/current_version/versiones. POST /recipes/:id/versions {expected_version,recipe}; versión inmutable con SHA.
- POST /recipes/:id/conformity {expected_version,decision:APPROVED|REJECTED,reason,authority:HUMAN|DELEGATED_PILOT,source}; valida referencias reales y conserva actor. No aprobación audiovisual final.
- POST /recipes/:id/quote {expected_version}: {recipe_id,version,recipe_sha,ready,issues,estimated_cost,currency,steps,assets,workers,quote_id}. POST /recipes/:id/submit {expected_version,quote_id,max_cost,authorization_id?,preferred_device_id?}: {job_id,status}. Quote bloqueante no produce. Tope y autorización exactos.
- GET /v1/studio/assets, /jobs, /jobs/:id, /artifacts (project_id opcional).
- POST /v1/studio/uploads {project_id,name,size_bytes,sha256,content_type,purpose:source|master|preview|captions|copy|manifest,rights:{status:OWNED|LICENSED,evidence}}; devuelve {id,asset_id,part_size,part_count,status,version}. Una sesión pendiente por usuario.
- POST /uploads/:id/parts/:partNumber {expected_version}: {url,headers,expires_at,size_bytes}; browser envía Blob directo a R2. No guardar URL en logs.
- POST /uploads/:id/complete {expected_version}: servidor lista/cierra partes, verifica bytes/SHA/tipo remoto, copia a final único y responde asset READY sólo tras evidencia. POST /uploads/:id/abort.
- GET /assets/:id/access?disposition=inline|attachment: {url,expires_at,sha256,size_bytes,content_type}; URL breve para HEAD/GET/Range, renovar en errores de expiración. MCP devuelve página autenticada.
- POST /artifacts/:id/review {expected_version,sha256,decision:APPROVED|CHANGES_REQUESTED,kind:EDITORIAL|PRODUCTION,reason}; humano con permiso; no service token. QA separado.

## Preparación y permisos

GET /v1/creative/settings devuelve providers, budgets, storage, devices, permissions y bloqueos. PUT /settings/:provider {expected_version,enabled,config,secret?}, proveedor r2/searchapi/openai/elevenlabs; secretos cifrados no se devuelven. PUT /budgets {provider,expected_version,limit_usd,max_units,expires_at,authorization_source}. GET/PUT /members, GET /devices y POST /devices/:id/revoke. Owner autoriza capacidades; otros roles comerciales no las heredan.

## Dispositivos

POST /creative-device/v1/pairing/start {name,platform,engineVersion,apiVersion:1,capabilities} devuelve pairingId,userCode,verificationUrl,expiresAt,pollSecret. POST /pairing/:id/poll {pollSecret} devuelve status y token privado una vez aprobado. Owner POST /v1/creative/pairings/:id/approve {expected_version,project_ids,user_code} registra consentimiento; token no es token humano.

Device bearer /creative-device/v1/claim POST {platform,engineVersion,apiVersion,freeBytes,memoryBytes,cacheHashes} devuelve {jobId,attemptId,fence,leaseExpiresAt,recipe,inputApproval,authorization,assets:[{assetId,sha256,sizeBytes,contentType}],projectId} o null. heartbeat/step/complete/fail/reconcile POST {jobId,attemptId,fence,...}. Lease90s, heartbeat15s, un job por device/dos workspace. Complete {artifacts:[{assetId,kind,sha256}],qa,manifest}; sólo intento vigente promueve. Upload paths equivalentes bajo /creative-device/v1/uploads; asset access idem. Todo upload resultado incluye jobId/attemptId/fence y los valida.

## Coste

executeProviderOperation({workspaceId,environment,actorId},{kind,request,operationKey}) retorna {id,status,result?,estimated_cost,confirmed_cost?,currency,remote_id?}. UNKNOWN mantiene reserva y nunca repite POST. Búsqueda y análisis se procesan en cola durable separada del outbox comercial. Concurrencia proveedor1.
