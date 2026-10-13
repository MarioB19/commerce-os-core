# ADR V7 RF-11 — Lectura de Meta por perfil (D-06)

Agente: Claude · 13-oct-2026 · rama `claude/v7-f2-cutover`.

## Mecanismo decidido (RF-11.b)

D-06 eligió el **token de usuario del sistema** que cada negocio crea en su
propio portafolio de Meta y pega en *Cuenta → Integraciones*. La alternativa,
una app de Meta global con OAuth, exige revisión de la app y verificación del
negocio por Meta; queda fuera del valor por defecto y no se presume aprobada.

- El dueño pega el token en una sesión interactiva (`PUT /v2/integrations/meta/token`).
  Se guarda cifrado con la llave de datos (alcance `profile.meta.token.v1`,
  perfil y revisión dentro del texto cifrado) y sólo se muestran los últimos
  cuatro caracteres.
- Se valida con dos lecturas oficiales (`/me` y `/me/permissions`); queda
  `VERIFIED` sólo si concede `ads_read`. Un fallo de Meta deja `UNVERIFIED`
  sin inventar un estado.
- Cada perfil ve sólo las cuentas publicitarias que su propio token alcanza.

## Lectura (RF-11.a)

- Trabajos `meta_insight_jobs` con `request.source = 'V7_PROFILE'`: uno por hora
  por perfil con token `VERIFIED` y activo, o cuando el dueño pide
  «Actualizar datos de Meta» (`POST /v2/campaigns/sync`, alcance
  `integrations:write`; MCP `campaigns_read.sincronizar_lectura`). Un solo
  trabajo abierto por perfil.
- El automation-worker los procesa dentro del WorkerScope de ese perfil
  (`apps/automation-worker/src/meta-profile-sync.ts`): fases cortas para
  reclamar, leer el token y guardar; las lecturas a Graph ocurren entre fases,
  sin transacción abierta. El rol `commerce_automation` sólo puede leer las
  columnas necesarias del token y únicamente en el contexto del perfil dueño
  (migración `0110_v7_meta_profile_sync.sql`).
- La ventana es de 7 días en la zona horaria de cada cuenta publicitaria.
- Si el token cambió entre la petición y la lectura, el trabajo se cancela con
  `META_CREDENTIAL_CHANGED` sin llamar a Meta; la siguiente lectura usa la
  revisión nueva. Desactivar Meta detiene la programación.
- El ciclo V5 (tokens de `integration_settings`) no reclama trabajos V7 y deja
  de reprogramarse para un perfil en cuanto existe un trabajo V7.

## Sólo lectura (RF-11.c)

El cliente de Graph (`apps/api/src/meta-client.ts`) sólo hace `GET`; la API y
el MCP no tienen ninguna ruta o acción que cree, active, pause, escale o
financie anuncios. `POST /v2/campaigns/sync` sólo encola una lectura.

## Consecuencias

- `GET /v2/campaigns` devuelve `connected` según el token (no según datos
  antiguos) y `sync` con el estado de la última lectura; los datos leídos antes
  siguen visibles aunque el token falte.
- Para un perfil adoptado de V5 con lecturas previas, el dueño pega su token en
  Integraciones; hasta entonces se ven los datos ya leídos y el aviso de conectar.
- `portafolios` sigue pendiente en el registro MCP (la lectura descubre las
  cuentas publicitarias del token, no lista portafolios).
