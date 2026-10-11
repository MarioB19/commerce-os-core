# Decisión: aislamiento del origen sin atribuir una parada Docker

El billing del proyecto anterior está cerrado. Compute no permite inspección
actual y Asset Inventory sólo conserva un corte indexado: no es evidencia de
que un contenedor Docker específico haya sido detenido. No se reactivará el
origen para fabricar ese recibo.

La nueva migración67 incorpora un método separado: observación real de Billing
Google por el owner original más revocación humana de los dispositivos Commerce
anteriores desde el teléfono principal. Root crea un desafío de corta vigencia,
vinculado a cuenta/sesión, owner/generación anterior, generación de credenciales,
responsable y principal. La API sólo registra la declaración humana con revisión,
idempotencia y locks. La IA no puede inferirla a partir de disponibilidad o permiso.
Root conserva la evidencia técnica y emite el recibo únicamente tras cotejar los
dos componentes. El método declara su procedencia y nunca afirma parada Docker.

El worker acepta únicamente un recibo Root terminado, no vencido, no consumido y
vinculado al mismo owner/generación y principal/credenciales. Se mantienen los
gates de lease, freeze, reconciliación y aislamiento del gateway. No concede
permisos comerciales ni envía mensajes. Un QR fresco, identidad y recepción
físicos siguen siendo pasos independientes. Las migraciones65 previas no se editan.
