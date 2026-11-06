# V7.2 — Grupos propios, biblioteca y autoridad QR

Estado: aprobado por Brandon el 5 de noviembre de 2026; implementado y en validación de release.

Brandon autorizó implementar, probar y publicar V7.2. Crear e iniciar programas
está permitido desde web, API y MCP con `warmup:write` y los mismos controles.
La conexión QR verificada sigue siendo el origen del permiso; un token no puede
inventarla ni saltar pausas, revocaciones, pertenencia al perfil o salud.

## Contrato

- Un programa `QR_GROUP` utiliza un grupo existente. Todos sus destinatarios
  físicos deben ser números propios identificados del perfil. Se reservan todos
  los miembros; al menos dos se seleccionan como emisores.
- No se modifica el significado de `QR_CONTINUOUS` ni del legado. La transición
  explícita cancela efectos pendientes, bloquea `SENDING`/`UNKNOWN`, conserva
  episodios/evidencia y no convierte participaciones históricas en crédito saliente.
  Nuevos números esperan selección de grupo; no arrancan el catálogo de 12 checks.
- Biblioteca estática, original y versionada, sin dependencia de IA. Importación
  valida forma, propiedad, duplicados normalizados y cobertura. El contenido usado
  es inmutable. Selección persistida y determinista por programa/día, sin repetir
  guion ni texto durante siete días por grupo o número.
- Cuotas independientes: salientes del grupo y salientes por emisor. No se
  multiplican por receptores. Reservas e incertidumbre consumen capacidad; no se
  reintenta `UNKNOWN`. Curva conservadora de 14 días efectivos, evaluación desde
  día 15 y evidencia de salud/entrega; no representa reputación de WhatsApp.
  `group-outgoing/v1` traduce el mínimo diario a salientes: limita el mínimo
  de la curva por la parte entera de la capacidad del grupo/ventana completa
  entre sus emisores. Empezar tarde no reduce ese mínimo. Así diez emisores
  pueden completar evidencia dentro de nueve horas sin exigirles seiscientos
  envíos en una ventana cuya capacidad es menor. La previsualización rechaza
  límites que no permitan completar intercambios enteros de la biblioteca. No se reetiquetan créditos previos.
- Outbox, observación de integrantes, recibos individuales, aislamiento del
  proveedor y compuerta final son compartidos. Cada efecto fija revisión del
  programa, biblioteca, grupo, emisor y miembros; se relee antes de emitir.
  Observación, planificación y comandos toman primero el lock del perfil.
  El dispatcher ya posee una fila outbox: intenta ese lock sin esperar y difiere
  con `GROUP_WARMUP_BUSY` si está ocupado. Así una pausa o cambio de integrantes
  puede cancelar pendientes sin invertir locks. El recheck no consume envío.
- Pausa cancela lo no iniciado. Reanudar planifica sólo capacidad futura de hoy;
  nunca recupera días perdidos. Archivar conserva historial. Mantenimiento debe
  elegirse al configurar y cede prioridad a conversaciones comerciales.
- Una familia API `/v2/warmup` y acciones cerradas en `warmup_manage`; se conserva
  el presupuesto de 40 herramientas MCP. Las tres superficies comparten dominio.

## Publicación y verificación

Pruebas con PostgreSQL restringido y proveedor simulado, cobertura 2/3/10 líneas,
cuotas/concurrencia/pausas/RLS/recibos/reinicio, regresión de ventas y legado.
Migración aditiva desde 0117, FULL nativo y paquete canónico del SHA publicado;
ensayo de instalación aislado antes de producción. Verificar instalación y recorrido productivo.
Un intercambio físico sólo se acredita con QR y grupo propios disponibles y sus
recibos observados; nunca con resultados del simulador.
