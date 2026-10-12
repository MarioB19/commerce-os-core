# Mes de uso Pacific para CI y medidor de runtime

Decisión de preparación del 11 de octubre de 2026. No cambia el candidato
`b17086e2417fdc02f552e8f8ba090e70ada307e2`, el tooling instalado, ningún ledger ni
su admisión actual. El trabajo de octubre11 pertenece al mismo mes con ambos
calendarios; este hallazgo no sustituye ni permite omitir FULL.

## Hallazgo reproducido

`cloudbuild_admission.months()` corta intervalos en el primer día UTC y
`charges()` atribuye allí los segundos confirmados, redondeados al minuto.
`_budget_usage()` usa esos cortes para reservas y terminales. En
`cloudbuild_runtime_meter`, `months()` devuelve las etiquetas UTC del inicio y
fin de la cota; `reserve()`, `extend()` y `validate()` comparten esa función,
mientras `usage()` suma las etiquetas guardadas. No hay un vaciado de archivos,
pero sí se abre lógicamente el saldo de otro mes antes de Pacific.

La [auditoría ejecutada de las funciones originales](evidence/v7-f1-recovery-20261011/ci-runtime-calendar-audit.json)
conserva sus hashes y cuatro ejemplos sintéticos. Un trabajo de450s iniciado el
1-nov06:45Z carga480s confirmados de CI y la cota450s de runtime a noviembre UTC,
aunque todo su uso pertenece a octubre Pacific. El1-dic07:30Z cae todavía en
noviembre Pacific. A las07:00Z del1-nov y el11-oct ambos calendarios coinciden.
No se usaron inventarios, credenciales ni efectos nativos para reproducirlo.

[Cloud Billing Reports](https://docs.cloud.google.com/billing/docs/how-to/reports)
define los días del periodo de uso en Pacific con DST. Esto gobierna la
envolvente de uso adoptada; no afirma que cada línea de una factura, ajuste o
crédito se emita en ese mismo periodo. `America/Los_Angeles` coloca el cierre de
octubre en1-nov07:00Z y el cierre de noviembre en1-dic08:00Z. Noviembre tiene721h.

## Gate previo a la frontera

Antes de admitir cualquier nuevo trabajo cuyo intervalo máximo de cola,
ejecución y limpieza pueda tocar una frontera distinta entre UTC y Pacific,
debe estar instalada y verificada la migración canónica del calendario, además
del sobre completo de cada mes tocado. No basta cambiar la etiqueta de mes de
una admisión ni esperar hasta07Z: un trabajo iniciado antes de00Z puede cruzar
la frontera durante su ejecución. Sin esa migración, se cierra únicamente la
admisión nueva que pueda tocar el intervalo discrepante. Los trabajos admitidos,
sus conciliaciones y los registros inciertos se conservan.

No se puede contar como saldo nuevo el intervalo1-nov00:00–07:00Z ni
1-dic00:00–08:00Z. El suplemento B02 schema3 ya requiere octubre, noviembre y
diciembre Pacific; ello no corrige por sí mismo los medidores de CI/runtime.
Los dos sobres futuros íntegros siguen excediendoUSD100 y permanecen cerrados.

## Migración canónica requerida, todavía no implementada

La corrección debe usar una política inmutable y versionada
`America/Los_Angeles`, con tzdata disponible en la imagen y pruebas de DST. No
habrá selector de zona desde HTTP, entorno ni solicitud del cliente. Los
instantes se conservan UTC; sólo se calculan en Pacific sus límites de mes,
convertidos de nuevo a UTC antes de restar duraciones.

Con controles pausados y sin efectos activos o ambiguos, el operador debe
capturar los originales completos y sus generaciones, derivar la propuesta y
guardar un recibo previo al CAS. El ledger de CI conserva cada evento, plan,
aprobación, reserva, fallo, aborto y observación nativa; los terminales usan
duración por mes Pacific redondeada hacia arriba y las reservas retienen la
cota completa en cada mes posible. Ningún desconocido se libera por cambiar
el calendario.

El medidor conserva las filas históricas y las etiquetas UTC originales como
evidencia, en vez de reescribirlas silenciosamente. Un esquema sucesor debe
derivar una proyección Pacific autenticada. Durante la migración se conserva
al menos la carga ya comprometida en cada mes: para filas históricas se exige
la unión conservadora de sus cargos UTC y Pacific; ninguna reasignación puede
fabricar saldo. Las nuevas filas usan exclusivamente la política Pacific
sellada, con la cota completa en todos los meses tocados. El esquema anterior
queda sólo en el validador histórico explícito y no puede operar como una
alternativa seleccionable.

El readback debe probar igualdad de todos los originales preservados y de la
derivación exacta, sin reset de los420min, del consumo confirmado ni de las
filas del medidor. Un CAS desconocido sólo admite GET de conciliación. Imágenes,
configuración protegida y consumidores deben rechazar el esquema operativo
anterior después del corte, sin una ventana donde alguno vuelva a escribirlo.

Antes de activar se requieren pruebas de00Z/07Z/08Z, DST, trabajos que cruzan
ambos límites, colas, resultados perdidos, conservación por mes y rechazo de
un segundo CAS. La prueba nativa y la nueva admisión económica se hacen con
Root; esta decisión y la reproducción local no las acreditan.
