# API-first: catálogo y publicación interna

Fecha: 2026-09-06. Decisión previa a implementación; complementa ADR-003 y conserva Fastify, PostgreSQL, `/v1` y snapshots inmutables.

Reproducción local con PostgreSQL aislado (migraciones 0001–0014): crear producto/oferta/flujo devuelve 201; publicación por servicio devuelve 403 aun con todos los scopes disponibles; versiones de oferta/flujo y transiciones de producto devuelven 404. Las credenciales, usuarios y productos fueron sintéticos. No se llamaron proveedores.

Se agregan scopes explícitos de lectura y publicación interna (`products:publish`, `offers:read`, `offers:publish`, `workflows:read`, `workflows:publish`), manteniendo compatibilidad de scopes previos. Una credencial de borradores conserva su prohibición de publicar. Publicar internamente no genera comandos, outbox, autorizaciones ni efectos externos. Los materiales, banco y política continúan siendo requisitos de una oferta lista; se consultan como referencias sanitizadas sin entregar secretos.

Productos conservan ID y `record_versions`; una revisión explícita vuelve a DRAFT y las transiciones permitidas son DRAFT → PUBLISHED/ARCHIVED, PUBLISHED → ARCHIVED, ARCHIVED → DRAFT. Ofertas y flujos conservan IDs inmutables por versión, agregan linaje `series_id` y relación con la versión anterior. Duplicar crea un linaje nuevo. Rollback crea una versión nueva dentro del mismo linaje; jamás acepta un flujo ajeno. Publicaciones bloquean por registro, verifican versión y rechazan otra publicación del mismo borrador.

Se agregan rutas para revisiones, versiones y validación por ID sin cambiar endpoints consumidos por la web. Relaciones producto/oferta/flujo/agente/assets se validan en el mismo workspace y entorno; las asociaciones no requieren cuenta WhatsApp. Errores estructurados conservan la lista textual compatible con la UI. OpenAPI documenta schemas, scopes, respuestas y requisitos de idempotencia/concurrencia.

La prueba API directa crea una credencial mediante sesión humana sintética; prueba alta, revisión, publicación, historial, aislamiento, concurrencia, deduplicación y revocación. Cuenta efectos antes/después y verifica que siguen ausentes. La prueba de navegador complementaria comprueba que el catálogo y los flujos creados por API aparecen en la misma web.
