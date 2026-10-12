# RF19 — transporte canónico dentro del motor dedicado

Decisión previa, 12 de octubre de 2026. Root autoriza un cambio acotado de
dependencias en `dispatchOutbox` dentro de esta rama aislada. Su entrada comercial
conserva el store, proveedores, materiales, gates y resultado anteriores. No se
copia el dispatcher ni se habilita un selector de transporte desde la acción.

La entrada del laboratorio exige un lease opaco instalado y una composición
protegida. Cada fase SQL utiliza el mismo cercado de perfil/run/operación y reloj
final del motor; ninguna transacción permanece abierta durante lectura física
de materiales. La selección se limita al run y conversación capturados. Los
efectos de warm-up/grupos quedan fuera de esta entrada porque no forman parte del
grafo comercial remapeado; no se omiten sus controles para la entrada existente.

El proveedor sólo puede ser el simulador de catálogo existente. Su comprobación
de outbox/cuenta/conversación/contacto y su ACK cifrado reciben el puerto SQL y
la clave del laboratorio fijados por la factory. No puede cargar integraciones,
sesiones, claves REAL, webhooks ni clientes HTTP. Los materiales salen únicamente
de la custodia copiada y verificada del laboratorio; no se aceptan rutas, URLs o
claves públicas. Un enlace o acceso remapeado conserva su carácter LAB_ONLY.

Claim, validación final, reserva de capacidad local, efecto/attempt, causalidad,
controles, tiempo virtual y readback siguen la implementación canónica. La
capacidad se registra sólo en la base dedicada y bajo SIMULATION; no consume
cuotas REAL. Una pérdida de confirmación conserva incertidumbre y exige lectura,
sin reenviar. Los permisos nuevos, si hacen falta, se limitan a tablas operativas
vacías de esa base, con políticas de perfil y entorno; no se amplía el kernel.

Las pruebas deben cubrir el camino comercial predeterminado además del nuevo
puerto, causalidad, pausa/opt-out, archivos cifrados y fallos de custodia. Un
resultado SENT sintético no equivale a DELIVERED: el ACK debe pasar por su
consumidor canónico antes de acreditar entrega. Hasta completar ese consumidor
la salida lo mantiene pendiente. Este ADR no acredita montaje ni egress físico.

Los consumidores `processInbound` y `consumeProviderObservations` también
conservan entradas predeterminadas. Sus implementaciones privadas reciben el
mismo puerto SQL y, para laboratorio, un filtro fijo de cuenta/run y únicamente
ACK originados por `catalog_simulator`. El cifrado del ACK usa clave LAB y AAD
run/efecto; no reutiliza la clave ambiental comercial. Normalización, dedup,
orden provider-id y actualización de estado siguen el código común. Mensajes,
sesiones, grupos y restricciones no son entradas aceptadas por esta composición.
La entrega de archivos exige la copia cifrada privada, metadatos del plan y hash
del contenido; enlaces/accesos continúan cerrados hasta un adaptador específico.

Después del ACK, `materializeEffectResults` reutiliza su implementación privada
para proyectar el estado durable sobre mensajes/fulfillments/pedidos del mismo
run y conversación. El adaptador no declara una entrega a partir de un SENT ni
escribe estados de venta por fuera de ese consumidor. Cada pasada es finita;
trabajo posterior conserva el avance canónico para la siguiente acción.

El primer ensayo conservado descubrió que el plan reutilizado de
`guard_warmup_effect` comprueba permisos de `warmup_turns` incluso en efectos
comerciales. Se concede sólo SELECT con RLS restrictiva `false`, verificando
antes que la tabla esté vacía. No se cambia el trigger, se admiten turnos ni se
concede escritura. El ensayo fallido y su dump permanecen separados.

La respuesta registra las fases ejecutadas y los estados nativos, por separado.
SENDING, UNKNOWN, READY, BLOCKED o SENT mantienen TRANSPORT pendiente; únicamente
el ACK o un resultado terminal conocido cierra esa dependencia. El recibo de
acción APPLIED no se interpreta como entrega exitosa.

El segundo ensayo conservado acreditó35/36 casos y mostró una expectativa de
fixture incorrecta: NUMBER_FLOW_TEST_V1 deja el cursor en send2/WAITING con
simulation_continue después del primer mensaje. La regresión final verifica ese
estado, encola continue por el control canónico y comprueba ambos DELIVERED con
predecessor exacto. No se cambia el avance del workflow para forzar dos envíos.
El tercer ensayo36/36 pasó con41 fuentes idénticas antes/después; el contenedor
propio se retiró y los5 contenedores/65 volúmenes ajenos permanecieron exactos.

El puerto de bloqueo compartido del namespace privado que prepara D18 es una
dependencia del montaje final sobre raíces de producción; las fixtures actuales
usan raíces privadas propias de un solo writer. Este incremento no acredita esa
composición del host ni el borrado real de archivos.
