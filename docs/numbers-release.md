# Preparación de release y piloto

Publicado y verificado `2a6e4fbd777ac2ee0c8a1e895ba2c42497ea2517`, [PR #2](https://github.com/MarioB19/commerce-os/pull/2), el 19-sep a las 23:21 México (20-sep 05:21 UTC). Mis números/Calentamientos, política 4+10 días, grupos y capacidad incremental están en producción. [Recibo completo](evidence/numbers-publication.json). GitHub no inició Commerce CI gate porque agotó el presupuesto de Actions; deploy quedó SKIPPED. Se resolvió como incidente con la autorización Google existente, el paquete sellado de ese run y los instaladores canónicos sin modificar. Resultado SUCCEEDED: seis servicios, 57 migraciones, HTTPS por hash y sesiones/gateways conservados. El workflow sigue FAILURE por presupuesto; no se alteró ningún check, presupuesto, rol o scope. El despliegue real quedó registrado separadamente en GitHub (6549461250), exigiendo los checks verify/package exitosos. Brandon eximió expresamente el banco sostenido de dos horas; el último intento de 21.6 minutos permanece parcial y no se presenta como aprobado. Veinte cuentas y ampliación/reinicio se comprobaron funcionalmente en SIMULATION; producción conserva tres gateways y tres plazas legadas reservadas, sin capacidad física de veinte acreditada. Administrador de capacidad y piloto físico pendientes de recursos/alcance concretos; no hubo mensajes ni activaciones nuevas y REAL permanece congelado.

## G8 · publicado; comprobaciones y límites

El PR 35487595339 pasó completo; el merge 35489026855 volvió a pasar verify y package: 401 unitarias +1 omisión nativa, 473 integraciones +1 QR optativa, 116 E2E, 140 Python, 23 Node, tipos/lint/build, recuperación y auditoría sin vulnerabilidades conocidas.

Lecturas productivas: 20 GET de API y 15 llamadas MCP aprobadas; siete assets web coinciden por hash. Mis números, detalle, preparación, capacidad, Calentamientos y móvil 390px comprobados en navegador contra la API real con el PAT owner existente, sin respuestas simuladas. La contraseña bootstrap guardada devolvió 401; no se reinició ni modificó. Portal HTTPS confirma el mismo SHA y 480 actividades. MCP firmado instalado: 104 herramientas, incluidas las 38 nuevas; firma, seis archivos y paridad API comprobados. La conexión actual de Codex conserva el proceso anterior: recargarla antes de aceptar el recorrido completo desde ese cliente.

El archivo privado de deployment está archivado por hash como draft `ci-deployment-35489026855-1`, release ID 392323504. El [recibo](evidence/numbers-publication.json) conserva su procedencia manual de incidente. La lista siguiente documenta el procedimiento y las aceptaciones físicas/de cliente pendientes:

1. Revisar diff y evidencia final; volver a consultar `origin/main` antes de integrar y conservar cambios ajenos. Si cambió la base, resolver compatibilidad y repetir sólo lo afectado más los checks requeridos. No reutilizar permisos de publicaciones V5/QR históricas.
2. Revisar migraciones aditivas 0049–0057: programas/grupos/episodios, roles de runtime, jobs y tickets efímeros, causalidad de tres participantes, administración/capacidad, equidad y exclusividad física entre workspaces. No migran cuentas a grupos ni crean checklist o entregas. Conservar todos los checksums previos.
3. Con autorización para publicar este incremento, usar [publishing-changes](publishing-changes.md) y [CI/CD](ci-cd.md). Registrar commit exacto, run/intento, checks, imágenes por digest, manifiesto y resultado del instalador. Un PR o build local no es publicación.
4. Capturar antes/después las referencias sanitizadas de gateway, imagen, arranque, red, montajes, sesión, ownership/generación, flags operativos y autorizaciones. El release congela operación; no iniciar nuevas sesiones, recuperar QR, activar calentamientos ni ampliar tokens. Los gateways y volúmenes quedan fuera de recreación del núcleo. Conservar el overlay incremental privado en los siguientes releases.
5. Comprobar por HTTPS las rutas `/sales/channels/whatsapp`, `/sales/warmups` y detalle lateral; probar datos completos/vacíos, lectura de preparación, productos y capacidad. Cotejar `/v1/numbers`, `/v1/number-programs`, `/v1/number-capacity`, `/v1/number-policy` y contratos con el SHA publicado. Healthz por sí solo no acredita el recorrido.
6. Publicar/instalar el MCP de este SHA por el procedimiento existente y verificar `tools/list` desde el cliente Codex autorizado. Conservar tokens y permisos actuales. Si faltan scopes, presentar el permiso concreto y no ampliarlo automáticamente. Ejecutar el recorrido completo SIMULATION en recursos aislados desde ese cliente; la prueba SDK local no sustituye esta aceptación.
7. Instalar el componente administrativo acotado sólo dentro del alcance de infraestructura aprobado. Configuración privada, HTTPS validado, actor/scope específicos, archivos 0600 y directorio 0700. Medir primero y releer cada operation_id; preparación no conecta ni autoriza mensajes. No es necesario preparar veinte contenedores para publicar la interfaz.

Brandon eximió el banco de dos horas y solicitó merge y verificación posterior. Se conserva el último ensayo parcial de 21.6 minutos; no acredita capacidad sostenida ni física. Esta exención no omite CI/CD ni autoriza mensajes, sesiones, infraestructura o piloto. [Recibo](evidence/numbers-two-hour-user-waiver.json).

## Rollback revisable

Conservar backup B02 y prueba de restauración, `previous-release.env`, digests anteriores, overlay actual y su backup de revisión, credenciales y recibos de ownership privados. No imprimirlos en la conversación ni guardarlos en Git.

Después de instalar esta entrega, ejecutar rollback **desde sus helpers actuales** con el archivo privado de imágenes anteriores. La versión anterior del helper admite sólo diez gateways y no debe validar un overlay ampliado. El objetivo debe soportar warm-up interno y política operativa en DB; el script rechaza objetivos anteriores incompatibles. No hacer downgrade de esquema.

```sh
# Sólo en una intervención de rollback autorizada y desde esta release comprobada:
sh scripts/release.sh rollback /ruta/privada/previous-release.env
```

El congelamiento bloquea despacho REAL, congela ownership, pausa pools de programas nuevos e invalida sus revisiones. Programas completados/archivados y episodios conservan historia. Los workers antiguos no pueden generar efectos privados sobre pools de grupo: la migración guarda la marca de protocolo y el guard de DB. UNKNOWN permanece incierto, con reservas; no reenviar, borrar outbox ni resetear sesiones.

Releer que los programas operativos quedaron PAUSED, ningún pool nuevo habilitado, flags REAL congelados, sesiones/volúmenes iguales y ninguna nueva activación. Revisión de identidad/ownership y nueva autorización concreta preceden cualquier reanudación. Si el problema exige restore, usar el restaurador en una base nueva; revoca credenciales/autorizaciones, pausa programas, invalida snapshots y deja conciliación pendiente.

## G9 · preparación de un piloto físico

La [lectura autorizada del 19-sep](evidence/numbers-production-readonly-20260919.json) encontró tres cuentas GOWS: una WORKING, una FAILED y otra UNKNOWN, cero autorizaciones de envío vigentes. Son referencias de API, no inventario Docker ni benchmark físico. No hay todavía dos cuentas elegibles ni grupo comprobado para presentar una activación REAL concreta. No se inició QR, invitación, mensaje, recuperación o calentamiento productivo.

Preparar la revisión final con estos campos observados; no rellenarlos con inferencias:

| Campo | Condición del piloto inicial |
|---|---|
| Entorno y finalidad | REAL, conversación interna propia de validación; separado de ventas |
| Cuentas | Exactamente dos propias inicialmente, identidad/propiedad confirmadas y checklist real; alias resueltos a recursos existentes |
| Grupo | Existente, creado por la persona, sólo esas dos cuentas; snapshots frescos de ambas, permisos y versión sellados |
| Transporte | Versión/edición/engine instalados y capacidades de grupos/eventos observadas; GOWS persistido no basta |
| Contenido | Una conversación de seis turnos de texto, revisada literal y aprobada en biblioteca; registrar ID y versión del resultado real |
| Cuota inicial | Día automático 1: seis envíos totales, máximo tres propios por cuenta; cada una participa en seis actividades combinadas. Volver a calcular al cambiar turnos, miembros o fecha; el máximo de fin de semana es floor(15×0.5)=7 participaciones por número |
| Horario | 09:00–18:00 America/Mexico_City; sólo dentro del próximo día laboral autorizado |
| Vigencia | Fecha/hora de inicio y fin explícitas en la revisión, sin renovación automática; un piloto breve no equivale a autorizar el programa completo |
| Alcance del programa | El preflight estándar exige cobertura de los diez días automáticos. Para validar físicamente un tramo, autorizar el programa completo sólo si Brandon aprueba ese alcance; detenerlo tras la conversación acordada. No reducir el permiso en DB ni saltar el preflight |
| Impacto | Todas las asignaciones comerciales y conversaciones pendientes de las dos cuentas, antes de enrolarlas; no elegir la cuenta comercial operativa por defecto |
| Parada | Tercero/membresía incierta, identidad distinta, expiración, salud vencida, 429, UNKNOWN o falta de recepción correlacionada |
| Evidencia | Un envío por efecto, recepción autenticada por destino, turno causal, pausa/reanudación, cero duplicados; sin afirmar reputación ni días humanos desde SIMULATION |

Esta tabla prepara la selección; aún no es autorización ni una revisión sellada ejecutable. No pedir aprobación de un piloto sin completar primero los recursos, versiones, texto, límites, fechas e impacto. Si se requieren reconexiones físicas, autorización y escaneo son acciones separadas.

Escalar 2→5→10→20 sólo con capacidad medida, teléfonos disponibles, presupuesto y consentimiento específicos. Observar al menos 24 horas de carga física acordada en cada alcance; comparar CPU/RAM/disco, latencias, salud y colas. Veinte cuentas sintéticas no acreditan veinte sesiones físicas. No esperar quince días reales para entregar el software ni acreditar esos días por reloj virtual.

## Dimensionamiento y costo

Primera alternativa: mantener host y concurrencia actuales si la medición satisface los márgenes; costo incremental de VM cero, consumo/egreso y almacenamiento siguen su tarifa. No hay lectura física suficiente para confirmar que esta alternativa admite veinte.

Segunda alternativa: ampliación vertical revisada. Calcular RAM necesaria como `(uso actual + consumo medido adicional + reserva de aplicación/DB)/0.75`; CPU con carga observada y 30 % libre, no sumando sólo límites. El preview muestra máximos y estimación por separado. La prueba local con adaptador sin red no permite estimar RSS de veinte procesos WAHA.

El costo mensual de comparación es `730 × tarifa_horaria_VM + disco + snapshots + IP/egreso`; el incremento resta el costo actual. Escenarios orientativos de cómputo, sin afirmar capacidad física: E2 standard-4 (4 vCPU/16 GiB), USD 0.13402284/h ≈ USD 97.84/mes; standard-8 (8/32), USD 0.26804568/h ≈ USD 195.67/mes; standard-16 (16/64), USD 0.53609136/h ≈ USD 391.35/mes. Tarifas on-demand de la tabla pública predeterminada Iowa, consultada el 19-sep; confirmar `us-east1`, moneda y contrato antes de cotizar o cambiar el host. No incluyen disco, snapshots, IP, egreso ni impuestos. [Fuente oficial](https://cloud.google.com/products/compute/pricing/general-purpose).

La selección concreta queda pendiente del inventario y consumo físicos; una VM de 16 GiB no queda validada por el hecho de que veinte límites de gateway sumen 15 GiB. No se compró ni redimensionó infraestructura.
