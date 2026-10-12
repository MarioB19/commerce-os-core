# Alcance del reloj de temporizadores · 11-oct-2026

Estado: corrección local; FULL e instalación productiva pendientes.

## Problema y decisión

`processTimers()` enlazaba los IDs de conversación y simulación como texto sin
fijar su espacio de trabajo, entorno ni tipo. La selección global de trabajo
podía tomar el reloj virtual de un record de otro alcance. Además, la rama de
tiempo real podía seleccionar un timer cuya conversación pertenecía al entorno
opuesto: `getRecord()` comprueba espacio de trabajo, tipo e ID, pero no entorno.

Los dos JOIN ahora fijan `workspace_id`, `environment` y `kind` junto al ID.
Se conservan el reloj de pared como alternativa, orden, límite, bloqueo asesor,
`FOR UPDATE` y comprobación temporal posterior al bloqueo. Antes de continuar,
el worker exige que timer y conversación tengan el mismo entorno. `nowFor()`
sólo adopta un reloj de simulación del mismo entorno; de otro modo conserva el
reloj de pared. La misma regla protege el reloj de `assignmentGate()`, y sólo una
conversación SIMULATION puede marcar como completada su simulación del mismo
entorno. No se cancela, repara ni reasigna una referencia fuera de alcance.

La corrección reutiliza índices existentes; no requiere una migración ni cambia
plazos, autorizaciones, revisión humana, semántica de envío o cuotas. No elimina
el segundo control temporal: una fila seleccionada sigue siendo sólo candidata.

## Verificación

Doce integraciones dirigidas ejercen PostgreSQL real con 68 migraciones en una
base sintética aislada: relojes ajenos por espacio/entorno/tipo, conversación de
otro espacio, reloj de pared bajo revisión humana, timer/conversación de entornos
opuestos en ambas direcciones, rechazo del reloj REAL durante el segundo control
y disparo único de una espera virtual con workers concurrentes y repetidos.
También prueban que un reloj REAL no revive una asignación vencida y que terminar
el workflow no completa una simulación ajena en ninguna dirección. Pasan las 72
integraciones relacionadas, 558 unitarias, TypeScript y lint dirigido.

Un `EXPLAIN (ANALYZE, BUFFERS)` local añadió 20 400 records y 200 timers sintéticos
dentro de una transacción revertida. Para el mismo límite de 25 candidatos:

| Consulta | Tiempo local | Bloques en caché | Plan observado |
|---|---:|---:|---|
| Anterior | 10,574 ms | 1 040 | Hash joins y secuenciales |
| Corregida | 0,220 ms | 180 | Nested loops, índices y memoización |

El plan corregido eligió `timers_pending`, `records_conversation_assignee` y
`records_lookup`. Es una sola muestra local con caché caliente y datos sintéticos;
no acredita latencia productiva ni cumplimiento de SLO. La
[evidencia resumida](evidence/timer-scope-20261011.json) distingue esa medición de
las pruebas funcionales y de la publicación pendiente.

## Comprobación productiva pendiente

Publicar mediante el controlador revisado, con FULL y paquete del mismo SHA.
Leer avance del ciclo de timers y su tiempo de consulta con la identidad del
runtime instalado. Conservar las barreras REAL, las pausas y todos los gates de
respaldo, instalación y recuperación. Readiness por sí sola no demuestra avance
del worker ni que este cambio esté instalado.
