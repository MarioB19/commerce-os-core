# Perfil público fijo para la publicación V7

11 de octubre de 2026. Decisión adoptada para el candidato integrado F0/F1;
no acredita FULL, instalación ni permisos nativos por sí misma.

La edición pública deriva exclusivamente de la exportación de fuente ya saneada.
Conserva las exclusiones de historia privada, contenido comercial y archivos
operativos. La incorporación de cambios posteriores usa comparación de tres
versiones; las resoluciones de privacidad se registran con hashes antes/después.
El árbol privado original y sus evidencias permanecen sin convertir.

El perfil ejecutable se fija a `MarioB19/commerce-os-core`, ID1414365450, fuente
`commerce-v7-public-sources-1065291779811`, Artifact Registry `commerce-ci-public`
y las identidades `commerce-v7-<rol>-core`. No hay selector de repositorio, cuenta,
bucket ni fábrica en HTTP o en archivos del candidato. Los contextos de imagen
con configuración instalada se sellan por separado después de leer generaciones
nativas; ninguna generación de prueba se utiliza como observación real.

El publicador usa la App5276479, instalación170342995, sólo en ese repositorio:
contents/read, administration/read, actions_variables/read y deployments/write,
además de metadata/read. La configuración exige la versión1 del secreto
`commerce-v7-publisher-github-key` y el hash de su clave pública. La clave privada
se obtiene con la identidad publisher-core y permanece en memoria. El controlador,
attestor, verify y package no tienen acceso al secreto. Controller, attestor y
publisher usan la conexión dedicada `commerce-v7-github-core` para autenticar
fuente y eventos. Su única referencia es el repositorio público; el permiso de
lectura se liga a esa conexión, sin depender de una condición IAM de repositorio;
verify/package no reciben su token.

La custodia usa controles separados bajo `core/`; el ledger y meter existentes
se adoptan sin reset. SOURCE escribe `core/source-journals/`, el coordinador de
publicación `core/controller-journals/` y el worker `core/journals/`. Inicializar
el journal del worker admite sólo creación exclusiva; no concede al controlador
permiso de reemplazarlo. Tareas y cuerpos contienen referencias y hashes, nunca
claves ni datos personales de clientes.

Se conserva la protección nativa de main, incluidos PR, historia lineal y el
check de la App10529. Una integración que cambie el SHA exige FULL y atestación
nuevos sobre main antes de package. El FULL de PR no se atribuye al SHA resultante
del merge. Package, Root, HTTPS y Deployment deben acreditar el mismo SHA final.
No se relaja la regla de PR para ahorrar una ejecución.

Los ocho scripts del respaldo restaurado y las herramientas históricas de
Actions/OIDC conservan sus bytes y su autoridad original. Actions permanece
deshabilitado. Esas herramientas no forman parte del control plane público
nativo ni reciben permisos nuevos; no se remapean contratos de respaldo para
atribuirlos a otro repositorio. El módulo dedicado de la App ya tiene identidad
pública y conserva también sus pruebas negativas de repositorio privado.

Los instaladores comparten un catálogo explícito de módulos transferidos y una
prueba de importación aislada. La edición pública incluye `operator_identity.py`
donde los lectores CLI saneados lo necesitan; no reintroduce una cuenta personal
por defecto. El builder SHADOW histórico conserva su vencimiento original y no
es una vía de inicialización o admisión OPERATING.

Pendiente de prueba nativa: imágenes finales por digest, permisos efectivos,
triggers PR/main, FULL/atestaciones, package, instalación Root, arranque durable,
lecturas HTTPS y Deployment. Los informes históricos conservan su SHA y alcance.
