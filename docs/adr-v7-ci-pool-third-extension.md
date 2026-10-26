# Tercera ampliación de la bolsa de CI y del medidor del controlador (Agente: Claude)

26-oct-2026. La release correctiva V7.1 está fusionada en `main` (`0e27d1c3`,
PR #17) y falta su FULL. Octubre estaba así:

- **Ledger de Cloud Build:** 81,780 de 90,000 s confirmados. Un FULL reserva
  5,700 s, así que cabía uno solo. Un FULL fallido o un segundo FULL por un
  defecto del ensayo general ya no cabían.
- **Medidor del controlador:** 49,150 de 50,000 s vCPU reservados en 134
  solicitudes. Cada FULL y cada atestación reservan unos 3 × 450 s, así que no
  cabía ni el primer FULL hasta el 1-nov.

## Decisión

Brandon lo decidió en el chat el 26-oct (01:39 UTC): «ok doy autorización para
hacer el deploy en producción, amplía la bolsa de ci/cd».

- **Bolsa.** Pasa de 1,500 a 1,800 minutos por mes UTC (90000 → 108000 s) con
  una transición única, `raise_monthly_limit_third`, del operador protegido.
  - Exige que no haya intento activo ni bloqueo, y que exista el recibo
    `limit_second_extension` (sólo se sale del pool de 1,500).
  - Conserva byte a byte la historia y los recibos `limit_reduction`,
    `limit_extension` y `limit_second_extension`.
  - Agrega el recibo inmutable `limit_third_extension`.

  Un ledger en 108000 sin ese recibo se rechaza; la bolsa nunca crece de forma
  implícita.
- **Medidor.** Los techos mensuales pasan de 50,000 a 70,000 s vCPU y de
  100,000 a 140,000 GiB-s. Se conservan:
  - el límite de 2,000 solicitudes y la cota de 450 s por solicitud;
  - todas las filas, cargos, exclusiones y recuperaciones.

  No se reinicia el medidor ni el ledger y no hay reembolsos.

## Costo

Es un techo, no una factura, y sólo se paga lo que se usa.

| Concepto | Cálculo | Techo adicional al mes |
|---|---|---|
| Bolsa de Cloud Build (precio de lista del pool por defecto, método de `adr-v7-ci-pool-extension.md`) | 300 min × USD 0.006 × 1.16 | USD 2.09 con IVA |
| Medidor del controlador (tarifas tier-1 de Cloud Run: USD 0.000024/vCPU-s y USD 0.0000025/GiB-s) | (20,000 × 0.000024 + 40,000 × 0.0000025) × 1.16 | USD 0.67 con IVA |
| **Total** | | **USD 2.76 con IVA** |

Con eso el tope de CI queda en USD 12.53 al mes y el techo del proyecto sigue en
USD 100. Fuentes: https://cloud.google.com/build/pricing y
https://cloud.google.com/run/pricing.

## Aplicación (orden, el mismo del 18, 20 y 21-oct)

1. Código y pruebas en la rama (`tests/ci`): seis pruebas de la bolsa nueva,
   incluida la forma del ledger vivo, y la regresión del medidor con las
   reservas reales del 26-oct (103 × 450 s, 23 × 120 s y 8 × 5 s).
2. Imágenes derivadas de las desplegadas por digest:
   - controlador: cambian `cloudbuild_admission.py` y
     `cloudbuild_runtime_meter.py`;
   - atestador: cambia sólo `cloudbuild_admission.py` (no usa el medidor).

   Los demás archivos de `/opt/trusted` se conservan. Las imágenes vivas traen
   diagnósticos que no están en `main`, como en las ampliaciones anteriores.
   Los dos archivos que cambian coincidían byte a byte con `main` antes del
   cambio.
3. Revisión nueva de Cloud Run y digest del atestador en los dos triggers, con
   los controles en pausa y la aprobación requerida intacta.
4. CAS Root `raise_monthly_limit_third` con lectura de comprobación.
5. Fusión, y luego el FULL del nuevo `main`.
