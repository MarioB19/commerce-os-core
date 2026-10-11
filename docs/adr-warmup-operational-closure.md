# Warm-up: preparación legítima entre cuentas propias

Decisión previa a implementación, 2026-09-08 UTC. Base e536992. Brandon aprobó expresamente en esta tarea los ajustes de fase 0: identidad real, concentración visible con 2–3 cuentas, 20 % sólo donde sea factible desde seis, fase 3 desde día efectivo 8, standard 30 días, UNKNOWN sin reenvío y graduación sin permisos comerciales. No se autorizaron pilotos, mensajes ni cambios de perfil externos.

## Persistencia y transporte

Se mantiene `records(kind=channel_account)` como único inventario, el adaptador/provider factory existente, ingreso y ACKs, outbox e intentos, ownership y workers existentes. La migración aditiva 0024 añade tablas satélite scoped y un tipo de efecto `warmup`. En ese tipo, conversation_id identifica una conversación interna y contact_id la cuenta peer: un trigger valida el par y turno en el mismo workspace/entorno. No crea contactos, conversaciones comerciales ni pedidos. La alternancia se gobierna por turnos persistidos; sólo se despacha un sucesor después de confirmar la entrega anterior. El agregado comercial ignora efectos internos.

El clasificador consulta fingerprints de identidades propias antes de materializar mensajes comerciales, incluso con el pool pausado/apagado. Destinos cifrados se descifran únicamente al preparar el transporte. No se permite una dirección libre en el plan/API. Identidades y contenido pertenecen al workspace/entorno y su aprobación inicial no habilita por sí misma despachos.

## Programa y controles

Ventanas diaria, 15 minutos y hora se conservan en PostgreSQL, bajo lock transaccional con resultado/lease persistidos. Los loops existentes sólo despiertan el escaneo durable: reiniciar no pierde ventanas/planes. El horario IANA se comprueba de nuevo al despachar. Las reservas completas consumen presupuesto de conversación y mensajes de ambos participantes, incluidos graduados; bucket atómico por emisor y receptor. Sin peer/identidad/contenido/capacidad espera y vuelve a evaluar automáticamente. Un día sólo cuenta con actividad confirmada; pausas no se compensan con ráfagas.

El pool empieza apagado. REAL sigue siendo el default de la aplicación. La autorización de warm-up es separada, con cuentas/contenidos/caps/vencimiento/configuración fijados. El guard definitivo vuelve a comprobar flag, breaker, policy, controles, ownership, identidad, salud, horario y cuota antes de HTTP. El guard comercial impide ventas desde cualquier cuenta enrolada sin graduar aunque se apague warm-up. UNKNOWN nunca se reintenta automáticamente.

Breaker: cuentas distintas fallando / cuentas del pool >= 20 % en 24 horas; rearme humano. FAILED no acredita baneo. Graduación: ventana efectiva, estabilidad observada de siete días, ACK maduros y muestra suficiente >=98 %, sin restricción confirmada. Dos extensiones de siete días como máximo; luego cuarentena. Cloud no participa en el pool y conserva sus controles oficiales.

La evaluación de graduación utiliza la estabilidad y la última observación que acaba de persistir en el mismo tick. Un hueco de una hora o más reinicia la ventana de estabilidad aunque la cuenta vuelva saludable y ya tenga treinta días y suficientes ACK. El historial anterior al hueco no puede acreditar siete días continuos. Los días efectivos completados durante ese tick sí se incorporan a la decisión.

## Capacidades, publicación y recuperación

Las APIs de perfil de la documentación WAHA no acreditan capacidades de la imagen instalada. Su verificación por motor/digest y aprobación de perfil son dependencias explícitas. No se implementan identidades ficticias, proxies evasivos, ni garantías antibaneo. Grupos, presencia, respuestas citadas y reacciones no están implementados ni anunciados como capacidades en este incremento: no hay uso aprobado/capacidad comprobada que permita activarlos. El alcance disponible es texto, imagen, audio, documento y perfil, condicionado a evidencia del motor/digest; cualquier extensión requiere su contrato y prueba aislada.

Primera publicación compatible con warm-up apagado, sin efectos internos. Sólo después de verificar esa base se permite activar un piloto. Una vez que existan efectos internos, rollback sólo a releases compatibles; el instalador debe rechazar imágenes sin esta compatibilidad. Restore pausa pools y revoca autorización; conserva UNKNOWN. Apagar evita claims nuevos y no retira HTTP ya iniciado.

Fuentes: [auditoría fase 0](../../01%20—%20WhatsApp/🔎%20Auditoría%20fase%200%20—%20Warm-up%20de%20números%20—%202026-09-07.md), [perfil WAHA](https://waha.devlike.pro/docs/how-to/profile/), [motores](https://waha.devlike.pro/docs/how-to/engines/). Las pruebas virtuales no sustituyen staging 24 h, piloto ni ventanas reales de rollout.
