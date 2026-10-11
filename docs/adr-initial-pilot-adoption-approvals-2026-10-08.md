# ADR — Aprobación de adopción del piloto inicial

Fecha: 2026-10-08. Estado: implementado y probado localmente; no acredita aprobación ni adopción productiva.

El consumidor Root/B02 de reconciliación requiere una aprobación de catorce campos. Los emisores existentes cubren publicación e inicio del piloto; ninguno liga la adopción posterior al arranque, HTTP y operación de capacidad ya confirmados. Un archivo escrito a mano no aporta esa observación.

Se añade un emisor separado observe→seal, acotado a waha-01 y al linaje del actuador inicial. Su entrada es el ref auténtico de aprobación del piloto y nuevos IDs de revisión/ejecución. De approval, intent, prepared, start-intent y http-readback conserva la captura original anterior a PROVISION, el respaldo y release.env anteriores; no admite CIDs, fechas, conteos ni autorizaciones aportadas por cliente.

Cada observación valida paquete y readers instalados, CAS de adopción/plan, nueve contenedores, continuidad exacta de ocho servicios, red y volúmenes, imagen/credenciales/configuración, REAL y perfiles congelados, nuevo hold, operación de la misma cuenta/plaza SUCCEEDED/VERIFIED y su audit auténtico. Usa los guards existentes y consulta autenticadamente sólo /api/sessions?all=true del servidor local para confirmar cero sesiones; nunca inicia sesiones ni escribe negocio. Un recibo HTTP anterior también liga el primer arranque a su CID y operación.

Observe guarda evidencia privada Root600 y una copia600 del pilot.yaml instalado. Seal exige digest explícito, TTL30min, respaldo todavía fresco y dos lecturas bajo los cuatro locks. Sólo emite aprobación, ref y un manifiesto B02 nuevo de seis campos; este último liga herramientas exactas de la release y hashes OPERATING actuales. Reutilizar el manifiesto de publicación anterior fallaría su CAS. Los archivos son inmutables, NOFOLLOW, acotados y fsync; una repetición sellada es histórica. Ni emisor ni sello adoptan, modifican Root/B02, transfieren ownership ni fabrican aislamiento.

El consumidor existente ejecuta la adopción separadamente y luego exige nuevo B02/restore. Las otras dos cuentas/plazas permanecen preservadas; ninguna prueba de este emisor acredita conexión WhatsApp, continuidad COMOSW01 ni revocación del origen.

Pruebas: composición exacta de los catorce/seis campos, doble lectura y drift, caducidad, referencia alterada, symlink/custodia, journals ausentes, HTTP/op/slot divergentes, ausencia de writes nativos, y compatibilidad con el guard B02 real incluyendo rechazo del manifiesto de baseline anterior.

El orden de cierre usa `capacity.admin_readback` VERIFIED y `slot.readback.observed_at`, no `number_operations.updated_at`: el administrador actual no actualiza ese último campo al completar. El evento usa la hora de inicio de su transacción y el readback usa el reloj de la aplicación; no se impone un orden ficticio entre ambos. Los dos deben ser posteriores al HTTP del arranque y anteriores al nuevo hold observado.

Después de completar la misma operación mediante el administrador y tomar un nuevo hold canónico, desde la release instalada y como Linux Root:

```sh
python3 scripts/initial-pilot-adoption-approvals.py observe REVIEW-ID NEW-RUN-ATTEMPT PILOT-APPROVAL-REF-FILE
# Revisar la observación privada antes de decidir el sello.
python3 scripts/initial-pilot-adoption-approvals.py seal REVIEW-ID OBSERVATION-SHA256
python3 scripts/deploy-ci-vps.py reconcile-copy-runtime-gateways RETURNED-APPROVAL-REF-FILE
```

Los IDs son nuevos; el ref del piloto viene del emisor inicial. Observe conserva sus archivos en `private/initial-pilot-adoption-reviews/REVIEW-ID/` y no emite autorización. Seal escribe los manifiestos nuevos en `private/controller-approvals/` y devuelve el archivo ref del consumidor. Cada lectura HTTP consulta únicamente el servidor local de WAHA con secretos por stdin; no llama a WhatsApp ni modifica sesiones. Un fallo de arranque sin `http-readback.json` auténtico requiere conciliación; este emisor no fabrica ese journal ni completa una operación inconclusa.
