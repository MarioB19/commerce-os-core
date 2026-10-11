# Portal Mi Ciclo Listo en el VPS existente

Decisión del 13-sep-2026, autorizada por el pedido de cierre completo. Vercel informa plan Hobby activo y su uso comercial no está permitido. Se conserva `https://ciclo.inovaris.online`, sin compras ni recursos Cloud nuevos. El despliegue de Vercel permanece como recuperación hasta verificar su sustituto.

El portal Next.js independiente se incorpora en `portals/mi-ciclo-listo`. El CI/CD actual verifica y empaqueta una cuarta imagen Linux/amd64 con los diez PDFs privados, sin credenciales durante build. El mismo job productivo, identidad OIDC y exclusión de despliegue instala el portal después de verificar Commerce. El contenedor no publica puertos del host; Caddy comparte únicamente la red proxy existente. Los límites de memoria/CPU y estado de todos los contenedores ajenos se comprueban y preservan.

Los dos códigos actuales se verificaron por el API de acceso y permanecen válidos. Sus hashes se inyectan en ejecución desde configuración privada. Vercel no permite leer su secreto sensible de sesión; el traslado utiliza un secreto nuevo, de modo que las sesiones antiguas pueden requerir ingresar el mismo código nuevamente. No se exfiltra configuración de Vercel ni se cambia la IA de Ventas.

Se respalda la configuración Caddy y se modifica exclusivamente el bloque de `ciclo.inovaris.online`, comprobando concurrencia, configuración activa y reversión. El corte DNS conserva el resto de la zona y sólo ocurre después del healthcheck y la verificación del nuevo origen. El artefacto registra commit, imagen, PDFs y resultado; HTTPS y el recorrido autenticado completan la comprobación tras el corte.

Los intentos fallidos usan un almacén SQLite local persistente con ventana de quince minutos. Caddy sustituye las cabeceras de dirección/origen reenviadas, el contenedor queda inaccesible directamente y los registros tienen rotación limitada. Los PDFs y los códigos nunca forman parte de los bundles públicos. El Calendario sigue sin ruta de descarga en el portal.

La identidad, domicilio y contacto del responsable de privacidad/soporte aún requieren datos confirmados. Se muestran como pendientes mientras falten; desplegar el software no acredita completar esos datos ni revisión jurídica o pedagógica humana.
