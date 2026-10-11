# Primera publicación de API/web sobre la copia recuperada

Adaptación local revisable del CI/CD existente. No acredita adopción, instalación
remota, recepción de correo, vinculación WhatsApp ni operación comercial.

## Selección y configuración inicial

`COMMERCE_DEPLOY_SCOPE` es una variable del entorno GitHub `production` con valores
`api-web`, `portal-copy` inicial o `full`. El cliente valida el target completo antes de ejecutar comandos
externos. El tuple legado conserva su selección `full` si la variable falta. El
tuple de la copia recuperada exige `api-web` explícito; omisión, valor desconocido
o `full` se detienen. Cambiar una variable no autoriza la futura transición full.
Ésta requiere reconciliar tareas históricas y un recibo compatible revisado.
`portal-copy` sólo admite el tuple de la copia y completa API/web y el portal
inicial en el mismo run, conservando el recibo de ambas fases. Requiere el estado
Root v1 real y su publicación API/web comprobada; no arranca consumidores ni
retira la prohibición de full. [Contrato de transición](adr-copy-portal-initial-transition-2026-10-07.md).

Antes del primer CI, la configuración inicial de incidente debe autenticar el
recibo REAL de la transición SMTP **disabled**, sus perfiles y su runtime. Copia
los seis perfiles existentes más los perfiles admin/backup autorizados al
contrato canónico, preserva auth y claves originales, fija imágenes y recursos
externos reales, y adopta `current` hacia la release d36 existente. Nunca ejecuta
prepare-production, roles, bootstrap, import, migraciones ni servicios.

Sólo después de ese readback se guarda `api-web-adoption.json`, Root/600, con
estado `ADOPTED_EXISTING_API_WEB`. Su esquema cerrado está en
[api_web_deployment.py](../scripts/api_web_deployment.py): refs reales del recibo
SMTP y Caddyfile, ocho archivos canónicos, cuatro proyecciones de contenedor,
redes, digest de Caddy activo, plan B02 actual, política93 y nueve reglas
atestadas por la transición. No se construyen hashes o recibos futuros. Las
referencias y hashes de perfiles/plan permanecen privados; no entran en Git,
stdout ni el reporte de CI. El deploy consume ese estado; no lo fabrica.

Después de la transición inicial comprobada, el esquema v2 conserva cinco
contenedores y referencias privadas de portal, runtime/env/manifest y proxy.
Las publicaciones API/web siguientes mantienen esa proyección sin recrearla y
comprueban la versión HTTPS del portal conservado; el contrato v1 sigue exigiendo
cuatro servicios y Ciclo503. La versión del portal puede diferir del SHA de API.

## Preparación, activación y recuperación

La [continuidad de sesiones owner](adr-copy-owner-session-continuity-2026-10-07.md)
valida membresías activas del mismo workspace y un PAT válido, con observación
privada acotada. Los conteos históricos4/2 no limitan accesos legítimos previos
a la publicación. Identidades, permisos y membresías deben conservarse durante
todas las fases; no se crean, eliminan ni modifican para pasar el instalador.

1. Bajo el lock de CI, validar cuatro contenedores, perfiles, auth del owner,
   espacio pausado, política93 FROZEN, correo disabled, veinte barreras en cero,
   historial terminal y los 65 hashes de migración **exactos**. Validar el paquete,
   cargar imágenes y completar un **nuevo** backup predeploy canónico. Se lee
   completo el ciphertext local acotado a1GiB y se verifica COMOSB02; ese readback
   no acredita copia externa ni decryption/restore. El backup toma sus locks
   schedule→maintenance; no se sustituyen sus bytes por una custodia previa.
2. Soltar CI y adquirir daily→CI→schedule→maintenance. Releer baseline, plan,
   perfiles, auth, política y esquema. Si cambiaron durante el handoff, parar
   antes de activar. Los journals B02 usan `journal.json`; un backup incierto,
   cleanup anterior no conciliado o rollback anterior desconocido bloquea.
3. Activar sólo API/web, sin dependencias, pulls, SQL de esquema, hold, bootstrap,
   import ni consumidores. Conservar PG/Caddy, montajes/HostConfig, perfiles y
   claves. El overlay usa PG/core/volumen externos y conserva el edge de SMTP:
   core/proxy internos, edge sólo Caddy+API, IPv4 y gateway edge prioridad1. Se
   comprueba también la ruta real del kernel, no sólo el YAML.
4. Verificar tres servicios seleccionados, manifest HTTPS, SHA de API, readiness
   JSON de API/DB, auth/política iguales y Ciclo503. No transportar secretos ni
   instalar portal, timer WAHA, ingress, workers o soak. CI no modifica firewall;
   el recibo SMTP acredita sus nueve reglas y un nuevo readback Cloud sigue
   siendo evidencia independiente. `SUCCEEDED` lleva `deployment_scope=api-web`
   y `full_runtime_started=false`; no significa seis servicios o ventas listas.
5. Ante fallo conocido, rollback recrea sólo API/web anteriores y valida política,
   auth, migraciones, PG/Caddy, redes y perfiles. Nunca restaura DB. Cleanup
   desconocido bloquea rollback. Un rebase parcialmente escrito requiere
   conciliación de sólo lectura: no hay segundo start/rebase/rollback automático.

## Continuidad B02

Después de éxito o rollback completamente verificado, con los cuatro locks,
CAS del plan cambia **sólo `preserved_runtime`**. Conserva el plan previo, fuentes
canónicas, refs de promoción/storage y claves originales; el controller y la
imagen de mantenimiento de B02 siguen ligados a d36. El siguiente journal
distingue `source_sha` del workflow y `backup_source_sha` del tool retenido.

El nuevo hash privado de plan debe leerse y actualizarse en el transporte por
Root sólo tras el resultado actual. Un hash anterior se detiene por drift. La
programación sigue apagada. Custodia off-host, restauración física, correo y
TEST entrante conservan sus pruebas y autorizaciones independientes. Ninguna
evidencia técnica se registra automáticamente como HUMAN_ATTESTATION.
