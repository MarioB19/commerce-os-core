# ADR — Provisionar una plaza existente adicional sin sustituir la cuenta

Fecha: 2026-10-09. Estado: decisión de implementación; la instalación y su lectura nativa se acreditan por separado.

## Problema comprobado

La cuenta que se debe conservar y conectar tiene una plaza legacy reservada, pero su gateway no existe en el destino. Su ensayo SIM completo pertenece a esa misma cuenta; el ensayo incompleto de otra línea no invalida esa prueba ni autoriza reiniciarla. La presencia de un teléfono no es requisito para preparar un servidor detenido y comprobar después su HTTP sin sesiones.

`provision_existing` conserva la cuenta y su plaza con versiones y quietud comprobadas. No crea infraestructura. El administrador sólo arranca gateways nuevos durante EXPAND; ese recorrido excluye las plazas legacy preservadas. La aprobación y el actuador iniciales se limitan a slot1 y a un baseline sin gateways. Por tanto, ni solicitar PROVISION ni ampliar el contador sustituyen la preparación física y su adopción Root. La lectura ausente o incierta nunca se transforma en cero sesiones o en autoridad para crear un container.

## Decisión y alcance

Se añade un recorrido separado y acotado para **slot3**, desde los ocho servicios del núcleo más `waha-01` ya adoptados. Su cuenta, sesión, perfil y operación se obtienen de lecturas nativas y de `provision_existing`; no se aceptan identidades aportadas como sustituto de esas lecturas. Slot1 conserva container, definición, imagen, volúmenes, arranque y recibo físico. Slot2 no se crea ni se reasigna. Tampoco se recrean cuentas, reservas, conversaciones, sesiones, cuotas o pruebas SIM.

El módulo `additional_existing_gateway.py` comparte lectores y validadores canónicos. Sus CLI separan `capture`, `observe`, `seal`, `prepare`, `start`, lectura HTTP y aprobación de adopción. No hay modo fixture en CLI, escritor libre de aprobaciones, SQL de negocio ni cambio de tamaño de VM. Los adaptadores sintéticos existen sólo en las pruebas.

### Referencia de una plaza reservada anterior a su provisión

La lectura autenticada del 9-oct, después de instalar `cbeb035`, encontró la
plaza3 existente en RESERVED con `gateway_ref=WAHA_03`. El helper se detuvo antes
del POST y conservó únicamente su fallo; no se creó una operación. La guarda
canónica también exigía prematuramente `waha-03`. El inventario administrativo
sólo actualiza readback y versión; `provision_existing` conserva la referencia.
La API la convierte a `waha-03` al completar PREPARED/VERIFIED con lectura física
auténtica, después de la preparación que estaba bloqueada.

La guarda de esa operación acepta exactamente `WAHA_03` o `waha-03` para slot3,
sin reescribir la fila ni normalizar cadenas arbitrarias. Conserva el perfil
`WAHA_03`, la misma cuenta, plaza, operación, workspace, entorno y versiones,
así como las barreras de estado y lease. Otras plazas, perfiles, prefijos, URLs
y variantes de formato siguen rechazadas. La continuidad posterior a VERIFIED
mantiene su exigencia de la referencia física `waha-03`; no necesita excepción.
La corrección y sus pruebas locales no acreditan su publicación ni la provisión
de la plaza. El cierre operativo continúa PARCIAL.

### Autoridad y preparación

1. Obtener B02 auténtico y externo del baseline vigente. Capturar dos veces paquete, pareja Root/B02, nueve servicios, propietario, política, perfiles privados y topología. La cuenta, sesión, plaza y ownership se vuelven a comprobar después de la operación canónica. El orden es `backup terminado <= captura <= creación de PROVISION`.
2. Crear PROVISION mediante la API canónica para la misma cuenta y plaza, con versiones frescas e idempotencia. Tomar después el hold canónico y volver a observar. REAL continúa congelado; las guardas de sesión detenida/pausada, recuperación deshabilitada, ownership congelado sin lease vigente y ausencia de trabajo pendiente/incierto permanecen.
3. Sellar sólo hechos observados del paquete instalado, operación, perfil deshabilitado, credenciales existentes concordantes, imagen fijada, overlay adicional canónico y volúmenes. Conservar ambos volúmenes existentes o autorizar explícitamente su creación vacía sólo cuando ambos nombres estén ausentes. Un volumen aislado, container ajeno, credencial discordante o incertidumbre bloquean. No crear ni rotar secretos para hacer pasar el readback.
4. Bajo los cuatro locks, escribir intención durable antes de cualquier efecto. Preparar exclusivamente `waha-03` detenido, sin pull/build/recreate/dependencias, y sólo la red y dos volúmenes aprobados. Comprobar la definición y topología, incluyendo el estado Docker CREATED que aún no tiene NetworkID. Ningún proceso inicia una sesión de WhatsApp.

Si `waha-03.env` aún no existe, no se inventa una credencial nueva: `credentials-observe` y `credentials-seal` autentican el perfil cifrado existente de la misma cuenta y versiones contra captura, backup, MANUAL, hold y paquete. La materialización obtiene esos dos valores del lector API instalado en una transacción de sólo lectura, por stdin/RAM, y crea únicamente el archivo ausente con O_EXCL/Root600 después de una segunda comprobación. Sus journals contienen referencias y metadatos, nunca los valores. Compara el archivo creado con el perfil vigente y no rota, habilita ni modifica el perfil. Un cambio de versión, presencia concurrente o fallo posterior conserva la intención y exige conciliación; no vuelve a exportar o escribir automáticamente.

La lectura nativa del 2026-10-09 a las 15:45 UTC confirmó ese prerrequisito: `waha-03.env` no existe en la custodia local ni en destino; `waha:WAHA_03` v2 permanece deshabilitado y conserva ambas claves cifradas. Es un hecho previo que se revalida al ejecutar, no una aprobación reutilizable. La observación previa informa únicamente `secrets_present` y `secrets_valid`; `credentials_match` sólo se emite después de comparar valores auténticos del archivo y del perfil. Una API key almacenada como hash `sha512:` no se materializa como secreto de autenticación.

### Arranque, lectura y administración

El arranque usa una sola vez el CID observado de `waha-03`. Guarda intención original y fecha de solicitud antes de `docker start`; un resultado incierto exige conciliación y no produce otro arranque. El tiempo nativo de arranque debe estar entre esa solicitud y el HTTP observado. La lectura autenticada viaja por stdin/RAM. Una respuesta HTTP tardía puede completarse mediante dos lecturas auténticas del mismo CID y linaje, con un nuevo journal exclusivo; no se inventa el fallo anterior ni se reemplaza una lectura existente.

Sólo HTTP correcto, cero sesiones y continuidad de los nueve servicios previos permiten publicar inventario de slot3 y claim/complete del mismo PROVISION por API. Un perfil existente deshabilitado permanece deshabilitado. La operación terminal VERIFIED liga cuenta, plaza, actor, evento y digest de infraestructura. No habilita onboarding, permisos comerciales, ventas ni fuente aislada.

### Adopción y continuidad de B02 programado

La aprobación de adopción conserva el contrato canónico de catorce campos y emite el manifiesto B02 de seis campos contra el baseline auténtico actual. Exige PROVISION terminal, auditoría, HTTP y arranque, nuevo hold, orden temporal y backup todavía fresco. El consumidor conserva el recibo previo de slot1 y sólo añade slot3.

Además de Root y plan, la programación GCP tiene un binding que fija `plan_sha256` y un journal APPLIED que fija el mismo hash. Cambiar únicamente el plan rompe `read_gcp_binding`; conservar `schedule_enabled=true` no prueba continuidad. Tampoco es válido crear directamente otro journal SCHEDULED conservando la custodia anterior: el controlador exige un binding MANUAL previo y custodia comprobada del plan actual antes de volver a programar.

Se usan cuatro épocas operativas mediante los controladores existentes, sin rebases de autoridad ni excepciones a sus guardas:

1. Pausar el Scheduler y pasar canónicamente a MANUAL sobre el paquete y nueve servicios actuales; obtener el B02 previo a la publicación.
2. Publicar el nuevo paquete con nueve servicios preservados. Vincular la imagen de transporte y el modo MANUAL al nuevo SHA/plan observados, sin ampliar Job, executor, permisos, horario o ventana financiera. Obtener B02 fresco y capturar el baseline antes de crear PROVISION.
3. Preparar y adoptar exclusivamente slot3. Conciliar canónicamente MANUAL contra el plan de diez servicios y obtener el nuevo B02 con custodia externa y restauración aislada.
4. Volver a SCHEDULED mediante `gcp-propose-scheduled` y observe/seal/apply, usando la custodia MANUAL del mismo SHA y plan ampliado. Habilitar el Scheduler sólo tras readback correcto; la siguiente entrega natural conserva su evidencia independiente.

Cada época liga su propio SHA, pareja, binding, custodia y journal terminal. Se conservan los bytes históricos, el primer backup y sus permisos originales; no se atribuye una entrega programada que no haya ocurrido. Un binding antiguo, plan incoherente o journal no terminal bloquea la continuación. Mientras el Scheduler está pausado, esa pausa transitoria se declara expresamente; no se presenta como programación efectiva continua.

Después de la adopción se requieren nuevo B02 del inventario ampliado, custodia externa y restauración aislada. El estado WAHA COMOSW01 se comprueba separadamente. Ninguna copia o restauración sustituye autenticación, revocación del origen, pairing o recepción física.

El codec COMOSW01 existente admite ambos gateways sin cambios de fuente. Su próxima derivación administrativa privada debe fijar el SHA y baseline de diez servicios observados, capturar/restaurar dos cápsulas separadas para slot1 y slot3 y preservar los otros nueve servicios durante cada ventana fría. El material anterior ligado a un único gateway no acredita ese inventario ampliado. La carpeta de media exige vacío observado porque el codec respalda sesiones y configuración; si contiene archivos, esta derivación debe detenerse y conciliar el alcance.

## Comprobaciones necesarias

- Regresión de la plaza legacy: misma cuenta/sesión/historia y reserva; ninguna creación por fallo de readback, ningún slot2, ninguna sustitución de slot1.
- Rechazo anterior a efectos por slot/binding/paquete/política/owner/hold/backup/CAS alterados, lease vigente, comandos o efectos inciertos, credenciales discordantes y topología o volúmenes ajenos.
- CREATED a arranque con CID exacto y cero sesiones; ausencia no equivale a cero; HTTP tardío no reintenta START; journals e intenciones durables y exclusivos.
- Adopción acepta sólo el recibo PROVISION y auditoría de la cuenta/plaza exactas, conserva el recibo físico histórico y rechaza la lectura o el evento de otro slot.
- Cuatro épocas GCP: plan enlazado y custodia MANUAL actuales antes de SCHEDULED, historia anterior inmutable, mismo Job/ejecutor/horario/límites y rechazo de un binding antiguo o transición incompleta.
- Pruebas proporcionales de los lectores compartidos conservan el piloto inicial. Fixtures, pruebas Docker aisladas y aprobación local se distinguen de ejecución productiva.

## Pendiente humano separado

Responsable y dispositivo principal, aislamiento real del origen, revocación auténtica, QR nuevo, identidad y pruebas con el receptor propio siguen requiriendo presencia física. Preparar slot3 no los acredita. El límite de 250 mensajes acumulados por número y el congelamiento comercial siguen vigentes. La capacidad del host se mide justo antes de una operación y su observación caduca; no se añade un productor periódico.
