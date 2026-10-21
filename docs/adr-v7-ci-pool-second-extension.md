# Segunda ampliación de la bolsa de CI a 1,500 minutos (Agente: Claude)

20-oct-2026. El FULL de `main` `f3b7f05d` (Build `93788e93`, intento
`64935c09`) pasó todas las etapas de prueba, incluidas integración y e2e, y
falló en `audit` (`pnpm audit --audit-level high`). Ese día se publicaron tres
avisos altos:

- `@modelcontextprotocol/sdk` < 1.32.0: GHSA-22jm-h49p-29qw y GHSA-46jr-4wx8-v453.
- `vite` 8.2.0–8.2.3, por `launch-editor`: GHSA-587h-7wmj-h5pm.

Con sus 54 minutos, octubre quedó en 67,980 de 72,000 segundos. Un FULL reserva
5,700, así que no cabe otro intento en el mes.

## Decisión

Brandon lo decidió en el chat el 20-oct («Subir bolsa a 1,500 min»).

**Dependencias.** `@modelcontextprotocol/sdk` 1.31.0 → 1.32.1 (raíz y
`apps/commerce-mcp`) y `vite` 8.2.2 → 8.2.4 (`apps/web`). El lockfile sólo
cambia esas dos versiones. `pnpm audit --audit-level high` queda sin altos
(9 moderados, como antes).

**Bolsa.** Pasa de 1,200 a 1,500 minutos por mes UTC (72000 → 90000 s). Se
aplica con una transición única, `raise_monthly_limit_second`, del operador
protegido:

- exige que no haya intento activo ni bloqueo;
- conserva byte a byte la historia y los recibos `limit_reduction` y
  `limit_extension`;
- agrega el recibo inmutable `limit_second_extension`.

Un ledger en 90000 sin ese recibo se rechaza; la bolsa nunca crece de forma
implícita.

**Costo.** Al precio de lista del pool por defecto (USD 0.006/min, el método de
`adr-v7-ci-pool-extension.md`), el techo adicional es de 300 × 0.006 × 1.16 =
USD 2.09 al mes con IVA, y sólo si se usa. Con eso el tope de CI queda en
USD 10.44 al mes y el techo del proyecto sigue en USD 100. Fuente:
https://cloud.google.com/build/pricing

## Aplicación (orden)

1. Código y pruebas en la rama (`tests/ci`).
2. Imágenes derivadas del controlador y del atestador. Cada una cambia sólo
   `cloudbuild_admission.py` respecto de la desplegada (mismo procedimiento
   del 19 y 20-oct).
3. Revisión nueva de Cloud Run y digest del atestador en los dos triggers,
   todo con los controles en pausa.
4. CAS Root `raise_monthly_limit_second` con readback.
5. Fusión, y luego FULL del nuevo `main` con pausas sin lecturas de Cloud
   Build antes de cada tick con fence.
