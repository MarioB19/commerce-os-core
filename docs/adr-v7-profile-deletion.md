# ADR V7 — Exportación y solicitud de eliminación de perfil (RF-01.5) y alcance del borrado D-18

Agente: Claude · 13-oct-2026 · rama `claude/v7-f2-cutover` · migración `0117_v7_profile_deletion_request.sql`.

## Contexto

RF-01.5 pide que eliminar un perfil requiera **una exportación legible previa** y la
**confirmación específica de Brandon**. D-18 fija la retención (registros técnicos 90 días,
conversaciones 180 días, datos financieros 5 años) y el borrado por ventanas.

Las primitivas de privacidad de D-18 ya están en las migraciones 024–038 (fences de escritores,
trabajos, cierre, minimización de registros y archivos, resultados, implementaciones opacas,
atestaciones de respaldo por archivo y por fila). Lo que **no** existe todavía es:

1. el ensamblador que encadena esas primitivas en una ejecución de borrado completa;
2. la instalación en producción de los fences de escritores y del plan de inventario
   (triggers sobre todas las tablas, que la suite completa no ejerce contra el runtime real);
3. el operador nativo que obtiene la atestación de restauración de B02 que exige la autoridad
   de los trabajos de privacidad.

## Decisión

Opción conservadora y reversible, registrada según §2 del prompt V7:

- **Este despliegue entrega** la exportación del dueño, la solicitud de eliminación de
  plataforma con confirmación por nombre exacto, su cancelación y el bloqueo de reactivación
  mientras está pendiente. **No borra nada.**
- **El borrado automático D-18 se difiere** a un incremento dedicado, con fecha límite antes del
  primer vencimiento real: registros técnicos de 90 días (diciembre de 2026) y conversaciones de
  180 días (marzo de 2027). RNF-04.c queda **Parcial** con esos tres puntos pendientes.

## Diseño

**Exportación (dueño).** `GET /v2/profile/export` (alcance `audit:export`, sólo persona Dueño,
también con el perfil suspendido) devuelve un NDJSON comprimido: cabecera, perfil, membresías,
todos los `records` del perfil paginados por `(kind,id)`, variantes, asignaciones y un
manifiesto con conteos. Se omiten las claves que parecen secretos (tokens, contraseñas, llaves,
cifrados) a cualquier profundidad; lo sellado sigue sellado. Límite de 120 MB sin comprimir.
La base sólo guarda un **recibo inmutable** en `profile_data_exports` (huella SHA-256, filas,
bytes, autor), con RLS por perfil. El evento `profile.data.exported` queda en el diario del perfil.

**Solicitud (plataforma).** `GET|POST /v2/platform/profiles/:id/deletion` y
`POST .../deletion/cancel`, sólo con sesión interactiva de administración de plataforma, sin
tokens. Requisitos que valida la base (funciones `SECURITY DEFINER` de
`commerce_platform_owner`): perfil `SUSPENDED`, versión exacta, nombre del negocio escrito
igual, recibo de exportación del propio perfil de los últimos 7 días, ninguna otra pendiente,
motivo de 8 a 500 caracteres. Idempotente por `operationId` (`platform_operations`, tipos
`REQUEST_DELETION` y `CANCEL_DELETION`). La plataforma ve el recibo (huella y conteos), nunca el
contenido (0100).

**Bloqueo.** El trigger `guard_profile_deletion_pending` impide cambiar el estado del perfil a
algo distinto de `SUSPENDED` mientras haya una solicitud `PENDING_ERASURE`.

**Clasificación.** `profile_data_exports`: perfil (fila por `workspace_id`), privacidad
`MINIMAL`. `platform_profile_deletions`: plataforma fuera de todo perfil (`profile_id`),
privacidad `EXCLUDED`, como `platform_operations`. Inventario: 197 relaciones.

## Reversión

La migración es aditiva (2 tablas, 1 trigger, 3 funciones, una restricción ampliada). Revertir
el código deja las tablas sin uso; ningún dato existente cambia.

## Pruebas

`tests/integration/v7-profile-deletion.test.ts` (4): exportación legible sin secretos y recibo
inmutable; aislamiento del recibo y cierre de la tabla de solicitudes al rol de la API;
negativas (activo, nombre, exportación ausente o vieja, no administrador), éxito idempotente,
nada borrado, reactivación bloqueada; cancelación idempotente y reactivación posterior.
