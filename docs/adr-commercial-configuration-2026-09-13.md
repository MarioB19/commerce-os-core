# Configuración comercial independiente de conexiones

Decisión del 13-sep-2026, solicitada por Brandon para el cierre de Mi Ciclo Listo.

Producto, oferta, flujo, vendedor y materiales se publican internamente sin cuentas ni
proveedor IA. Publicado describe una configuración revisada, no permiso para operar.
La disponibilidad del proveedor/canal y la autorización operativa se calculan por
separado. No se crean cuentas, modelos ni credenciales de relleno.

Un vendedor con proveedor `workspace` y modelo `null` referencia exclusivamente la
conexión de IA de Ventas `openai:default`. El modelo, tarifas y límite por respuesta
se resolverán desde esa conexión cuando el propietario la configure. Sin todos esos
datos no hay inferencia; no se utiliza Inteligencia, Estudio ni un proveedor alterno.
Los vendedores históricos con modelo explícito conservan su contrato. Las pruebas
deterministas permanecen explícitas y sólo acreditan reglas/contexto/herramientas.

Los IDs comerciales se comparten mediante `/channel-accounts/:id/setup`. Cada cuenta
conserva revisión, binding, sesión, controles y autorizaciones. La asignación por lote
usa la misma operación, valida una revisión por cuenta y retorna cada resultado;
los reintentos conservan una clave por elemento. Guardar siempre deja envíos apagados.
Publicar versiones nuevas no modifica bindings ni conversaciones anteriores.

El importador exige el ID del producto canónico cuando existe. Usa la API de versiones
del mismo producto y referencias existentes de Core, Kit y cobro. Conserva un diario
recuperable por release y comprueba hashes. La revisión técnica/editorial identifica
al agente que la realizó y no afirma revisión humana, jurídica ni pedagógica.

La retirada de configuración usa archivo recuperable, separado del estado publicado.
Los registros archivados salen de las selecciones nuevas, pero siguen consultables por
ID, conservan referencias históricas y pueden restaurarse con control de revisión.
No se eliminan pedidos, comprobantes, conversaciones, auditoría ni cuentas.

Se mantienen autenticación, permisos, entorno, consentimiento, ventanas, presupuesto,
revisión humana del comprobante, control humano y despacho autorizado. La prueba física
y la evaluación IA real quedan diferidas por decisión del propietario.
