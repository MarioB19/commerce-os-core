# ADR — Publicación de la copia con consumidores y continuidad Root v3

Fecha: 2026-10-08. Estado: implementado localmente, pendiente de revisión, FULL CI y publicación del candidato exacto. No acredita canales conectados, SIM instalada ni ventas físicas.

La copia conserva el publicador existente y agrega el scope explícito `copy-runtime` para el destino autorizado. `full` sigue rechazado en la copia. No ejecuta bootstrap, importación del legado, recreación de roles ni congelamiento comercial de una publicación anterior. El operador Root y los archivos privados sellados autorizan las transiciones; una variable de repositorio selecciona el transporte, nunca reemplaza los permisos o las pruebas.

## Preparación y continuación

1. Partir de la adopción API/web+portal v2 confirmada con exactamente cinco servicios. Exigir respaldo nuevo, propietario vigente, 65 hashes de migraciones sin cambios y los cuatro locks existentes en el orden existente.
2. Crear únicamente la red técnica vacía aprobada por Root. Revalidar inmediatamente los hashes de todas las redes/endpoints Docker, rutas IPv4 main e inventario de definiciones/estado vivo, comprobar ausencia y solapamientos y repetir CAS de los archivos state/plan. No conectar contenedores durante la creación. Publicar sólo las migraciones 0066/0067 revisadas, en una transacción canónica que mantiene el advisory lock del migrador. Actualizar API/web con cinco servicios; verificar imágenes, HTTPS, propietario, portal, proxy, infraestructura y hashes exactos.
3. Instalar las tres herramientas B02 sólo desde su manifest Root sellado. El helper devuelve dos blobs exactos sin escribir la pareja. El publicador registra PREWRITE, conserva la pareja anterior, escribe plan y adopción con CAS/readback, llama `mark_pair_applied` y sólo entonces publica `PREPARED_ACTION_REQUIRED`/`CORE_PREPARED`. Este estado nunca es SUCCEEDED ni un baseline completo del CI.
4. Cancelar el PENDING retenido y deshabilitar las integraciones de canal mediante la API canónica. Root conserva los recibos de revisión y los liga a domain_events e idempotency reales, con actor, clave, operación, respuesta y cuerpos/versiones adyacentes exactos. No hay cancelación SQL directa. response_sha256 autentica idempotency.response exactamente, es decir el data almacenado por la API, sin el wrapper HTTP; integration.settings_disabled aporta operational_revision.
5. Continuar con el mismo SHA, imágenes, web manifest y bytes de fuentes/SQL del paquete preparado. Tomar hold canónico, con capacidad específica de API/worker verificada en las imágenes actual/candidata; repetir los gates de cero PENDING, perfiles deshabilitados y REAL congelado dentro del hold. Crear ingress y los dos workers, conservando los contenedores API/web preparados. Comprobar los seis servicios de aplicación/DB, HTTPS, owner, cuotas/autorizaciones, portal y límites; liberar sólo el hold transitorio. Adoptar Root v3 OPERATING y B02 plan3 con la misma pareja CAS. SUCCEEDED significa instalación técnica de ocho servicios, nunca venta física.

La continuación reutiliza el paquete privado inmutable del primer intento, mediante re-run únicamente del job deploy fallido después de las acciones API. Conserva GITHUB_RUN_ID y outputs del package exitoso; RUN_ATTEMPT y candidate_root cambian. La aprobación Root de B02 del segundo intento debe ligar ese candidate_root nuevo, stage OPERATING y los hashes actuales CORE_PREPARED. Un workflow_dispatch que reconstruya el mismo SHA puede fallar correctamente si cambian imágenes/manifests; no se acepta una reconstrucción diferente por conveniencia.

Los comandos lifecycle REAL, salud/QR/inbox y cambios de integración REAL deben adquirir el lock operacional canónico y rechazar hold en API/worker. El marcador `copy-runtime-hold-capability.json` describe este contrato con `real_channel_lifecycle_remote_rechecked` específico de lifecycle; no afirma cobertura universal de SDK. Pruebas de comportamiento de esos módulos deben demostrarlo. La primera preparación termina sin hold para permitir cancel/disable entre fases. Sólo la continuidad toma hold; no emite pruebas de aislamiento del origen.

## Red de consumidores y aprobación Root

El archivo `private/copy-runtime-migrations.json` es cerrado: schema_version=1, source_sha del candidato, migration_hashes de exactamente 0066/0067, consumer_edge_network, consumer_edge_approval_ref y backup_tools_manifest_ref. Todos los refs contienen path/bytes/sha256 y son leídos con custodia Root. La aprobación de red debe estar bajo `private/controller-approvals/` y contener exactamente:

```json
{
  "schema_version": 1,
  "source_sha": "SHA_REAL_DEL_CANDIDATO",
  "before_adoption_sha256": "HASH_REAL_DEL_STATE_V2",
  "before_plan_sha256": "HASH_REAL_DEL_PLAN",
  "definition": {
    "name": "commerce-os_consumer-edge", "driver": "bridge", "scope": "local",
    "internal": false, "attachable": false, "enable_ipv6": false,
    "subnet": "172.30.80.0/24", "gateway": "172.30.80.1",
    "options": {
      "com.docker.network.bridge.enable_ip_masquerade": "true",
      "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
      "com.docker.network.bridge.enable_icc": "false",
      "com.docker.network.bridge.gateway_mode_ipv4": "nat"
    },
    "labels": {
      "com.inovaris.product": "commerce-os",
      "com.inovaris.purpose": "copy-consumer-edge",
      "com.inovaris.source-sha": "SHA_REAL_DEL_CANDIDATO"
    }
  },
  "preflight": {
    "networks_sha256": "HASH_REAL_DE_EDGE_PREFLIGHT",
    "routes_sha256": "HASH_REAL_DE_EDGE_PREFLIGHT",
    "containers_sha256": "HASH_REAL_DE_EDGE_PREFLIGHT"
  }
}
```

Los textos de ejemplo son deliberadamente inválidos como aprobación. `edge_preflight(command, current_root)['hashes']` genera las tres observaciones privadas readonly después de adoptar portal y antes de crear la red. Root revisa el candidato y sella esta aprobación; no se aprueban automáticamente hashes calculados. La red admite sólo automation-worker al operar; API conserva su edge original y su ruta kernel. Los cuatro servicios de aplicación con networking tienen forwarding IPv4/IPv6=0. No se cambia firewall Cloud, VPC, IAM, cuenta de servicio o usuario. La creación de un bridge Docker aplica sus reglas Docker de NAT/ICC; esa red técnica es el único cambio de red de este scope.

Si la red se crea pero falla la lectura o la instalación, `consumer-edge-transition.json` conserva `RECONCILIATION_REQUIRED` y no la borra ni la llama adoptada. Su recibo inmutable Root se liga a state v3 como consumer_edge_ref; tanto CORE_PREPARED vacío como OPERATING con automation-worker se verifican por Docker inspect, IPAM/options/labels y endpoints exactos. Un siguiente intento después de fallo exige reconciliación explícita; no acepta una red homónima por conveniencia.

## Continuidad después de REAL

Root v3 separa definición estática de estado vivo. La definición incluye Id/Image/Name/Config/HostConfig/Mounts, IDs de redes, aliases ordenados y GwPriority. PID, StartedAt, salud y endpoints/direcciones efímeros se revisan por operación. B02 plan3 usa la proyección estática2 y compara la proyección completa/viva antes y después de cada respaldo. Un reinicio futuro no necesita inventar un baseline a partir de PID nuevo.

Las siguientes publicaciones OPERATING pueden conservar una política diferente de93. Sólo revisiones con auditoría/idempotencia canónica exacta permiten reconciliarla; no se inventan recibos ni se cambia un body sin versión. La publicación toma hold compatible, detiene los workers de este destino, rechaza envíos REAL SENDING, operaciones pagadas en vuelo, number_operations REAL PREPARING con lease vigente y warmup_identities REAL con profile_operation_status APPLYING y usa captura+atestación reales del proceso destino para el recambio legítimo. No congela permisos comerciales permanentemente, no resetea presupuestos, autorizaciones, manual_controls o cuotas REAL. La captura privada compara configuración y reservas REAL durante el período quieto; SIM puede avanzar independientemente. Después de liberar el hold, actividad legítima puede consumir cuotas sin modificar la definición estática Root.

Un inventario ya adoptado admite ocho servicios y cero a tres gateways, incluso detenidos. Cada gateway debe tener overlay_ref auténtico, digest de definición, operación capacity PROVISION/EXPAND SUCCEEDED/VERIFIED, slot REAL/primary, readback bounded_administrator, imagen/volúmenes/red y auditoría canónica. Esto acredita provisión histórica; no conexión, identidad ni salud vigente. La adición 0→3 posterior cambia CIDs/wiring y requiere una transición CAS explícita del baseline Root/B02 después del administrador canónico; este publicador rechaza extensiones sin adoptar. No hay exclusión silenciosa de gateways. El administrador de capacidad vigente exige que slot1 ya sea un piloto preparado; no lo crea desde un baseline de cero gateways. Esa preparación inicial y su readback canónico siguen pendientes y tienen su propio plan revisable; esta orden no los sustituye.

## Adopción canónica posterior de gateways

La orden Root separada `python3 scripts/deploy-ci-vps.py reconcile-copy-runtime-gateways MANIFEST_REF_FILE` adopta sólo gateways ya creados por el administrador canónico. El archivo argumento contiene un ref3 de una aprobación Root bajo `private/controller-approvals/`. Su manifest cerrado contiene schema_version=1, source_sha del release actual, current_release, run_id, before_adoption_sha256, before_plan_sha256, observed_policy, runtime_before_ref, previous_release_env_ref, current_release_env_ref, ownership_observation_ref, backup_before_provision_ref, gateway_provisioning y backup_tools_manifest_ref. No se generan hashes de aprobación por conveniencia ni se toma/libera hold desde esta orden. Se verifica PACKAGE.sha256 completo y la igualdad de bytes de los controllers/readers cargados con el paquete instalado; source_sha por sí solo no acredita esos bytes.

Root captura el runtime anterior completo, los ownerships/pruebas existentes y los archivos privados. El respaldo cifrado anterior debe ser fresco, contener los cuatro exports auténticos, corresponder al plan/release actual y preceder tanto la captura como la operación canónica. Cada gateway agregado exige operación REAL PROVISION o EXPAND apply=true, SUCCEEDED/VERIFIED, actor de auditoría, overlay auténtico, readback exacto del slot y cero sesiones. Los CIDs, PID, StartedAt, endpoints anteriores y perfiles privados siguen intactos; sólo ingress y channel-worker admiten los nuevos miembros de red canónicos. Docker inspect debe coincidir con la imagen, entorno, credenciales y límites renderizados por el compose canónico. Las definiciones detenidas se conservan; el reconciliador no crea, conecta, arranca o detiene gateways.

Bajo los mismos cuatro locks, el reconciliador exige hold canónico activo, freeze de ownerships, política exacta autenticada y ausencia de efectos en vuelo. B02 devuelve el nuevo plan3 ligado al inventario completo; la pareja Root/B02 usa el mismo PREWRITE, CAS y mark nativo. Antes del reporte terminal se verifica de nuevo que configuración comercial y ownerships no cambiaron. El resultado declara business_mutations=0, gateways_started=0, hold_released=false, backup_before_coverage=PRIOR_BASELINE_ONLY, new_backup_required=true y new_restore_required=true. SUCCEEDED aquí acredita únicamente la adopción técnica. Después deben ejecutarse respaldo nuevo y restauración del portal y gateways adoptados. La repetición exacta sólo lee el linaje confirmado; un reporte anterior no terminal no se sobrescribe ni se omite.

## Fallos y límites

Un fuse Root Linux abarca los1500 segundos de todo el intento, incluyendo herramientas, SQL, hold y CAS; cada fase recibe sólo el presupuesto restante. La interrupción posterior a SQL/red/tools conserva evidencia y la pareja anterior/parcial. No hace rollback SQL, restaura backups a ciegas ni libera un hold que necesite reconciliación. Sólo la pareja leída y confirmada puede emitir estado terminal exitoso. Los reportes públicos excluyen cuerpos privados, claves y teléfonos.

Falta ejecutar FULL CI y publicar un candidato exacto, sellar las aprobaciones Root con observaciones reales, realizar ambos pasos y validar B02 instalado. La copia paralela requiere además la evidencia humana efectiva de revocación de dispositivos vinculados y observación financiera del origen, por cuenta/actor/versión/challenge/nonce. Billing deshabilitado no prueba container_stopped. No se fabrica CID ni ownership proof y el publicador/reconciliador no transfiere ownership ni emite pruebas de aislamiento. La migración 0067 aporta un lector aditivo de recibos reales; acquireOwnership conserva sus requisitos y añade la barrera SHARE/hold. SIM instalada debe preceder las pruebas físicas autorizadas. Meta sigue sujeto a su restricción real.


## Interrupciones antes del reporte terminal

El estado terminal se construye aparte y sólo se publica en el reporte después del CAS duradero, mark_pair_applied y guard final. KeyboardInterrupt y SystemExit también registran FAILED con la reconciliación requerida y vuelven a propagarse; una interrupción no conserva un SUCCEEDED o PREPARED_ACTION_REQUIRED prematuro en memoria. Las regresiones cubren las dos fases y la adopción de gateways, tanto en el mark como en la escritura posterior. SIGKILL y pérdida del host siguen dependiendo del journal PREWRITE y de la lectura/reconciliación nativa; estas pruebas no acreditan recuperación física.
