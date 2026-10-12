# F3 — preparación automática desde una conexión QR verificada

Decisión adoptada por Root el12-oct-2026 antes del código, sobre RF07 y D17.
Conectar QR autoriza permanentemente preparación entre números propios del
mismo perfil. No añade activación, renovación, campaña ni destinatario ajeno.
Esta rama prepara transición015 y enrollment/planner; Root posee el gate final
channel y su helper de autorización.014 pertenece a las cuotas de F0.

La transición añade continuity_mode LEGACY/QR_CONTINUOUS a pools, por defecto
LEGACY. Sólo pools automáticos nuevos son directos, standard-15d/v2 y tienen
small-pool=true: D17 contempla dos números propios. Se mantienen curva,
frecuencia, ventana, contenido, causalidad, recibos, salud y créditos existentes.
Cada perfil/entorno tiene un pool automático separado, sin mover programas ni
alterar registros históricos. Pausar, archivar o proteger jamás se revierte por
enrollment. Reenlazar conserva episodio, créditos y fechas; no reinicia días.

La identidad QR lleva qr_verified_at, qr_command_id y qr_identity_fingerprint
observados, distintos de profile_verified_at. La sesión debe conservar el
último connect APPLIED, la identidad autenticada y su ciphertext. Se descifra,
normaliza y compara sólo en RAM; el registro queda cifrado. profile_ciphertext
puede ser NULL únicamente para identidad QR, y no se inventa nombre, about,
avatar o lectura de metadata del proveedor. El worker de metadata excluye los
pools QR. La autorización permanente tampoco prueba salud actual.

Bootstrap y enrollment son funciones internas SQL acotadas por perfil, rol,
conexión y grant vigente. No conceden INSERT global a los workers. El scheduler
suministra el perfil autenticado; ningún selector HTTP, default tenant o primer
membership establece autoridad. Los cambios y su origen se auditan.

La biblioteca SYSTEM_QR_POLICY es texto operativo propio, versionado y fijado
por hash: comprobaciones internas explícitas, sin personalidad fingida ni
mecanismos de evasión. No representa una aprobación humana ficticia. Se crea
una copia independiente por perfil y el planner sólo consume las versiones
exactas del catálogo. No contiene enlaces, archivos ni datos de clientes.

El planner QR revalida el grant actual de cada participante y los bloqueos
humanos/protecciones. Los efectos usan continuous_authorization_id del emisor,
con authorization_id NULL; nunca sustituyen autoridad en un efecto antiguo.
El gate final de Root revalida ambos grants, QR identity, salud y cuotas cerca
del envío. Sin par propio elegible se registra espera; no se cambia inbound.
Grupos y programas existentes conservan su camino anterior.

La adopción de miembros legacy necesita una operación explícita, auditable y
compatible con créditos/episodios/pausas; el bootstrap automático no los mueve.
Ese tramo se entrega por separado y su ausencia no se presenta como migración
completa. Montaje del scheduler y prueba integrada necesitan el helper/gate de
Root y el contexto de workers de F0. No se usan QR, claves o mensajes reales en
las pruebas locales.

La función de inscripción usa search_path pg_catalog,public,pg_temp porque los
triggers históricos consultan tablas públicas sin calificar. La instalación
rechaza CREATE público para los roles runtime; el esquema temporal queda al
final, y una prueba con records temporal confirma la lectura real. Los campos
QR y el origen SYSTEM_QR_POLICY sólo pueden escribirse por el propietario de
las tablas dentro del bootstrap cerrado; roles runtime, incluidos logins que
heredan permisos, no pueden falsificarlos mediante INSERT/UPDATE directo.

Validación inicial: 28 unitarias y 12 PostgreSQL reales con conexiones runtime
sin superusuario; no hay proveedor en el ensayo. Se conservaron los fallos
previos y se verificó la identidad de cinco contenedores y 65 volúmenes. Los
casos ampliados incluyen caducidad, pausas, protección, episodio incompatible,
shadow temporal y concurrencia. La prueba no acredita montaje ni envío real.

Cierre de inscripción/planner: attempt8 pasó 44 PostgreSQL (27 casos legados y
17 de QR con roles restringidos), con cinco contenedores/65 volúmenes exactos y
retirada sólo del contenedor propio. Typecheck, ESLint y 28 unitarias pasaron;
F0 leyó el núcleo completo y ejecutó 28 independientes. La regresión legada
requirió claves sintéticas en el harness y un reloj explícito común para las
observaciones del breaker; sus assertions y el rechazo productivo de datos
futuros no cambiaron. Los intentos fallidos previos quedan preservados.
Los hashes y límites están en docs/evidence/v7-auto-qr-warmup-local.json.
