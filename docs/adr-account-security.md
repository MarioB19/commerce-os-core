# ADR — Seguridad de cuenta y correo de identidad

Fecha: 07-sep-2026 UTC. Alcance inicial: implementación y verificación local H0–H6. Brandon autorizó después publicar el software y eligió Resend; la prueba con destinatario real sigue pendiente. Base `0a53310`, rama `codex/account-security`, worktree y configuración privados separados.

## Decisión previa a implementación

Se reutiliza Better Auth 1.7.2 para hashing, cambio, creación/consumo de verificaciones y sesiones. Su implementación PostgreSQL consume una verificación con DELETE RETURNING, pero el recorrido completo no comparte transacción. Una instancia ligada a la conexión de una transacción PostgreSQL ejecutará cada operación de identidad; un lock por usuario serializa login, solicitud, cambio, reset y despacho de correo. Las membresías activas se releen y bloquean durante las operaciones. Contraseña, revocación obligatoria, invalidación de enlaces y auditoría se confirman juntas; cookies sólo se propagan tras COMMIT. Ningún recorrido escribe hashes manualmente.

Las rutas nativas alcanzables pasan por el mismo controlador, con lista explícita de endpoints. Cambio requiere sesión humana, origen confiable, contraseña actual, nueva 12–128 y confirmación. `revokeOtherSessions` siempre se fuerza a true; identidades objetivo se rechazan. Tokens de sesión se eliminan de JSON. Login también se serializa para impedir la creación tardía de una sesión con una contraseña invalidada. Caché de cookies deshabilitada.

Recuperación: respuesta uniforme, límite persistente por IP y digest HMAC de destinatario, 30 minutos, identificadores de Better Auth hasheados. Una tabla auxiliar relaciona digest y usuario para invalidar todos los enlaces; no almacena tokens claros. La URL se construye desde el origen web confiable, nunca desde Host/callback arbitrario. GET sólo abre la pantalla; token en fragmento para evitar logs/referrers, capturado y retirado antes de arrancar el router. POST valida nuevamente membresía y vigencia bajo lock. Éxito exige login posterior.

Correo de identidad es global y separado de Real/Simulación y del outbox comercial. Configuración singleton versionada, secretos cifrados con el mecanismo AES-GCM existente, accesible sólo a owner. No se reutilizan las tablas de conexiones comerciales porque sus revisiones cambian autorizaciones de campañas. La base gobierna cada lectura; no hay caché de secretos. Destinos/IP SMTP y origen público se restringen por variables protegidas del servidor. SMTP remoto exige STARTTLS/465 y certificado válido; SMTP local sólo admite las direcciones privadas explícitamente autorizadas. Nodemailer es transporte SMTP, sin APIs de proveedores.

La cola dedicada guarda payload cifrado y Message-ID estable, claim durable y estados PENDING/SENDING/ACCEPTED/FAILED/EXPIRED/UNCERTAIN/CANCELLED. El bucle supervisado de API procesa la cola sin esperar en la respuesta pública. Reintentos limitados sólo ante fallo inequívoco; timeout tras DATA o reinicio con claim abandonado queda UNCERTAIN, sin reenvío automático. Se limpia el payload al terminar/expirar/invalidarse. Un lock por cuenta protege la comprobación previa al envío frente a reset; mensajes ya aceptados por un MTA pueden seguir en su spool, pero su enlace deja de servir. Aceptación SMTP nunca significa recepción.

Migraciones aditivas `0020_account_security.sql` y `0021_identity_runtime_grants.sql` para configuración, límites, correlación de enlaces, cola, auditoría global y permisos mínimos exclusivos del perfil `commerce_api`. Workers comerciales y PUBLIC no reciben acceso. No se modifica ninguna migración aplicada. Pruebas con PostgreSQL independiente y SMTP loopback, incluida concurrencia y rollback por fallo de auditoría/revocación.

La resolución inicial de cookie ocurre antes de tomar una conexión transaccional, sin refresh. Dentro de la transacción se revalida sin absorber cookies; el handler nativo hace el refresh y su respuesta se entrega después del commit. Esto evita agotar el pool con lecturas anidadas y perder la cookie de una sesión refrescada. La limpieza confirma las filas de jobs antes de borrar verificadores: nunca retiene locks de jobs mientras espera verificadores, que el reset bloquea primero. Message-ID queda dentro del payload cifrado desde la encolación y no cambia al editar el remitente entre reintentos.

## Viabilidad de infraestructura

Google Cloud documenta bloqueo externo de TCP 25 para la mayoría de proyectos; 587/465 necesitan un servidor de submission, no sustituyen los MX. Se comprueba la VM sin MAIL/RCPT/DATA antes de decidir instalación. La plantilla Postfix queda preparada, sin instalar ni cambiar DNS, firewall o redes. Un relay elegido, identidad de remitente, DNS/PTR/DKIM y recepción acordada siguen siendo requisitos para habilitar producción.

Fuentes: [Better Auth](https://better-auth.com/docs/authentication/email-password), código instalado `api/routes/password.mjs`, `update-user.mjs`, `db/internal-adapter.mjs`; [Google Cloud](https://docs.cloud.google.com/compute/docs/tutorials/sending-mail); [Nodemailer SMTP](https://nodemailer.com/smtp).

## Actualización — Resend elegido por Brandon, 07-sep-2026

La instrucción posterior «tengo resend configurado… actualizar el código para que se use eso» sustituye la exclusión inicial de Resend. Se usa su servicio SMTP con Nodemailer: `smtp.resend.com`, puerto 465/TLS implícito, usuario `resend` y API key como contraseña. No hace falta un SDK HTTP ni instalar Postfix. El panel de Resend mostró `inovaris.online` verificado; esto no acredita configuración en el VPS ni entrega de mensajes.

La UI owner ofrece un preset editable que prepara el formulario sin guardar y propone envío deshabilitado. La API key se introduce por el campo protegido y conserva el cifrado existente. Cambiar de host o modalidad exige reemplazar o eliminar la credencial anterior también por API directa. Los errores AUTH permanentes tienen diagnóstico específico; los temporales conservan el reintento acotado.

Las instalaciones existentes pueden usar `BETTER_AUTH_URL` como origen web confiable cuando no definan `PUBLIC_WEB_ORIGIN` ni `CLIENT_ORIGIN`; se mantiene la validación estricta de HTTPS/origen exacto, sin usar cabeceras del cliente. El generador nuevo declara `PUBLIC_WEB_ORIGIN` y una lista SMTP vacía por defecto. Las IP permitidas del relay se configuran por el canal privado del VPS, sin autoautorizar destinos desde la UI.

Referencia: [SMTP de Resend](https://resend.com/docs/send-with-smtp). Credencial de envío, remitente controlado, conectividad desde el VPS y recepción real se verifican por separado de la adaptación de código. No se reutilizan claves de otros proyectos.

## Corrección del proxy exterior — 07-sep-2026

La publicación `81a3e5b` completó CI/CD y los recorridos HTTPS de cuenta/Resend, pero el proxy exterior conservó `Referrer-Policy: same-origin` y sobrescribió el `no-referrer` del backend/web. El HTML incluye meta no-referrer y los correos nuevos usan fragmentos; aun así, el contrato exige corregir también la cabecera HTTP, incluidos los redirects nativos.

El CI/CD existente actualizará exclusivamente la política del bloque único `commerce-os.inovaris.online` después de instalar el núcleo sano. El helper compara configuración activa/disco para evitar aplicar cambios ajenos pendientes, valida el candidato, conserva el inode montado y los demás sitios, guarda respaldo privado y revierte si falla reload. No recrea Caddy, redes o volúmenes. Configuraciones ambiguas se rechazan. Se añade un gate HTTPS de no-store/no-referrer al informe de despliegue; la paridad de assets por sí sola no verificaba esas cabeceras.

Esta corrección de publicación utiliza la identidad temporal existente de CI/CD. No necesita acceder a la cuenta Google en el navegador ni resuelve la autorización pendiente para configurar SMTP mediante Cloud Shell.
