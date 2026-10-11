# Actualización auditada r4: preservar núcleo y piloto

Autorización vigente: `PROGRESS.md`. Está autorizado actualizar el núcleo existente; esto no autoriza mensajes, campañas, anuncios, conversiones ni gasto. El procedimiento se ejecutó el 06-sep-2026: r4 quedó instalado a las 12:08:37 UTC y verificado con 16 migraciones, seis servicios sanos y el piloto preservado. La evidencia posterior está en [comparación del release](evidence/deployment-r4-release-comparison.json), [HTTPS](evidence/deployment-r4-https.json), [Meta](evidence/meta-production-r4.json) y [QR](evidence/qr-production-onboarding-r4.json). Los apartados de preparación describen cómo se construyó y verificó el paquete sellado, que permanece sin modificar.

## Corrección del instalador

El instalador y `release.sh` anteriores aplicaban únicamente `production.yaml`, incluso cuando el piloto ya existía. Al recrear channel/ingress podían perder la configuración y red del gateway. `scripts/compose-release.sh` es ahora la única entrada Compose para check, deploy, rollback y recreate final de API. Incluye `pilot.yaml`, el archivo privado del piloto y el perfil `waha-pilot` cuando están configurados; bloquea una actualización incompleta si existe un gateway incluso detenido. No arranca ni recrea WAHA como efecto de actualizar los servicios del núcleo.

`COMMERCE_PILOT_RELEASE_ENV` puede fijarse en `release.env` o pasarse como segundo argumento del instalador. El descubrimiento compatible reconoce `/opt/commerce-os/private/pilot/pilot-release.env`, ruta comprobada en la copia privada offsite histórica. Este dato histórico debe cotejarse antes de operar el VPS. No se regeneran claves ni sesiones. Un piloto ausente, incompleto o ambiguo bloquea el flujo.

El modelo combinado impone `DISPATCH_FROZEN=true`, `REAL_SENDS_ENABLED=false` y `ALLOW_REAL_OPERATIONS=false` a API y workers, aun si un archivo privado contuviera otro valor. `ALLOW_CHANNEL_ONBOARDING` conserva su permiso separado; una actualización no lo habilita por sí sola. La futura prueba QR requiere habilitar sólo onboarding, con los tres controles anteriores congelados y sin enviar.

Pruebas: cuatro regresiones locales con Docker simulado cubren composición, gateway detenido, configuración incompleta y primera instalación. Trece comprobaciones reales de `docker compose config` con secretos sintéticos privados verifican ambos networks, referencias, perfil, puertos y banderas; no arrancan contenedores. El primer comprobador confundió `core:null` del JSON de Compose con ausencia de red; la comprobación final usa presencia de la clave y confirma ambas redes.

## Paquete y verificación previa

La carpeta privada del paquete contiene `images.tar.gz`, `images.sha256`, `PACKAGE.sha256`, `RELEASE.json`, `images.json`, `source-manifest.json`, `infra/`, `scripts/` y este documento. El archivo exterior es un TAR sin enlaces y su SHA256 se comunica por separado. No contiene configuración privada, contraseñas, tokens, sesiones ni contactos. Las imágenes son Linux/amd64 y se construyen fuera del VPS desde un snapshot de fuentes.

En el host que recibe el paquete, verificar primero el SHA256 exterior contra el valor entregado por el coordinador. Extraer en una carpeta nueva, nunca encima de `current`, y verificar todos sus miembros con `sha256sum --check PACKAGE.sha256`. `install-vps.sh` repite la verificación de todos los miembros y del archivo de imágenes antes de actuar; el SHA256 exterior se compara en el host receptor contra el valor entregado por separado. El manifiesto distingue IDs de manifest locales y config IDs del archive para la carga en otro almacén Docker.

## Evidencia local del paquete

Las tres imágenes Linux/amd64 se verifican contra un snapshot de 189 archivos: 146 hashes de fuentes runtime coinciden y los cinco archivos estáticos de web coinciden entre las imágenes runtime y web. Los contenedores de comprobación son efímeros, de sólo lectura y sin red. Las banderas de congelamiento están confirmadas y la herramienta de rotación de credenciales locales está excluida. Véanse [verificación de imágenes](evidence/release-image-verification-r4.json) y [composición del piloto](evidence/release-overlay-verification-r4.json). Estos resultados describen el paquete local; no acreditan instalación en el VPS.

El TAR final `commerce-os-20260906-audit-r4.tar` ocupa 197.632.000 bytes y su SHA256 es `625b569fee02c211ca440ded1c26f4d4e91558047c71396c80582901020236b5`. Se verificaron las 56 entradas de `PACKAGE.sha256`, los tres config IDs y la ausencia de enlaces en el TAR. La ruta privada y los IDs están en [evidencia del paquete](evidence/release-package-r4.json). La suite final coordinada pasó 13/13 antes de exportar; sus detalles y la validación general están en `audit-report.md`.

## Secuencia exacta para el coordinador autorizado

Antes de ejecutar, el acceso Cloud Shell/IAP debe estar operativo y debe verificarse la ruta real del piloto. `scripts/audit-vps-readonly.py` permite inventario sanitizado antes/después; no sustituye el login del operador ni desbloquea el Mac.

```sh
# En el VPS, tras copiar el paquete y comprobar su SHA256 exterior.
sudo install -d -m 700 /opt/commerce-os/releases/20260906-audit-r4
sudo tar -xf /ruta/privada/commerce-os-20260906-audit-r4.tar \
  -C /opt/commerce-os/releases/20260906-audit-r4
cd /opt/commerce-os/releases/20260906-audit-r4
sudo sha256sum --check PACKAGE.sha256

# Inventario previo: constatar core, piloto, volúmenes, congelamiento y backup.
# OWNER_EMAIL se obtiene del acceso seguro existente; nunca se pega en notas.
sudo sh scripts/install-vps.sh "$OWNER_EMAIL" \
  /opt/commerce-os/private/pilot/pilot-release.env
```

El instalador comprueba primero el overlay; hace un B02 nuevo usando la imagen de mantenimiento anterior y conserva `release.env` en `release-history` antes de cargar imágenes y migrar. Migra 0015/0016 de forma aditiva con el runner único; no borra datos. Mantiene la base, volúmenes, configuración, Caddy, POC y red del piloto. Actualiza únicamente servicios del núcleo y sólo mueve `current` después de readiness. No ejecuta `compose down`, no reinicia el gateway y no cambia anuncios.

Después de instalar: verificar 16 migraciones, todos los servicios del núcleo sanos, `DISPATCH_FROZEN=true`, las dos prohibiciones de operación/envío en false, la presencia del gateway en channel/ingress y los volúmenes previos. Verificar HTTPS, sesión, UI y endpoints de lectura; repetir inventario sanitizado y guardar evidencia del B02 pre-update. La API Meta debe seguir mostrando datos no disponibles si faltan credenciales; no copiar secretos locales automáticamente al VPS.

El núcleo puede pasar readiness sin acreditar QR o Meta. El pairing real exige intervención humana; un token Meta local validado no demuestra que esté instalado en la VM. Ninguna comprobación de actualización envía mensajes ni altera campañas.

## Rollback compatible

Congelar y revisar trabajos en vuelo antes de cambiar imágenes. No revertir migraciones ni restaurar encima del único volumen válido. Con un `release.env` previo compatible y el piloto explícito:

```sh
sudo env COMMERCE_PILOT_RELEASE_ENV=/opt/commerce-os/private/pilot/pilot-release.env \
  sh scripts/release.sh rollback /opt/commerce-os/private/release-history/ARCHIVO_PREVIO.env
```

Usar el helper actualizado para conservar el overlay también al volver a imágenes anteriores. Verificar versiones compatibles, ambos sitios HTTPS, volúmenes y estado de los servicios. Rollback no deshace ninguna acción externa ya realizada.
