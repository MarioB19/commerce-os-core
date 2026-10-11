# Configuración operativa administrada desde Commerce OS

Decisión del 06-sep-2026, solicitada por Brandon: administrar desde la plataforma la configuración de Ventas, conexiones, credenciales, límites, activación de números y asignación de producto/oferta/flujo. Incluye implementación, validación y publicación en la instalación existente. El primer producto es Mi Ciclo Listo — Preescolar, cuya oferta y materiales se recuperan de Vibe Marketing.

## Autoridad y persistencia

La base de datos es la autoridad de configuración operativa. Se eliminan las tres banderas de despliegue que impedían habilitar REAL desde el panel. Cada workspace y entorno tiene configuración versionada; sus valores por defecto no autorizan envíos. Los workers leen la revisión vigente al ejecutar y antes de despachar. Las autorizaciones quedan vinculadas a esa revisión; cambiar una conexión o una condición relevante invalida la autorización anterior.

Los ajustes de infraestructura necesarios para arrancar el sistema —acceso a su propia base de datos, identidad de los procesos, llave maestra de cifrado, puertos/redes y ubicación de volúmenes— siguen siendo responsabilidad del instalador. No son requisitos que el operador deba editar para activar un número, configurar proveedores o montar un producto. El panel identifica esta frontera sin presentar estos datos como configuraciones operativas pendientes.

## Credenciales y conexiones

Conexiones Meta, IA, WhatsApp y entrega utilizan perfiles persistidos con secretos cifrados. Sólo el administrador puede reemplazarlos o retirarlos; GET devuelve presencia y estado, nunca valores. Ni la auditoría ni la idempotencia almacenan texto de secretos. Las rutas de cada proveedor validan destinos para impedir que una URL configurable acceda a metadata, loopback u otros servicios internos. Los gateways privados usan destinos de la topología permitida.

El despliegue importa una vez la configuración privada existente con un auxiliar autorizado que sólo emite conteos. No conserva precedencia oculta de variables operativas del servidor. Cambios de autenticación de webhooks deben coordinarse con el gateway; no se declara una rotación aplicada sólo porque el formulario se guardó.

## Operación por número

Producto → oferta publicada → versión de flujo → agente → número forman una asignación explícita. El servidor comprueba compatibilidad, materiales de entrega y cobro, identidad y salud del canal, permisos y límites. Guardar una asignación determina qué versiones usarán conversaciones nuevas y no reescribe las anteriores.

La activación tiene un preflight vigente y una revisión explícita del administrador. La UI calcula su autorización mediante selectores y límites; no pide hashes ni JSON como recorrido principal. Conectar por QR conserva separadas la identidad y la capacidad de enviar. La pausa, desactivación y revocación se aplican por entorno y quedan auditadas.

## Validación y primer producto

Pruebas con PostgreSQL y proveedores aislados cubren permisos, cifrado, versiones, cambios concurrentes, revocación y comportamiento de los workers. E2E cubre configuración desde UI, asignación y activación con evidencia del resultado, sin registrar credenciales ni QR.

El catálogo productivo se prepara con los materiales existentes y precios constatados del producto de preescolar. La prueba real llega hasta el límite verificable sin el teléfono del usuario. Cualquier primer mensaje debe tener destinatario, contenido y alcance concretos; no se envían mensajes a clientes existentes como efecto de configurar o desplegar.

## Detalles de ejecución y recuperación

Los alcances permiten contactos seleccionados o nuevas conversaciones entrantes. Esta segunda modalidad exige creación de conversación y tiempo del proveedor posteriores a la autorización, ventana de atención vigente y ausencia de campaña saliente; conserva límites, caducidad, revisión operativa y versiones del catálogo. No libera efectos históricos bloqueados.

Los portales existentes con código compartido usan un acceso estático cifrado. La concesión local es idempotente y describe entrega de credenciales existentes; no equivale a crear una cuenta ni verificar consumo del material. El flujo incorpora una espera de respuesta sin temporizador para preservar la compuerta comercial de preescolar.

Cada despliegue congela la política REAL en base de datos y aumenta su revisión antes de reemplazar procesos. El instalador verifica la eliminación del contenedor anterior y registra evidencia de aislamiento por owner y generación. El worker puede consumirla para recuperar la sesión desde la plataforma. Ni una lease vencida ni un cambio de nombre constituyen prueba de aislamiento. La transferencia automática de un piloto sin vincular se limita a cuentas sin identidad ni historial de efectos reales.
