# Diagnóstico seguro de SOURCE y reservas inciertas

11 de octubre de 2026. Decisión prospectiva; no acredita la causa del incidente
nativo ni autoriza repetir su adquisición.

El primer SOURCE público terminó con STOP_PRESERVE y dejó su intención de
adquisición sin resultado. No hay intención de upload en el diario observado.
El controlador ocultó el código de EvidenceError y el log nativo sólo registra
HTTP200. Ese HTTP confirma la respuesta, nunca el éxito del trabajo. La reserva
de 450 segundos y todo el historial anterior permanecen retenidos.

El controlador devolverá únicamente códigos enumerados del código confiable y
una fase también enumerada. Nunca serializará excepciones arbitrarias, stderr de
Git, URL, rutas, cabeceras, credenciales ni respuestas de proveedores. Un código
no enumerado conserva el resultado genérico. Los errores de Git distinguirán la
operación fija (init, fetch, checkout, inventario, estado o fsck), sin argumentos.
El cambio es diagnóstico: no agrega retry, escritura compensatoria ni finaliza
el medidor ante una excepción.

Las pruebas recorrerán tick y RuntimeFactory reales con ledger, journal y meter
CAS en memoria. Se inducirán fallos antes y después de la intención para probar
que el diagnóstico corresponde a la fase y que la reserva/exclusión se conservan.
Una reproducción local separada usa el mismo child Linux publicado, originales
locales y Git/archivo reales; los proveedores simulados impiden atribuir ese
resultado a permisos o ejecución nativa de Cloud Run.

La recuperación económica y el aborto anterior al dispatch son transiciones
separadas, con sus propios contratos y evidencia nativa. El diagnóstico por sí
solo no permite desbloquear el medidor, liberar la reserva de FULL, repetir una
intención ni atribuir pruebas de un SHA a otro.

El cierre funcional asociado en `_admit` es distinto del diagnóstico: después de
las transiciones CAS se relee el intento y se exige RESERVED con la exclusión
exacta. Repetir una tarea ADMIT de un evento abortado ya no devuelve la etiqueta
literal RESERVED tras tres no-op. Su prueba conserva el documento completo y
comprueba que no se llama a CreateBuild. No reabre ni sustituye eventos abortados.
