# Arranque durable del host

11-oct-2026. Decisión adoptada antes de implementar. Instalación pendiente.

La VM conserva `automaticRestart=true`, pero Docker y containerd todavía están
deshabilitados para el arranque del sistema. Los servicios principales usan
`unless-stopped`; los gateways conservan `restart=no` y todas las opciones de
arranque automático de sesiones deshabilitadas. Reiniciar el host hoy necesita
intervención técnica. Esta decisión no acredita recuperación ni veinte conexiones.

El instalador deberá habilitar las unidades existentes de containerd/Docker y
una unidad Root de Commerce, conservando los contenedores, imágenes y volúmenes.
No ejecutará `compose up`, creará contenedores ni hará comandos de WhatsApp. Docker
recupera los servicios principales mediante sus políticas existentes. Después de
comprobar su salud, la unidad sólo puede arrancar los servidores gateway exactos
del inventario adoptado y de una política privada revisada. Arrancar un servidor
no arranca sus sesiones: pausas, bajas, ownership y elegibilidad siguen en las
reglas persistidas del canal. La recuperación comercial corresponde a F3.

La política liga por hash la adopción Root y el plan B02 vigente; una publicación
que cambia esos archivos necesita renovar la política por el camino canónico.
La actualización requiere los cuatro locks de publicación/respaldo. Si difieren
identidades, definiciones, archivos, release, red o inventario, no hay arranque.
Un gateway desconocido o retirado no se adopta por encontrarlo en Docker.

Cada boot tiene un journal propio ligado al ID nativo del kernel. Antes de cada
`docker start CID` se persiste un intento único; una respuesta incierta conserva
el intento. La conciliación sólo puede reconocer el mismo CID ya arrancado y
sano, nunca repetir el comando. Los intentos de otro boot no autorizan un nuevo
arranque dentro del actual. La unidad no tiene `Restart=always` ni un bucle de
arranques. Un error conserva el diagnóstico privado para el monitor externo.

Las fuentes se preparan sin instalar ni habilitar la unidad. La instalación y
habilitación requieren revisión, FULL, package, respaldo fresco y admisión Root
vigente. Después hace falta un ensayo real de reinicio con los mismos CIDs,
barreras comerciales, portal, workers y HTTPS para acreditar recuperación;
las pruebas locales no sustituyen ese ensayo ni certifican un SLO.

El adaptador Root usa una entrada fija en `private/runtime-boot/tools`, cuyo
manifest tiene nueve fuentes exactas y queda ligado por hash en la unidad.
Autentica todos los archivos antes de importar el adaptador; no acepta rutas,
plugins ni comandos desde inputs externos. Los cuatro locks deben existir y
pertenecer a Root. La lectura B02 utiliza el constructor normal del controlador,
sus fuentes selladas y `runtime_guard`/`portal_guard`; sólo sustituye el ejecutor
de comandos por una implementación con bytes y tiempo acotados. No lee la clave
mínima ni inicia un respaldo. También valida recibo y transición de la adopción,
archivos canónicos, portal, proxy activo, redes y rutas del kernel.

La proyección de redes conserva el baseline estático. Durante boot compara los
endpoints vivos únicamente con los contenedores que Docker reporta `Running`;
un contenedor detenido conserva su membresía configurada sin inventar un
endpoint activo. Cualquier endpoint ajeno, ausencia, red o ruta distinta bloquea.
El núcleo tiene hasta 120 segundos para quedar sano bajo un plazo total de 300
segundos. Cada gateway dispone de una sola orden y hasta 60 segundos de lectura
de salud, dentro del mismo plazo global. No se recrea ningún contenedor.

El journal de cada boot tiene un marcador de creación separado: si falta el
journal después de consumir ese marcador, se rechaza un nuevo archivo vacío.
Los cambios usan CAS, escritura exclusiva, fsync del archivo y directorio y
readback. Sólo un CAS confirmado en la invocación actual concede el permiso en
memoria para emitir `docker start`; un proceso nuevo no convierte un intento
incierto en otro arranque. Un reinicio de la unidad en el mismo boot únicamente
puede reconocer los mismos servidores ya sanos.

Estado del incremento: entrada, adaptadores de boot e instalación, unidad y
bundle implementados y probados localmente. El bundle no prueba FULL ni admite
efectos por recibir flags como `full=true`. La unidad usa `Restart=no`, plazo de
inicio 315 segundos y salida limitada a estado/códigos; no se ha instalado o
habilitado en producción.

La integración adoptada inserta un hook en `commit_stage`, después de que B02
confirme la pareja plan/adopción `OPERATING` y antes del reporte `SUCCEEDED`.
Usa las fuentes del mismo package verificado por FULL y mantiene los cuatro
locks. No habrá una CLI de instalación alternativa. Un error del hook impide
publicar éxito; tampoco se reinicia Docker ni se arrancan sesiones durante la
instalación. Los servicios core deben conservar `unless-stopped` en la adopción
canónica: una política diferente exige su transición legítima, no un
`docker update` que invalide B02.

La instalación registra cada escritura y habilitación antes del efecto y liga
el journal al source, política y manifest. Una respuesta perdida sólo se puede
conciliar observando el archivo exacto o la unidad habilitada. Si no se confirma,
no se repite la operación. Habilitar Docker/containerd y la unidad propia prepara
el próximo boot; no certifica un reinicio ya realizado. La aprobación de Root
debe ligar también los originales del restore: el recibo de
`verify_predeploy_backup` por sí solo acredita ciphertext local, no decryption
ni restore.

`runtime_boot_install_gate` consume exclusivamente
`/opt/commerce-os/private/host-boot-approval.json`, Root 0600, producido por la
admisión canónica. Liga SHA, run, archivo de package, host, CIDs y ocho originales
de FULL/package; éstos se comprueban con los validadores existentes de F0.
Sólo admite un package Cloud Build del mismo source/tree/build. Los originales
residen en `host-boot-evidence/<sha256>.json` con custodia Root; no se toman
archivos ni autorizaciones del caller. La aprobación nueva dura como máximo
quince minutos y se vuelve a comprobar tras los I/O de cada fence.

El restore histórico conserva los dieciséis originales auténticos, bytes y
fechas. Su validador exige cadena Root/off-host, ejecución terminal, autenticación
antes de escritura DB, readback, assets, portal y limpieza. No se vuelve a
restaurar sólo por edad. La compatibilidad del candidato requiere exactamente
el mismo mapa de migraciones y ocho fuentes de restore extraídas del package;
un cambio exige evidencia correspondiente. Este resultado histórico nunca
afirma respaldo predeploy actual ni autoriza la instalación por sí solo.

El journal de instalación vive en el directorio del despliegue, antes de crear
el bundle. Conserva los bytes de una instalación anterior autenticada. Cada
reemplazo usa CAS, archivo exclusivo, fsync y readback; cada intento nuevo obtiene
un permiso sólo en memoria. Tras reiniciar el proceso, los intentos previos sólo
pueden conciliar el resultado exacto. Las unidades core también quedan ligadas
por ruta/hash. `enable` nunca usa `--now`; no se actualizan políticas Docker por
fuera de B02. El resultado terminal distingue instalación de ensayo de reboot:
`HOST_BOOT_INSTALLED_REBOOT_NOT_VERIFIED`.

La integración F0 incorpora `ci_provider_evidence.py` a los dos catálogos
sellados del bundle: diez archivos exactos. Una prueba crea el bundle real en
un directorio aislado e importa host/runner con Python `-I`, sin checkout ni
`PYTHONPATH`; también confirma que omitir ese módulo bloquea el import. Esta
prueba no ejecuta systemd, Docker ni el adapter de producción.

Pendientes de integración, no gates omitidos: cerrar el perfil público sellado,
transferir el catálogo fijo del instalador, producir el approval con los lectores
nativos y reservar/admitir su custodia antes del despliegue. No se
ha creado un approval ni una lectura FULL de producción con fixtures. Después
faltan publicación canónica y ensayo real de reboot con readback completo.

La admisión se transporta como `release/host-boot-inputs.json`, un archivo privado
producido por el worker protegido, separado del TAR y del árbol Git. Conserva
bytes originales en base64 con tamaño/hash; no acepta host ni CIDs del cliente.
El catálogo canónico SCP, su doble checksum y un argumento hash fijo ligan este
archivo al mismo arranque de `deploy-ci-vps`. No hay otra CLI de autoridad.
El esquema tiene cotas de 12 MiB de transporte y 8 MiB de originales agregados;
la reserva del publicador debe cubrir cada copia y lectura antes del efecto.

Root deriva los CIDs sólo de los gateways ya activos en la captura canónica
anterior y los contrasta con la adopción aplicada, manteniendo los cuatro locks.
El productor puro revalida FULL/package y la compatibilidad histórica antes de
escribir evidencia. Cada copia Root y el reemplazo de approval tiene intento
durable previo, readback y CAS; un intento heredado sólo admite conciliación del
resultado exacto. El approval conserva la ventana del worker, nunca gana otros
quince minutos al llegar. La instalación vuelve a comprobar el respaldo actual,
B02, inventario, salud y esa vigencia antes de sus propios efectos.

### Reconciliación de gateways con instalación preservada (2026-10-11)

La adopción canónica de un gateway ya provisionado no instala un nuevo bundle. Su
manifiesto Root, la observación vigente de runtime, las barreras comerciales y los
cuatro locks autorizan una transición distinta: conservar herramientas y unidad
exactas, y sustituir únicamente `runtime-boot/policy.json` por CAS después de que
el par B02 quede confirmado. Antes de cualquier CAS del par, el controlador
verifica que la instalación anterior esté completa, que su fuente coincida con el
paquete actual y que sus archivos, unidad, CIDs anteriores y recibos sigan íntegros.

El controlador deriva una admisión Root nueva, ligada al manifiesto de adopción,
a los hashes del par anterior, al recibo de instalación, al host y a los CIDs
observados. Su vigencia termina como máximo quince minutos después y nunca
extiende la hora de vigencia de la observación del runtime. Antes de sustituir la
política vuelve a comprobar la pausa, el par APPLIED, el constructor B02 legítimo,
la identidad de unidades y el inventario. Un intent duradero precede al único CAS;
una ejecución ambigua sólo admite readback exacto, jamás un segundo reemplazo.

El recibo final declara `HOST_BOOT_POLICY_RECONCILED_INSTALLATION_PRESERVED`,
conserva el vínculo al recibo original FULL/package y no afirma una nueva
instalación, restauración, reboot ni arranque de sesiones. La siguiente publicación
puede autenticar esta política mediante ese recibo y su journal. El replay de una
adopción completada también comprueba la política vigente. Cambiar fuente,
herramientas, unidad o autoridad requiere la ruta normal FULL/package; una
aprobación antigua de instalación no autoriza esta nueva operación.

La ruta OPERATING de migraciones conserva el contrato explícito 67→68 y también
68→68 con los mismos hashes. El segundo caso no ejecuta SQL de migración; los
metadatos de adopción/B02, incluidos cambios de DNS, no se presentan como un
nuevo RELEASE ni autorizan futuras migraciones F2.
