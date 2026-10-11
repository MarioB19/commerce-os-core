# ADR — Captura y aprobación Root del piloto inicial

Fecha: 2026-10-08. Estado: implementado y probado localmente; no acredita una
aprobación, captura ni ejecución productiva.

El actuador `initial-pilot-root.py` consume una aprobación cerrada, pero nunca la
crea. El emisor separado `initial-pilot-approvals.py` tendrá tres comandos.
`capture` toma dos lecturas nativas del runtime OPERATING sin gateways, después
de autenticar un B02 fresco y sus herramientas. Conserva la hora real de captura
y las ocho definiciones observadas. La operación PROVISION se crea después por
la API canónica; el emisor no la crea, reserva, completa ni modifica.

`observe` exige esa captura, una operación PROVISION de slot1 del mismo workspace
sin lease activo, el hold canónico, freeze y perfiles deshabilitados. Lee la
configuración y credenciales privadas existentes; prepara únicamente una copia
de release.env que agrega el overlay piloto. Renderiza Compose mediante el
comando canónico, exige el pin ya presente y verifica volúmenes completos.
No ejecuta pulls, Docker mutante, HTTP proveedor ni escrituras SQL.

`seal REVIEW-ID DIGEST` registra una decisión Root explícita posterior. Repite
las lecturas bajo los cuatro locks, autentica bytes del paquete instalado y
readers, compara captura, operación, ownership, archivos y composición. Emite
la aprobación exacta del actuador y un ref3 privado. Una observación caduca en
30 minutos y el respaldo sigue limitado a una hora. La captura nunca se fecha
retroactivamente ni se acepta desde JSON aportado por el cliente.

La emisión sólo escribe archivos nuevos Root600 en directorios Root700. Se
reutilizan lecturas NOFOLLOW, fstat/lstat, nlink, límites y fsync del emisor de
runtime. Una escritura interrumpida admite repetición exacta con nuevas lecturas;
un sello completado se devuelve como histórico, sin afirmar vigencia. La
aprobación no ejecuta prepare/start ni sustituye el B02 y adopción posteriores.
Las pruebas usan adaptadores sintéticos sólo dentro del proceso de prueba;
la CLI siempre requiere Linux Root y observaciones nativas auténticas.

Secuencia operativa, desde la release instalada:

```sh
python3 scripts/initial-pilot-approvals.py capture REVIEW-ID BACKUP-REF-FILE TOOLS-REF-FILE
# Crear PROVISION mediante API canónica y activar hold canónico; fuera del emisor.
python3 scripts/initial-pilot-approvals.py observe REVIEW-ID RUN-ATTEMPT OP-UUID PILOT-ENV ADMIN-CONFIG
# Revisar la observación privada y su resumen antes de decidir el sellado.
python3 scripts/initial-pilot-approvals.py seal REVIEW-ID OBSERVATION-SHA256
```

BACKUP-REF-FILE y TOOLS-REF-FILE son archivos Root600 con ref3 de artefactos ya
auténticos; no cuerpos de aprobación. PILOT-ENV y ADMIN-CONFIG son archivos
privados existentes. Las tres credenciales deben existir y concordar; nunca se
crean ni rotan aquí. `candidate-release.env`, la captura, el inventario y los
recibos quedan en `private/initial-pilot-reviews/REVIEW-ID/`. Sólo el sello escribe
`controller-approvals/initial-pilot-REVIEW-ID.json` y `approval-ref.json`.

Las regresiones cubren contrato exacto del consumidor, orden temporal, operación
ausente, cambio de runtime/credenciales/composición/volúmenes, caducidad, segunda
lectura, escritura interrumpida, symlinks y ausencia de comandos mutantes. La
captura puede preceder al hold; observe/seal y el actuador lo exigen de nuevo.
