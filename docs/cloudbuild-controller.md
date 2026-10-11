# F0 — CI nativo PR/main sin dependencia del Mac

10-oct-2026. **Arquitectura adoptada para el siguiente incremento; control de admisión y adaptador GCS en implementación local. Sin controlador, triggers ni mutaciones cloud instalados.** No sustituye ADR-V7-11, la admisión económica vigente ni los gates Root. Se leyeron el ADR, bootstrap, verify.yaml, publicador FULL, procedencia y publicación canónica actuales. El ejecutor principal sigue siendo la fuente del estado del primer build; este documento no afirma que haya pasado.

## Decisión propuesta y alcance mínimo

**Dos triggers nativos GitHub PR/main, ambos con aprobación requerida, que ejecutan una atestación corta y confiable. Un controlador Cloud Run separado admite FULL y luego aprueba la atestación.** El check requerido lo emite la GitHub App de Cloud Build, no un token dentro de verify. El controlador conserva el productor de fuente TGZ saneada y los validadores FULL existentes; mueve su ejecución a GCP. No reconstruye otro pipeline de pruebas ni deja el Mac como productor obligatorio.

Flujo: evento GitHub → gate nativo PENDING → fuente/revisión/presupuesto/CAS → FULL con SA verify → conciliación nativa → gate corto con SA lectora → check App del SHA. Sólo main vigente y correctamente atestado puede seguir a package nativo → publicador confiable → instalador Root canónico → lectura instalada/HTTPS → Deployment. PR nunca publica.

[Cloud Build documenta](https://docs.cloud.google.com/build/docs/automating-builds/github/build-repos-from-github) triggers PR/push, configuración inline y resultados GitHub. Fijar config inline y digest fuera del candidato, sin autodetectar cloudbuild.yaml de la PR; fijar la SA **en el trigger**, pues prevalece sobre la del YAML. No activar logs a GitHub. Mantener nombres distintos del Commit Status manual `Commerce V7 Cloud Build gate` para evitar ambigüedad; seleccionar el nombre y app_id reales después del ensayo. La instalación de la App se limita a este repositorio.

El gate nativo **no arranca un worker para esperar FULL**: queda PENDING mediante [approvalRequired](https://docs.cloud.google.com/build/docs/securing-builds/gate-builds-on-approval). El controlador llama approve una sola vez después de persistir su reserva. Una aprobación API desconocida se concilia por UUID; no se reenvía automáticamente. El gate no hereda ciegamente el queueTtl600s del FULL: la API mide TTL desde createTime. Admitir una ventana de espera que cubra FULL+reconciliación+cola (propuesta4h, a validar nativamente), conservando timeout de ejecución2min; si expira, no marcar éxito ni recrearlo sin otra admisión. Confirmar en el ensayo la interacción PENDING/TTL; el límite de aprobación de dos meses no sustituye esa prueba.

Esta decisión preserva autenticidad del required check después de la conciliación externa. Un FULL directo nativo con step SUCCESS puede producir verde antes de ella. Si se prefiere FULL directo, la alternativa honesta son FULL+atestación PR y FULL+atestación main (cuatro triggers), con la misma admisión y otro contrato de procedencia; no llamar al primer verde la atestación final.

## Reutilización y frontera de confianza

- Extraer un módulo común de las funciones puras de `cloudbuild-publish-status.py`: validate_manifest, validate_native, validate_full_receipt y lectura única de logs. Los CLI existentes lo usan sin perder el rechazo de triggers en la rama bootstrap. La nueva entrada usa ADC de SA, no `--account` personal ni `gh` del Mac.
- Una imagen del controlador y otra del atestador, por digest revisado, contienen esos módulos. No importan scripts del workspace candidato, no ejecutan hooks/tests del repo y no se actualizan por la PR que están evaluando.
- `SourceApproval` protegido fija repo, evento, PR/base/head según corresponda, SHA, tree, hash del workflow, imagen/runner/policy/config, revisión autorizada y vencimiento. Una aprobación de SHA anterior no migra al nuevo push. El revisor autorizado puede ser el agente bajo el mandato V7; esto no añade una pregunta humana por release. Identidad de autor o hash aislado no sustituyen esa revisión.
- El TGZ lo prepara el controlador con fetch del commit real a repositorio desechable autocontenido: `.git` válido, sin hooks/configuración heredada, secretos, homes ni archivos ignorados. Compara SHA/tree limpios antes/después, sella SHA256 y escribe GCS con creación exclusiva y generación. Crear FULL por API referenciando directamente esa generación final, sin un submit que vuelva a stagear y cambie el objeto. Es el mismo contrato del bootstrap. El tamaño local observado de `source-1e128ef7b693.tgz` es **126,530,154 bytes**; no asumir un payload diminuto ni memoria ilimitada.
- Ruta mínima sin credenciales GitHub en verify: después de auditar y publicar una fuente saneada separada, conservando privado el repositorio original, fetch HTTPS público. **Esta revisión no hace público el repo.** Si permanece privado, sólo el productor confiable puede usar la conexión/credencial aprobada, saneando todo antes del TGZ; verify nunca recibe token, permiso de Secret Manager ni fetchReadToken. La autenticación de la App pertenece al plano de control.

El acceso a Docker y metadata hace al worker candidato capaz de usar su SA. Se conserva SA verify con logging y lectura del repositorio del verificador/fuentes concretos, sin producción, IAM, GitHub, aprobación, creación/cancelación de builds, ledger ni estado del controlador. La admisión sigue limitada a candidatos revisados: estas pruebas no son una atestación criptográfica resistente a código hostil que controle el daemon.

| Identidad | Permisos propuestos y límite |
|---|---|
| Controlador | Get/list Build/trigger/logs CI, approve/cancel y create estrictamente para plantillas admitidas; actAs de verify/package/publisher; escritura de ledger/fuentes/manifiestos privados. Sin SSH/secretos de producción. No modificar sus propios triggers/IAM/imagen. |
| Verify | Contrato mínimo actual. No modificar ledger ni invocar controlador. |
| Atestador | Leer admisión protegida y FULL nativo/logs, escribir sólo sus logs. Sin ejecutar candidato, publicar GitHub, aprobar otro build ni entrar a VM. |
| Package | Ejecutar packager confiable con fuente exacta; escribir sólo artifacts CI. Sin secretos, SSH, aprobación o GitHub. |
| Publicador | Imagen confiable, acceso mínimo al artefacto y destino canónico/IAP/Root. No ejecutar tests ni construir Dockerfiles candidatos con esta SA. Credenciales de publicación GitHub, si son necesarias para Deployment, sólo aquí y con alcance mínimo; nunca en verify. |

[Google advierte](https://docs.cloud.google.com/build/docs/cloud-build-service-account) que el código invocado por triggers hereda privilegios de su SA. Auditar permisos efectivos/heredados y todas las rutas capaces de crear/aprobar builds. Owner de emergencia sigue siendo poder humano; una ejecución de incidente debe asentarse en el mismo ledger antes de gastar. La concurrencia de Cloud Run no es la barrera de exclusión.

## Check SHA y procedencia: incompatibilidades que se prueban

El lector actual rechaza `buildTriggerId` y sólo admite storageSource + generación + SHA256 nativo del TAR. **Conservarlo para FULL**. El gate añade un lector propio de trigger admitido, sin transformar UUID en Actions ni aceptar cualquier fuente.

La [API Build](https://docs.cloud.google.com/build/docs/api/reference/rest/v1/projects.builds) distingue connectedRepository/resolvedConnectedRepository y gitSource/resolvedGitSource de storageSource. Los triggers imponen ALLOW_LOOSE y dynamicSubstitutions=true; reconocerlos explícitamente en el esquema de trigger y seguir rechazándolos si cambian el contrato bootstrap. Comparar campos completos admitidos, imagen por digest, SA, timeout, source, trigger ID y aprobación; no aceptar opciones/secrets/steps extra.

Google [documenta shallow clone de un solo commit](https://docs.cloud.google.com/build/docs/automating-builds/create-manage-triggers#including_the_repository_history_in_a_build). Si se ensaya FULL directo nativo, comprobar `.git`, HEAD/tree, limpieza y custodia real de credenciales antes de confiar en ese checkout. No simular `.git` ni fabricar un commit desde archive. El TGZ confiable evita exigir un fetch privado adicional al worker.

Primera prueba nativa debe registrar por separado PR head SHA, base SHA, cualquier test-merge SHA, COMMIT_SHA, revisión resuelta y `check_run.head_sha`. [Los built-ins de PR](https://docs.cloud.google.com/build/docs/configuring-builds/substitute-variable-values) no incluyen una garantía documentada de igualdad head/test-merge; una variable no es procedencia. Aprobar sólo la igualdad exigida por el contrato. Si el proveedor usa un merge sintético, registrar y validar ese objeto auténtico de extremo a extremo, sin atribuirlo al head; el main posterior requiere su propio FULL exacto.

Configurar la protección con **App de origen esperada**, último SHA y política de base actualizada, sin required check “any source”, bypass automático, skip-ci ni neutral convertido en PASS. [GitHub](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) diferencia head y test-merge y acepta neutral/skipped como éxito; probar las conclusiones reales de rejection/cancelación antes de usarlas. Mientras se desconozcan, dejar el gate pendiente bloqueando merge. Un FULL fallido nunca aprueba el gate; un check manual homónimo no satisface el origen App. La publicidad autorizada queda condicionada a la auditoría y no se presume realizada.

## Admisión atómica, una ejecución y estados inciertos

Cloud Run recibe notificaciones autenticadas de `cloud-builds` y un Scheduler **horario** de reconciliación. [Cloud Build publica cambios de estado](https://docs.cloud.google.com/build/docs/subscribe-build-notifications); siempre releer Build por API, no actuar por campos del evento. No usar un build de polling ni esperar FULL dentro de una solicitud. Cada llamada hace una transición durable y retorna.

Un objeto GCS privado controla serialización global y bolsa por mes. Usar [ifGenerationMatch](https://docs.cloud.google.com/storage/docs/request-preconditions) para cada CAS y creación `=0`; conflicto412 recarga/revalida, nunca last-write-wins. Guardar fencing generation, intent único, UUIDs, SHA/tree, source generation, configuración/digest y reservas de cada etapa. Registros inmutables auxiliares no deciden por sí solos. Duplicados/orden invertido de [Pub/Sub push](https://docs.cloud.google.com/pubsub/docs/exactly-once-delivery) son esperables.

Transiciones: DISCOVERED → SOURCE_APPROVED → RESERVED → SUBMIT_INTENT → UUID_BOUND/UNKNOWN → RUNNING → TERMINAL_UNRECONCILED → RECONCILED. Gate/package/install son hijos de la misma identidad, cada uno con reserva propia. Antes de aprobar/crear, exigir `consumido confirmado + reservas pendientes + nueva cota ≤480min`, proyección infraestructura/IVA≤100 y crédito vigente. Incluir fallos, bootstrap, atestación, package, publisher y operaciones de prueba.

FULL reserva95min; gate corto propone2min; package propone30min; publisher propone15min. Son timeouts a validar, no tiempos prometidos. Un main podría reservar hasta142min por etapas y un PR hasta97min: diez fases no están garantizadas. Reservar un hijo sólo tras liberar por medición comprobada la parte no consumida del anterior; mantener la exclusión hasta conciliar terminal nativo. No liberar por expiración de lease, reloj local, timeout HTTP o mero pedido de cancelación.

La [API create](https://docs.cloud.google.com/build/docs/api/reference/rest/v1/projects.locations.builds/create) no ofrece un requestId de deduplicación en ese contrato. Persistir intención antes del único POST, desactivar retries de mutación y conservar UNKNOWN ante503/timeout/respuesta perdida. Reconciliar inventario nativo por objeto fuente único con nonce/generación, intervalo/config/SHA y operación; tags sólo si un esquema nuevo revisado los admite, pues el build_config bootstrap actual no acepta campos extra; cero coincidencias inmediatas no prueba que no se creó. No reenviar hasta probar no-ejecución; múltiples coincidencias bloquean y todas cuentan. Si aparece un build fuera del ledger, bloquear admisiones y reconciliar; no borrarlo del cálculo.

Reintentos sólo son nuevos intentos explícitos, con nuevo UUID/reserva, nunca sobreescriben fallos. Eventos de main superado se cancelan/rechazan sin transferir su éxito al nuevo head; no interrumpir una instalación Root crítica a mitad por otro push. Cambio de mes conserva reservas y la exclusión global; asignar el intervalo facturable entre meses, no reiniciar a cero una operación viva.

## Package y publicación sin nuevo instalador

Reutilizar `release.sh`, `cloudbuild_release_evidence.py`, `ci_provider_evidence.py`, transporte `deploy-ci-client` y `copy_runtime_deployment`; extraer transportes ADC/GCS cuando haga falta, no copiar validaciones. La rama nativa permanece bloqueada por `NATIVE_CLOUD_PACKAGE_PUBLICATION_NOT_ENABLED` hasta tener productor, contrato y evidencia reales.

Package es otro Build UUID con la misma fuente/commit/tree y enlace FULL; exporta tar/manifiesto a bucket privado. El lector verifica resultado nativo, generación y hash del artifact real, además de bytes descargados; JSON del candidato no basta. El publicador usa `cb-<UUID-package>-<attempt>`; `cv-<UUID-FULL>-<attempt>` sigue identificando únicamente canonical-local. No llamar nativo al paquete local.

El publicador GCP materializa admisión y artefactos protegidos en custodia efímera0700/0600, validando ancestros y sin falsificar garantías mediante GCS FUSE. El estado durable vive en GCS/Root; el lock local no sustituye CAS global ni `ci-deploy.lock` remoto. Root mantiene revisión del paquete/digest observado, igualdad de lectores, migraciones permitidas, backup fresco, hold/drain, activación, ownership admisible, rollback compatible y lectura final. No autoaprobar paquetes por tener hash. Preservar copy-runtime y portal con su SHA instalado, no atribuirlo al nuevo.

Sólo informe Root SUCCEEDED/OPERATING + imágenes/release/SHA y HTTPS coherentes permiten publicar Deployment. Resultado incierto de instalación/publicación se relee antes de repetir. No restore automático DB ni cambio de owners/pausas comerciales para conseguir verde. Después de un push admitido, ni FULL, package, custodia durable, instalación ni lectura dependen del Mac encendido.

## Costo incremental propuesto, sin cuotas gratis

Mantener el monitor de salud cada minuto en us-west1 y su costo modelado **USD0.695737 antes de IVA**, con sus alertas existentes. El controlador es separado, en us-east1, request-based, min0/max1, concurrency1, 1vCPU/2GiB y CPU boost desactivado; no es el monitor de salud. Añadir reconciliación horaria, no otro sondeo por minuto.

| Cota mensual del controlador, 744h | USD antes de IVA |
|---|---:|
| Scheduler adicional, un job | 0.100000 |
| Cloud Run ≤5000vCPU-s, incluyendo arranque/parada | 0.120000 |
| Memoria ≤10000GiB-s | 0.025000 |
| ≤2000 solicitudes incluidas duplicadas | 0.000800 |
| GCS ledger: ≤2000 claseA +5000 claseB | 0.012000 |
| Logs adicionales ≤0.02GiB | 0.010000 |
| Pub/Sub: ≤0.02GiB throughput +0.001GiB-mes retenido | 0.001051 |
| Egreso adicional ≤0.05GiB a0.12 | 0.006000 |
| Estado/control ≤0.01GiB-mes a0.025 | 0.000250 |
| **Controlador / con monitor** | **0.275101 / 0.970838** |
| **Conjunto con reserva IVA16%** | **1.126172** |

Cabe sólo **dentro de la reserva existente de USD1 antes de IVA** (USD1.16 con IVA), margen0.029162 antes de IVA. No cabe si se interpreta USD1 incluyendo IVA. Fuentes: [Run](https://cloud.google.com/run/pricing), [Scheduler](https://cloud.google.com/scheduler/pricing), [GCS](https://cloud.google.com/storage/pricing), [Pub/Sub](https://cloud.google.com/pubsub/pricing), [Logging](https://cloud.google.com/products/observability/pricing). CPU boost tiene [facturación adicional](https://docs.cloud.google.com/run/docs/configuring/services/cpu); min0/max1 no impone límite mensual.

**Estas son cotas de admisión por medir, no ahorro ya ganado.** 2000 requests incluyen744 ticks y todos los eventos/duplicados;5000CPU-s debe incluir clonado/TGZ y arranques. Si no cabe, no activar automatización alegando max1. Control de comentarios/admisión de PR públicas evita ejecutar forks no revisados; una avalancha no puede inducir builds ilimitados ni logs/tráfico ilimitados sin disparar pausa de admisión y revisión. El monitor de salud permanece activo.

Los minutos para construir imágenes controller/attestor/package/publisher pertenecen a480, igual que los builds normales. Sus imágenes, tar y fuentes **no** están incluidos en0.275101: se asignan contra las reservas actuales Registry/staging con inventario de bytes/retención antes de activar. Por ejemplo40TGZ de126,530,154bytes retenidos todo el mes son4.713616GiB; a0.025/GiB-mes serían0.117840USD, frente a0.05USD de staging ya reservados: delta≈0.067840antesIVA/0.078695conIVA, si ésa fuese la retención real. No afirmar que todas las fuentes caben en0.058conIVA sin medirlas. No recortar evidencia, WAL, DR, correo ni logs de seguridad para cuadrar esta tabla. Recalcular el total del mes vigente: el documento no vuelve a admitir gasto con una cifra antigua.

## Incrementos decisivos y gates de salida

1. Extraer módulos comunes y contratos puros; simular CAS concurrente, duplicados, mes cruzado,503/timeout después de submit, cancelación pendiente y adversarial source/config. Guardas actuales bootstrap siguen pasando.
2. Medir productor confiable TGZ y controlador, sin gastar nube en esta revisión; definir fuentes/retención/digests y presupuesto por SKU. Cerrar auditoría de privacidad y estado real de App/repositorio/protección.
3. Instalar controlador inicialmente en shadow/admisión cerrada. Crear triggers con aprobación requerida y confirmar evento PENDING, configuración congelada y metadatos reales sin correr FULL. Probar que verify no obtiene producción/ledger/GitHub y que sólo la identidad controladora aprueba.
4. Admitir un FULL real exacto, luego gate corto. Capturar App/name/head_sha/result, procedencia,21etapas y costo. Demostrar PR fallido bloqueado, PR correcto permitido, push nuevo invalida evidencia vieja y dos eventos no arrancan dos builds. Sólo entonces cambiar required check, preservando protecciones durante transición.
5. Implementar/probar package nativo y publisher por los módulos canónicos, activar la rama nativa sólo tras evidencia. Ensayar fallo antes/después de envío, lock ocupado, paquete alterado, main superado y respuesta perdida de instalación. Verificar publicación completa con Mac apagado.
6. Reconciliar minutos/bytes/IVA y recepción de alertas externas. F0 no cierra por una FULL sola ni por la existencia del controlador. Mantener manual canónico únicamente como fallback de incidente equivalente.

## Implementación local y admisión pendiente

Los módulos `cloudbuild_admission.py` y `cloudbuild_gcs_store.py` implementan el contrato de estado y la escritura CAS con generación. No habilitan automatización: la integración HTTP/eventos, fuente aprobada, identidades, permisos, triggers, productor de paquetes e instalación siguen pendientes. Toda reserva real exige conciliar el bootstrap ya ejecutado y la proyección vigente; los números propuestos arriba no sustituyen esa admisión.

La escritura GCS hace un único POST condicional y relee sus bytes por generación. Un 412 devuelve conflicto; timeout, redirección, respuesta malformada o readback discordante conservan resultado incierto. No generan automáticamente otro POST ni CreateBuild. El objeto de control exige bucket privado, IAM exclusivo y exclusión de cualquier lifecycle de borrado. Su ausencia tras la inicialización es un incidente, no permiso para empezar el presupuesto desde cero.

Referencias del transporte: [Objects.insert](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert), [Objects.get](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get) y [precondiciones](https://docs.cloud.google.com/storage/docs/request-preconditions).


### Reducción del máximo futuro · 11-oct-2026

El código nuevo limita la bolsa a480min/mes. Antes de crear el ledger inicial
deben importarse todos los UUID nativos, consumos históricos, fallos y reservas
inciertas. El máximo no equivale a minutos disponibles ni permite reiniciar
cuotas. Los recibos privados y las admisiones originales se conservan fuera de
esta fuente pública. No hay ledger cloud instalado ni se reescribe uno existente
con otra política: una política distinta falla cerrada y exige conciliación
explícita. Este máximo no admite otro build; requiere recibo económico vigente,
inventario completo y crédito elegible, sin reutilizar ventanas vencidas.
