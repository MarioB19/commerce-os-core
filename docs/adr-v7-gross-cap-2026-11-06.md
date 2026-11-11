# Techo bruto mensual de US$150 — 6-nov-2026

Brandon autorizó explícitamente «US$150 mensuales; conservar respaldos» durante
la preparación de V7.2. El inventario de VM, discos y snapshots ya excedía el
techo anterior de US$100 antes de otros servicios e impuestos.

El límite de `cloudbuild_admission.py` pasa a 150,000,000 microUSD. Es el máximo
bruto de la proyección del mes, incluidos infraestructura, almacenamiento,
tráfico, transición, CI e impuestos. No se descuentan créditos para cumplirlo.
Se conserva la exigencia de inventario completo, financiación autorizada,
aprobación ligada al candidato y evidencia vigente. No se amplían minutos de
CI, medidor, permisos, número de ejecuciones ni presupuesto de Actions.

Todos los respaldos se conservan. El dueño autorizó después archivar y retirar
únicamente tres discos antiguos desconectados (`commerce-os-test-boot-r20261021a`,
`commerce-os-test-boot-r20261021b`, `commerce-os-test-boot-r20261021c`), después de
crear y verificar snapshots actuales dentro del margen económico. Se conservan
los snapshots anteriores, PITR, producción y los demás discos. Esta excepción
operativa específica no autoriza otras eliminaciones. Los ADR anteriores conservan su
límite histórico; esta decisión sustituye únicamente el techo bruto global.

Las pruebas de admisión y composición aceptan exactamente US$150 y rechazan
US$150.000001. También siguen rechazando inventario incompleto y evidencia vencida.

Brandon aclaró después: «ok no importa, lanzamos aunque se salga de los creditos,
con 150 usd». Esa instrucción sustituye su respuesta intermedia de usar sólo
créditos. Se añade una vía explícita de financiación: `owner_budget` registra
`decision_sha256`, `month` y `monthly_cap_microusd`. La custodia protegida del
operador verifica la decisión real; su hash sólo la vincula, no autentica al dueño.
El mes debe coincidir con la admisión y el importe proyectado debe caber tanto en
el presupuesto autorizado como en el límite global. La vía conserva
`credit_verified: false` y rechaza afirmar simultáneamente créditos verificados.
Sin `owner_budget`, se mantiene el contrato histórico de créditos suficientes.
No se cambia ningún recibo histórico ni se exime el inventario, la caducidad o
la revisión del SHA candidato.

La aplicación operativa requiere derivar las imágenes confiables del
controlador y atestador desde sus digests instalados, reemplazar exclusivamente
el módulo revisado y comprobar la revisión de Cloud Run y los triggers con
controles en pausa. No se reemplaza el runtime instalado por código candidato
no relacionado ni se reutilizan aprobaciones de otro SHA. El cambio del
repositorio por sí solo no acredita que el nuevo techo esté activo en la nube.

Este ajuste operativo permite preparar la publicación autorizada. El alcance
funcional de V7.2 sigue siendo calentamiento por grupos con biblioteca, sin IA,
iniciable desde web, API y MCP.

## Enmienda — 7-nov-2026: techo US$155

El ensayo aislado del paquete de main V7.2 detectó que el instalador no admitía
el paso de migraciones 117→118, y la proyección conservadora llegó a US$150.41
porque la VM de laboratorio quedó encendida ocho horas sin plan. Brandon decidió
«Corregir y seguir, tope US$155». `GROSS_CAP_MICROUSD` pasa a 155,000,000. Las
pruebas aceptan exactamente US$155 y rechazan US$155.000001; el presupuesto del
dueño y la proyección siguen exigiendo inventario completo, mes vigente,
`credit_verified: false` sin saldo comprobado y evidencia vigente. Se conservan
todos los respaldos, snapshots y PITR. La aplicación operativa sigue la misma
regla: imágenes derivadas de los digests instalados con sólo este módulo cambiado.

## Enmienda — 11-nov-2026: techo US$175 para V7.4

Brandon autorizó el 11-nov, para el release V7.4, «como máximo US$20 adicionales
en total de Google Cloud», una sola bolsa entre fases, reintentos y sesiones,
sobre la operación base (tope anterior US$155). `GROSS_CAP_MICROUSD` pasa a
175,000,000: es el techo anterior más esa bolsa, no un aumento general. La
admisión sigue exigiendo `owner_budget` del mes, proyección dentro del
presupuesto, inventario completo, evidencia vigente y `credit_verified: false`.
Las pruebas aceptan exactamente US$175 y rechazan US$175.000001. El consumo
incremental de V7.4 se registra aparte de la operación habitual; pasado este
release, un gasto superior al de la operación base requiere otra decisión.
La aplicación operativa sigue la misma regla: imágenes derivadas de los digests
instalados con sólo este módulo cambiado; no se amplían minutos de CI, medidor,
permisos ni ejecuciones.

Aplicación operativa (Claude, 11-nov-2026, controles en pausa, sin intento
activo): controlador `controller@sha256:c916abb8fcf4880b69dac8f8fb4cd57a034046260778fe7cdc1a34889e738ab7`
(revisión `commerce-v7-controller-core-v74-cap175`, derivada de `a07b8e7a…`) y
atestador `attestor@sha256:0541d12d696aa9e249a9a490959339fe67997517a56ba3656eac9cbf0ff41d26`
(derivado de `b03b467a…`) en los disparadores `commerce-v7-attestation-main` y
`-pr`. La única diferencia de cada imagen es la línea `GROSS_CAP_MICROUSD` de
`/opt/trusted/cloudbuild_admission.py`; variables, recursos, cuenta de servicio
y aprobación requerida no cambiaron.
