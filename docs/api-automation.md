# Catálogo por API para agentes y automatizaciones

OpenAPI: `GET /v1/openapi.json`. Implementación compartida por web y clientes externos. Base del ejemplo: `http://localhost:3001`; usar HTTPS en el despliegue. IDs se tratan como cadenas opacas. REAL es el entorno predeterminado de lectura. Toda mutación exige `environment` explícito en cuerpo o query; valores contradictorios devuelven 400. El [cliente oficial ejecutable](api-client.md) declara REAL y tiene un modo de laboratorio explícito. El servidor obtiene workspace de la identidad, nunca de un campo del cliente.

## Credencial y permisos

Una sesión humana owner crea y revoca credenciales. Login existente: `POST /api/auth/sign-in/email` con JSON `{email,password}` y Origin permitido; guarda la cookie en un archivo privado mediante el cliente seguro. No pegues contraseñas ni tokens en ejemplos, notas o Git. En los siguientes comandos `OWNER_COOKIE_FILE` apunta al archivo privado y `COMMERCE_ORIGIN` a un Origin admitido por el servidor.

```bash
umask 077
export COMMERCE_API_URL='http://localhost:3001'
# Configura OWNER_COOKIE_FILE y COMMERCE_ORIGIN por el canal privado de operación.
TOKEN_RESPONSE=$(mktemp)
TOKEN_EXPIRES_AT=$(node -e 'console.log(new Date(Date.now()+86400000).toISOString())')
TOKEN_BODY=$(jq -n --arg expires "$TOKEN_EXPIRES_AT" '{name:"Catálogo automatizado",environment:"SIMULATION",allowed_environments:["SIMULATION"],scopes:["products:read","products:write","products:publish","offers:read","offers:write","offers:publish","workflows:read","workflows:draft","workflows:publish"],expires_at:$expires}')
curl --fail-with-body --silent --show-error \
  "$COMMERCE_API_URL/v1/service-tokens?environment=SIMULATION" \
  --cookie "$OWNER_COOKIE_FILE" -H "Origin: $COMMERCE_ORIGIN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  --data "$TOKEN_BODY" \
  --output "$TOKEN_RESPONSE"
export COMMERCE_SERVICE_TOKEN=$(jq -r '.data.token' "$TOKEN_RESPONSE")
export COMMERCE_TOKEN_ID=$(jq -r '.data.id' "$TOKEN_RESPONSE")
rm -- "$TOKEN_RESPONSE"
```

El ejemplo calcula una caducidad de 24 horas; el límite configurable por credencial es 90 días. Respuesta 201: `{data:{id,token,name,scopes,expires_at}}`. El token sólo se obtiene en esta respuesta (y su replay idempotente cifrado), nunca al listar credenciales. Carga `data.token` en el gestor de secretos/entorno de la automatización, guarda `data.id` como `COMMERCE_TOKEN_ID` y elimina el archivo temporal. No imprimas su contenido.

| Operación | Scopes de servicio |
|---|---|
| Consultar productos / assets / agentes | `products:read` |
| Crear, editar, duplicar y versionar productos; preparar assets | `products:write` |
| Publicar producto internamente | `products:publish` |
| Consultar ofertas / versiones | `offers:read` (compatibilidad: `products:read`) |
| Crear y versionar oferta | `offers:write` |
| Publicar oferta internamente | `offers:publish` |
| Consultar flujos / versiones / validar por ID | `workflows:read` (compatibilidad: `workflows:draft`) |
| Crear, editar, validar definición, versionar o duplicar flujo | `workflows:draft` |
| Publicar o revertir flujo internamente | `workflows:publish` |

Crear producto con `initial_offer` requiere además `offers:write`. Una credencial de borradores no recibe scopes de publicación. `simulations:run` es opt-in separado; este recorrido no lo necesita. Ninguno de estos scopes permite enviar mensajes, operar números, leer contenido privado de bancos/archivos, conciliar, autorizar operación real o administrar Meta. Caducidad inválida devuelve 400; token inválido, vencido o revocado devuelve 401; scope ausente devuelve 403.

## Recorrido completo con curl

Requiere Node del proyecto, `curl`, `jq` y `uuidgen`; token disponible en `COMMERCE_SERVICE_TOKEN` desde el almacén privado. Todos los ejemplos usan SIMULATION y sólo escriben datos internos. Una oferta puede existir en borrador sin banco/material; publicarla requiere IDs de perfil bancario, política de comprobante y material READY previamente preparados por el owner. La automatización recibe los IDs, sin secretos bancarios.

```bash
PRODUCT_KEY=$(uuidgen)
PRODUCT_BODY='{"name":"Producto API de demostración","description":"Creado sin formularios","references":[{"label":"Referencia","url":"https://example.invalid/producto"}]}'
PRODUCT_JSON=$(curl --fail-with-body --silent --show-error "$COMMERCE_API_URL/v1/products?environment=SIMULATION" \
  -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $PRODUCT_KEY" --data "$PRODUCT_BODY")
PRODUCT_ID=$(printf '%s' "$PRODUCT_JSON" | jq -r '.data.id')
curl --fail-with-body "$COMMERCE_API_URL/v1/products/$PRODUCT_ID?environment=SIMULATION" \
  -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN"

OFFER_JSON=$(curl --fail-with-body --silent --show-error "$COMMERCE_API_URL/v1/products/$PRODUCT_ID/offers?environment=SIMULATION" \
  -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  --data '{"name":"Oferta inicial","currency":"MXN","base_amount_minor":9900,"fulfillment":[]}')
OFFER_ID=$(printf '%s' "$OFFER_JSON" | jq -r '.data.id')

FLOW_BODY=$(jq -n --arg product "$PRODUCT_ID" --arg offer "$OFFER_ID" \
  '{name:"Flujo API",product_id:$product,offer_version_id:$offer,entry_node_id:"inicio",nodes:[{id:"inicio",type:"entry",config:{},next:"fin"},{id:"fin",type:"end",config:{}}]}')
FLOW_JSON=$(curl --fail-with-body --silent --show-error "$COMMERCE_API_URL/v1/workflows?environment=SIMULATION" \
  -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" --data "$FLOW_BODY")
FLOW_ID=$(printf '%s' "$FLOW_JSON" | jq -r '.data.id')
curl --fail-with-body "$COMMERCE_API_URL/v1/workflows/$FLOW_ID/validate?environment=SIMULATION" \
  -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN" -H 'Content-Type: application/json' --data '{}'

PUBLISH_KEY=$(uuidgen)
PUBLISHED_JSON=$(curl --fail-with-body --silent --show-error "$COMMERCE_API_URL/v1/workflows/$FLOW_ID/publish?environment=SIMULATION" \
  -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $PUBLISH_KEY" --data '{"expected_version":1}')
PUBLISHED_FLOW_ID=$(printf '%s' "$PUBLISHED_JSON" | jq -r '.data.id')

curl --fail-with-body "$COMMERCE_API_URL/v1/products/$PRODUCT_ID?environment=SIMULATION" --request PATCH \
  -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  --data "$(jq -n --arg flow "$PUBLISHED_FLOW_ID" '{expected_version:1,workflow_template_version_id:$flow}')"

for RESOURCE in "products/$PRODUCT_ID" "offers/$OFFER_ID" "workflows/$PUBLISHED_FLOW_ID"; do
  curl --fail-with-body "$COMMERCE_API_URL/v1/$RESOURCE/versions?environment=SIMULATION" \
    -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN"
done
```

Respuestas: altas 201 con `{data:{id,version:1,environment:"SIMULATION",status:"DRAFT",...}}`; validación 200 `{data:{valid:true,errors:[],issues:[]}}`; publicación 200 con **nuevo ID** de flujo PUBLISHED, `parent_id`, `series_id` y `sending_enabled:false`. PATCH producto devuelve 200 y `version:2`. GET versiones devuelve 200 `{data:[...],meta?}`. Estos recursos aparecen en Catálogo y Flujos de la misma web, en el mismo workspace/entorno.

Para completar una oferta operativamente preparada, el owner entrega `BANK_PROFILE_ID`, `RECEIPT_POLICY_ID` y `READY_ASSET_ID`. Crear una revisión preserva condiciones omitidas:

```bash
REVISION_BODY=$(jq -n --arg bank "$BANK_PROFILE_ID" --arg policy "$RECEIPT_POLICY_ID" \
  --arg asset "$READY_ASSET_ID" --arg flow "$PUBLISHED_FLOW_ID" \
  '{expected_version:1,changes:{payment_profile_version_id:$bank,receipt_policy_version_id:$policy,workflow_version_id:$flow,fulfillment:[{asset_id:$asset,release_on:"receipt_approved"}]}}')
REVISION_JSON=$(curl --fail-with-body --silent --show-error "$COMMERCE_API_URL/v1/offers/$OFFER_ID/versions?environment=SIMULATION" \
  -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" --data "$REVISION_BODY")
REVISION_ID=$(printf '%s' "$REVISION_JSON" | jq -r '.data.id')
curl --fail-with-body "$COMMERCE_API_URL/v1/offers/$REVISION_ID/publish?environment=SIMULATION" \
  -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" --data '{"expected_version":1}'
```

Revisión 201, publicación 200. Publicar internamente no conecta números, crea pedidos ni envía. Los pedidos existentes conservan su `offer_version_id` y snapshot. Las ejecuciones conservan `workflow_version_id`.

## Duplicados, errores y revocación

```bash
# Misma clave + mismo cuerpo: 201 y el mismo PRODUCT_ID; no duplica.
curl --fail-with-body "$COMMERCE_API_URL/v1/products?environment=SIMULATION" \
  -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $PRODUCT_KEY" --data "$PRODUCT_BODY"

# Moneda no válida: 400 VALIDATION_ERROR; detalles asociados a currency.
curl "$COMMERCE_API_URL/v1/products/$PRODUCT_ID/offers?environment=SIMULATION" \
  -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" --data '{"currency":"ZZZ","base_amount_minor":9900}'

# La credencial de catálogo no puede administrar números: 403 FORBIDDEN.
curl "$COMMERCE_API_URL/v1/channel-accounts?environment=SIMULATION" \
  -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" --data '{"name":"Operación prohibida"}'

# Owner revoca: 200 {data:{revoked:true}}. El siguiente GET con el token: 401.
curl --fail-with-body --request DELETE "$COMMERCE_API_URL/v1/service-tokens/$COMMERCE_TOKEN_ID?environment=SIMULATION" \
  --cookie "$OWNER_COOKIE_FILE" -H "Origin: $COMMERCE_ORIGIN" -H "Idempotency-Key: $(uuidgen)"
curl "$COMMERCE_API_URL/v1/products?environment=SIMULATION" -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN"
```

Cuerpo/query contradictorios: 400 `ENVIRONMENT_CONFLICT`. Entorno omitido en mutación: 400 `ENVIRONMENT_REQUIRED`. Misma clave con otro contenido/entorno: 409 `IDEMPOTENCY_CONFLICT`. Versión obsoleta: 409 `VERSION_CONFLICT`. Otra publicación del mismo borrador con clave diferente: 409 `ALREADY_PUBLISHED`. Scope ausente: 403 `FORBIDDEN`. Referencia ajena o entorno incorrecto al consultar: 404. Una validación de grafo responde 200 `valid:false` con `issues:[{code,path,message}]`; guardar/publicar un grafo inválido devuelve 400 `INVALID_WORKFLOW`. Un error nunca se convierte en éxito.

## Rutas adicionales

| Método y ruta | Payload |
|---|---|
| GET `/products`, `/offers`, `/workflows` | `q`, `status`, `product_id`, `environment`, `limit`, `offset` en query |
| PATCH `/products/:id`, `/workflows/:id` | `{expected_version,...campos}`; sólo borradores; clave idempotente |
| POST `/products/:id/duplicate` | `{name}`; nuevo producto y auditoría |
| POST `/products/:id/versions` | `{expected_version,changes:{...}}`; mismo ID, revisión DRAFT nueva |
| POST `/products/:id/transition` | `{expected_version,status}`; DRAFT→PUBLISHED/ARCHIVED, PUBLISHED→ARCHIVED, ARCHIVED→DRAFT |
| POST `/offers/:id/versions` | `{expected_version,changes:{...}}`; ID inmutable nuevo, mismo producto/linaje |
| POST `/workflows/:id/versions` | `{expected_version,changes:{nodes?,product_id?,offer_version_id?,agent_version_id?,...}}` |
| POST `/workflows/:id/duplicate` | `{name?}`; linaje nuevo |
| POST `/workflows/:id/rollback` | `{version_id,expected_version}`; nueva publicación restaurada del mismo linaje |
| GET `/products/:id/versions`, `/offers/:id/versions`, `/workflows/:id/versions` | Historial sanitizado del mismo workspace/entorno |

`expected_version` en rollback se acepta opcional por compatibilidad; enviarlo evita operar una revisión local obsoleta. Rollback conserva la definición restaurada en un nuevo ID y nunca sobrescribe ejecuciones. Las versiones inmutables de ofertas/flujos usan `version:1` de registro; el linaje se identifica con `series_id`, `source_version_id`/`parent_id` y marcas de tiempo.

Evidencia: `tests/integration/api-first.test.ts` opera handlers HTTP/auth reales contra PostgreSQL aislado; incluye revocación, caducidad, linajes, campos omitidos, concurrencia y conteos de ausencia de efectos. La prueba de navegador complementa visibilidad de recursos. Estas pruebas locales no acreditan una integración remota ni un despliegue.

La consola web permite consultar permisos/vigencia y revocar con confirmación. La creación de credenciales se realiza desde el cliente seguro de API descrito arriba: la consola no carga ni revela secretos de servicio en el DOM. Catálogo, ofertas y flujos sí conservan creación/edición web mediante los mismos endpoints.
