# Techo bruto mensual de US$150 — 6-nov-2026

Brandon autorizó explícitamente «US$150 mensuales; conservar respaldos» durante
la preparación de V7.2. El inventario de VM, discos y snapshots ya excedía el
techo anterior de US$100 antes de otros servicios e impuestos.

El límite de `cloudbuild_admission.py` pasa a 150,000,000 microUSD. Es el máximo
bruto de la proyección del mes, incluidos infraestructura, almacenamiento,
tráfico, transición, CI e impuestos. No se descuentan créditos para cumplirlo.
Se conserva la exigencia de inventario completo, créditos verificados,
aprobación ligada al candidato y evidencia vigente. No se amplían minutos de
CI, medidor, permisos, número de ejecuciones ni presupuesto de Actions.

Todos los respaldos y discos actuales se conservan. Esta decisión no autoriza
su eliminación para reducir la proyección. Los ADR anteriores conservan su
límite histórico; esta decisión sustituye únicamente el techo bruto global.

Las pruebas de admisión y composición aceptan exactamente US$150 y rechazan
US$150.000001. También siguen rechazando inventario incompleto, créditos sin
verificar y evidencia vencida.

La aplicación operativa requiere derivar las imágenes confiables del
controlador y atestador desde sus digests instalados, reemplazar exclusivamente
el módulo revisado y comprobar la revisión de Cloud Run y los triggers con
controles en pausa. No se reemplaza el runtime instalado por código candidato
no relacionado ni se reutilizan aprobaciones de otro SHA. El cambio del
repositorio por sí solo no acredita que el nuevo techo esté activo en la nube.

Este ajuste operativo permite preparar la publicación autorizada. El alcance
funcional de V7.2 sigue siendo calentamiento por grupos con biblioteca, sin IA,
iniciable desde web, API y MCP.
