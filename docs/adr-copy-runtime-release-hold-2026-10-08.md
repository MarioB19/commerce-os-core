# Barrera de publicación para la primera continuidad de consumidores

CORE_PREPARED conserva cinco servicios, política REAL congelada y release_hold falso para ejecutar cancelación y cuarentena por las APIs canónicas. Antes de iniciar los consumidores, el controlador toma el hold duradero y comprueba nuevamente las barreras. Un SELECT previo al arranque no excluye cambios concurrentes de otros owners.

Las mutaciones REAL de canales, números y capacidad toman el lock operacional exclusivo antes de locks de cuenta y rechazan el hold. Las actualizaciones de integraciones hacen lo mismo. Las lecturas permanecen disponibles; SIMULATION conserva su operación. La API no convierte el hold en autorización ni cancela órdenes por SQL.

El worker no reclama órdenes REAL durante el hold. Revalida bajo lock operacional compartido antes de lifecycle remoto, health, historial y QR; el lock permanece durante la llamada del proveedor. El hold Root espera que esa lectura u operación termine antes de establecer la barrera. El orden es operations → channel-command, evitando inversión con la API. Ningún recibo de aislamiento, permiso comercial ni cuota cambia por este contrato.

La capacidad declarada en la imagen es un contrato de construcción ligado al candidato. Las regresiones PostgreSQL y las llamadas de proveedor synthetic acreditan su comportamiento; un archivo marcador solo no constituye una prueba. Instalación, lectura real de la capacidad y continuidad todavía pendientes.


## Persistencia después de una lectura en curso

Salud, media y observaciones de grupo repiten SHARE y verifican el hold antes de persistir. Los claims de salud omiten perfiles de canal explícitamente deshabilitados; los de grupos omiten scopes held antes del cupo global y mantienen el orden de la cola. Un claim de grupo previo conserva su lease hasta vencer si el hold impide cleanup. Dispatch difiere RELEASE_HOLD_ACTIVE sin modificar outbox ni su agenda.

La barrera no afirma cobertura universal de writes de recuperación o de todos los SDK. El publicador detiene los workers al reemplazar un runtime OPERATING y exige cero envíos SENDING, operaciones pagadas, number_operations PREPARING con lease vigente, perfiles APPLYING y comandos lifecycle PENDING con processing_owner. Un comando sin claim puede conservar su intención para la operación posterior. No convierte una recuperación o una fila incierta en éxito.


## Continuidad QR sin locks anidados

La API comprueba el hold antes del proxy sin conservar SHARE durante HTTP; el worker conserva SHARE como autoridad de la lectura SDK. Mantener ambos locks puede formar un ciclo si el hold exclusivo de Root entra entre las dos peticiones. Después del proxy, la API vuelve a tomar SHARE y descarta bytes y auditoría de éxito si el hold ya quedó confirmado. Propaga el rechazo 409 del worker. Cuatro regresiones PostgreSQL comprueban el orden con Root en cola, descarte posterior, entrega sin hold y rechazo anterior sin llamadas ni auditoría; usan una URL y transporte sintéticos autocontenidos.
