# Mi cuenta y recuperación por correo

Ajuste del proxy integrado y publicado en `637a94c`: cuatro rutas de identidad responden `no-store` y `no-referrer`. Login, Seguridad y preset Resend se comprobaron por HTTPS; configuración SMTP versión 2 y credencial cifrada se conservaron con recuperación habilitada. [Evidencia productiva](evidence/integrated-production-publication.json).

Incremento preparado en `codex/account-security` desde `0a53310`; entrega local original `b33910c`. [Decisión de arquitectura](adr-account-security.md). El 07-sep-2026 Brandon eligió el servicio Resend existente por SMTP y autorizó publicar el software mediante el CI/CD habitual. El código `81a3e5b` fue publicado por CI/CD; la verificación HTTPS funcional pasó y detectó una política anterior del proxy exterior, cuya corrección acotada pasó 39 pruebas Python y un ensayo Caddy real aislado; espera la publicación coordinada. No se instaló un MTA ni se cambió ninguna contraseña real.

## Revisar en este Mac

Carpeta independiente: `/Users/example-user/.local/share/commerce-os-worktrees/account-security`.

```sh
cd /Users/example-user/.local/share/commerce-os-worktrees/account-security
export PATH="$HOME/.local/share/commerce-os-toolchain/node_modules/.bin:$PATH"
pnpm account:review
```

La revisión quedó arrancada al entregar. Si estas direcciones ya responden, no repetir el comando. Para volver a iniciarla después, usar el comando anterior.

Abrir [Commerce OS local](http://127.0.0.1:5473) y [bandeja SMTP local](http://127.0.0.1:8027). API y servicios usan 3301–3304. Si algún puerto está ocupado, no detener procesos ajenos: ajustar los puertos de este runtime y su proxy/origen. La suite no reutiliza un servidor existente salvo `E2E_REUSE_SERVER=true` explícito.

La configuración ya preparada está en `~/.config/commerce-os-account-review/runtime.env`, fuera del vault/Git, directorio 0700 y archivo 0600. El usuario sintético es `review@commerce.test`; su contraseña inicial está en `BOOTSTRAP_PASSWORD` en ese archivo. La fuente de verdad después de cambiarla es Better Auth en PostgreSQL: ese archivo no se actualiza ni revierte la contraseña. Recuperarla por la bandeja local funciona sin copiarla a notas. `Ctrl+C` detiene únicamente los procesos iniciados por este comando.

Para otra máquina/copia nueva, preparar Node/pnpm y PostgreSQL según [guía de desarrollo](publishing-changes.md), instalar dependencias y ejecutar `pnpm account:setup`, `pnpm build`, `pnpm account:review`. El setup crea otra base vacía utilizando sólo la conexión al PostgreSQL local; genera nuevas claves y acceso sintético, sin copiar proveedores ni datos reales. No volver a ejecutar setup sobre una configuración existente.

`account:review` habilita únicamente SMTP loopback 2527 en esa base de revisión. Captura en memoria, sin retransmisión externa; sólo acepta destinatarios `example.invalid` y `commerce.test`. La bandeja expira los enlaces a los 30 minutos y al reiniciar. No usarla en producción. Puede mostrar un enlace ya usado hasta que expire: el servidor de identidad lo rechazará.

Recorrido de revisión:

1. Iniciar sesión → bloque del usuario → **Mi cuenta → Seguridad**. Abrir además otra sesión con la misma cuenta. Cambiar la contraseña: funciona el navegador solicitante con nueva cookie y dejan de servir las cookies anteriores.
2. Login → **Olvidé mi contraseña** → correo sintético → abrir/actualizar la bandeja local → enlace → contraseña y confirmación → login obligatorio. El enlace es de un uso y dura 30 minutos; completar invalida los demás.
3. **Sistema → Integraciones → Correo transaccional**, sólo owner. Ver configuración, presencia de credenciales, diagnóstico y solicitudes recientes. “Comprobar conexión” no manda un correo. Configuración global: no cambia con el selector Real/Simulación.

## Contrato HTTP

Todas las rutas nativas pasan por el mismo controlador. Sólo están habilitadas las siguientes; se mantienen cerrados registro, cambios de email/nombre, set-password y otras mutaciones fuera del alcance.

| Ruta | Contrato |
|---|---|
| POST `/api/auth/sign-in/email` | Email/password de Better Auth, cuenta activa; login serializado con cambios/reset. Cookie HTTP-only; token retirado del JSON. |
| GET `/api/auth/get-session` | Sesión vigente y membresía activa; sin token en JSON. |
| POST `/api/auth/sign-out` | Cierra la sesión; sin ampliar permisos. |
| POST `/api/auth/change-password` | `currentPassword`, `newPassword`, `confirmPassword`; 12–128, distintas, confirmación exacta; revocación siempre activa aunque `revokeOtherSessions` falte o sea false. |
| POST `/api/auth/request-password-reset` | `email` normalizado. Misma respuesta para cuenta activa, inexistente o inactiva; falta de configuración produce el mismo 503 global. |
| POST `/api/auth/reset-password` | `token`, `newPassword`, `confirmPassword` en cuerpo JSON. Revalida membresía, expiración y unicidad bajo lock. Sin login automático. |
| GET `/api/auth/reset-password/:token` | Compatibilidad con enlace nativo; no consume. Sólo permite callback exacto; redirige al fragmento de `/reset-password`. El correo nuevo usa directamente el fragmento y evita que el token llegue a logs HTTP. |
| GET/PUT `/v1/identity/mail` | Sólo owner humano. `expected_version`, `enabled`, `config`; `username`/`password` opcionales para reemplazar y `clear_credentials` explícito para eliminar. GET devuelve presencia, nunca secretos. |
| POST `/v1/identity/mail/diagnose` | Conexión/handshake/autenticación sin envío. Cinco diagnósticos por propietario/minuto. |
| GET `/v1/identity/mail/jobs` | Últimas 50 solicitudes: ID, estado, intentos y código sanitizado; sin correo, token o payload. |

POST exige Origin confiable; Bearer no autoriza identidad, incluso acompañado de cookie. Se rechazan parámetros de identidad objetivo y campos desconocidos. Cambio/reset no guardan cuerpos ni respuestas con secretos en la idempotencia comercial, no se reintentan automáticamente y no aceptan secretos en query string. Cookies nuevas se propagan sólo tras commit. Errores de red ambiguos invitan a login/recuperación; no se afirma éxito sin revocación/auditoría confirmadas.

Límites persistentes en PostgreSQL: recuperación 10/IP/15 min y 3/destinatario/15 min; cambio 10/IP y 10/cuenta/15 min; consumo de reset 10/IP/15 min; login 30/IP/min. Destinatarios e IP se guardan como HMAC con separación de dominio, no texto ni hash de contraseña. Suprimir por destinatario conserva respuesta uniforme. El límite general de API sigue vigente. En producción el API está detrás del proxy interno existente; no publicar el puerto directamente ni permitir encabezados reenviados de clientes no confiables.

Respuesta de solicitud con tiempo mínimo 200–230 ms, trabajo SMTP desacoplado y sin diferencias por destinatario. No se promete indistinguibilidad absoluta ante saturación/fallos de base. Solicitudes ajenas no bloquean el login de una cuenta.

## SMTP productivo: Resend elegido

Antecedente de infraestructura: [diagnóstico sanitizado](evidence/account-smtp-preflight.json), 07-sep-2026 UTC, por Cloud Shell/IAP, sólo lectura. Estas observaciones de Hostinger/Google no acreditan autenticación o entrega mediante Resend:

- Sin Postfix/Exim, listeners SMTP o contenedores MTA encontrados. Cero claves SMTP en 19 archivos env bajo `/opt/commerce-os/private`; no se imprimieron valores. Esto no descarta un servicio no documentado fuera de ese alcance.
- UFW inactivo, sin reglas EGRESS explícitas del proyecto. Dos conexiones IPv4 a MX de Google en TCP25 vencieron a los cinco segundos. No se verificaron todas las posibles políticas jerárquicas; la causa precisa no se atribuye sólo al timeout. El resultado es consistente con [la restricción de Google Cloud](https://docs.cloud.google.com/compute/docs/tutorials/sending-mail).
- `smtp.hostinger.com` y `smtp.gmail.com` respondieron con saludo 220 en 587 y con TLS/certificado válido y 220 en 465. No hubo AUTH/MAIL/RCPT/DATA. En 587 se comprobó TCP/saludo; el STARTTLS obligatorio del transporte se comprobará con la configuración elegida.
- El dominio `inovaris.online` usa MX Hostinger, SPF con Hostinger/MailerLite y DMARC `p=none`. IP externa reservada en uso; PTR genérico de Google, sin A para `mail.inovaris.online`. DKIM/HELO/remitente no acreditados para envío directo. No se cambió DNS.

**Decisión vigente, 07-sep-2026:** Brandon autorizó reutilizar Resend, que ya estaba configurado en su cuenta. El panel mostró `inovaris.online` como dominio verificado. Se usa el transporte [SMTP de Resend](https://resend.com/docs/send-with-smtp): host `smtp.resend.com`, puerto **465**, TLS implícito, usuario **`resend`** y API key como contraseña SMTP. Se conserva Nodemailer y la cola cifrada de identidad. Esta decisión sustituye la exclusión inicial de Resend; no requiere añadir su SDK o utilizar su API HTTP de envío.

**Configuración inicial comprobada, 07-sep-2026 15:12 UTC:** clave dedicada `commerce-os-recuperacion`, permiso Sending access restringido a `inovaris.online`; cargada desde la UI owner y guardada cifrada, versión 1. Remitente `seguridad@inovaris.online`, nombre Commerce OS. El VPS comprobó DNS, certificado, TLS 1.3 y EHLO en dos direcciones de Resend por 465; se autorizó el destino en `api.env` privado y se comprobó su carga en API. El diagnóstico de la aplicación devolvió `SMTP_CONNECTION_OK` (conexión y autenticación), con cero jobs. En esa comprobación inicial la recuperación quedó deshabilitada. Brandon pidió después dejarla lista para funcionar: **habilitada en versión 2 a las 15:41 UTC**, con conexión/autenticación nuevamente correctas y estado activo confirmado por HTTPS/UI. La prueba controlada de recepción sigue pendiente y ya no bloquea la activación autorizada. [Activación](evidence/resend-production-activation.json). [Evidencia sanitizada](evidence/resend-production-configuration.json).

Postfix directo queda sin habilitar: la salida TCP25 no fue acreditada e instalarlo no elimina esa restricción. El relay SMTP elegido evita necesitar un MTA nuevo en el VPS. La [preparación de Postfix](../infra/smtp/README.md) se conserva como alternativa histórica sin instalar.

## Configuración protegida y activación posterior

La API usa la revisión vigente de `identity_mail_settings` en cada solicitud/dispatch. No hay archivo paralelo ni caché de contraseñas SMTP. Credenciales cifradas mediante AES-GCM con la clave privada existente, ligadas al scope/version. La API key de Resend ocupa el campo secreto `password`; los metadatos sólo indican si existen credenciales. Sólo la API necesita poder descifrarlas; no se añaden secretos a workers comerciales. Cambiar SMTP no incrementa revisiones ni revoca autorizaciones comerciales.

En **Sistema → Integraciones → Correo transaccional**, el botón **Configurar Resend** prepara host, puerto, TLS y usuario, vacía el campo de API key y selecciona envío deshabilitado en el formulario. Se conserva el remitente para su revisión. El botón no guarda ni modifica la configuración que está operando: los cambios se aplican mediante **Guardar configuración**. La API key se pide explícitamente cuando no existe una guardada o se cambia de servidor; después de guardar se vacía del formulario.

Al cambiar host o modalidad con credenciales guardadas, la API exige una contraseña nueva o `clear_credentials`, incluso en llamadas directas. Si falta, responde HTTP 400 `SMTP_CREDENTIAL_REPLACEMENT_REQUIRED`; no transfiere silenciosamente la clave anterior al nuevo servidor. Mantener el mismo servidor permite conservar la credencial sin devolverla al navegador.

Variables de infraestructura en el `api.env` privado del VPS:

- `PUBLIC_WEB_ORIGIN=https://commerce-os.inovaris.online`, origen exacto sin path/query. La prioridad es `PUBLIC_WEB_ORIGIN`, primer origen de `CLIENT_ORIGIN`, y después `BETTER_AUTH_URL`, lo que permite usar el origen HTTPS de la instalación existente. Cada valor elegido debe superar la misma validación; un valor explícito inseguro no se ignora para recurrir a otro. En producción no se acepta HTTP ni se usa un origen de desarrollo.
- `SMTP_ALLOWED_TARGETS`: JSON con objetos `{host,port,mode,addresses}`; direcciones IP literales explícitas aprobadas por el operador. Ejemplo de estructura sintética: `[{"host":"smtp.example.invalid","port":465,"mode":"remote","addresses":["192.0.2.10"]}]`. No copiar ese destino a producción. Resolver/verificar las direcciones del servidor elegido y mantenerlas si el proveedor cambia IP. El transporte conecta a la primera IP permitida y valida certificado/SNI contra `host`; no hace DNS controlado por el formulario ni fallback a destinos no permitidos.
- `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, `BETTER_AUTH_SECRET`, clave de datos y base conservan su custodia. No rotarlas por este incremento.

El generador `prepare-production.mjs` incorpora el origen público y `SMTP_ALLOWED_TARGETS=[]` sólo en `api.env`. Una instalación nueva no permite destinos SMTP hasta configurarlos. El instalador preserva las variables privadas existentes; no convierte una allowlist vacía en autorización para Resend. Para este servicio se debe autorizar exactamente `smtp.resend.com`, 465, `remote` y sus IP verificadas. El fallback del origen no reemplaza ese requisito.

Remoto exige puerto 587/STARTTLS obligatorio o 465/TLS implícito, TLS ≥1.2 y validación de certificado. Local exige IP privada concreta y destino permitido; no acepta credenciales ni confía en toda la VPC. La configuración general de conectores conserva sus defensas contra SSRF.

La publicación del software está autorizada y debe seguir el CI/CD existente hasta el informe `SUCCEEDED` del SHA integrado y la revisión HTTPS del recorrido. La publicación `81a3e5b` está acreditada; la corrección de cabeceras del proxy exterior quedó instalada y comprobada en `637a94c`/CI34138553520. [Evidencia](evidence/identity-proxy-verification.json). La configuración privada y la autenticación SMTP están comprobadas; la recuperación está habilitada por solicitud expresa de Brandon, versión 2. Las solicitudes válidas desde **Olvidé mi contraseña** se procesan automáticamente.

Con aplicación e infraestructura preparadas: cargar Resend desde la UI owner, guardar inicialmente deshabilitado y ejecutar **Comprobar conexión sin enviar correo**. El diagnóstico verifica conexión/TLS/autenticación; no ejecuta envío. Un rechazo permanente AUTH 535 produce `SMTP_AUTH_FAILED`; un rechazo temporal AUTH 454 conserva la clasificación temporal y los reintentos acotados de la cola.

La recuperación ya está habilitada. Para acreditar una prueba completa, acordar el destinatario de una cuenta sintética y observar recepción + enlace + reset + login. Auditar y documentar esos resultados separados. Si falla, deshabilitar la recuperación, inspeccionar estado privado y pedir un enlace nuevo cuando se resuelva. Nunca usar la cuenta de Brandon como fixture. La aceptación SMTP no demuestra recepción ni ubicación en la bandeja principal.

## Mantener el destino SMTP del VPS

El acceso autorizado a Google/Cloud Shell se recuperó. El bloqueo anterior de revisión automática quedó resuelto; no sigue siendo una dependencia. La configuración se aplicó sobre `ci-34131587609-1-81a3e5b6decc` antes del siguiente despliegue conjunto. Sólo cambió `PUBLIC_WEB_ORIGIN` y `SMTP_ALLOWED_TARGETS`; el wrapper Compose existente recreó únicamente API, con otros servicios preservados y copia privada 0600. Las credenciales SMTP permanecen en la base cifrada, no en el env. La revisión posterior por HTTPS confirmó versión, remitente, diagnóstico y ausencia de credenciales en metadatos.

El [helper revisado](operations/resend-vps-setup.py) conserva el procedimiento para futuros cambios de IP. Es una herramienta operativa manual, no un paso de CI ni una autorización permanente para cambiar producción. Preparar y revisar el comando antes de ejecutar; copiar únicamente este script sin secretos por el canal administrativo autorizado y consultar el release vigente:

```sh
sudo python3 /tmp/resend-vps-setup.py preflight
sudo readlink -f /opt/commerce-os/current
sudo python3 /tmp/resend-vps-setup.py apply --expected-release RELEASE_CONFIRMADO
```

Sustituir `RELEASE_CONFIRMADO` por el nombre observado, nunca por un release histórico. `preflight` sólo hace DNS/TCP/TLS/EHLO/QUIT sin AUTH o envío. `apply` vuelve a comprobar el endpoint, exige correo deshabilitado/sin jobs pendientes, adquiere el lock de CI, detecta instalaciones activas o cambios concurrentes, respalda el env privado y aplica sólo API. No instalar durante un CI en curso; coordinar primero. Errores `CI_DEPLOYMENT_IN_PROGRESS`/`CURRENT_RELEASE_CHANGED` exigen revisar el estado. `ENV_REPLACED_VERIFICATION_REQUIRED` o `APPLY_FAILED_ROLLBACK_REQUIRES_REVIEW` requieren inspección privada del archivo, backup y API antes de reintentar. Nunca imprimir archivos env ni añadir claves al script. El certificado y SNI siguen siendo obligatorios; no ampliar el destino desde el formulario.

Después de cada ajuste, comprobar metadatos por HTTPS y ejecutar **Comprobar conexión sin enviar correo**. El preflight desde el host no acredita por sí solo acceso desde el contenedor o credenciales correctas. Un despliegue posterior debe conservar este env y la configuración cifrada; comprobarlo antes de activar recuperación.

## Cola, estados y fallos

La API supervisa un bucle de cola de identidad con hechos durables, separado de outbox/pg-boss comerciales y de `DISPATCH_FROZEN`. Reiniciar API recupera pendientes; `SENDING` abandonado por más de 60 s queda `UNCERTAIN`. Un lock de cuenta serializa dispatch con reset/cambio; los datos se revalidan antes de SMTP. Un job no puede despacharse concurrentemente por dos workers.

| Estado | Significado / tratamiento |
|---|---|
| PENDING | Aún no enviado, o rechazo temporal inequívoco; como máximo tres intentos, separados 30 s y sujetos a vigencia. |
| SENDING | Claim durable. Si el proceso se corta, no se reenvía a ciegas. |
| ACCEPTED | SMTP aceptó un destinatario; **no acredita recepción** ni bandeja principal. |
| FAILED | Rechazo definitivo, configuración ausente o agotamiento de reintentos conocidos. |
| EXPIRED | Caducó antes del envío; no se despacha. |
| UNCERTAIN | Timeout ambiguo, caída tras DATA o claim abandonado; sin reenvío automático. Consultar MTA por Message-ID en entorno privado o pedir otro enlace. |
| CANCELLED | Cuenta desactivada/enlace invalidado o restauración de respaldo. |

La encolación se deduplica por digest del mismo enlace. Una nueva solicitud HTTP deliberada puede generar otro enlace, limitada a tres; no reutilizar idempotencia comercial para capturar contraseñas. Message-ID y enlace se conservan durante los reintentos de un job; no garantizan deduplicación remota. Aceptado/fallido/vencido/incierto/cancelado elimina el payload cifrado de la cola activa. Los verificadores vencidos y límites caducados se limpian; auditoría y metadatos terminales se conservan. Definir retención histórica con el equipo antes de un volumen sostenido; los backups cifrados pueden contener payloads históricos durante su retención.

El MTA puede conservar mensajes ya aceptados incluso después de invalidar el enlace. Su spool necesita permisos/retención propios y no tiene cifrado por mensaje por el mero uso de TLS o AES en la aplicación. No registrar SMTP debug, cuerpos, URLs o contraseñas. La plantilla HTML/texto no carga imágenes ni recursos externos y no hace seguimiento.

Restore elimina verificaciones de reset, payloads pendientes, sesiones y deshabilita correo, conservando la contraseña almacenada. Un backup no debe reactivar enlaces usados ni enviar un lote viejo. Bootstrap sólo crea usuarios que no existen; no restablece contraseñas. Los verificadores productivos que leían la clave inicial deberán recibir una credencial vigente por el canal privado existente; no ampliar service tokens para evitar el login.

## Verificación local

Evidencia histórica de la entrega `b33910c`: **64 unitarias, 140 integraciones (+1 QR optativa omitida), 25 E2E, nueve pruebas Python**, typecheck/lint/build, recuperación y auditoría aprobados. Tras el último ajuste se repitieron los tres E2E de identidad y el recorrido del comando de revisión. Encabezados verificados además con Caddy real en un contenedor local, montando sólo configuración/build de esta rama.

La evidencia de esa entrega se conserva en [account-security-verification.json](evidence/account-security-verification.json). Incluye contraseña actual/nueva/confirmación, seis roles, tres sesiones, expiración/reuso/concurrencia, login simultáneo, desactivación, rutas directas, origen, límites persistentes, cifrado/configuración y fallos SMTP/TLS/rollback. Pruebas con PostgreSQL real aislado y transporte SMTP loopback.

E2E cubre teclado/foco, validaciones, mostrar/ocultar, autocompletado, navegación normal/compacta/móvil, sesión renovada tras reload, recuperación completa, URL limpia, reset usado y error de red ambiguo. Axe en las pantallas de identidad, estados de error/éxito y plantilla; inspección visual de escritorio/móvil y correo. No acredita Outlook/Gmail reales, lector de pantalla humano o entrega real. [Capturas sanitizadas](evidence/account-security/).

Capturas/trazas automáticas de los tests que escriben secretos están deshabilitadas; capturas explícitas se hacen con campos vacíos y enlace redactado. `test:e2e` sanea reportes/ZIP con credenciales sintéticas temporales privadas y elimina ese inventario tras sanitizar. Los servidores/API/SMTP no registran cuerpos ni URLs de recuperación. Caddy nuevo conserva no-store/no-referrer y meta referrer en el HTML; en instalación se debe comprobar que ningún proxy adicional registre rutas nativas de tokens.

Verificación final de los ajustes Resend: **68 unitarias, 140 integraciones (+1 optativa omitida), 26 E2E, nueve pruebas Python**, typecheck/lint/build y auditoría de dependencias aprobados. También pasó el smoke del generador privado (permisos, origen, allowlist vacía y rechazo de sobrescritura). [Evidencia](evidence/resend-verification.json). Se añaden casos de origen productivo heredado y prioridades, rechazo de credenciales inválidas, sustitución al cambiar de servidor —incluida la llamada directa— y el preset con guardado explícito y borrado del campo secreto. Las cifras históricas anteriores no se atribuyen a estos cambios ni a una integración SMTP productiva.

La primera ejecución en CI detectó una carrera en la captura SMTP del test: esperaba el primer fragmento, no el mensaje completo. La fixture ahora espera `stream.end`; tipos y los cuatro recorridos de identidad se repitieron correctamente. [Corrección y evidencia](evidence/resend-ci-recovery.json). La verificación completa por CI de `81a3e5b` pasó en 34131587609 (26 E2E).

Comandos (configuración privada de esta revisión):

```sh
export COMMERCE_CONFIG_DIR="$HOME/.config/commerce-os-account-review"
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:integration
pnpm test:recovery
pnpm test:e2e tests/e2e/account-security.spec.ts
python3 -m unittest discover -s tests/ci -p 'test_*.py'
pnpm audit --audit-level high
```

La regresión completa de navegador también necesita las fixtures comerciales existentes. Se preparó una segunda configuración privada, `~/.config/commerce-os-account-e2e`, usando `COMMERCE_CONFIG_DIR="$HOME/.config/commerce-os-account-review" node scripts/setup-campaign-review.mjs "$HOME/.config/commerce-os-account-e2e"`. Tiene otra base y datos completamente sintéticos; no cambia el catálogo de la revisión de cuenta. En esta máquina ejecutar `COMMERCE_CONFIG_DIR="$HOME/.config/commerce-os-account-e2e" pnpm test:e2e`. No repetir el setup si existe su runtime.

Detener `account:review` antes de E2E para que la suite levante su propia copia y capture SMTP. El software y la corrección de cabeceras del proxy exterior están publicados y verificados en 637a94c. La API key, remitente y allowlist de IP están configurados y la recuperación habilitada; sólo queda pendiente acreditar recepción con una cuenta sintética acordada. No hace falta cambiar los MX del dominio para usar Resend SMTP.
