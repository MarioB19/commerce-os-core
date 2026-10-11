# Publicación r5: configuración operativa desde Commerce OS

Release `20260906-configuration-r5`, para la instalación existente en `https://commerce-os.inovaris.online`. Brandon autorizó la implementación, validación, actualización del VPS y versionado. La publicación del software no inicia campañas ni envía mensajes a contactos.

## Cambio de autoridad

La configuración operativa se administra en **Sistema → Configuración**, por workspace y entorno. La revisión persistida en PostgreSQL gobierna permisos, congelamiento, onboarding, límites y conexiones. Las imágenes y Compose dejan de imponer las antiguas banderas de activación. Los valores privados heredados se importan una sola vez; no mantienen precedencia sobre cambios posteriores hechos en el panel.

Los valores iniciales congelan el despacho y deshabilitan operaciones reales, envíos y onboarding. El instalador congela REAL e incrementa su revisión antes de reemplazar procesos. Una autorización anterior no recupera validez al terminar la actualización. La base, el cifrado, la identidad de los procesos y la topología de red siguen siendo configuración del instalador; el operador no necesita editar archivos del servidor para montar una oferta o activar un número.

## Paquete verificable

El paquete contiene `images.tar.gz`, `images.sha256`, `PACKAGE.sha256`, `RELEASE.json`, `images.json`, `source-manifest.json`, `infra/`, `scripts/` y este documento. El TAR exterior usa rutas relativas, no contiene enlaces ni configuración privada y tiene permisos `0600`. Sus imágenes son Linux/amd64.

El snapshot de fuentes y cada archivo runtime se comparan por SHA256. Los assets estáticos deben coincidir entre runtime y web. La comprobación de imágenes ejecuta contenedores efímeros sin red, de sólo lectura: verifica ausencia de banderas operativas en la imagen y que la configuración ausente permanece congelada incluso al inyectar valores legados permisivos en el proceso de prueba. El manifiesto distingue el manifest ID del almacén local y el config ID contenido en `docker save`.

Las imágenes conservan los inputs de construcción del commit `69fb5f4`. Una corrección posterior de fixtures de integración no cambia código de aplicación, scripts, infraestructura ni configuración de build. El paquete conserva el `source-manifest.json` original y registra en `test-verification-final.json` los hashes anteriores/finales de los tests y su validación. Por ello la evidencia declara `source_snapshot_unchanged=false` y `runtime_source_unchanged=true`: la paridad exacta acreditada corresponde a los 172 archivos runtime y cinco assets web; no se atribuye al build una revisión de tests que ocurrió después.

La verificación de Compose usa exclusivamente valores sintéticos. Sus 18 comprobaciones preservan redes, referencias de importación, volúmenes y aliases; mantienen el gateway sin puertos publicados ni reinicio de sesiones automático. Seis regresiones del helper incluyen once pruebas de aislamiento de contenedores y bloquean un rollback incompatible antes de mutar procesos o la política. Véanse [composición verificada](evidence/release-overlay-verification-r5.json) y [verificación de imágenes](evidence/release-image-verification-r5.json). La evidencia local de un paquete no acredita su instalación remota.

## Actualización del VPS

1. Confirmar el SHA256 exterior por el canal de entrega, extraer en una carpeta nueva y verificar `PACKAGE.sha256`. No extraer encima de `current`.
2. Inspeccionar núcleo, piloto, volúmenes y respaldo existente con salidas sanitizadas. El piloto histórico se configura en `/opt/commerce-os/private/pilot/pilot-release.env`; confirmar esa ruta en el host.
3. Ejecutar el instalador autorizado. Conserva el overlay existente; una configuración de piloto incompleta bloquea la actualización.

```sh
sudo install -d -m 700 /opt/commerce-os/releases/20260906-configuration-r5
sudo tar -xf /ruta/privada/commerce-os-20260906-configuration-r5.tar \
  -C /opt/commerce-os/releases/20260906-configuration-r5
cd /opt/commerce-os/releases/20260906-configuration-r5
sudo sha256sum --check PACKAGE.sha256
sudo sh scripts/install-vps.sh "$OWNER_EMAIL" \
  /opt/commerce-os/private/pilot/pilot-release.env
```

`OWNER_EMAIL` se obtiene del acceso privado existente. No pegar credenciales en documentación ni comandos registrados.

Antes de cargar imágenes, el instalador crea un B02 con la imagen de mantenimiento vigente y preserva `release.env`. Después registra el contenedor anterior y su owner/generación; congela REAL; detiene API y workers que pueden mutar la política; aplica migraciones aditivas hasta `0018`; importa una vez las conexiones operativas privadas; recrea sólo los servicios del núcleo y comprueba readiness. Caddy, POC, gateway y volúmenes del piloto se conservan.

La importación exige archivos privados protegidos, rechaza conflictos y no imprime secretos. Repetir la publicación no reintroduce credenciales que el administrador haya retirado del panel. Las nuevas tablas guardan los secretos cifrados y separan permisos de lectura por proceso. La evidencia de aislamiento se registra sólo si el contenedor anterior fue eliminado o quedó detenido, sin red y sin política de reinicio. El nuevo worker consume el comprobante una sola vez para recuperar la propiedad de la sesión; una lease vencida por sí sola no permite recuperar un número vinculado.

## Validación posterior

Comprobar las 18 migraciones, salud de los seis servicios del núcleo, HTTPS y sesión. Leer desde la API la revisión REAL y verificar `dispatch_frozen=true`, `real_sends_enabled=false` y `allow_real_operations=false`; las variables del contenedor ya no son la prueba de la política efectiva. Confirmar conexiones importadas por presencia, versión y estado, nunca por valores secretos. Confirmar preservación de redes y volúmenes del piloto y registrar el B02 previo a la actualización.

Verificar en la plataforma los formularios de configuración, conexiones, producto, oferta, flujo y asignación por número. El preflight debe mostrar sus bloqueos actuales. El alta del producto de preescolar puede importar materiales y publicar catálogo mediante `scripts/import-preschool.ts`; no activa números ni emite mensajes. El flujo y los materiales se describen en [preparación de preescolar](preschool-launch.md).

La instalación no prueba identidad WhatsApp, recepción ni entrega real de mensajes. El pairing exige el dispositivo del usuario. El primer ensayo necesita un número elegido, destinatario y alcance concreto. Registrar los resultados reales de esas acciones separadamente de las pruebas de software y del catálogo preparado.

## Recuperación y rollback

Conservar el B02, `release-history`, el paquete anterior y la evidencia del intento. Si falla una migración, importación o readiness, mantener congelado y revisar la causa antes de reactivar. No deshacer migraciones ni restaurar sobre el único volumen válido.

El helper r5 bloquea el rollback a imágenes sin soporte de política operativa en PostgreSQL antes de mutar procesos o la base. **r4 y anteriores dependían de banderas de entorno:** el congelamiento de la base no protege esos binarios. Para volver a r4 se necesita recuperar su composición congelada y comprobar explícitamente las banderas legadas antes de iniciar sus workers, conservando el overlay del piloto. La migración de configuración no elimina los archivos privados heredados, pero éstos no deben usarse como prueba de la política de r5.

Un rollback no deshace acciones externas que ya se hayan realizado.

## Resultado productivo — 06-sep-2026 UTC

Instalador finalizado correctamente antes de las 23:46 UTC; `current` apunta a r5. El inventario de las 23:56 UTC confirma las 18 migraciones con checksums, importación heredada completada y seis servicios principales sanos. PostgreSQL, WAHA, POC y Caddy conservan imagen, arranque y redes. B02 previo: `commerce-2026-09-06T23-44-35.594Z.backup.aes`, 819.236 bytes, encabezado B02 y permisos privados verificados. No se atribuye una restauración nueva a esta copia.

Docker usa los índices OCI del archivo sellado como identidad de las imágenes. El comparador final distingue índice, manifiesto y configuración; además comprueba Linux/amd64 y la cadena de capas. Pasan las tres imágenes y cinco contenedores de aplicación. La web pública coincide byte a byte en sus cinco archivos con el build comprobado. [Inventario del VPS](evidence/deployment-r5-vps.json) · [Identidad de imágenes](evidence/deployment-r5-image-identity.json) · [Paridad HTTPS](evidence/production-web-parity-r5.json).

La validación autenticada comprueba política REAL congelada, metadatos de dos perfiles Meta y uno WAHA, catálogo publicado de Preescolar y seis materiales READY. El piloto conserva una constancia de aislamiento válida para recuperar su sesión al conectar; no se consumió como si hubiera identidad vinculada. Su asignación al producto pasó siete comprobaciones. Faltan habilitación operativa, sesión, identidad y salud del teléfono; no existen autorizaciones ni efectos REAL. [HTTPS y catálogo](evidence/production-https-configuration-r5.json) · [Asignación del piloto](evidence/preschool-pilot-assignment-r5.json).

Observación visual menor: Sistema conserva tres heartbeats históricos de channel-worker como filas amarillas «Resultado incierto», junto al worker vigente. No marcan instalación fallida ni bloquean controles. La lectura de las 23:47 UTC verificó API READY y workers actuales con heartbeat reciente; no deben interpretarse las filas antiguas como tres servicios activos caídos. Agrupar ese historial es una mejora de presentación pendiente.

Meta se comprobó nuevamente el 07-sep-2026 a las 00:16 UTC mediante una sola sincronización de lectura: las dos credenciales cifradas son válidas, las revisiones coinciden y se recuperaron dos portafolios. El inventario sigue PARTIAL: dos consultas WABA requieren `whatsapp_business_management` y dos consultas `ads_dataset` fueron rechazadas. No se modificaron recursos de Meta ni permisos. La comprobación HTTPS final de las 00:18 UTC pasó trece controles y confirmó asignación persistida, política congelada y cero outbox/autorizaciones REAL. [Meta después de la migración](evidence/meta-production-configuration-r5.json).
