# Bootstrap SHADOW del controlador

Decisión del 11 de octubre de 2026, pendiente de admisión económica nativa. La
revisión9 propone USD0.03 adicionales antes de IVA y conserva480 minutos de CI,
74 consumidos. Este bootstrap no admite builds, publicación ni automatización.

`cloudbuild_shadow_bootstrap.py` deriva dos manifiestos puros; no realiza llamadas
de nube. El operador debe fijar el hash del programa revisado y derivar A desde
un inventario nativo completo, autenticado y de menos de120s desde su primera
lectura. No recibe un manifiesto editable como autorización para mutar IAM.

La fase A crea únicamente `commerce-v7-ci-control-1065291779811` en us-east1,
STANDARD, UBLA, PAP enforced, soft-delete7d, sin versionado ni regla que borre
objetos actuales. Su custodia es independiente del bucket legible por verify.
El SA controller recibe GET de tres objetos exactos y create/delete sólo para
reemplazar el meter con CAS. Dos roles custom evitan listados y acceso a otros
objetos. Revisar permisos efectivos heredados, identidad y políticas existentes
antes de crear; conservar bindings ajenos y aplicar IAM con etag/version3.

Los tres objetos se crean una vez con `ifGenerationMatch=0`. El ledger importa
el Build fallido24031884-e8e1-4cdf-86c1-9f39c8e842af mediante la transición
canónica, con su intervalo nativo y4,440s redondeados; cambia el inventario y la
propuesta deja de ser válida. Control queda `shadow` con tarea nula; meter se
inicializa exclusivamente en este bootstrap. Ausencia posterior no autoriza
recreación ni reset. Registrar intención exclusiva antes de cada efecto;
respuesta desconocida permite sólo conciliación GET, sin repetir el POST.

Una creación de rol confirmada no prueba su disponibilidad inmediata para el
binding de Storage. El operador A del11oct recibió400 en setIamPolicy y confirmó
la política sin cambios mediante etag y lectura nativa. Los recursos creados se
conservan; su journal no se reinicia. Antes de una continuación IAM independiente,
leer los roles exactos y su disponibilidad para el bucket, conservar el rechazo
y releer la política original. Una continuación debe tener intención propia,
alcance IAM únicamente y revisión explícita; no repetir bucket/SA/roles ni
convertir una respuesta desconocida en permiso para intentar otra escritura.

La fase B requiere generaciones, tamaños y hashes nativos de A. Esos valores
quedan dentro de `/opt/trusted/runtime-config.json`, root-owned/0444, en un
contexto local sellado. Sólo después del build local, scan cero HIGH/CRITICAL,
revisión de fuentes y lectura del digest/bytes Registry se deriva el servicio.
No usar una imagen con configuración sintética ni tags como evidencia.

El único servicio es controller SHADOW privado:1vCPU/2GiB, min0/max1,
concurrency1, request-based, boost desactivado, timeout60s. IAM invoker sólo para
el operador autorizado. Máximo cinco POST `/tick` vacíos, registrando latencias,
arranques, resultados, generaciones del meter y logs nativos. Scheduler y
Pub/Sub quedan sin crear. La ruta `/events` del handler acepta sólo hints
acotados y los descarta; no se instala una suscripción en este bootstrap.

Las reservas propuestas son900vCPU-s/1,800GiB-s incluyendo escenario de arranque
y cierre,100 operaciones GCS claseA,200 claseB y0.01GiB-mes de custodia. Son
reservas conservadoras, no un límite de facturación impuesto por el proveedor.
El operador contabiliza llamadas/bytes y detiene pasos adicionales ante una
respuesta incierta. No resta créditos, cuotas gratuitas ni reservas previas.
La operación horaria requiere su propia admisión y el conteo completo de ticks,
eventos, source, CAS, reconciliación y arranques.

Referencias oficiales: [IAM Conditions de Storage](https://cloud.google.com/storage/docs/access-control/iam),
[reemplazo de objetos](https://cloud.google.com/storage/docs/uploading-objects),
[servicio Cloud Run v2](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services).
