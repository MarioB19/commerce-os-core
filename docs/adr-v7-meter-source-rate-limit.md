# ADR V7 — Conciliar el medidor tras SOURCE429 sin liberar CI

Fecha:11-oct-2026. Implementación pura; los efectos permanecen reservados al
adaptador Root revisado y a originales nativos recientes.

El intento SOURCE del candidato actual recibió un429 en el fence posterior al
intent de adquisición. El incidente ocurre antes de adquirir/archivar o subir
fuente. Se conserva el mismo evento, plan, candidato y reserva FULL de95 minutos.
No se usa el aborto anterior ni se libera esa reserva de CI. Tampoco se declara
un Build exitoso o se inventa un UUID nativo.

El parser cerrado `cloudbuild_source_resume` exige originales correlacionados:
respuesta429 y fase exacta, control pausado, journal con adquisición sin resultado
ni upload, objeto ausente y solicitud terminada. Se espera el techo completo de
450s más30s de margen. Sólo ese recibo autenticado y vigente puede alimentar
`cloudbuild_meter_source_resume`; un recibo construido por un cliente no es
prueba. La generación y bytes íntegros del ledger420 deben ser los mismos que
observó el parser, todavía RESERVED, sin submit intent ni Build.

El módulo produce únicamente una propuesta: conserva toda fila, mes, fecha,
techo y uso del medidor; cambia la fila activa de RESERVED a COMPLETED, agrega
el hash de su recibo y elimina `active_request`. El nuevo incidente retiene
sus450s completos además de todo consumo anterior. No hay reembolso de tiempo,
peticiones, memoria, dinero ni cuota. Se conservan incluso las reservas que
cruzan meses. La propuesta no permite una nueva adquisición ni una CAS por sí
sola; la continuación del journal pertenece a otro contrato específico.

El adaptador Root debe releer metadata/media/current de ledger y medidor,
validar originales y admisión después del intent durable y enviar una sola CAS
contra la generación prevista. Una respuesta incierta permite sólo GET del
documento exacto; nunca reenvía esa CAS. No se expone una operación HTTP pública
ni una bandera para seleccionar recuperación o límites históricos.
