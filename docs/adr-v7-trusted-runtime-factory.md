# V7: fábrica fija para el controlador y el atestador

Fecha: 2026-10-11. Estado: implementación; instalación nativa pendiente.

El proceso carga una configuración inmutable de `/opt/trusted/runtime-config.json`. HTTP sólo despierta al controlador; la selección de trabajo procede de un objeto privado de GCS y sus documentos por generación, tamaño y hash. No acepta código, rutas, credenciales, callbacks ni propuestas del request. El SDK usa exclusivamente la identidad de servicio exacta de cada rol mediante metadata ADC.

Los objetos de control, admisión y medidor deben existir previamente, con generaciones mínimas instaladas. El arranque no los crea. La adopción explícita conserva los 74 minutos ya consumidos y el techo CI de 480 minutos; la revisión económica debe incluir también el medidor y las operaciones GCS. Un modo `shadow` permite verificar lectura y configuración sin despachar efectos. Ni este modo ni los tests representan FULL, App check, despliegue o admisión financiera nativos.

Cada operación vuelve a leer el control y la custodia. Las admisiones y los despachos cotejan revisión protegida, evento GitHub actual e inventario completo del proyecto; las reservas y los intentos durables siguen gobernados por el ledger existente. Una ejecución conocida se reconcilia; una respuesta perdida jamás permite otro POST. La adquisición de fuente tiene un intento propio y conserva el digest resultante antes de subir el archivo. Su pérdida no autoriza una nueva adquisición automática.

El atestador tiene un entrypoint fijo y sólo acepta el UUID nativo de su propia ejecución. Lee el bundle protegido, confirma identidad, ejecución `WORKING`, aprobación durable, fuente actual y FULL nativo antes de emitir su recibo. El check de GitHub sigue siendo responsabilidad de la App de Cloud Build, confirmado después por el controlador.

El publicador y la admisión de migraciones posteriores conservarán el instalador canónico. Su baseline real después del incidente DNS es la adopción `20261011-711`, de metadata y sin software nuevo. No se reinterpretará como FULL ni GitHub Deployment. El paso de migraciones 67→68 a releases normales requiere su propio contrato, pruebas y revisión antes de habilitar F2.

La revisión independiente añadió un fence posterior al CAS: el POST de crear o aprobar vuelve a leer control, custodia, vigencia, evento y un inventario nuevo antes del único envío. La fuente aplica el mismo control después de su intento durable. El atestador revalida después de leer FULL, antes de emitir su recibo. Las carreras de pausa, nueva revisión y vencimiento quedan probadas conservando el intento consumido.

La imagen `Dockerfile.runtime` necesita un contexto privado con `runtime-config.json` ya revisado y recursos/generaciones reales. Copia el archivo como root, modo 0444, y ejecuta como UID 65532. Controller y attestor requieren imágenes separadas por configuración; no hay selección de rol ni rutas mediante variables de entorno. La construcción, el scan, la identidad/IAM, la adopción de estado y el despliegue siguen siendo gates pendientes, no efectos de este Dockerfile.
