# Preparación canónica de la revisión Root de MAIN

Decisión del 12 de octubre de 2026, antes del código. El reinicio del Mac perdió
los directorios temporales, pero sobrevivieron Git y los originales privados.
Se conserva el procedimiento `observe → seal` de `copy_runtime_approvals`.
No se reconstruye una aprobación a partir de un resumen ni se repite un backup,
restore, provisión, cambio de tamaño o arranque para recuperar evidencia.

El nuevo preparador es puro: recibe bytes de fuentes ya autenticadas y describe
el cierre que deberá transferirse con el TAR de MAIN. Une el catálogo literal
del cliente canónico con los lectores de revisión y las tres herramientas B02.
Comprueba las sentencias de importación directas del nivel superior. Imports
condicionales o dinámicos requieren validación aislada adicional. Rechaza
un catálogo calculado, nombres repetidos, rutas, archivos ausentes y deriva de
los hashes. No importa ni ejecuta fuentes del candidato; tampoco hace SSH, SQL,
Docker, red, escritura de cuotas o transferencia. Los datos que recibe aún deben
venir de FULL, PACKAGE y de originales autenticados por Root.

El plan liga el SHA y árbol de MAIN, UUID de PACKAGE, intento de instalación
decimal canónico (`installation_attempt`, cadena de 1 a 999999, sin ceros
iniciales), TAR y catálogo. La identidad resultante es
`cb-<package_build_id>-<installation_attempt>`, como exige
`ci_provider_evidence.cloud_installation_id`; el intento no es otro UUID. No inventa esos identificadores cuando todavía faltan. Produce
argv canónicos para `observe` y, sólo después de recibir un hash de observación,
para `seal`. Los comandos son una descripción, nunca una autorización ni una
entrada alternativa al publicador. El operador protegido seguirá siendo quien
autentique, adopte y transfiera el plan antes de invocar la CLI Root existente.

Las ventanas tienen alcances diferentes: la nueva admisión Root no puede durar
más de dos horas; la observación que se sella vence en treinta minutos; la
aprobación de arranque durable vence en quince minutos. No se extiende ninguna
fecha histórica. Antes de cada mutación de host se revalidan la admisión vigente,
FULL/PACKAGE/main/pausas y la lectura nativa bajo los cuatro locks canónicos.
El backup predeploy nuevo lo produce `install-vps --prepare` dentro del intento;
su hash completo y custodia son obligatorios. El restore histórico acredita
compatibilidad de las 68 migraciones y ocho fuentes actuales, no frescura de ese
backup ni permiso de instalar. El portal real y sus datos permanecen preservados.

El contador B02 observado el 11-oct a las 20:03 conserva 17/37 (incluye el fallo).
El siguiente slot natural es el 12-oct a las 06:45 UTC. Esto es un pronóstico
histórico; antes de una admisión se releen binding, plan, claims y todos los
journals. No se adelanta ese slot, se reinicia la cuota ni se da por ejecutado.
Los sobres futuros y el suplemento de noviembre continúan cerrados. PITR pasó
sólo su laboratorio PostgreSQL/pgBackRest local; faltan observación WAL real,
repositorio regional, financiación y validación productiva.

Este incremento permanece separado del candidato F0 y de sus imágenes. Su
validación incluye imports reales de un staging aislado del candidato público,
pruebas negativas de cierre/identidad/ventanas y los originales de restauración
conservados, sin contactos de red ni lecturas de claves.


## Backup previo: contrato y cuota preservados

La cláusula 4 del ciclo por fase exige «Respaldo fresco verificado y restaurable
antes de migraciones o cambios de infraestructura» y comprobar permisos,
conteos, hashes, lectura y restauración aislada. Este incremento no reduce esa
cláusula a un estado de job. La ruta vigente combina la restauración aislada
histórica autenticada con compatibilidad exacta del candidato y un backup nuevo
creado y leído durante su propia instalación. No dice que los datos de ese
backup nuevo ya se hayan restaurado.

`runtime_boot_restore_gate.validate_restore_for_candidate` vuelve a autenticar
los 16 originales y exige los mapas exactos de las 68 migraciones y las ocho
fuentes de backup/restore. Una migración o herramienta distinta bloquea esta
ruta y exige evidencia correspondiente. La revalidación local de 51f72 pasó;
MAIN y el paquete reales deben volver a pasarla. El resultado conserva
`historical_only=true`, `fresh_backup_proven=false` e
`installation_authorized=false`.

`copy_runtime_deployment.publish` llama siempre `install-vps` en fase prepare.
La imagen de mantenimiento autenticada del candidato crea un COMOSB02 nuevo,
con snapshot PostgreSQL coherente y manifiesto de archivos cifrados con hashes.
`verify_predeploy_backup` exige el resultado de ese intento, archivo Root600,
ningún symlink, tamaño acotado a 1 GiB, lectura completa y SHA256 con identidad de
archivo estable. La preparación posee el lock CI y toma los locks de schedule y
maintenance; después adquiere los cuatro locks canónicos y relee plan, estado,
pausas y autoridad antes de la mutación. El hook de boot vuelve a ligar backup,
reporte, fuentes y aprobación de quince minutos. No se atribuyen cuatro locks
simultáneos al dump ni una nueva restauración al hash del ciphertext.

El límite de 37 inicios lo aplica `b02-backup-root.execute` a los journals
`DAILY_B02`. La preparación local usa `maintenance.sh backup`; no crea un job
Cloud Run, journal diario, cápsula nueva del portal ni copia externa. Los 17
inicios históricos y los veinte slots naturales de 12–31 de octubre siguen
consumidos/reservados. Esperar el natural de las 06:45 UTC no evita el backup
local que exige el instalador. Este hecho no autoriza un backup manual B02
adicional, no cambia cuotas ni modifica su calendario.

El 12-oct a las 02:18 UTC se releyeron, bajo el lock compartido existente, las
345 reservas de transferencia de los seis directorios originales. Base previa
1,965,101,013 bytes + reservas = 6,294,327,863 de 6,442,450,944 bytes; quedan
148,123,081 bytes sin refund. La descarga anterior fue 1,028,180,322 bytes:
1,023,744,036 de ciphertext, 4,431,773 del portal y 4,513 de metadatos. Otra
restauración completa no cabe en ese saldo. La historia autenticada ocupa
101,392 bytes y ya tiene custodia externa; no se vuelve a descargar el backup.

El presupuesto publisher por intento, también limitado a 6 GiB, es otro
contrato: reserva fuentes + dos recorridos del TAR + 16 MiB + 58 MiB de originales
boot. No restablece el ledger histórico F1 ni acredita por sí solo presupuesto
de facturación. La transferencia prospectiva observe/seal también debe
contabilizarse antes de realizarla, con tamaño del TAR real y rutas conocidas;
no se atribuye a una bolsa nueva para ocultar consumo previo.

La revisión económica 16 conserva USD 99.8155865487603659 brutos y margen
0.1844134512396341, con todas sus reservas. La opción propuesta no requiere otro
job de backup, VM, disco provisionado ni egreso del ciphertext local. No se
libera ni aumenta reserva alguna. Antes de instalar faltan lectura de espacio
y estado nativos, admisión de transferencias y tamaños reales, MAIN/FULL/PACKAGE,
seal, ventana Root nueva de como máximo dos horas y relectura final. Si esos
costes o el espacio no caben, la instalación permanece cerrada; el margen no se
interpreta como autorización automática. Portal, medios, sesiones, cápsulas W01
y retención permanecen intactos; sus pruebas históricas no se fechan de nuevo.

Evidencia agregada: [contabilidad y límites](evidence/v7-f1-recovery-20261012/backup-admission-analysis.json).
