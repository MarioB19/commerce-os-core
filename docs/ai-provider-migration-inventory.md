# RF-14 — consumidores y gates de integración

Inspección de código del 11-oct-2026 sobre `80a6d6ea`. Este inventario describe
la fuente; no afirma que todos los consumidores estén activos en producción.
El contrato nuevo está en [ADR de adaptadores](adr-v7-ai-provider-contracts.md).

| Consumidor | Fuente actual | Integración que debe conservarse |
|---|---|---|
| Respuesta del vendedor | `apps/automation-worker/src/agents.ts`, `configuredAi` y `processAgents`; `packages/domain/src/sales/ai.ts` | Snapshot de oferta/vendedor, conversación y secuencia; parsers/grounding, permisos, controles, propuesta antes de outbox y revisión humana. |
| Comprobantes visuales/PDF | `processReceiptAnalyses` y `OpenAiSalesProvider.receipt` en esas fuentes | Bytes privados del mismo perfil; extracción documental separada de aprobación; revalidación de conversación, revisión y controles al aplicar. |
| Análisis de inteligencia | `packages/intelligence/src/index.ts`, `processIntelligenceAnalysis` | Lotes y evidencia citada, claves de operación, recibo pagado anterior al parser, distinción texto observado/inferencia y conciliación de UNKNOWN. |
| Transporte y recuperación de inteligencia | `packages/provider-broker/src/index.ts`, `executeProviderOperation` y `recoverOpenAI` | Ledger del negocio, operación durable y recibo original; no repetir POST para recuperar. El GET del proveedor anterior no se traslada a otro proveedor. |
| Diagnóstico de conexión | `apps/api/src/integration-diagnostics.ts` | Revisión exacta de configuración, autoridad, reserva e idempotencia; prueba mínima al guardar una key separada de habilitación/activación y de evaluación comercial. |
| Configuración y origen histórico de keys | `packages/db/src/integration-settings.ts`, `legacy-integrations.ts`, `apps/api/src/creative-settings.ts` | Migración explícita a perfil, custodia y revisiones. El adaptador nuevo no consulta variables globales ni ejecuta la importación histórica. |
| Corpus sintético | `packages/intelligence/src/corpus-evaluation.ts` | Casos/oráculo/versiones, fuente de tarifas y evaluación limitada. No convertir una prueba de contrato en calidad comercial comprobada. |

La búsqueda focal en TypeScript no encontró un transporte de transcripción
OpenAI existente. Audio es una capacidad nueva del contrato: transcripción
OpenAI y entrada de audio Gemini. Anthropic se mantiene sin audio y requiere
una configuración complementaria explícita o revisión humana.

Antes de conectar cualquiera de estos consumidores deben existir un catálogo
protegido de modelos/precios/máximos vigentes y adaptadores F2 de credencial y
admisión. La reserva identifica perfil, entorno, variante, conversación cuando
exista, intento y hash de solicitud. La autoridad final comprueba también la
revisión de la key y la misma reserva. Los datos de otro perfil y los secretos
no pueden entrar en el fallback.

El incremento actual no cambia ninguno de los consumidores de la tabla. Su
migración conservará los contratos de propuesta, la validación determinista y
los gates de instalación, y requerirá pruebas transaccionales reales de coste,
revocación y aislamiento. RF-13 y la muestra real acotada de Operación Brandon
siguen pendientes; no se han usado keys reales ni solicitado otras al usuario.
