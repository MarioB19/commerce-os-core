import { z } from "zod";
import { categorySchema } from "../../../packages/contracts/src/seller.js";
import {
  productSchema,
  offerSchema,
  offerVersionCreateInputSchema,
  workflowSchema,
  schemas,
  serviceScopes,
} from "../../../packages/contracts/src/index.js";
type Json = Record<string, any>;
const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: "openapi-3.0" }) as Json;
const inputJson = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: "openapi-3.0", io: "input" }) as Json;
const environment = {
  type: "string",
  enum: ["SIMULATION", "REAL"],
  default: "REAL",
};
const expected = { type: "integer", minimum: 1 };
const resource = {
  type: "object",
  required: ["id", "version", "environment"],
  properties: {
    id: { type: "string", format: "uuid" },
    version: expected,
    environment,
    status: { type: "string" },
    series_id: { type: "string", format: "uuid" },
  },
  additionalProperties: true,
};
export function documentCatalogApi(spec: Json) {
  const body = (schema: Json) => ({
    required: true,
    content: {
      "application/json": {
        schema: {
          ...schema,
          properties: { ...schema.properties, environment },
        },
      },
    },
  });
  const error = {
    description: "Error accionable; nunca incluye secretos.",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                details: {},
                diagnostic: { type: "object" },
              },
            },
          },
        },
      },
    },
  };
  const define = (
    path: string,
    method: string,
    scope: string,
    schema?: Json,
    status = 200,
  ) => {
    const operation = spec.paths?.[path]?.[method];
    if (!operation) return;
    operation.tags = ["Catalog and automation"];
    operation["x-required-service-scopes"] = scope.split(" ");
    operation.security = [{ session: [] }, { service: [] }];
    operation.description =
      "Workspace derivado de la sesión o credencial en servidor. Publicación exclusivamente interna; nunca envía mensajes ni modifica Meta. Scopes de servicio requeridos: " +
      scope +
      ".";
    operation.parameters ??= [];
    if (
      ["post", "patch", "put", "delete"].includes(method) &&
      !path.endsWith("/validate")
    )
      operation.parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", minLength: 8, maxLength: 160 },
        description:
          "Una clave estable por operación lógica. Replay idéntico conserva ID/respuesta; cuerpo diferente devuelve 409.",
      });
    if (method === "get" && !path.includes("{id}"))
      for (const name of ["q", "status", "product_id", "limit", "offset"])
        operation.parameters.push({
          name,
          in: "query",
          required: false,
          schema: ["limit", "offset"].includes(name)
            ? {
                type: "integer",
                minimum: name === "offset" ? 0 : 1,
                maximum: name === "limit" ? 200 : undefined,
              }
            : { type: "string" },
        });
    operation.parameters.push({
      name: "environment",
      in: "query",
      required: false,
      schema: environment,
    });
    if (schema) operation.requestBody = body(schema);
    operation.responses = {
      [status]: {
        description:
          status === 201
            ? "Recurso creado de forma durable."
            : "Operación completada; versiones históricas conservadas.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["data"],
              properties: {
                data:
                  method === "get" &&
                  (!path.endsWith("{id}") || path.endsWith("/versions"))
                    ? { type: "array", items: resource }
                    : resource,
                meta: { type: "object" },
              },
            },
          },
        },
      },
      400: error,
      401: error,
      403: error,
      404: error,
      409: error,
      410: error,
      429: error,
    };
  };
  for (const [path, schema, read, write] of [
    ["products", productSchema, "products:read", "products:write"],
    ["offers", offerSchema, "offers:read", "offers:write"],
    ["workflows", workflowSchema, "workflows:read", "workflows:draft"],
  ] as const) {
    define("/v1/" + path, "get", read);
    define("/v1/" + path + "/{id}", "get", read);
    define("/v1/" + path + "/{id}/versions", "get", read);
    define("/v1/" + path, "post", write, json(schema), 201);
    if (path !== "offers")
      define("/v1/" + path + "/{id}", "patch", write, {
        ...json(schema.partial()),
        required: ["expected_version"],
        properties: {
          ...json(schema.partial()).properties,
          expected_version: expected,
        },
      });
    define(
      "/v1/" + path + "/{id}/versions",
      "post",
      write,
      path === "offers" ? inputJson(offerVersionCreateInputSchema) : {
        type: "object",
        required: ["expected_version"],
        additionalProperties: false,
        properties: {
          expected_version: expected,
	          changes: json(
	            path === "products"
	              ? productSchema.omit({ initial_offer: true }).partial()
	              : workflowSchema.omit({ status: true }).partial(),
          ),
        },
      },
      201,
    );
    if(path === "offers"){
      const versionOperation=spec.paths?.["/v1/offers/{id}/versions"]?.post;
      if(versionOperation)versionOperation["x-mcp-tool"]="offer_version_create";
    }
  }
  define(
    "/v1/products/{id}/offers",
    "post",
    "offers:write",
    json(offerSchema),
    201,
  );
  define("/v1/products/{id}/transition", "post", "products:publish", {
    type: "object",
    required: ["expected_version", "status"],
    additionalProperties: false,
    properties: {
      expected_version: expected,
      status: { type: "string", enum: ["DRAFT", "PUBLISHED", "ARCHIVED"] },
    },
  });
  for (const path of ["products", "workflows"])
    define(
      "/v1/" + path + "/{id}/duplicate",
      "post",
      path === "products" ? "products:write" : "workflows:draft",
      {
        type: "object",
        properties: { name: { type: "string", minLength: 1, maxLength: 160 } },
        ...(path === "products" ? { required: ["name"] } : {}),
      },
    );
  for (const path of ["offers", "workflows", "agents"])
    define(
      "/v1/" + path + "/{id}/publish",
      "post",
      path === "offers" ? "offers:publish" : "workflows:publish",
      {
        type: "object",
        required: ["expected_version"],
        additionalProperties: false,
        properties: { expected_version: expected },
      },
    );
  define("/v1/products/{id}/configuration", "get", "products:read");
  for (const [path,scope] of Object.entries({products:'products:write',offers:'offers:write',workflows:'workflows:draft',agents:'workflows:draft',assets:'assets:write'}))
    define(`/v1/${path}/{id}/archive`,"post",scope,{type:'object',required:['expected_version','archived','reason'],properties:{expected_version:expected,archived:{type:'boolean'},reason:{type:'string',minLength:3,maxLength:1000}},additionalProperties:false});
  define('/v1/channel-accounts/setup-batch','post','human-owner-only',{type:'object',required:['assignments'],properties:{assignments:{type:'array',minItems:1,maxItems:50,items:{type:'object',required:['account_id','expected_version','product_id','offer_version_id','workflow_version_id','reason'],properties:{account_id:{type:'string',format:'uuid'},expected_version:expected,product_id:{type:'string',format:'uuid'},offer_version_id:{type:'string',format:'uuid'},workflow_version_id:{type:'string',format:'uuid'},agent_version_id:{type:'string',format:'uuid',nullable:true},reason:{type:'string',minLength:3,maxLength:500}}}}}});
  const batch=spec.paths?.['/v1/channel-accounts/setup-batch']?.post;
  if(batch){batch.responses[207]={...batch.responses[200],description:'Resultados individuales; hay conflictos o fallos pendientes. Reintentar únicamente cuentas fallidas con su revisión vigente.'};batch.security=[{session:[]}];}
  define(
    "/v1/workflows/apply",
    "post",
    "workflows:draft",
    json(workflowSchema),
    201,
  );
  define(
    "/v1/workflows/validate",
    "post",
    "workflows:draft",
    json(workflowSchema),
  );
  define("/v1/workflows/{id}/validate", "post", "workflows:read", {
    type: "object",
  });
  define("/v1/workflows/{id}/rollback", "post", "workflows:publish", {
    type: "object",
    required: ["version_id"],
    additionalProperties: false,
    properties: {
      version_id: { type: "string", format: "uuid" },
      expected_version: expected,
    },
  });
  for (const path of ["/v1/workflows/validate", "/v1/workflows/{id}/validate"])
    if (spec.paths?.[path]?.post)
      spec.paths[path].post.responses[200].content[
        "application/json"
      ].schema.properties.data = {
        type: "object",
        required: ["valid", "errors", "issues"],
        properties: {
          valid: { type: "boolean" },
          errors: { type: "array", items: { type: "string" } },
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                code: { type: "string" },
                path: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
      };
  for (const [plural, schema, read, write] of [
    ["categories", categorySchema, "products:read", "products:write"],
    [
      "agents",
      schemas.agent as z.ZodObject<any>,
      "products:read",
      "workflows:draft",
    ],
  ] as const) {
    define("/v1/" + plural, "get", read);
    define("/v1/" + plural + "/{id}", "get", read);
    define("/v1/" + plural + "/{id}/versions", "get", read);
    define("/v1/" + plural, "post", write, json(schema), 201);
    define("/v1/" + plural + "/{id}", "patch", write, {
      type: "object",
      required: ["expected_version"],
      properties: {
        ...json(schema.partial()).properties,
        expected_version: expected,
      },
    });
  }
  define("/v1/workflows/{id}/seller", "get", "workflows:read");
  spec.paths["/v1/workflows/{id}/seller"]?.get?.parameters.push({ name: "offer_version_id", in: "query", required: false, schema: { type: "string", format: "uuid" }, description: "Oferta explícita cuando varias ofertas publicadas usan el mismo flujo. Sin contexto inequívoco devuelve offer_selection.state=REQUIRED y snapshot=null." });
  define(
    "/v1/workflows/{id}/evaluations",
    "post",
    "simulations:run",
    {
      type: "object",
      additionalProperties: false,
      required: ["expected_version"],
      properties: {
        expected_version: expected,
        agent_version_id: { type: "string", format: "uuid" },
      },
    },
    201,
  );
  define("/v1/evaluations/{id}", "get", "simulations:run");
  define("/v1/evaluations/{id}/turns", "post", "simulations:run", {
    type: "object",
    additionalProperties: false,
    required: ["expected_version", "input"],
    properties: {
      expected_version: expected,
      input: {
        oneOf: [
          {
            type: "object",
            required: ["type", "text"],
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["reply"] },
              text: { type: "string", minLength: 1, maxLength: 2000 },
            },
          },
          {
            type: "object",
            required: ["type", "seconds"],
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["clock"] },
              seconds: { type: "integer", minimum: 0, maximum: 31536000 },
            },
          },
          {
            type: "object",
            required: ["type", "decision"],
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["receipt"] },
              decision: { type: "string", enum: ["PENDING", "APPROVED"] },
              amount_minor: { type: "integer", minimum: 1, maximum: 10000000 },
            },
          },
          {
            type: "object",
            required: ["type"],
            additionalProperties: false,
            properties: { type: { type: "string", enum: ["approve"] } },
          },
        ],
      },
    },
  });
  define(
    "/v1/evaluations/{id}/provider",
    "post",
    "workflows:draft",
    undefined,
    409,
  );
  for (const [path, method] of [
    ["/v1/workflows/{id}/seller", "get"],
    ["/v1/workflows/{id}/evaluations", "post"],
    ["/v1/evaluations/{id}", "get"],
    ["/v1/evaluations/{id}/turns", "post"],
  ] as const) {
    const op = spec.paths?.[path]?.[method];
    if (!op) continue;
    op.description +=
      " Evaluación determinista aislada: snapshot inmutable, sin mensajes comerciales, outbox, temporizadores ni proveedor externo. Sesión humana: workflows:write para evaluar; catalog:read para inspeccionar vendedor.";
    const status = path.endsWith("/evaluations") ? 201 : 200;
    op.responses[status].content["application/json"].schema.properties.data =
      resource;
  }
  const disabled = spec.paths?.["/v1/evaluations/{id}/provider"]?.post;
  if (disabled) {
    disabled.description =
      "Siempre 409 PROVIDER_EVALUATION_NOT_ENABLED; no realiza llamadas pagadas ni habilita IA externa en SIMULATION.";
    disabled.responses[409] = error;
  }
  define(
    "/v1/service-tokens",
    "post",
    "human-owner-only",
    {
      type: "object",
      required: ["name", "scopes", "expires_at"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100 },
        scopes: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: serviceScopes },
        },
        expires_at: {
          type: "string",
          format: "date-time",
          description: "Futuro; máximo 90 días.",
        },
      },
    },
    201,
  );
  define("/v1/service-tokens/{id}", "delete", "human-owner-only");
  for (const [path, method] of [
    ["/v1/service-tokens", "post"],
    ["/v1/service-tokens/{id}", "delete"],
  ])
    if (spec.paths?.[path!]?.[method!])
      spec.paths[path!][method!].security = [{ session: [] }];
  if (spec.paths?.["/v1/service-tokens"]?.post)
    spec.paths["/v1/service-tokens"].post.responses[201].content[
      "application/json"
    ].schema.properties.data = {
      type: "object",
      required: ["id", "token", "name", "scopes", "expires_at"],
      properties: {
        id: { type: "string", format: "uuid" },
        token: {
          type: "string",
          description:
            "Credencial secreta devuelta sólo en la creación y su replay protegido. No registrar.",
        },
        name: { type: "string" },
        scopes: {
          type: "array",
          items: { type: "string", enum: serviceScopes },
        },
        expires_at: { type: "string", format: "date-time" },
      },
    };
  if (spec.paths?.["/v1/service-tokens/{id}"]?.delete)
    spec.paths["/v1/service-tokens/{id}"].delete.responses[200].content[
      "application/json"
    ].schema.properties.data = {
      type: "object",
      required: ["revoked"],
      properties: { revoked: { type: "boolean", enum: [true] } },
    };
}
