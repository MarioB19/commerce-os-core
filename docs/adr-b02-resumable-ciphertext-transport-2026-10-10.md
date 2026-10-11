# B02: cifrado directo de Root a Cloud Storage

Fecha: 2026-10-10. Estado: preparación autorizada; sin publicación ni ejecución.

El respaldo local del Job `commerce-b02-daily-l2wxh` terminó, pero el transporte
SCP por IAP agotó su límite. Una lectura posterior observó aproximadamente
39 KiB/s: mover cerca de 1 GiB por ese canal no cabe en el plazo del Job.
El fallo, sus cuatro exports y el journal pendiente se conservan; no se atribuye
custodia externa ni éxito Cloud al intento fallido.

Se mantiene la arquitectura actual, la identidad del executor y el bucket
privado. Cloud Run inicia una sesión resumable de GCS para el objeto exacto con
`ifGenerationMatch=0`. Envía exclusivamente su URI de sesión por stdin de SSH;
la capability vive en RAM, sin argumentos, archivos, hashes de credenciales ni
logs. No envía un token OAuth al VPS para esta carga.

Root acepta sólo un nombre de los cuatro exports del run autenticado y pendiente,
con el plan, binding, permiso/claim y UID del executor originales. Verifica el
host HTTPS fijo `storage.googleapis.com`, bucket y nombre del objeto. Lee el
cifrado original protegido por descriptor, valida hash/metadatos antes y después
y realiza un único PUT acotado. No permite paths arbitrarios, redirects,
reintentos automáticos, sobrescrituras ni una lectura de llave o plaintext.
La intención durable contiene identidad y hash del archivo, nunca la URI.

Cloud Run describe la generación y descarga el objeto completo por su conexión
regional a GCS. Sólo tras comparar bytes/hash produce el mismo recibo de custodia;
el quinto objeto, ACK Root y descarte conservan su contrato vigente. Un resultado
incierto detiene el intento y conserva evidencia. IAP transporta únicamente
metadatos y el pequeño recibo de custodia, sin el cifrado voluminoso.

No cambian MAX37, la ventana global de 30 días, 1 GiB por ejecución, fechas,
retención, presupuesto USD125, Actions USD0, permisos/IAM, servicios, SA o
aprovisionamiento. El controlador Root cambia legítimamente de hash: requiere
paquete, revisión e instalación canónicos antes de ejecutar la nueva imagen.
La recuperación privada del archivo anterior es un procedimiento separado y no
sustituye la publicación de este cambio. Debe cerrar el journal pendiente antes
de observar el paquete: `copy-runtime` rechaza respaldos no terminales. Con el
Scheduler pausado, el sello incluye los tres hashes del controlador; el instalador
llama `prepare_reviewed_controllers`, conserva los bytes anteriores bajo cuatro
locks, instala los tools exactos en DAILY y confirma el CAS del plan/estado y su
journal. No reinicia runs, claims ni cuotas. Después se requiere el binding MANUAL
legítimo del nuevo plan antes de ejecutar la nueva imagen.

Pruebas dirigidas: create-only, binding de host/bucket/objeto, rechazo de paths
ajenos y redirects, límites de tiempo/tamaño, una sola intención, preservación
tras timeout, hash completo y ausencia de capabilities en salidas/recibos.

Referencias primarias: [cargas resumable](https://docs.cloud.google.com/storage/docs/performing-resumable-uploads)
y [objects.insert](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert).
