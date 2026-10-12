# Recuperación explícita de SOURCE anterior al upload

11 de octubre de 2026. Decisión prospectiva adoptada: ningún retry ni cambio de
contabilidad hasta autenticar originales nativos y revisar el operador.

Un fallo anterior a upload puede dejar consumida la intención de adquisición y
retenidas dos reservas distintas. La adquisición sólo lee proveedores y escribe
archivos efímeros. La escritura del objeto de fuente exige una intención posterior
separada. No se supone que una excepción ni HTTP200 demuestren ausencia de efectos.

Un parser común verifica la solicitud exclusiva original, su único log terminal,
la respuesta STOP_PRESERVE, la identidad exacta del servicio/revisión/imagen, el
control actualmente pausado, el ledger RESERVED sin submit_intent/UUID, el diario
con únicamente adquisición sin resultado y la respuesta nativa404 del objeto
exacto. Un inventario global nuevo debe coincidir con la admisión anterior: ninguna
construcción nueva puede ocultarse en la conciliación. Los metadatos, generaciones,
bytes y hashes de las lecturas GCS se autentican antes y después de cada lectura.
Los originales y el recibo están ligados a una adopción externa protegida; JSON
aportado por una petición HTTP no tiene autoridad.

Primero, la transición canónica ABORTED_BEFORE_DISPATCH preserva plan, aprobación,
admisión, evento y reserva histórica de95min; libera únicamente la reserva que
nunca llegó a CreateBuild. No crea un UUID ni una observación terminal ficticia.
El consumo histórico74min permanece. Si el CAS es incierto, sólo se observa.

Después, el medidor compara el ledger completo con el aborto esperado y conserva
cada fila, instante, mes y techo. La fila SOURCE450s termina por conciliación con
hash del recibo; permanece íntegramente cobrada junto con los470s previos. No se
borra la intención, no se reinicia el medidor y no se atribuye éxito de SOURCE.
La recuperación tiene su propia admisión económica, plazo y presupuesto de API.

Cada CAS requiere observación fresca y revalidación final de los originales y
la generación inmediatamente antes del envío. La ejecución anterior debe haber
terminado y superado su techo450s; el control pausado impide iniciar trabajo nuevo.
La recuperación parcial mantiene bloqueado el medidor hasta lectura concluyente
del ledger. Una nueva fuente o imagen se somete a su propia procedencia y gates.
