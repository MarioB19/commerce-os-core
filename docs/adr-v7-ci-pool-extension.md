# Ampliación de la bolsa mensual de CI a 1,200 minutos

Fecha: 2026-10-18. Estado: decisión del dueño adoptada (Brandon, chat de Cowork,
18-oct 09:45 MX); aplicación nativa (imágenes, Cloud Run, triggers y ledger)
pendiente de sus recibos. Agente: Claude.

## Contexto

La bolsa operativa de CI quedó en 420 minutos por mes UTC con la reducción
prospectiva del 11-oct (`adr-v7-ci-pool-reduction.md`). El ledger de octubre
registra 355 minutos confirmados y 0 reservados; cerrar la V7 exige un FULL de
PR y un FULL de `main` (95 minutos reservados cada uno) más margen para dos
reintentos: unos 380 minutos. Esperar al 1-nov renovaría la bolsa, pero B02 no
tiene cuota del 1 al ~6-nov y la ventana se iría a la segunda semana de noviembre.

El FULL corre en el pool por defecto de Cloud Build (`machineType` sin
especificar, e2-standard-2): USD 0.006 por minuto de lista; Google indica además
2,500 build-minutes gratuitos al mes por cuenta de facturación, que el método de
la revisión económica no descuenta. Con 1,200 minutos el tope es
1,200 × 0.006 × 1.16 = USD 8.35 al mes con IVA y el uso previsto hasta el cierre
(380 min) USD 2.64. Sobre la revisión 23 (recurrente post-V7 USD 72.91; octubre
proyectado USD 70.45) el techo de USD 100 se conserva.

## Decisión

La bolsa pasa de 420 a 1,200 minutos por mes UTC (25200 → 72000 segundos). El
contrato del ledger cambia así:

- `MONTHLY_LIMIT_SECONDS` = 72000; `REDUCED_MONTHLY_LIMIT_SECONDS` = 25200;
  `HISTORICAL_MONTHLY_LIMIT_SECONDS` = 28800 sigue siendo sólo lectura.
- **El documento manda.** La admisión operativa acepta un ledger de 25200 o de
  72000 y cada uno admite sólo hasta su propio límite registrado
  (`MONTHLY_POOL_EXCEEDED`, `OBSERVED_MONTHLY_POOL_EXCEEDED`). Un ledger nunca
  crece de forma implícita: el controlador antiguo o un documento sin migrar
  siguen operando a 420. Los originales de 480 siguen rechazados
  (`OPERATING_POOL_REDUCTION_REQUIRED`).
- Transición única `raise_monthly_limit` (25200 → 72000, `evidence_sha256`,
  `native_verified`), del operador protegido: exige ausencia de intento activo
  y de bloqueo, conserva byte a byte eventos, intentos, builds externos y el
  recibo `limit_reduction`, y añade el recibo inmutable `limit_extension`
  (`from_seconds`, `to_seconds`, `evidence_sha256`, `extended_at`, posterior a
  `reduced_at`). La misma evidencia produce un replay sin escritura; otra
  evidencia, otros límites, un documento con trabajo activo o un ledger
  manipulado se rechazan. Un ledger operado que muestre 72000 sin su recibo se
  rechaza (`LIMIT_EXTENSION_RECEIPT_REQUIRED`); un ledger nuevo nace en 72000.
- La reducción histórica sigue aceptándose sólo sobre originales de 480 y ya no
  puede seguir a la ampliación.

## Aplicación nativa (orden)

1. Código y pruebas en la rama (`tests/ci`: 1,826 pruebas OK, 10 nuevas).
2. Imágenes nuevas del controlador y del atestador desde este commit
   (`infra/cloudbuild/Dockerfile.runtime`), escaneo sin HIGH/CRITICAL y
   publicación por digest en el Registry privado.
3. Revisiones nuevas de Cloud Run y digest del atestador en los dos triggers.
4. Migración del ledger con `raise_monthly_limit` por un solo CAS con readback.
5. Lectura del medidor antes del primer FULL.

Cada paso deja recibo en `00 — Dirección/V7/evidencia/2026-10-18/etapa-c/` del
vault. Ninguno despliega aplicación ni toca REAL.
