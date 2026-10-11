# Mi Ciclo Listo: ensayo físico y patrocinio Madrina

Decisión previa a implementación, 12-sep-2026. Fuente: plan rector y prompt de ejecución del lanzamiento, y Operación Madrina de Costura (27-jul), con las correcciones comerciales del 12-sep.

Un total de comprobantes positivos aprobados estrictamente mayor a 10700 centavos crea un patrocinio por pedido, sin conciliación adicional. Se conserva Calendario/Kit y se registra `max(0,19400-total)` para revisión humana; 19400 es referencia contable histórica, nunca un precio mínimo. Correcciones o clasificación Falso suspenden nuevas acciones si el total deja de ser elegible. La recepción confirmada no se inventa ni se revierte retroactivamente.

El ensayo físico se registra antes de recibir compromisos o comprobantes: propietario, contactos existentes, número, oferta, propósito, vencimiento y roles. El pedido nace TEST, irrevocablemente fuera del ingreso comercial. Su total documental de prueba permite probar beneficios sin cambiar `receipt_sales_v1` ni hacer una venta REAL para reclasificarla después. La vigencia del ensayo no autoriza transporte ni IA; las autorizaciones existentes siguen siendo obligatorias y se validan al despachar.

La beneficiaria usa una conversación propia y consentimiento respaldado por mensaje entrante. Un operador confirma elegibilidad, asigna y solicita entrega. La conversación pasa a patrocinada, sin obligación de pago, sin vendedor automático ni cobro. Se reutiliza el mismo acceso Core; no se crea un tercer código. Solo tras envío confirmado y confirmación entrante revisada de apertura Core/PDF puede proponerse el aviso a la madrina, sin datos de la beneficiaria. Los efectos pasan por commands/outbox y sus controles habituales. Se impide duplicar beneficiaria, entrega y aviso.

Se añaden tablas específicas y permisos mínimos. No se cambian migraciones históricas ni se habilitan números, pauta, publicación o envíos al migrar. La API y la UI exponen pendiente, efecto, proveedor y evidencia de apertura por separado. Las pruebas locales y los fixtures no acreditan teléfono, elegibilidad CTWA ni revisión pedagógica.
