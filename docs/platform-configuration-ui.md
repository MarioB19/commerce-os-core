# Configuración desde la plataforma

Controles de números publicados en `637a94c`: desconexión independiente del permiso de preparación, diagnóstico QR y confirmaciones para desvincular/eliminar conservando historia. La verificación HTTPS abrió y canceló ambos diálogos, sin operar números reales. [Evidencia productiva](evidence/integrated-production-publication.json).

Implementación del 06-sep-2026 conforme a [[adr-platform-configuration-2026-09-06]]. Este documento describe los formularios; las comprobaciones de backend y despliegue se registran por separado.

## Sistema

En `/settings`, **Operación** permite elegir modo congelado u operación con cuentas y alcances autorizados, permitir vinculación de números y ajustar frecuencia por contacto y concurrencia por número. El servidor guarda una revisión por workspace y entorno. Habilitar Real requiere revisión explícita; cada cambio incluye motivo y `expected_version`.

**Conexiones** usa la definición tipada de la API para Meta, IA, WhatsApp y entrega. Dejar una credencial vacía conserva la existente; retirarla es una acción explícita. Los formularios de secretos llaman a la API directamente, sin guardar variables o respuestas privadas en la caché de mutaciones. Al cerrar o guardar se descartan los secretos de la pantalla. La UI no muestra valores almacenados ni prueba proveedores con envíos.

La **pausa adicional de todo el espacio** indica que afecta a ambos entornos. Congelar y liberar requieren motivo. Liberar no sustituye el modo, los límites ni las autorizaciones propias de cada entorno.

En **API y tokens**, el administrador selecciona permisos y vigencia para crear accesos limitados. La credencial aparece una sola vez en un campo protegido y puede copiarse al gestor de secretos; cerrar elimina el valor de la pantalla. La lista sólo permite consultar metadata y revocar.

## Preparación por número

Ruta: `/sales/channels/whatsapp` → número → **Preparar este número**.

1. Seleccionar producto, oferta publicada, flujo publicado, agente y conexión. Las opciones respetan familias de versiones. Cambiar el gateway requiere desconectar previamente. Guardar fija la asignación para conversaciones nuevas y deshabilita la cuenta hasta nueva revisión.
2. Actualizar las comprobaciones y resolver sus vínculos. Habilitar usa la revisión de cuenta y configuración vigentes. La desactivación está disponible para cuentas habilitadas.
3. Definir audiencia, máximo de mensajes, vencimiento y permiso de automatización. La opción predeterminada selecciona contactos con conversación observada en ese número; la selección no registra consentimiento. La alternativa **Nuevas conversaciones entrantes** contempla únicamente contactos que escriban después de autorizar, dentro de su ventana de 24 horas; excluye la base histórica y el inicio de conversaciones salientes. El servidor calcula el alcance y su hash. La autorización puede revocarse desde el mismo asistente.

Los conflictos de versión se muestran sin reintentar automáticamente la operación. El asistente no solicita QR ni envía mensajes como efecto de abrirlo, guardar la asignación o registrar el alcance.

## Materiales y oferta

En `/catalog`, **Agregar material** admite archivos privados, enlaces HTTPS, accesos de portal con código y referencias de un servicio de entrega. El portal tiene URL, código protegido obligatorio e instrucciones; se serializa internamente como `delivery_reference` para cifrado en el backend, sin publicar el código en el nombre ni en una URL pública del material. Cerrar o guardar descarta los campos protegidos. La creación y carga usan llamadas directas y claves idempotentes estables para el intento.

Las ofertas configuran entregas como filas: material disponible, liberación al aceptar compromiso / aprobar comprobante / conciliar pago, e importe mínimo opcional en centavos. Se validan filas incompletas, importes inválidos, duplicados y un máximo de treinta entregas. El usuario no necesita escribir JSON.

## Validación

`tests/e2e/configuration.spec.ts` intercepta todas las rutas `/v1` y prueba los controles de Real, conservación y descarte de secretos, permisos del administrador, token efímero, asignación/activación/alcance, portal protegido y filas de entrega. Usa sólo fixtures sintéticos; no sustituye la integración con PostgreSQL ni la comprobación productiva. La ejecución aislada usa web estática en localhost:5174, sin API, workers o base de datos.

## Desconectar, desvincular y eliminar números

Incremento local del 07-sep-2026 UTC, pendiente de publicación: [[adr-channel-lifecycle-controls]].

En Ventas → Números, abrir el número:

- **Desconectar** detiene la sesión y pausa su actividad. Funciona aunque Vinculación de números esté en pausa.
- **Desvincular WhatsApp** pide confirmación y cierra la sesión WAHA. Volver a vincular requiere un nuevo QR. Esperar «Acción aplicada» antes de eliminar.
- **Eliminar número** pide confirmación y lo retira de la lista y selectores. Conserva conversaciones, ventas y auditoría. Un número nuevo sin sesión se elimina directamente; uno con sesión debe estar detenido y desvinculado. Las acciones pendientes y envíos inciertos deben resolverse antes. No se borra el perfil cifrado de la conexión.

Las operaciones respetan el entorno seleccionado. El servidor comprueba permiso, versión e idempotencia. La eliminación no reactiva envíos ni borra resultados comerciales.

Si aparece `QR_OPERATION_NOT_AUTHORIZED`, cambiar Sistema → Operación → Vinculación de números a **Permitir conexión y QR** y guardar con motivo. El modo de despacho puede permanecer **Congelado**. El monitor muestra esta explicación y un acceso a Configuración.
