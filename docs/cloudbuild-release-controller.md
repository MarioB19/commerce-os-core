# Control de package y publisher

11 de octubre de2026. Implementación local en revisión; no admite gasto ni
activa el runtime SHADOW. Extiende la decisión del controlador confiable y
conserva el ledger global480min, sin reiniciar intentos ni devolver reservas
por fallos.

`cloudbuild_release_controller.py` deriva las peticiones de los contratos
fijos de package y publisher, no de YAML suministrado por el candidato. Un
package requiere FULL reconciliado, atestación nativa, recibo de logs y check
real de la App. Publisher exige además package reconciliado y su artifact
nativo. Custodia, evento actual y admisión económica se releen antes y después
del CAS, junto con vigencia y exclusión global, antes de enviar un único POST.

La lectura `package_native_identity` liga y contabiliza Build en ejecución o
fallido; `package_native` conserva todos los requisitos SUCCESS, exit0,
procedencia y artifact. Las pruebas de transición utilizan respuestas
sintéticas y no acreditan una ejecución nativa. Publisher SUCCESS representa
sólo ejecución contabilizada. El worker y el lector instalado conservan la
prueba separada de Root, HTTPS y Deployment.

Cada etapa necesita una fuente distinta por intento. `cloudbuild_source_replica`
verifica el TGZ de FULL y realiza una sola [copia nativa](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/copy)
con generación fuente exacta y destino `ifGenerationMatch=0`. Comprueba SHA256,
MD5, tamaño y generación antes de emitir el descriptor protegido. Una respuesta
desconocida conserva intención y reserva; la conciliación posterior sólo lee.
No reutiliza el locator de FULL para disimular un segundo CreateBuild.

El worker publisher puede comenzar antes de que el operador ligue su UUID.
El estado explícito `PUBLISH_PREPARED` permite como máximo cinco observaciones
GET durante30s, dentro de los900s globales. Sólo una transición exacta a custodia
PUBLISH y ledger UUID_BOUND/RUNNING habilita sus efectos. Pausa, vencimiento,
otra fuente o cambio de aprobación no son motivos para repetir una operación.

Pendiente antes de activar: composición en la fábrica instalada, productor de
custodia PREPARED→bound, revisión independiente, IAM exacto, imágenes con
configuración real, réplica y builds nativos admitidos. La configuración del
bootstrap SHADOW permanece sin importar estos módulos ni conceder sus permisos.
Las reservas financieras deben incluir sus lecturas repetidas y CAS; los
inventarios Cloud Build son distintos de operaciones GCS claseB.

## Custodia del publicador: decisión del 11 de octubre

El control del publicador será un objeto separado dentro del bucket privado de
custodia. El controlador conserva su propio task durante PREPARED→UUID_BOUND,
mientras el worker lee el control específico de publisher. Compartir el mismo
objeto invalidaría la guarda del controlador o el contrato del worker.

El productor sólo escribe JSON inmutable en nombres fijos por intento (body,
prepared y bound), inicializa el journal específico del worker y cambia el
control mediante CAS sobre generación y bytes observados. Cada escritura queda
precedida por una intención en el journal del controlador, separado del journal
del worker. No se usa este procedimiento para crear o reponer ledger, meter ni
el journal del controlador. La ausencia posterior es un incidente; una respuesta
desconocida sólo admite lectura de conciliación. El bootstrap SHADOW no recibe
estos objetos ni permisos; requieren la admisión operativa posterior.

La conciliación del documento valida los bytes nativos de su generación, además
de volver a comprobar la generación vigente. No usa reserialización del JSON
como evidencia de SHA256/MD5. Este camino consume cinco lecturas GCS clase B
del destino (metadata+media iniciales, media exacta y nueva metadata+media),
además de las operaciones del journal. Doce pruebas locales y revisión
independiente cubren respuestas perdidas, deriva, pausa y no recreación.

## Composición del runtime — decisión del 11 de octubre

Las operaciones `PACKAGE` y `PUBLISH` se incorporan a la fábrica sellada, con
payloads leídos exclusivamente de custodia privada. No se toman decisiones de
los cuerpos HTTP. La réplica de fuente es una transición independiente: la
creación sólo ocurre con reserva vigente, y un intento existente se concilia
por GET. El descriptor nativo obtenido alimenta la propuesta posterior.

Antes de crear el Build publicador se crean su journal, cuerpo y tarea
`PUBLISH_PREPARED`, y se enlaza el control preexistente mediante CAS. El journal
del controlador vive en `controller-journals/`, separado del journal que el
worker podrá modificar en `journals/`. El cuerpo usa un mínimo de generación
positivo para ese nuevo journal; su binding incluye el hash del plan y se
comprueba al leerlo. No se inventa una generación observada ni un UUID de Build.

Después de vincular el UUID nativo al ledger, la misma solicitud instala la
tarea `PUBLISH` y el control final. Cada CAS conserva su intención y verifica
custodia, permiso vigente, main y Build nativo antes del efecto. En esa fase el
inventario anterior ya contiene deliberadamente un Build menos: no se reutiliza
su igualdad de hash para afirmar un inventario nuevo. La elegibilidad para crear
el Build sigue requiriendo el inventario completo actual antes de la única POST.
Una respuesta incierta nunca autoriza recrear un objeto o reenviar CreateBuild.
La espera del worker continúa acotada a cinco observaciones/30 segundos; una
vinculación tardía falla cerrada y retiene los costes de su ejecución.

Las solicitudes con replica/custodia/package/publisher reservan 450 segundos
antes de trabajar. Esta composición es código candidato: requiere imagen,
permisos, admisión económica y prueba nativa propios antes de activarse.

La adquisición SOURCE utiliza exclusivamente `source-journals/`, separada de
`controller-journals/` y de `journals/` del publicador. IAM puede conceder al
publicador escritura sólo sobre sus journals sin permitir alterar los intentos
de adquisición de fuente. Una tarea con un prefijo de journal distinto falla
antes de abrir el store o adquirir/transferir fuente.
