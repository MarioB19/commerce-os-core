# Emisor Root del aislamiento del origen

Estado de preparación: **PREPARED_SYNTHETIC_ONLY**. Este documento y el código preparado no acreditan instalación, custodia Linux Root ejecutada, revocación física, conexión WhatsApp ni permiso de venta. Brandon pospuso los teléfonos; no se emite un desafío ni un recibo real durante esta preparación.

## Autoridad y alcance

`scripts/copy-source-isolation-root.py` es un adaptador local Linux con UID efectivo 0, sin argumentos y con un único JSON por stdin. `scripts/copy_source_isolation_root.py` contiene contratos y SQL cerrado. No llama Cloud, transportes, APIs de negocio, perfiles, bootstrap, roles, cancelación ni transferencia. Sólo inserta el desafío técnico de migración 67 y, después de validar ambos componentes, inserta `ownership_isolation_receipts` y completa ese desafío en una misma transacción. Nunca cambia registros, sesiones, owners, políticas, credenciales, comandos, efectos o audit del negocio.

El recibo usa exclusivamente `source_billing_disabled_and_primary_device_revoked`. No afirma parada de Docker ni la deduce de Asset Inventory, indisponibilidad, lease vencido o gasto detenido. El lease vencido y freeze son barreras adicionales. La nueva vinculación, identidad, recepción, entrega y cobro físicos siguen siendo pasos separados; los resultados del emisor tienen `authorizes_operations=false`.

## Custodia, versión y CAS

La entrada admite exactamente `schema_version`, `action`, `candidate_sha`, `migration67_sha256`, `adoption_ref`, `billing_ref`, `challenge_id`, `ttl_seconds`, `binding` y, sólo para `finalize`, `human_ref`. No acepta flags `approved`, `api_proof`, `human_verified` o `test_mode`. El límite es 64 KiB; duplicados, NaN y campos ajenos se rechazan. stdin espera como máximo diez segundos. La ejecución nativa de PostgreSQL tiene límite de 35 segundos, timeout SQL de veinte segundos y lock de diez; mata el grupo del subproceso al vencer.

Root fija el SHA del candidato instalado en `RELEASE.json`, el hash del archivo 67 empacado y el mismo hash en `schema_migrations`. Exige `/opt/commerce-os/current` apuntando al release y bytes/hash exactos de `/opt/commerce-os/private/api-web-adoption.json`; usa los validadores Root existentes de v2/v3, relee referencias privadas, portal, plan B02 y perfiles canónicos sin imprimirlos. El manifiesto se compara antes e inmediatamente alrededor de SQL. No es una inspección completa de salud/topología ni una nueva validación de publicación.

Conserva el orden de los locks existentes: `daily-b02-controller.lock`, `ci-deploy.lock`, `backup-schedule.lock`, `maintenance-backup.lock`, y agrega `source-isolation.lock`. Se mantienen hasta terminar SQL y readback. Los directorios propios `private/source-isolation/{evidence,challenges}` y cada UUID son Root 0700. Archivos y locks son Root 0600, regulares, con un hardlink, apertura `O_NOFOLLOW`, padres Root sin escritura de grupo/otros y verificación estable de dispositivo/inodo/tamaño/timestamps. Escribe archivos nuevos exclusivos, fsync y readback; un archivo previo distinto bloquea el reintento.

Cada `challenges/<uuid>/intent.json` guarda el tuple completo y las referencias por hash antes de SQL. Así se conservan `session_id`, gateway, sesión remota e identidad esperada que la tabla 67 no persiste. `finalize` exige idéntico tuple, candidato, hash instalado, manifiesto y observación técnica. El cambio legítimo de cualquiera requiere un desafío nuevo; no hay rebase automático. Un prewrite sin challenge no concede autoridad. Si SQL pudo haber comenzado y falla un readback, el adaptador informa `UNKNOWN_REQUIRES_READBACK`, nunca una ausencia falsa de recibo; repetir exactamente permite reconciliar la misma operación.

## Observación técnica y declaración humana separadas

`billing_ref` sólo admite una referencia sellada Root bajo `private/source-isolation/evidence/<nombre>.json`. Su contenido debe conservar el recibo de observación nativa: proyecto `vibe-conversa-prod`, cuenta original `operator@example.invalid`, comando Billing de Google con respuesta `projectId` exacta y `billingEnabled=false`, identidad ACTIVE comprobada en ese mismo terminal, cero mutaciones y sin atribución de parada de Compute/Docker. Se rechazan snapshots de Asset, cuentas de servicio, flags truthy y datos de más de 24 horas o futuros. El archivo del vault puede ser fuente para revisión y transferencia; todavía no es custodia Root en destino.

Un hash o un JSON bien formado no autentica por sí mismo una consulta Google. Root debe haber presenciado y verificado la lectura nativa autenticada, y transferir ese recibo a custodia Root con su referencia exacta. El código no ejecuta ni simula esa lectura. En esta preparación todos los recibos son fixtures explícitamente sintéticos.

La API sólo registra una declaración canónica. Para completar, Root exige además `human_ref` **separado** y un `source_message_ref` Root al mensaje humano original: clase `DIRECT_HUMAN_PRIMARY_DEVICE_CONFIRMATION`, challenge/cuenta/workspace/principal/responsable/actor exactos, acción explícita `REVOKED_PREVIOUS_COMMERCE_DEVICES_AFTER_CHALLENGE`, instante de acción posterior al desafío y anterior al reporte canónico, recepción y registro posteriores. El mensaje original debe expresar realmente la revocación de los dispositivos Commerce anteriores, con su contexto, y ser verificado por Root antes de normalizar/sellar los campos. Una autorización general, un PAT manejado por la IA, una respuesta de API o JSON creado por la IA no son esa evidencia humana. No se convierte un permiso amplio en una declaración física.

`human_ref` también fija el event canónico, idempotency key, método de autenticación y credential ID si fue PAT. El emisor coteja el reporte inmutable, owner membership activa del actor en el workspace, PAT activo y REAL permitido si aplica, audit real con actor/credential/challenge/source y resultado de idempotencia real. La API serializa timestamps a milisegundos; sólo ese cotejo de `reported_at` trunca el valor DB a milisegundos, conservando el timestamp DB original para todos los deadlines. `audit.recorded_at` usa inicio de transacción y se verifica dentro del intervalo del desafío/reporte, sin inventar orden posterior a `clock_timestamp`.

La evidencia del recibo es un hash canónico de método, intent completo, observación técnica y dos hashes humanos con los IDs canónicos; no guarda texto humano, teléfonos ni tokens en la DB o salida pública. La autenticidad y la acción física de la declaración siguen siendo responsabilidad del verificador humano Root, no una prueba criptográfica producida por fixtures.

## Locks, vigencia y ausencia de efectos

SQL toma `operations:<workspace>:REAL` shared antes de `channel-command:<account>`, igual que el orden canónico de la API; luego bloquea la migración, cuenta, sesión, owner, membresías, política y workspace pause. Verifica el REAL waha exacto, cuenta/version, sesión/revision/id, old owner/generation, principal/responsable activos, credenciales, gateway e identidad esperada. Exige `STOPPED`, pausa, recovery deshabilitado, sending false, política REAL congelada y owner congelado con lease ya vencido.

Conserva sin editar todas las colas. Bloquea comandos PENDING y FAILED/UNKNOWN no reconciliados; efectos READY/SENDING/UNKNOWN, intentos sin terminar e inbound PENDING. SHARE locks breves de esas cuatro tablas excluyen inserciones fantasma durante la emisión; pueden bloquear productores y vencen de forma acotada. Un timeout o deadlock aborta; no cancela ni limpia la incertidumbre. Historial terminal permanece intacto.

Toda lectura temporal se hace después de las esperas de locks con `clock_timestamp()`, y las escrituras vuelven a comprobar deadline. El desafío dura como máximo doce horas y nunca más allá de la vigencia técnica de 24 horas. Dos finalizadores del mismo tuple se serializan y devuelven el mismo recibo; cambio de evidencia, expiración, consumo o drift bloquea replay. El INSERT receipt y el completion se confirman juntos, sin recibo huérfano si falla la última comprobación.

## Verificación proporcional

Unit tests en `tests/ci/test_copy_source_isolation_root.py`: contratos cerrados, referencia/procedencia, timestamps, identidad, flags falsos, límites stdin, sólo escrituras permitidas y orden de locks.

`tests/integration/copy-source-isolation-issuer.test.ts` ejecuta el fixture de PostgreSQL con Node 24 y un plazo acotado. El fixture deriva una DB propia del `DATABASE_URL` del job, migra su historial, usa la API real como `commerce_api` antes de imports y sólo el emisor SQL como `commerce_owner`. Crea/drop exclusivamente su DB y prueba replays, payload cambiado, drift, credencial revocada, colas, lease, no efectos, dos finalizadores concurrentes, espera real de row lock que cruza vencimiento y el orden operations/channel con el rol API.

Las pruebas no ejecutan el adaptador Root en Linux ni acreditan archivos Root reales, la lectura Billing o la revocación en un teléfono. Esos checks deben completarse en la instalación autorizada tras publicación del candidato exacto y cuando Brandon tenga los teléfonos. Mantener el método pendiente hasta entonces.
