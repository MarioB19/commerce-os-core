# ADR V7 — Renovación única del periodo financiero de B02

Agente: Claude · 17-oct-2026 · rama `claude/v7-b02-renewal`. Complementa
`docs/daily-b02-offsite.md`, `docs/adr-v7-f1-infrastructure.md` (§4e) y la guía
de la ventana `docs/v7-fase-c-runbook.md` (§3 y §6.6). No cambia la
arquitectura de B02: mismo Job, mismo Scheduler, misma cuota y mismas guardas.

## Contexto (medido el 17-oct-2026)

- La vinculación Root de B02 vale del 2026-10-05 al **2026-11-04T00:00Z**. Ese
  fin está fijo en el código (`GCP_FINANCIAL_END`). Root rechaza cualquier
  cambio de `valid_until` (`B02_GCP_FINANCIAL_RENEWAL_FORBIDDEN`) y el
  transporte de Cloud Run rechaza una vinculación que termine después
  (`B02_GCP_AUTHORIZATION_WINDOW_INVALID`). La condición IAM del invocador corta
  30 min antes.
- Brandon autorizó el 16-oct-2026 renovar **un periodo más igual al original**:
  30 días, hasta el 2026-12-04T00:00Z, dentro del techo mensual (bitácora V7).
  Sin código nuevo esa renovación no se puede aplicar.
- **Cuota de 37 corridas en 30 días (sin reinicio).** Los diarios de octubre la
  llenan el 31-oct: con los diarios 17–31-oct, los slots del 1, 2 y 3 de
  noviembre quedan en `BACKUP_30_DAY_RUN_LIMIT`. La primera corrida que sale de
  la ventana (7-oct 12:01) libera lugar el 6-nov a las 12:01. Medido sobre los
  diarios Root del 17-oct.
- Los archivos de B02 (`b02-backup-root.py`, `b02_backup_contract.py`,
  `b02-portal-capsule.mjs`) no cambiaron entre `80a6d6e` y `7e59446`. El
  transporte comprueba sus hashes en la VM y el SHA fuente de la vinculación.

## Decisión

1. `GCP_FINANCIAL_ORIGINAL_END` conserva el fin original (2026-11-04) y
   `GCP_FINANCIAL_END` pasa a **2026-12-04**. `gcp_binding`, el transporte y el
   plan de alta aceptan vinculaciones hasta esa fecha; `valid_from` sigue fijo
   en el 2026-10-05.
2. Root (`cutover_facts`) acepta un cambio de `valid_until` **sólo** como esa
   renovación exacta: de 2026-11-04 a 2026-12-04 y sólo hacia una vinculación
   `MANUAL` (`financial_renewal`). Cualquier otra fecha, un cambio de
   `valid_from` o una renovación directa a `SCHEDULED` siguen bloqueados. La
   activación `SCHEDULED` conserva los campos financieros de su `MANUAL`.
3. La cuota no cambia: 37 corridas en cualquier ventana de 30 días, sin
   reinicio, sin segundo Scheduler y sin reintentos automáticos. El plan de alta
   marca `renewal: true` cuando `valid_until` pasa del fin original.
4. El portal Mi Ciclo Listo crea su carpeta `public/` vacía al verificar
   (`npm run verify`): git no guarda carpetas vacías y sin ella la imagen del
   portal no se construía desde un checkout limpio (ensayo de empaquetado del
   17-oct).

## Consecuencias para la ventana y la Fase D

- **B02 fresco antes de los cambios:** no hay slot del 1 al 3 de noviembre. La
  ventana usa el último B02 natural (31-oct 06:45 UTC) con su restauración
  aislada, más el snapshot frío verificado del §1, que es el punto de regreso.
- **Después de instalar (§6.6):** como cambian los archivos Root de B02, el
  transporte se reconstruye con el SHA instalado (`infra/b02-cloud-run.Dockerfile`,
  misma base del SDK por digest) en la VM temporal de empaquetado. Después se
  actualiza el Job (nueva generación), la condición IAM del invocador pasa a
  `request.time < 2026-12-03T23:30Z`, se pausa el Scheduler y se vuelve a
  vincular en `MANUAL` hasta el 2026-12-04 (`gcp-observe` → `gcp-seal` →
  `gcp-apply`).
- **Fase D:** en el primer slot libre (desde el 6-nov 12:01) se hace la corrida
  manual genuina con su restauración aislada; luego `gcp-propose-scheduled`,
  `observe`/`seal`/`apply` en `SCHEDULED` y se reanuda el Scheduler. B02 queda
  sin corridas del 1 al ~7 de noviembre. Lo cubren PITR (activo desde la
  ventana), el snapshot frío, la copia diaria de archivos y el respaldo de
  sesiones W01.
- **Costo:** el periodo 2 cuesta lo mismo que el 1 (Cloud Run observado
  ≈ MXN 0.65 por día más almacenamiento) y ya está en la revisión económica 23.

## Alternativas descartadas

- Subir la cuota de 37: es la autorización financiera del dueño y el módulo
  nunca la reinicia.
- Una publicación aparte después de la V7: sería un segundo despliegue (congela
  REAL e invalida las autorizaciones operativas) y no adelanta B02, porque la
  cuota lo detiene hasta el 6-nov de todos modos.
- Dejar vencer B02 el 4-nov: obligaría a desmontar Job y Scheduler y a repetir
  todo el alta, y dejaría sin atestaciones de respaldo a la autoridad de
  privacidad.

## Verificación

- `tests/ci/test_b02_gcp.py`: el fin renovado se acepta y un segundo después se
  rechaza; `financial_renewal` sólo admite 2026-11-04 → 2026-12-04 hacia
  `MANUAL`; `cutover_facts` vuelve a vincular en `MANUAL` hasta el 4-dic y
  rechaza 20-nov, 4-dic + 1 s y 3-nov; el plan de alta marca la renovación.
- Suite Python de CI completa: 1,807 pruebas.
- Portal: `npm run validate` desde una exportación limpia del árbol.
