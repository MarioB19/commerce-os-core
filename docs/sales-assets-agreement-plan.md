# Materiales, audios y acuerdo directo — 16 septiembre 2026

## Resultado publicado

Runtime `51c5a539704cbcbaa37e7665b5e88915338ee889`, [CI/CD 35055211672, intento 3](https://github.com/MarioB19/commerce-os/actions/runs/35055211672), SUCCEEDED el 16-sep a las 14:19:32 UTC / 08:19 México. El número terminado en 8571 usa la nueva oferta, el flujo directo y el vendedor publicados por API.

Recorrido: explicar acuerdo de $97 MXN → aceptación contextual → entrega automática Core → datos bancarios inmediatamente → comprobante → beneficios correspondientes al pago aprobado. Cero espera artificial; precio, materiales, banco y condiciones de extras conservados. Una pregunta, negativa o condición no se interpreta como aceptación. Un efecto UNKNOWN conserva el bloqueo y no se repite.

## Plan ejecutado

- [x] Vista previa autenticada de archivos, enlaces y accesos; reproducción web de audio/video, imágenes y PDF.
- [x] Content-Disposition inline con extensión, MIME, Range 206/416, integridad y controles de acceso.
- [x] Conversión oficial `convert: true` en WAHA sendVoice para nuevos audios MP3 → OGG/Opus.
- [x] Vendedor breve y flujo versionado de acuerdo directo, con entrega idempotente y banco después de Core.
- [x] Publicar y releer vendedor, flujo y oferta por API; actualizar la asignación del número.
- [x] Tipos, lint, build, unitarias, integración, recuperación, E2E, CI/CD y HTTPS productivo.
- [x] Revalidar sesión, ownership, permisos, límites e historial por API.
- [ ] Escuchar un audio nuevo en WhatsApp: Brandon decidió hacer esta prueba después.

El cifrado en reposo permanece. La API descifra únicamente el recurso solicitado bajo autenticación. Códigos y enlaces privados no se guardan en el navegador ni se incluyen en el inventario. La CSP permite marcos del mismo origen sólo en el endpoint de contenido; las demás políticas permanecen.

## Evidencia

- CI final: 392 unitarias y una omitida; 466 integraciones y una optativa omitida; 111 E2E. Tipos, lint, build, recuperación y auditoría aprobados. Pruebas locales adicionales: 122 Python y validación Caddy 2.11.4; reproducción de audio y visor PDF nativo revisados en Chromium.
- Pruebas de flujo: acuerdo natural entrega Core y después banco; repetición no duplica material; UNKNOWN impide banco y conserva un único intento.
- Publicación: paquete e informe privados comprobados por hash; seis servicios sanos, 48 migraciones, paridad HTTPS y gateways/volúmenes conservados. El portal HTTPS coincide con el SHA y contiene 480 actividades.
- Producción: seis vistas de materiales correctas; cuatro archivos (dos MP3, imagen y PDF) responden Range 206, inline, private/no-store y una CSP del mismo origen. Los dos MP3 conservan tamaño, hash y decodificación. La petición sin autenticación recibe 401.
- Operación: asignación revisión 2, oferta sin demora y Core.next=bank. El recorrido anterior sin acuerdo aceptado quedó CLOSED mediante comando APPLIED; sus mensajes, pedido y eventos se conservaron. Verificados 14 mensajes y ocho efectos históricos.
- Política revisión 51, reanudación APPLIED/RESUMED, ownership liberado, cuenta WORKING y sending_enabled=true. Autorización sólo para nuevas conversaciones entrantes: 92 salidas restantes del cupo original de 100, hasta el 16-sep a las 21:36 México. Sin campañas, warm-up ni ampliación de vigencia. Recuperación automática apagada.
- Cero mensajes de prueba, QR o reconexiones iniciados por esta implementación. Ocho salidas anteriores DELIVERED; ningún efecto SENDING/UNKNOWN al verificar. La reproducción física de los nuevos audios queda diferida por decisión del usuario; los audios defectuosos históricos en WhatsApp no se reenviaron ni reemplazaron.

## Almacenamiento y recuperación del despliegue

Los intentos 1 y 2 terminaron FAILED en validate con INSUFFICIENT_FREE_DISK, antes de instalar. Brandon autorizó 10 GB adicionales: la API oficial de Compute amplió el mismo disco de 40 a 50 GiB. El sistema de archivos no había crecido automáticamente.

Tras autorizar SSH, se comprobó una raíz ext4 todavía de aproximadamente 40 GiB y sólo 3.55 GiB libres. La prueba seca de growpart confirmó crecimiento disponible; growpart y resize2fs finalizaron con código 0. Una lectura posterior independiente comprobó 47.39 GiB utilizables y 13.24 GiB libres. No hubo reinicio ni escrituras directas en PostgreSQL. La llave SSH temporal se revocó y su ausencia se verificó; también se eliminó la copia local.

El intento 3 reutilizó el paquete sellado, conforme al contrato de transporte, y completó el despliegue. No hubo reintentos de resultado remoto incierto, eliminación de respaldos ni compra de más capacidad. Credenciales en ubicación privada con permisos restrictivos; sin cambios de IAM o RBAC.

## Recibos sanitizados

- [Publicación](evidence/sales-assets-publication-20260916.json)
- [Operación y vistas](evidence/sales-assets-operation-20260916.json)
- [Almacenamiento](evidence/sales-assets-storage-20260916.json)
- [Validación e intentos anteriores](evidence/sales-assets-validation-20260916.json)

Contrato de voz: [WAHA — Send messages](https://waha.devlike.pro/docs/how-to/send-messages/). Publicación y recuperación: [CI/CD](ci-cd.md). Autorizaciones y revisiones: [Operación por producto V5](v5-product-operations.md).
