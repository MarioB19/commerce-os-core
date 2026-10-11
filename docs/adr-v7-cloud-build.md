# ADR: verificación FULL de V7 en Cloud Build

Fecha: 2026-10-10. Estado: implementación local; pendiente de build, conexión,
permisos mínimos y validación nativa. No acredita Cloud Build operativo, publicación
ni sustitución del check requerido de Actions.

Validación local: la suite de 724 pruebas Python terminó OK en macOS: 722 pasan
y dos se omiten explícitamente (Docker aislado opt-in y la prueba suplementaria
para el verificador Linux root). Los 18 contratos propios incluyen 17 aprobados
y esa omisión. La prueba suplementaria ejecuta el CLI real como UID 1000 con
copias de código público verificadas por hash, cubriendo la frontera que la suite
heredada omite cuando corre como root. YAML y shell embebido parseados. Esto no
acredita la suite FULL, Docker Linux, imagen construida ni una corrida cloud.

## Problema y decisión

Actions conserva USD 0. V7 necesita un gate verdadero del SHA exacto en Google
Cloud. Este incremento prepara exclusivamente verificación FULL: el runner sigue
los comandos de `verify` en `.github/workflows/ci.yml`, con PostgreSQL, contratos de
cápsulas/restore Linux, portal, integración, E2E y auditoría. No selecciona un
alcance abreviado ni omite pruebas por falta de dependencias. Un test de contrato
compara la secuencia con el workflow existente y falla si divergen.

`infra/cloudbuild/Dockerfile.verify` prepara Node 24.20.0, pnpm 10.34.5, Python,
Docker/Compose y dependencias de Chromium. Se construye una vez desde un checkout
revisado. La configuración `infra/cloudbuild/verify.yaml` exige la imagen por
digest en el repositorio Artifact Registry `commerce-ci/verify` del mismo
proyecto. El runner está dentro de esa imagen; no se ejecuta el driver de una PR
como orquestador de confianza. Actualizar versiones/suite exige revisar y construir
otra imagen y actualizar su digest en el trigger confiable.

El checkout candidato debe contener `.git`, HEAD debe coincidir con `COMMIT_SHA`
y estar limpio, incluidos archivos no rastreados. Se registra el tree y se repite
la comprobación al terminar. Un archive sin metadatos Git falla explícitamente:
la conexión debe entregar un checkout verificable; no se inventa HEAD a partir
de una sustitución. La configuración del trigger y `_VERIFY_IMAGE` deben quedar
fuera del control del contenido de la PR.

## Ejecución y evidencia

El build usa el default pool, sin solicitar una máquina mayor; la documentación
vigente identifica su máquina predeterminada como e2-standard-2. La configuración
deja 95 minutos para el build, 90 para la suite y diez en cola. Los comandos
comparten una sola fecha límite: timeout, señal, dependencia ausente o salida
distinta de cero impiden PASS. No hay reintentos automáticos. Se termina el grupo
de procesos del comando interrumpido. Una interrupción abrupta del worker puede
dejar el último recibo RUNNING; tampoco acredita éxito.

Cada etapa queda PASSED, FAILED, TIMED_OUT, CANCELLED o NOT_RUN. El recibo final
incluye SHA/tree, UUID nativo Cloud Build, digest de la imagen, hashes del runner
y workflow, tiempos y todas las etapas. Se guarda en
`.runtime/cloudbuild-<BUILD_ID>/verification.json` y se imprime en Cloud Logging;
los comandos conservan sus logs nativos. Sólo se usan fixtures y configuración
local nueva; recovery escribe evidencia dentro del directorio del build. E2E
recibe su propia configuración de campaña, como en el workflow original.

El proceso sale 0 únicamente si todas las etapas pasan y el source continúa
intacto. El recibo no publica un GitHub check y no es una atestación por sí solo:
un publicador de checks separado debe verificar identidad/procedencia, SHA y
estado terminal SUCCESS en Cloud Build, además del contrato FULL y digest del
verificador. Nunca atribuir este resultado a un run Actions. Los consumidores no
deben aceptar un JSON de workspace como prueba suficiente.

## Aislamiento y permisos

Se requiere `commerce-v7-verify@<proyecto>.iam.gserviceaccount.com`, separada de
deploy/backup y sin permisos de producción, IAM, Secret Manager ni escritura de
GitHub. Sólo logging y lectura del repositorio exacto del verificador; la conexión
de repositorio usa su propia identidad mínima. Antes de activar el trigger,
comprobar permisos efectivos, incluidos roles heredados. La plantilla no crea
cuentas, concede permisos ni guarda credenciales.

Docker/Compose y la prueba Linux de cápsulas necesitan el daemon Docker del
worker. El contenedor usa host network para el PostgreSQL de prueba en
127.0.0.1:5440; se monta el volumen source en su ruta real del daemon para que los
bind mounts de las fixtures compartan exactamente los mismos archivos. El
binario Node de la imagen se copia al runtime compartido, se compara por SHA-256
y versión y se antepone a PATH. Así `process.execPath` de la prueba Linux refiere
a los mismos bytes visibles para el daemon, con hash comprobado también al final.
HOME es `/root` del contenedor efímero, con ancestros compatibles con las pruebas
de custodia. TMPDIR general es `/tmp`, fuera del repositorio: varios contratos
rechazan correctamente estado privado dentro del checkout. Sólo la cápsula Linux
usa TMPDIR en el volumen compartido para sus bind mounts. La configuración local
y el store de pnpm quedan dentro del runtime privado e ignorado; fijar el store
evita que pnpm ensucie la raíz del volumen con una caché no rastreada.
Los comandos hijos usan umask 022 como Actions; el driver conserva umask 077 y sus
directorios 0700. La fixture de rechazo de custodia crea modo 0644 explícito para
probar la misma negativa tanto con UID root como sin privilegios.
No se montan homes ni ADC del paso Cloud Build. No se heredan variables de
proveedor o bases reales.

**Esto no constituye una frontera de seguridad frente al código de PR.** Docker
socket y host network permiten acceso amplio al worker y pueden exponer metadata
y la identidad del build. Ausencia de un archivo ADC no significa ausencia de
tokens. La protección es que esa identidad y ese worker no tengan acceso a
producción ni secretos. Nunca ejecutar esta configuración en el host productivo
ni conceder permisos de deploy a su SA. Configurar la admisión de PR externas y
la conexión con esta limitación explícita.

## Costos y activación pendiente

A USD 0.006/min, 95 minutos son USD 0.57 de cómputo bruto antes de impuestos,
sin descontar cuotas gratis; no incluye imagen inicial, Registry, tráfico ni logs.
Es una cota orientativa de esta plantilla, no una factura ni autorización de
gasto. La revisión de cuenta del 10-oct encontró IVA aplicable: el bootstrap y
las corridas siguen bloqueados hasta que la proyección mensual completa, impuestos
incluidos, cumpla USD 100 y los créditos cubran el consumo. No se ha ejecutado
una build cloud para validar este incremento.

El timeout limita una ejecución; **no limita el número de builds ni impone
concurrencia uno**. El controlador/trigger debe admitir como máximo una corrida
a la vez, verificar presupuesto antes de cada una y no reenviar eventos
duplicados. Ningún archivo de este cambio afirma haber instalado esa admisión.

Para cerrar F0 quedan: construir/probar la imagen en Linux; comprobar checkout y
mount/red nativos; instalar la conexión y trigger confiable; registrar duración y
costo real; implementar/publicar `Commerce V7 Cloud Build gate`; demostrar un PR
fallido bloqueado y uno correcto aprobado; sólo después sustituir el check
requerido de Actions. Conservar resultados históricos y Actions USD 0.

La migración del publicador, artifacts y baseline a Cloud Build es otro incremento:
IDs UUID, recibos por proveedor, selector de instalación, locks canónicos y SHA
por componente necesitan su contrato propio. Este cambio no modifica
`ci-changes.py`, instaladores, workflows legacy, locks del VPS ni operación real.
El cierre técnico 80a6 y sus restauraciones previas no se repiten.

Referencias: [workflow actual](../.github/workflows/ci.yml),
[guía de publicación](publishing-changes.md), [CI/CD](ci-cd.md),
[esquema Cloud Build](https://docs.cloud.google.com/build/docs/build-config-file-schema),
[volúmenes entre pasos](https://docs.cloud.google.com/build/docs/configuring-builds/pass-data-between-steps),
[cuenta de servicio dedicada](https://docs.cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts),
[precios Cloud Build](https://cloud.google.com/build/pricing).
