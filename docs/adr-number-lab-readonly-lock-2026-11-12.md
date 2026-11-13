# Lectura del laboratorio en el almacén privado de solo lectura

Estado: decisión y parche parcial de lectura probados localmente; completado en
V7.5.2 por Claude (inicialización canónica del lock, diagnóstico y cierre sin
reintento): ver [V7.5.2](adr-v7-5-2-lab-numbers.md).

## Evidencia y alcance

En V7.5.1 (`76901884`), los dos recorridos de una suite automática quedan en
`INTENT` antes de materializar el motor o llamar al proveedor de IA. La lectura
del montaje real confirma `/data/private:ro` y `/data/laboratory:rw`. Invocar
únicamente el bloqueo compartido sobre el primero reproduce `EROFS` al abrir
`.private-namespace.lock`: `withPrivateNamespaceLock` usa `O_RDWR | O_CREAT`
tanto para lectores como para escritores. No se reejecutan operaciones inciertas.

## Decisión

Un bloqueo SHARED abre un archivo existente con `O_RDONLY | O_NOFOLLOW`.
Si falta, conserva la inicialización en un almacén escribible con creación
exclusiva; si otro proceso lo crea primero, vuelve a abrirlo en lectura.
Un almacén de solo lectura sin el archivo sigue fallando, sin permisos nuevos.
EXCLUSIVE conserva su apertura de escritura y sus controles actuales.

Una segunda lectura nativa encontró **ausente** el archivo en el almacén fuente
productivo (`ENOENT`). El cambio de apertura por sí solo no basta para esta
instalación. La preparación canónica debe inicializar el lock vacío, del dueño
correcto y modo 0600, desde la raíz escribible antes de iniciar los lectores;
verificar los existentes sin truncarlos ni sustituirlos. Revisar
`scripts/copy_runtime_deployment.py::ensure_lab_storage`, que ya prepara la
custodia del laboratorio incluso si las migraciones están aplicadas. Esta parte
queda para la implementación de Claude junto con su prueba de instalación.

Se conservan validaciones de dueño, modo, inode, enlaces, raíz y filesystem,
el mismo bloqueo de kernel y la comprobación de la identidad antes y después.
No cambian montajes, custodia, migraciones, aprobaciones, contenido ni transporte.

## Alternativa revisada

Montar solo el archivo de bloqueo como escribible podría evitar `EROFS`, pero
cambiaría la definición adoptada del contenedor. La guarda
`application_boundary_equal` rechaza ese cambio; Root/B02 comparan los montajes
y la definición completa. No es un workaround compatible con el contrato
instalado, ni se debe simular un baseline nuevo. La corrección de código evita
esa transición de infraestructura.

## Verificación requerida

- Regresión: un lector sobre un archivo existente no necesita apertura de escritura.
- Inicialización compartida concurrente y exclusión mutua entre lectores/escritores.
- Rechazo de enlaces, permisos incorrectos y sustituciones de identidad.
- Lectura acotada con el montaje de solo lectura real, sin ejecutar el vendedor.
- Publicación canónica y una nueva suite autorizada antes de afirmar aceptación.

## Resultado local del parche parcial

La regresión de apertura reproduce EROFS en `76901884`; después del cambio,
59/59 pruebas de bloqueo, custodia y materialización pasan, junto con TypeScript
del servidor y ESLint de ambos archivos. El ensayo de lectura en el montaje
real no llegó al bloqueo porque faltaba el archivo (ENOENT); **no es PASS** y no
se creó el archivo ni se cambió el servicio. Los tests locales simulan el montaje
de solo lectura; la verificación nativa posterior sigue siendo obligatoria.

También pasan 58/58 pruebas de siete archivos de grupos, política QR,
calentamiento y continuidad de sesión. Esto protege el cambio local de lectura;
no demuestra una conversación real del grupo ni sustituye las integraciones
del candidato final que implemente Claude.
