# Cuarta ampliación del medidor del controlador, sólo noviembre de 2026 (Agente: Claude)

14-nov-2026, 05:20 UTC. La release V7.5.4 (recuperación de la matriz pagada de
Mi Ciclo Listo) necesita su cadena canónica: FULL y atestación del candidato,
FULL y atestación del SHA de `main`. Noviembre estaba así:

- **Ledger de Cloud Build:** 85,680 de 108,000 s confirmados. Caben los dos FULL
  (5,700 s reservados cada uno). No se amplía.
- **Medidor del controlador:** 67,445 de 70,000 s vCPU reservados (167
  solicitudes, todas `COMPLETED`, sin solicitud activa). Quedaban 2,555 s.

Cada FULL reserva 3 × 450 s (ADMIT, SOURCE, DISPATCH) más 120 s de conciliación,
y cada atestación 3 × 450 s (ADMIT, APPROVE, RECONCILE). La cadena completa
reserva 5,640 s; con un reintento de una atestación, como el del 13-nov
(V7.5.3), 6,990 s. Faltaban 4,435 s.

## Decisión

Brandon autorizó en el chat (13-nov 22:55 CDMX), para esta ejecución: «Si hace
falta ampliar capacidad de CI, autorizo el incremento mínimo para esta ejecución
dentro del presupuesto y del techo monetario vigente del proyecto».

- **Medidor.** Sólo el mes `2026-11` sube 4,500 s vCPU (y 9,000 GiB-s, la misma
  razón de 2 GiB por vCPU): 74,500 s y 149,000 GiB-s. Es el mínimo que cubre la
  cadena y un reintento de atestación. Los demás meses conservan 70,000 s y
  140,000 GiB-s; diciembre empieza en el techo anterior sin acción adicional.
- Se conservan el límite de 2,000 solicitudes, la cota de 450 s por solicitud,
  todas las filas, cargos, exclusiones y recuperaciones. No se reinicia el
  medidor ni hay reembolsos.
- **Ledger, techo bruto mensual (US$175) y atestador:** sin cambios.

## Costo

Es un techo, no una factura. Tarifas tier-1 de Cloud Run (USD 0.000024/vCPU-s y
USD 0.0000025/GiB-s): (4,500 × 0.000024 + 9,000 × 0.0000025) × 1.16 = **USD 0.15
con IVA**, sólo si se usa. Cabe en la bolsa de V7.5.4 y en el techo vigente.

## Aplicación (el mismo orden del 18, 20, 21 y 26-oct)

1. Código y pruebas en la rama (`tests/ci/test_cloudbuild_runtime_meter.py`):
   noviembre admite exactamente la cadena de V7.5.4 sobre las reservas reales
   del 14-nov y nada más; diciembre sigue en 70,000 s.
2. Imagen derivada del controlador desplegado por digest
   (`controller@sha256:c916abb8…`, revisión `commerce-v7-controller-core-v74-cap175`):
   sólo cambia `cloudbuild_runtime_meter.py`, que antes coincidía byte a byte con
   `main`. El atestador no usa el medidor y no cambia.
3. Revisión nueva de Cloud Run con los controles en pausa y sin intento activo.
4. Fusión dentro del PR de V7.5.4.
